const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("seekr", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  pickResume: () => ipcRenderer.invoke("pick-resume"),
  openPath: (p) => ipcRenderer.invoke("open-path", p),
  run: (opts) => ipcRenderer.invoke("run", opts),
  sendEnter: () => ipcRenderer.invoke("send-enter"),
  stop: () => ipcRenderer.invoke("stop"),
  reset: () => ipcRenderer.invoke("reset"),
  saveReport: (payload) => ipcRenderer.invoke("save-report", payload),
  on: (channel, cb) => {
    const allowed = [
      "queue-started",
      "job-started",
      "run-output",
      "run-awaiting-input",
      "job-finished",
      "queue-finished",
    ];
    if (allowed.includes(channel)) ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
