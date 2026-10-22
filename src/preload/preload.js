// Ponte mínima entre a UI (sandbox) e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('deck', {
  state: invoke('state:get'),
  profiles: {
    add: invoke('profiles:add'),
    remove: invoke('profiles:remove'),
    usage: invoke('profiles:usage'),
  },
  projects: {
    add: invoke('projects:add'),
    remove: invoke('projects:remove'),
  },
  git: {
    worktrees: invoke('git:worktrees'),
    createWorktree: invoke('git:createWorktree'),
    removeWorktree: invoke('git:removeWorktree'),
  },
  pty: {
    spawn: invoke('pty:spawn'),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (fn) => ipcRenderer.on('pty:data', (_e, id, data) => fn(id, data)),
    onExit: (fn) => ipcRenderer.on('pty:exit', (_e, id, code) => fn(id, code)),
    onStatus: (fn) => ipcRenderer.on('agent:status', (_e, id, info) => fn(id, info)),
  },
  session: {
    load: invoke('session:load'),
    save: (session) => ipcRenderer.send('session:save', session),
  },
  fs: {
    list: invoke('fs:list'),
    read: invoke('fs:read'),
    write: invoke('fs:write'),
  },
  open: {
    vscode: invoke('open:vscode'),
    external: invoke('open:external'),
  },
});
