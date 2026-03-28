const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function getClaudeProcesses() {
  try {
    const { stdout } = await execAsync(
      `ps -ax -o pid=,ppid=,%cpu=,tty=,command= | grep -E "/claude| claude" | grep -v grep`,
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
      const command = parts.slice(4).join(' ');
      if (!command.includes('/claude') && !command.match(/^claude\s/) && !command.match(/bin\/claude/)) continue;
      if (command.includes('grep') || command.includes('ShipIt')) continue;
      results.push({ pid, ppid, cpu, tty, command });
    }
    return results;
  } catch { return []; }
}

async function getTmuxSessions() {
  try {
    const { stdout } = await execAsync(
      `tmux list-panes -a -F "#{session_name}|#{pane_pid}|#{pane_current_path}" 2>/dev/null`,
      { timeout: 2000 }
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
      { timeout: 2000 }
    );
    const rawLines = stdout.trim().split('\n').filter(l => l.trim());
    if (!rawLines.length) return { status: 'idle', lastLine: '' };

    const last = rawLines[rawLines.length - 1];
    let status;
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(last)) status = 'thinking';
    else if (/[│╭╰]/.test(last)) status = 'streaming';
    else if (/[>❯]\s*$/.test(last) || last.includes('?')) status = 'idle';
    else status = 'active';

    const cleanLines = rawLines
      .map(l => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏│╭╰]/g, '').trim())
      .filter(l => l.length > 2);
    const lastLine = cleanLines[cleanLines.length - 1]?.slice(0, 60) || '';

    return { status, lastLine };
  } catch {
    return { status: 'unknown', lastLine: '' };
  }
}

async function getSessions() {
  // ps + tmux list 병렬 실행
  const [processes, tmuxPanes] = await Promise.all([
    getClaudeProcesses(),
    getTmuxSessions(),
  ]);

  const matched = processes.map(proc => ({
    proc,
    tmuxMatch: tmuxPanes.find(t => t.pid === proc.pid || t.pid === proc.ppid),
  }));

  // 모든 tmux capture-pane 병렬 실행
  const tmuxNames = [...new Set(
    matched.filter(m => m.tmuxMatch).map(m => m.tmuxMatch.session)
  )];
  const paneInfos = await Promise.all(tmuxNames.map(name => getTmuxPaneInfo(name)));
  const paneInfoMap = Object.fromEntries(tmuxNames.map((name, i) => [name, paneInfos[i]]));

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
      path = '';
      name = `Terminal (${ttyLabel})`;
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
      tty: proc.ttyFull || proc.tty,
      tmuxSession: tmuxMatch ? tmuxMatch.session : null,
      ...(tmuxMatch ? { lastLine } : {}),
    });
  }

  return sessions;
}

module.exports = { getSessions };
