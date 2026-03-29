const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  onSessionsUpdate: (cb) => ipcRenderer.on('sessions-update', (_, data) => cb(data)),
  onWindowShown: (cb) => ipcRenderer.on('window-shown', () => cb()),
  hide: () => ipcRenderer.send('hide-window'),
  launch: (sessionName, message, launchMode) => ipcRenderer.send('launch-session', { sessionName, message, launchMode }),
  onLaunchSessionInApp: (cb) => ipcRenderer.on('launch-session-inapp', (_, session) => cb(session)),
  focusSession: (session) => ipcRenderer.send('focus-session', session),
  sendToSession: (session, message) => ipcRenderer.send('send-to-session', { session, message }),

  // blur 처리: 런처 모드일 때만 숨김
  blurHideIfLauncher: () => ipcRenderer.send('blur-hide-if-launcher'),
  onCheckTermModeForBlur: (cb) => ipcRenderer.on('check-term-mode-for-blur', () => cb()),

  // PTY
  openPty: (session) => ipcRenderer.send('open-pty', session),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_, d) => cb(d)),
  onPtyReady: (cb) => ipcRenderer.on('pty-ready', (_, key) => cb(key)),
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', (_, key) => cb(key)),
  onPtyError: (cb) => ipcRenderer.on('pty-error', (_, msg) => cb(msg)),
  onPtyHistory: (cb) => ipcRenderer.on('pty-history', (_, d) => cb(d)),
  ptyInput: (key, data) => ipcRenderer.send('pty-input', { key, data }),
  ptyResize: (key, cols, rows) => ipcRenderer.send('pty-resize', { key, cols, rows }),
  closePty: (key) => ipcRenderer.send('close-pty', key),
  closeAllPty: () => ipcRenderer.send('close-all-pty'),

  // 윈도우 모드 전환
  setLauncherMode: () => ipcRenderer.send('set-launcher-mode'),
  setTerminalMode: () => ipcRenderer.send('set-terminal-mode'),

  // 세션 종료
  killSession: (session) => ipcRenderer.send('kill-session', session),
  confirmKill: (name) => ipcRenderer.invoke('confirm-kill', name),

  // 투명도
  setOpacity: (alpha) => ipcRenderer.send('set-opacity', alpha),

  // 클립보드
  writeClipboard: (text) => navigator.clipboard.writeText(text),

  // 설정
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),

  // 외부 터미널로 열기
  openInTerminal: (session) => ipcRenderer.send('open-in-terminal', session),
});
