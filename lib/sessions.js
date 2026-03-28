const { execSync, exec } = require('child_process');

// TTY 기반으로 작업 디렉토리 조회
function getCwdByPid(pid) {
  try {
    return execSync(`lsof -p ${pid} -a -d cwd -Fn 2>/dev/null | grep '^n' | head -1 | sed 's/^n//'`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

// ps로 Claude 프로세스 목록 가져오기
function getClaudeProcesses() {
  try {
    const out = execSync(`ps -ax -o pid,ppid,%cpu,tty,lstart,command | grep -E "claude" | grep -v grep`, { encoding: 'utf8' });
    const results = [];
    for (const line of out.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const cpu = parseFloat(parts[2]);
      const tty = parts[3]; // e.g. s008
      const command = parts.slice(8).join(' ');

      // claude CLI만 (bun, tmux 래퍼 제외)
      if (!command.includes('/claude') && !command.match(/^claude\s/) && !command.match(/bin\/claude/)) continue;
      if (command.includes('grep')) continue;
      if (command.includes('ShipIt')) continue;

      results.push({ pid, ppid, cpu, tty, command });
    }
    return results;
  } catch {
    return [];
  }
}

// tmux 세션 정보 가져오기
function getTmuxSessions() {
  try {
    const out = execSync(`tmux list-panes -a -F "#{session_name}|#{pane_pid}|#{pane_current_path}|#{pane_current_command}" 2>/dev/null`, { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [session, pid, path, cmd] = line.split('|');
      return { session, pid: parseInt(pid), path, cmd };
    });
  } catch {
    return [];
  }
}

// tmux 패널 마지막 의미있는 줄 가져오기
function getTmuxLastLine(sessionName) {
  try {
    const out = execSync(`tmux capture-pane -p -t "${sessionName}" 2>/dev/null | tail -10`, { encoding: 'utf8' });
    const lines = out.split('\n')
      .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏│╭╰]/g, '').trim())
      .filter(l => l.length > 2);
    return lines[lines.length - 1]?.slice(0, 60) || '';
  } catch { return ''; }
}

// tmux 패널 마지막 줄로 상태 파악
function getTmuxPaneStatus(sessionName) {
  try {
    const out = execSync(`tmux capture-pane -p -t "${sessionName}" 2>/dev/null | tail -5`, { encoding: 'utf8' });
    const lines = out.trim().split('\n').filter(l => l.trim());
    if (!lines.length) return 'idle';
    const last = lines[lines.length - 1];
    // Claude Code 스피너 문자들
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last)) return 'thinking';
    // 스트리밍 중 (│ 박스 문자)
    if (/[│╭╰]/.test(last)) return 'streaming';
    // 입력 프롬프트 대기
    if (/[>❯]\s*$/.test(last) || last.includes('?') ) return 'idle';
    return 'active';
  } catch {
    return 'unknown';
  }
}

// 전체 세션 목록 조합
function getSessions() {
  const processes = getClaudeProcesses();
  const tmuxPanes = getTmuxSessions();

  const sessions = [];

  for (const proc of processes) {
    // tmux 세션인지 확인 (tmux pane pid 또는 ppid 매칭)
    const tmuxMatch = tmuxPanes.find(t => t.pid === proc.pid || t.pid === proc.ppid);

    let name, path, type, status;

    if (tmuxMatch) {
      name = tmuxMatch.session;
      path = tmuxMatch.path;
      type = 'tmux';
      const paneStatus = getTmuxPaneStatus(tmuxMatch.session);
      if (proc.cpu > 15) status = 'thinking';
      else if (paneStatus === 'thinking' || paneStatus === 'streaming') status = 'thinking';
      else if (paneStatus === 'active') status = 'waiting';
      else status = 'idle';
    } else {
      // 일반 터미널 세션
      const ttyLabel = proc.tty !== '??' ? proc.tty : 'unknown';
      path = getCwdByPid(proc.pid) || '';
      name = path ? path.split('/').pop() || path : `Terminal (${ttyLabel})`;
      type = 'terminal';
      // TTY 저장 (포커스용)
      proc.ttyFull = proc.tty !== '??' ? `/dev/tty${proc.tty}` : null;

      if (proc.cpu > 15) status = 'thinking';
      else if (proc.cpu > 1) status = 'waiting';
      else status = 'idle';
    }

    // telegram bot 등 특수 세션 필터
    if (name === 'goagent-telegram' || proc.command.includes('--channels')) continue;

    sessions.push({
      pid: proc.pid,
      name,
      path,
      type,
      status,
      cpu: proc.cpu,
      tty: proc.ttyFull || proc.tty,
      tmuxSession: tmuxMatch ? tmuxMatch.session : null,
      ...(tmuxMatch ? { lastLine: getTmuxLastLine(tmuxMatch.session) } : {}),
    });
  }

  // 중복 제거 (같은 tmux 세션)
  const seen = new Set();
  return sessions.filter(s => {
    const key = s.tmuxSession || s.pid;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { getSessions };
