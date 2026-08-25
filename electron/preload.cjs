const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between Kiln and the desktop shell. Everything is a named
 * channel — the renderer never sees ipcRenderer or Node.
 */
contextBridge.exposeInMainWorld('kilnDesktop', {
  platform: process.platform,
  /** Hand the shell the command registry so it can build the native menu. */
  registerCommands: (commands) => ipcRenderer.send('kiln:register-commands', commands),
  onCommand: (fn) => ipcRenderer.on('kiln:command', (_e, id) => fn(id)),
  onShowShortcuts: (fn) => ipcRenderer.on('kiln:shortcuts', () => fn()),
  onOpenFile: (fn) => ipcRenderer.on('kiln:open-file', (_e, file) => fn(file)),
  saveFile: (defaultName, data, binary) =>
    ipcRenderer.invoke('kiln:save-file', { defaultName, data, binary: !!binary }),
  openScene: () => ipcRenderer.invoke('kiln:open-scene'),
});
