const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  onSessionsUpdate: (cb) => ipcRenderer.on('sessions-update', (_, data) => cb(data)),
  onWindowShown: (cb) => ipcRenderer.on('window-shown', () => cb()),
  hide: () => ipcRenderer.send('hide-window'),
  launch: (sessionName, message) => ipcRenderer.send('launch-session', { sessionName, message }),
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
  ptyInput: (key, data) => ipcRenderer.send('pty-input', { key, data }),
  ptyResize: (key, cols, rows) => ipcRenderer.send('pty-resize', { key, cols, rows }),
  closePty: (key) => ipcRenderer.send('close-pty', key),
  closeAllPty: () => ipcRenderer.send('close-all-pty'),

  // 윈도우 모드 전환
  setLauncherMode: () => ipcRenderer.send('set-launcher-mode'),
  setTerminalMode: () => ipcRenderer.send('set-terminal-mode'),
});
