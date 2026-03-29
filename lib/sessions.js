const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function getCwdByPid(pid) {
  try {
    const { stdout } = await execAsync(
      `lsof -p ${pid} -a -d cwd -Fn 2>/dev/null | grep '^n' | head -1`,
      { timeout: 1000 }
    );
    return stdout.trim().replace(/^n/, '') || null;
  } catch { return null; }
}

async function getClaudeProcesses() {
  try {
    const { stdout } = await execAsync(
      `ps -ax -o pid=,ppid=,%cpu=,tty=,lstart=,command= | grep "claude" | grep -v grep`,
      { timeout: 3000 }
    );
    const results = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const tty = parts[3];
      // lstart = 5 words: "Sat Mar 29 22:00:00 2026"
      const lstartStr = parts.slice(4, 9).join(' ');
      const startTime = new Date(lstartStr).getTime() || 0;
      const command = parts.slice(9).join(' ');
      // 실제 claude CLI만 허용: "bin/claude" 전체경로 또는 "claude" 단독 커맨드 시작
      if (!command.match(/bin\/claude(\s|$)/) && !command.match(/^claude(\s|$)/)) continue;
      // Electron 앱, tmux 래퍼, ShipIt 프로세스 제외
      if (command.includes('Electron') || command.includes('electron')) continue;
      if (command.startsWith('/usr/local/bin/tmux') || command.startsWith('tmux')) continue;
      results.push({ pid, ppid, cpu, tty, startTime, command });
    }
    return results;
  } catch { return []; }
}

async function getTmuxSessions() {
  try {
    const { stdout } = await execAsync(
      `tmux list-panes -a -F "#{session_name}|#{pane_pid}|#{pane_current_path}" 2>/dev/null`,
      { timeout: 1000 }
    );
    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [session, pid, path] = line.split('|');
      return { session, pid: parseInt(pid), path };
    });
  } catch { return []; }
}

async function getTmuxPaneInfo(sessionName) {
  try {
    const { stdout } = await execAsync(
      `tmux capture-pane -p -t "${sessionName}" 2>/dev/null | tail -10`,
      { timeout: 1000 }
    );
    // Claude 상태바 / 구분선 줄 필터링
    const rawLines = stdout.trim().split('\n')
      .filter(l => l.trim())
      .filter(l => !/esc to interrupt|shift\+tab to cycle|⏵/.test(l))
      .filter(l => !/^[─━\-= ]+$/.test(l));
    if (!rawLines.length) return { status: 'idle', lastLine: '' };

    const last = rawLines[rawLines.length - 1];
    // thinking 패턴은 전체 줄에서 하나라도 있으면 감지
    const anyThinking = rawLines.some(l =>
      /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(l) ||                   // 브레일 스피너
      /^\s*[✻✽✶✷✸]\s+\w+ing[…]/.test(l) ||          // ✽ Mustering… (줄 첫머리 상태 표시)
      /^\s*[✻✽✶✷✸]\s+.*\(\d+[smh]/.test(l)          // ✽ Something (33s...) 형식
    );
    let status;
    if (anyThinking) status = 'thinking';
    else if (/[│╭╰]/.test(last)) status = 'streaming';
    else if (/[>❯]\s*$/.test(last) || last.includes('?')) status = 'idle';
    else status = 'active';

    const cleanLines = rawLines
      .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏│╭╰]/g, '').trim())
      .filter(l => l.length > 2)
      .filter(l => !/^[❯>]\s+\S/.test(l))  // 사용자 입력 중인 줄 제외
      .filter(l => !/^~\//.test(l) && !/^\/[A-Za-z]/.test(l)); // 쉘 경로 프롬프트 제외
    const lastLine = cleanLines[cleanLines.length - 1]?.slice(0, 60) || '';

    return { status, lastLine };
  } catch {
    return { status: 'unknown', lastLine: '' };
  }
}

