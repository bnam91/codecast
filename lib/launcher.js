const { exec, execSync } = require('child_process');
const path = require('path');

// 새 tmux 세션 시작 (cctms 방식) + 첫 메시지 전송
function launchNewSession(sessionName, message) {
  const claudePath = execSync('which claude', { encoding: 'utf8' }).trim();

  // 동일 이름 세션 있으면 kill
  try { execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`); } catch {}

  // tmux 세션 생성 (TERM_NAME 환경변수 포함, cctms와 동일)
  execSync(`tmux new-session -d -s "${sessionName}" "export TERM_NAME='${sessionName}' && ${claudePath} --dangerously-skip-permissions --teammate-mode tmux"`);

  // Terminal.app에서 해당 tmux 세션 열기
  const fs = require('fs');
  const script = `
tell application "Terminal"
  activate
  do script "tmux attach -t '${sessionName}'"
end tell
`;
  const tmp = `/tmp/cc_launch_${Date.now()}.applescript`;
  fs.writeFileSync(tmp, script);
  try { exec(`osascript ${tmp}`); } catch {}

  // claude 시작 대기 후 첫 메시지 전송
  if (message && message.trim()) {
    setTimeout(() => {
      sendToSession(sessionName, message);
    }, 3500);
  }

  return sessionName;
}

// tmux 세션에 메시지 전송
function sendToSession(sessionName, message) {
  const escaped = message.replace(/'/g, "'\\''");
  execSync(`tmux send-keys -t "${sessionName}" '${escaped}' Enter`);
}

// Terminal.app 특정 탭으로 포커스 (TTY 기반)
function focusTerminalByTty(ttyPath) {
  const script = `
tell application "Terminal"
  set targetTTY to "${ttyPath}"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t = targetTTY then
        set selected tab of w to t
        set frontmost of w to true
        activate
        return
      end if
    end repeat
  end repeat
end tell
`;
  try {
    execSync(`osascript -e '${script.replace(/'/g, `'\\''`)}'`);
  } catch (e) {
    // fallback: osascript heredoc
    const fs = require('fs');
    const tmp = `/tmp/cc_focus_${Date.now()}.applescript`;
    fs.writeFileSync(tmp, script);
    try { execSync(`osascript ${tmp}`); } finally { fs.unlinkSync(tmp); }
  }
}

// TTY 기반 포커스 (sessions.js에서 전달받은 tty 값 처리)
function focusTerminalTty(tty) {
  const ttyPath = tty.startsWith('/dev/') ? tty : `/dev/tty${tty}`;
  focusTerminalByTty(ttyPath);
}

// tmux 세션으로 포커스 이동
function focusTmuxSession(sessionName) {
  // 해당 tmux 세션에 붙어있는 클라이언트 TTY 조회
  let clientTty = null;
  try {
    clientTty = execSync(`tmux list-clients -t "${sessionName}" -F "#{client_tty}" 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {}

  if (clientTty && clientTty.startsWith('/dev/')) {
    // 클라이언트가 붙어있는 탭으로 바로 이동
    focusTerminalByTty(clientTty);
  } else {
    // 클라이언트 없음 → Terminal.app에서 새 탭으로 attach
    const script = `
tell application "Terminal"
  activate
  do script "tmux attach -t '${sessionName}'"
end tell
`;
    const fs = require('fs');
    const tmp = `/tmp/cc_tmux_${Date.now()}.applescript`;
    fs.writeFileSync(tmp, script);
    try { execSync(`osascript ${tmp}`); } finally { fs.unlinkSync(tmp); }
    return;
  }

  // 탭 포커스 후 tmux 세션 전환
  try {
    execSync(`tmux switch-client -t "${sessionName}" 2>/dev/null`);
  } catch {}
}

// 앱 내 터미널 모드로 새 세션 시작 (Terminal.app 없이)
function launchNewSessionInApp(sessionName, message) {
  const claudePath = execSync('which claude', { encoding: 'utf8' }).trim();

  // 동일 이름 세션 있으면 kill
  try { execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`); } catch {}

  // tmux 세션 생성 (Terminal.app 없이)
  execSync(`tmux new-session -d -s "${sessionName}" "export TERM_NAME='${sessionName}' && ${claudePath} --dangerously-skip-permissions --teammate-mode tmux"`);

  // claude 시작 대기 후 첫 메시지 전송
  if (message && message.trim()) {
    setTimeout(() => sendToSession(sessionName, message), 3500);
  }

  return {
    name: sessionName,
    tmuxSession: sessionName,
    type: 'tmux',
    status: 'thinking',
    path: process.env.HOME || '',
    pid: null,
  };
}

module.exports = { launchNewSession, launchNewSessionInApp, sendToSession, focusTerminalTty, focusTmuxSession };
