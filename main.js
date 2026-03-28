const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { getSessions } = require('./lib/sessions');
const { launchNewSession, focusTerminalTty, focusTmuxSession, sendToSession } = require('./lib/launcher');

let win = null;
let pollInterval = null;

// pty 세션 관리
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('node-pty 로드 실패:', e.message);
}
const ptySessions = new Map(); // sessionId → ptyProcess

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 680,
    height: 480,
    x: Math.floor((width - 680) / 2),
    y: Math.floor(height * 0.2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile('index.html');

  win.on('blur', () => {
    // 터미널 모드일 때는 blur로 숨기지 않음
    // 런처 모드일 때만 숨김
    win.webContents.send('check-term-mode-for-blur');
  });
}

function showWindow() {
  if (!win) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win.setPosition(Math.floor((width - 680) / 2), Math.floor(height * 0.2));
  win.setSize(680, 480, false);
  win.show();
  win.focus();
  win.webContents.send('window-shown');
  startPolling();
}

function hideWindow() {
  if (!win) return;
  win.hide();
  stopPolling();
}

function startPolling() {
  if (pollInterval) return;
  // 즉시 한번 전송
  sendSessions();
  pollInterval = setInterval(sendSessions, 800);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function sendSessions() {
  if (!win || !win.isVisible()) return;
  try {
    const sessions = getSessions();
    win.webContents.send('sessions-update', sessions);
  } catch (e) {
    console.error('sessions error:', e);
  }
}

app.whenReady().then(() => {
  createWindow();

  // Ctrl+Shift+Space 글로벌 단축키
  globalShortcut.register('Ctrl+Shift+Space', () => {
    if (win && win.isVisible()) {
      hideWindow();
    } else {
      showWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // 모든 pty 종료
  ptySessions.forEach(p => { try { p.kill(); } catch(e) {} });
  ptySessions.clear();
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // 창 닫혀도 앱 종료 안 함
});

// IPC 핸들러

ipcMain.on('hide-window', () => hideWindow());

// 런처 모드에서 blur 처리: renderer에서 현재 모드를 알려줌
ipcMain.on('blur-hide-if-launcher', () => {
  hideWindow();
});

ipcMain.on('launch-session', (event, { sessionName, message }) => {
  hideWindow();
  launchNewSession(sessionName, message);
});

ipcMain.on('focus-session', (event, session) => {
  hideWindow();
  if (session.type === 'tmux' && session.tmuxSession) {
    focusTmuxSession(session.tmuxSession);
  } else if (session.tty) {
    focusTerminalTty(session.tty);
  }
});

ipcMain.on('send-to-session', (event, { session, message }) => {
  if (session.tmuxSession) {
    sendToSession(session.tmuxSession, message);
  }
  hideWindow();
});

// ── PTY IPC ──────────────────────────────────────────────

ipcMain.on('open-pty', (event, session) => {
  if (!pty) {
    win.webContents.send('pty-error', 'node-pty를 로드할 수 없습니다');
    return;
  }
  const key = session.tmuxSession || String(session.pid);
  if (ptySessions.has(key)) {
    win.webContents.send('pty-ready', key);
    return;
  }
  const cols = 120, rows = 30;
  const shell = '/bin/zsh';
  const args = session.tmuxSession ? ['-c', `tmux attach -t "${session.tmuxSession}"`] : [];

  try {
    const p = pty.spawn(shell, args, {
      name: 'xterm-256color', cols, rows,
      cwd: session.path || process.env.HOME,
      env: process.env,
    });
    ptySessions.set(key, p);
    p.onData(data => {
      if (win) win.webContents.send('pty-data', { key, data });
    });
    p.onExit(() => {
      ptySessions.delete(key);
      if (win) win.webContents.send('pty-exit', key);
    });
    win.webContents.send('pty-ready', key);
  } catch (e) {
    console.error('pty spawn 실패:', e);
    win.webContents.send('pty-error', e.message);
  }
});

ipcMain.on('pty-input', (_, { key, data }) => {
  ptySessions.get(key)?.write(data);
});

ipcMain.on('pty-resize', (_, { key, cols, rows }) => {
  try { ptySessions.get(key)?.resize(cols, rows); } catch(e) {}
});

ipcMain.on('close-pty', (_, key) => {
  try { ptySessions.get(key)?.kill(); } catch(e) {}
  ptySessions.delete(key);
});

ipcMain.on('close-all-pty', () => {
  ptySessions.forEach(p => { try { p.kill(); } catch(e) {} });
  ptySessions.clear();
});

// ── 윈도우 크기 모드 전환 ──────────────────────────────────

ipcMain.on('set-launcher-mode', () => {
  if (!win) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win.setResizable(true);
  win.setSize(680, 480, true);
  win.setPosition(Math.floor((width - 680) / 2), Math.floor(height * 0.2), true);
  win.setResizable(false);
});

ipcMain.on('set-terminal-mode', () => {
  if (!win) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win.setResizable(true);
  win.setSize(1000, 680, true);
  win.setPosition(Math.floor((width - 1000) / 2), Math.floor(height * 0.15), true);
});
