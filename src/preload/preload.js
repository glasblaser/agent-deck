// Ponte mínima entre a UI (sandbox) e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('deck', {
  state: invoke('state:get'),
  profiles: {
    add: invoke('profiles:add'),
    remove: invoke('profiles:remove'),
    setColor: invoke('profiles:setColor'),
    usage: invoke('profiles:usage'),
  },
  projects: {
    suggestSetup: invoke('projects:suggestSetup'),
    setSetup: invoke('projects:setSetup'),
    add: invoke('projects:add'),
    remove: invoke('projects:remove'),
    addWorkspace: invoke('projects:addWorkspace'),
    removeWorkspace: invoke('projects:removeWorkspace'),
    setPinned: invoke('projects:setPinned'),
  },
  git: {
    worktrees: invoke('git:worktrees'),
    rootStat: invoke('git:rootStat'),
    branches: invoke('git:branches'),
    createWorktree: invoke('git:createWorktree'),
    removeWorktree: invoke('git:removeWorktree'),
    diff: invoke('git:diff'),
    diffFile: invoke('git:diffFile'),
    conclude: invoke('git:conclude'),
    concludeInfo: invoke('git:concludeInfo'),
    finishTask: invoke('git:finishTask'),
  },
  agents: {
    recent: invoke('agents:recent'),
    dismiss: invoke('agents:dismiss'),
  },
  tasks: {
    addBacklog: invoke('tasks:addBacklog'),
    updateBacklog: invoke('tasks:updateBacklog'),
    removeBacklog: invoke('tasks:removeBacklog'),
    removeDone: invoke('tasks:removeDone'),
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
  window: {
    notify: (title, body, tabId) => ipcRenderer.send('window:notify', { title, body, tabId }),
    onOpenTab: (fn) => ipcRenderer.on('window:openTab', (_e, tabId) => fn(tabId)),
  },
  open: {
    vscode: invoke('open:vscode'),
    external: invoke('open:external'),
    folder: invoke('open:folder'),
  },
});
