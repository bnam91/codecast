const { app, BrowserWindow, globalShortcut, ipcMain, screen, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { getSessions } = require('./lib/sessions');
const { launchNewSession, focusTerminalTty, focusTmuxSession, sendToSession } = require('./lib/launcher');

let win = null;
let pollInterval = null;
let tray = null;

// pty 세션 관리
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('node-pty 로드 실패:', e.message);
}
const ptySessions = new Map(); // sessionId → ptyProcess

async function checkForUpdates(mainWindow) {
  try {
    const { default: ReleaseUpdater } = await import('./submodules/module_update_auto/release_updater.js');
    const { default: updateConfig } = await import('./submodules/module_update_auto/config.js');
    const updater = new ReleaseUpdater('bnam91', 'codecast', updateConfig.versionFile);
    const current = updater.getCurrentVersion();
    const latest = await updater.getLatestRelease();
    if (!latest || current === latest.tag_name) return;

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '업데이트 알림',
      message: `새 버전이 있습니다: ${latest.tag_name}`,
      detail: `현재: ${current ?? '없음'}\n\n업데이트 후 앱을 재시작하세요.`,
      buttons: ['지금 업데이트', '나중에'],
      defaultId: 0,
    });

    if (response === 0) {
      await updater.performUpdate(latest);
      const { response: restartRes } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '업데이트 완료',
        message: `${latest.tag_name} 업데이트가 완료됐습니다.`,
        detail: '지금 앱을 재시작할까요?',
        buttons: ['지금 재시작', '나중에'],
        defaultId: 0,
      });
      if (restartRes === 0) {
        app.relaunch();
        app.exit(0);
      }
    }
  } catch (e) {
    console.error('업데이트 체크 오류:', e.message);
  }
}

function createTray() {
  // 16x16 흰색 사각형 PNG (base64) - templateImage: true 로 macOS 자동 스타일 적용
  const iconBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVQ4jWNgYGD4' +
    'TwABAAD//wMAAwAB/2gDHgAAAABJRU5ErkJggg==';
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${iconBase64}`);
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Claude Commander');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show/Hide',
      click: () => {
        if (win && win.isVisible()) {
          hideWindow();
        } else {
          showWindow();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      },
    },
  ]);

  tray.on('click', () => {
    if (win && win.isVisible()) {
      hideWindow();
    } else {
      showWindow();
    }
  });

  tray.on('right-click', () => {
    tray.popUpContextMenu(contextMenu);
  });
}

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
  sendSessions();  // 즉시 한 번 전송 (최대 800ms 대기 제거)
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

app.whenReady().then(async () => {
  createWindow();
  createTray();

  // 자동업데이트 체크
  checkForUpdates(win);

  // Option+Space 글로벌 단축키
  const registered = globalShortcut.register('Control+Shift+Space', () => {
    if (win && win.isVisible()) {
      hideWindow();
    } else {
      showWindow();
    }
  });
  console.log('Ctrl+Shift+Space 단축키 등록:', registered ? '성공' : '실패');
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  tray?.destroy();
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

ipcMain.on('launch-session', async (event, { sessionName, message }) => {
  // 동일 이름 세션 존재 여부 확인
  try {
    require('child_process').execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
    // 존재함 → 경고
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '세션 이미 존재',
      message: `"${sessionName}" 세션이 이미 실행 중입니다.`,
      detail: '덮어쓰면 기존 세션이 종료됩니다.',
      buttons: ['덮어쓰기', '취소'],
      defaultId: 1,
      cancelId: 1,
    });
    if (response === 1) return; // 취소
  } catch {
    // 세션 없음 → 그냥 진행
  }
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

// ── 세션 종료 ──────────────────────────────────────────────
const { execSync } = require('child_process');

ipcMain.on('kill-session', (_, { pid, tmuxSession }) => {
  try {
    if (tmuxSession) {
      execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`);
    } else if (pid) {
      process.kill(pid, 'SIGTERM');
    }
  } catch (e) {
    console.error('kill-session error:', e.message);
  }
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
