const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const path = require('path');
const { getSessions } = require('./lib/sessions');
const { launchNewSession, focusTerminalTty, focusTmuxSession, sendToSession } = require('./lib/launcher');
const pty = require('node-pty');

let win = null;
let pollInterval = null;
let currentPty = null;

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
    hideWindow();
  });
}

function showWindow() {
  if (!win) return;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win.setPosition(Math.floor((width - 680) / 2), Math.floor(height * 0.2));
  win.show();
  win.focus();
  win.webContents.send('window-shown');
  startPolling();
}

function hideWindow() {
  if (!win) return;
  // pty 종료
  if (currentPty) {
    currentPty.kill();
    currentPty = null;
  }
  win.hide();
  // 창 크기 원래대로 복원
  win.setSize(680, 480, false);
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

  // Alt+Space 글로벌 단축키
  globalShortcut.register('Alt+Space', () => {
    if (win && win.isVisible()) {
      hideWindow();
    } else {
      showWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (e) => {
  e.preventDefault(); // 창 닫혀도 앱 종료 안 함
});

// IPC 핸들러

ipcMain.on('hide-window', () => hideWindow());

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

// PTY IPC 핸들러

ipcMain.on('open-pty', (event, session) => {
  if (currentPty) { currentPty.kill(); currentPty = null; }

  const cols = 90, rows = 18;
  const shell = process.env.SHELL || '/bin/zsh';
  const args = session.tmuxSession
    ? ['-c', `tmux attach -t "${session.tmuxSession}"`]
    : [];

  currentPty = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: session.path || process.env.HOME,
    env: process.env,
  });

  currentPty.onData(data => {
    if (win) win.webContents.send('pty-data', data);
  });
  currentPty.onExit(() => {
    if (win) win.webContents.send('pty-exit');
    currentPty = null;
  });
});

ipcMain.on('pty-input', (_, data) => {
  if (currentPty) currentPty.write(data);
});

ipcMain.on('pty-resize', (_, { cols, rows }) => {
  if (currentPty) currentPty.resize(cols, rows);
});

ipcMain.on('close-pty', () => {
  if (currentPty) { currentPty.kill(); currentPty = null; }
});

ipcMain.on('resize-window', (_, height) => {
  if (!win) return;
  win.setSize(680, height, true);
});
