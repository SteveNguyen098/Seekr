const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("seekr", {
  pickResume: () => ipcRenderer.invoke("pick-resume"),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
  run: (opts) => ipcRenderer.invoke("run", opts),
  sendEnter: () => ipcRenderer.invoke("send-enter"),
  stop: () => ipcRenderer.invoke("stop"),
  on: (channel, cb) => {
    const allowed = ["run-started", "run-output", "run-awaiting-input", "run-finished"];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
