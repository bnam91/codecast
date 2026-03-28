const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  onSessionsUpdate: (cb) => ipcRenderer.on('sessions-update', (_, data) => cb(data)),
  onWindowShown: (cb) => ipcRenderer.on('window-shown', () => cb()),
  hide: () => ipcRenderer.send('hide-window'),
  launch: (sessionName, message) => ipcRenderer.send('launch-session', { sessionName, message }),
  focusSession: (session) => ipcRenderer.send('focus-session', session),
  sendToSession: (session, message) => ipcRenderer.send('send-to-session', { session, message }),
  // PTY (인라인 미리보기)
  openPty: (session) => ipcRenderer.send('open-pty', session),
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_, d) => cb(d)),
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', () => cb()),
  ptyInput: (data) => ipcRenderer.send('pty-input', data),
  ptyResize: (cols, rows) => ipcRenderer.send('pty-resize', { cols, rows }),
  closePty: () => ipcRenderer.send('close-pty'),
  resizeWindow: (h) => ipcRenderer.send('resize-window', h),
});
