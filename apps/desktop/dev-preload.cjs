// Electron's sandboxed preload provides its bridge through CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("continuumDevUpdate", {
    subscribe(listener) {
      const receive = (_event, state) => listener(state);
      ipcRenderer.on("dev-update:state", receive);
      ipcRenderer.send("dev-update:subscribe");
      return () => {
        ipcRenderer.removeListener("dev-update:state", receive);
      };
    },
    requestRestart: () => ipcRenderer.invoke("dev-update:request"),
  });
}
