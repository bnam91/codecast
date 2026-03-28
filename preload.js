const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cc', {
  onSessionsUpdate: (cb) => ipcRenderer.on('sessions-update', (_, data) => cb(data)),
  onWindowShown: (cb) => ipcRenderer.on('window-shown', () => cb()),
  hide: () => ipcRenderer.send('hide-window'),
  launch: (sessionName, message) => ipcRenderer.send('launch-session', { sessionName, message }),
  focusSession: (session) => ipcRenderer.send('focus-session', session),
  sendToSession: (session, message) => ipcRenderer.send('send-to-session', { session, message }),
});
