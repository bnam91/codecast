const { app, BrowserWindow, globalShortcut, ipcMain, screen, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { execSync } = require('child_process');
const { getSessions } = require('./lib/sessions');
const { launchNewSession, launchNewSessionInApp, focusTerminalTty, focusTmuxSession, sendToSession } = require('./lib/launcher');
const { getSettings, setSetting } = require('./lib/settings');

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
    vibrancy: 'under-window',   // macOS 네이티브 블러 (창 뒤 배경 블러)
    alwaysOnTop: false,
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
  // 현재 스페이스에 나타나도록 (다른 데스크탑으로 이동하지 않음)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.show();
  win.focus();
  win.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true });
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
  pollInterval = setInterval(sendSessions, 2000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

let sendingInProgress = false;

async function sendSessions() {
  if (!win || !win.isVisible() || sendingInProgress) return;
  sendingInProgress = true;
  try {
    const sessions = await getSessions();
    if (win && win.isVisible()) win.webContents.send('sessions-update', sessions);
  } catch (e) {
    console.error('sessions error:', e);
  } finally {
    sendingInProgress = false;
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
ipcMain.on('show-window', () => showWindow());

// 런처 모드에서 blur 처리: renderer에서 현재 모드를 알려줌
ipcMain.on('blur-hide-if-launcher', () => {
  hideWindow();
});

ipcMain.on('launch-session', async (event, { sessionName, message, launchMode }) => {
  // 동일 이름 세션 존재 여부 확인
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
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
    try { execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`); } catch {}
  } catch {
    // 세션 없음 → 그냥 진행
  }

  const mode = launchMode || getSettings().launchMode;

  if (mode === 'inapp') {
    try {
      const sessionDescriptor = launchNewSessionInApp(sessionName, message);
      win.webContents.send('launch-session-inapp', sessionDescriptor);
    } catch (e) {
      dialog.showErrorBox('세션 생성 실패', e.message);
    }
  } else {
    hideWindow();
    launchNewSession(sessionName, message);
  }
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
  // tmux mouse off → xterm에서 텍스트 드래그 선택 가능하게
  const args = session.tmuxSession
    ? ['-c', `/usr/local/bin/tmux set -g mouse off 2>/dev/null; /usr/local/bin/tmux attach -t "${session.tmuxSession}"`]
    : [];

  // tmux 히스토리 사전 전송 (scrollback 용)
  if (session.tmuxSession) {
    try {
      const history = execSync(
        `tmux capture-pane -p -t "${session.tmuxSession}" -S -500 2>/dev/null`,
        { encoding: 'utf8', timeout: 2000 }
      );
      if (history.trim()) {
        // 히스토리를 pty-ready 전에 미리 보내두기 위해 key를 임시 등록
        // renderer에서 onPtyReady 후 처리하도록 history 이벤트 전송
        win.webContents.send('pty-history', { key, data: history });
      }
    } catch (e) { /* 히스토리 없으면 무시 */ }
  }

  try {
    const p = pty.spawn(shell, args, {
      name: 'xterm-256color', cols, rows,
      cwd: session.path || process.env.HOME,
      env: { ...process.env, LANG: 'ko_KR.UTF-8', LC_ALL: 'ko_KR.UTF-8', TERM: 'xterm-256color' },
    });
    ptySessions.set(key, p);
    p.onData(data => {
      // 마우스 리포팅 활성화 시퀀스 필터링 → tmux.conf mouse on이 있어도 xterm에서 텍스트 선택 가능
      const filtered = data
        .replace(/\x1b\[\?1000h/g, '').replace(/\x1b\[\?1000l/g, '')
        .replace(/\x1b\[\?1002h/g, '').replace(/\x1b\[\?1002l/g, '')
        .replace(/\x1b\[\?1003h/g, '').replace(/\x1b\[\?1003l/g, '')
        .replace(/\x1b\[\?1006h/g, '').replace(/\x1b\[\?1006l/g, '')
        .replace(/\x1b\[\?1015h/g, '').replace(/\x1b\[\?1015l/g, '');
      if (win) win.webContents.send('pty-data', { key, data: filtered });
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

// ── 외부 터미널로 세션 열기 ─────────────────────────────────
ipcMain.on('open-in-terminal', (_, session) => {
  const tmux = session.tmuxSession;
  if (!tmux) return;
  const cmd = `tmux attach -t \\"${tmux}\\"`;
  try {
    // iTerm 존재 확인
    const itermId = execSync(`osascript -e 'id of application "iTerm"' 2>/dev/null`).toString().trim();
    if (itermId) {
      execSync(`osascript -e 'tell application "iTerm"
        activate
        set newWin to (create window with default profile)
        tell current session of newWin
          write text "${cmd}"
        end tell
      end tell'`);
      return;
    }
  } catch {}
  try {
    execSync(`osascript -e 'tell application "Terminal"
      activate
      do script "${cmd}"
    end tell'`);
  } catch (e) {
    console.error('open-in-terminal error:', e.message);
  }
});

// ── 세션 종료 ──────────────────────────────────────────────
ipcMain.handle('confirm-kill', async (_, name) => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '세션 종료',
    message: `"${name}" 세션을 종료하시겠습니까?`,
    buttons: ['종료', '취소'],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
});

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

// ── 설정 ──────────────────────────────────────────────────
ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('set-setting', (_, key, value) => setSetting(key, value));

// ── 윈도우 크기 모드 전환 ──────────────────────────────────

ipcMain.on('set-opacity', (_, alpha) => {
  if (win) win.setOpacity(Math.max(0.1, Math.min(1.0, alpha)));
});

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