async function getAncestorPids(pid) {
  // pid의 조상 PID 목록 반환 (최대 5단계)
  const pids = new Set();
  let cur = pid;
  for (let i = 0; i < 5; i++) {
    try {
      const { stdout } = await execAsync(`ps -p ${cur} -o ppid= 2>/dev/null`, { timeout: 500 });
      const ppid = parseInt(stdout.trim());
      if (!ppid || ppid === cur || pids.has(ppid)) break;
      pids.add(ppid);
      cur = ppid;
    } catch { break; }
  }
  return pids;
}

async function getSessions() {
  // ps + tmux list 병렬 실행
  const [processes, tmuxPanes] = await Promise.all([
    getClaudeProcesses(),
    getTmuxSessions(),
  ]);

  // 각 프로세스에 대해 직접 매칭 먼저 시도, 실패 시 조상 PID 체크
  const tmuxPidSet = new Set(tmuxPanes.map(t => t.pid));
  const ancestorChecks = await Promise.all(processes.map(async proc => {
    const direct = tmuxPanes.find(t => t.pid === proc.pid || t.pid === proc.ppid);
    if (direct) return { proc, tmuxMatch: direct };
    const ancestors = await getAncestorPids(proc.pid);
    const match = tmuxPanes.find(t => ancestors.has(t.pid));
    return { proc, tmuxMatch: match || null };
  }));

  const matched = ancestorChecks;

  // tmux capture-pane + TTY CWD 병렬 실행
  const tmuxNames = [...new Set(
    matched.filter(m => m.tmuxMatch).map(m => m.tmuxMatch.session)
  )];
  const ttyProcs = matched.filter(m => !m.tmuxMatch).map(m => m.proc);

  const [paneInfos, cwds] = await Promise.all([
    Promise.all(tmuxNames.map(name => getTmuxPaneInfo(name))),
    Promise.all(ttyProcs.map(proc => getCwdByPid(proc.pid))),
  ]);
  const paneInfoMap = Object.fromEntries(tmuxNames.map((name, i) => [name, paneInfos[i]]));
  const cwdMap = Object.fromEntries(ttyProcs.map((proc, i) => [proc.pid, cwds[i]]));

  const sessions = [];
  const seen = new Set();

  for (const { proc, tmuxMatch } of matched) {
    if (proc.command.includes('--channels')) continue;

    let name, path, type, status, lastLine = '';

    if (tmuxMatch) {
      const key = tmuxMatch.session;
      if (seen.has(key)) continue;
      seen.add(key);

      name = tmuxMatch.session;
      if (name === 'goagent-telegram') continue;

      path = tmuxMatch.path;
      type = 'tmux';

      const paneInfo = paneInfoMap[key] || { status: 'idle', lastLine: '' };
      if (proc.cpu > 15) status = 'thinking';
      else if (paneInfo.status === 'thinking' || paneInfo.status === 'streaming') status = 'thinking';
      else if (paneInfo.status === 'active') status = 'waiting';
      else status = 'idle';
      lastLine = paneInfo.lastLine;
    } else {
      const key = proc.pid;
      if (seen.has(key)) continue;
      seen.add(key);

      const ttyLabel = proc.tty !== '??' ? proc.tty : 'unknown';
      path = cwdMap[proc.pid] || '';
      name = path ? path.split('/').pop() || path : `Terminal (${ttyLabel})`;
      type = 'terminal';
      proc.ttyFull = proc.tty !== '??' ? `/dev/tty${proc.tty}` : null;

      if (proc.cpu > 15) status = 'thinking';
      else if (proc.cpu > 1) status = 'waiting';
      else status = 'idle';
    }

    sessions.push({
      pid: proc.pid,
      name,
      path,
      type,
      status,
      cpu: proc.cpu,
      startTime: proc.startTime || 0,
      tty: proc.ttyFull || proc.tty,
      tmuxSession: tmuxMatch ? tmuxMatch.session : null,
      ...(tmuxMatch ? { lastLine } : {}),
    });
  }

  // 최근 시작순 정렬 (startTime 내림차순)
  sessions.sort((a, b) => b.startTime - a.startTime);

  return sessions;
}

module.exports = { getSessions };
