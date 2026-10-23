// Processo principal: janela, protocolo app:// e todos os handlers IPC.
// O renderer roda em sandbox, sem Node; tudo que toca disco, rede ou processo passa por aqui.
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, screen, Notification } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const store = require('./store');
const ptys = require('./pty');
const usage = require('./usage');
const git = require('./git');
const files = require('./files');
const agents = require('./agents');

const ROOT = path.join(__dirname, '..', '..');

// Só estes diretórios são servidos pelo app://. Nada fora deles é acessível ao renderer.
const SERVED = {
  renderer: path.join(ROOT, 'src', 'renderer'),
  xterm: path.join(ROOT, 'node_modules', '@xterm', 'xterm'),
  'xterm-fit': path.join(ROOT, 'node_modules', '@xterm', 'addon-fit'),
  monaco: path.join(ROOT, 'node_modules', 'monaco-editor', 'min'),
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Tudo numa origem só (app://deck/<pasta>/...), senão os imports de módulo esbarram em CORS.
function serveApp(request) {
  const url = new URL(request.url);
  const [, mount, ...rest] = decodeURIComponent(url.pathname).split('/');
  const base = url.host === 'deck' && SERVED[mount];
  if (!base) return new Response('not found', { status: 404 });
  const target = path.normalize(path.join(base, ...rest));
  if (!target.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
  return net.fetch(pathToFileURL(target).toString());
}

let win;
// Notificações abertas: sem referência, o coletor de lixo some com elas antes do clique.
const notes = new Set();
// Ao fechar, os terminais morrem um a um e a UI tentaria salvar abas "encerradas"; a partir daqui, nada é salvo.
let closing = false;

function createWindow() {
  // Cabe na área útil do monitor: com escala de 125-150% no Windows, 1500 px lógicos passam da tela.
  const area = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1500, area.width),
    height: Math.min(920, area.height),
    backgroundColor: '#14161a',
    title: 'Agent Deck',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // No teste de fumaça a janela costuma ficar atrás de outras; sem isso o Chromium pausa
      // a renderização (ResizeObserver, requestAnimationFrame) e o teste mede um estado congelado.
      backgroundThrottling: !process.env.AGENT_DECK_SMOKE,
    },
  });
  if (process.env.AGENT_DECK_SMOKE) require('./smoke')(app, win, process.env.AGENT_DECK_SMOKE);
  win.loadURL('app://deck/renderer/index.html');
  ptys.attach(win.webContents);
  win.on('close', () => { closing = true; });
  win.on('focus', () => win.flashFrame(false));
}

// O navegador embutido (<webview>) nunca recebe preload nem Node, e popups
// abrem no próprio webview em vez de criar janelas novas.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_ev, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^https?:/.test(params.src || 'about:blank') && params.src !== 'about:blank') {
      params.src = 'about:blank';
    }
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
  }
  // A janela principal nunca navega para fora do app://.
  if (contents.getType() === 'window') {
    contents.on('will-navigate', (ev, url) => {
      if (!url.startsWith('app://')) ev.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
});

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => fn(...args));
}

function registerIpc() {
  handle('state:get', () => store.publicState());

  handle('profiles:add', (input) => store.addProfile(input));
  handle('profiles:remove', (id) => store.removeProfile(id));
  handle('profiles:setColor', (id, color) => store.setProfileColor(id, color));
  handle('profiles:usage', (id, force) => usage.forProfile(store.profile(id), force));

  handle('projects:add', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return store.addProject(result.filePaths[0]);
  });
  handle('projects:remove', (id) => store.removeProject(id));

  handle('git:worktrees', (projectPath) => git.listWorktrees(store.requireProjectPath(projectPath)));
  handle('git:branches', (projectPath) => git.branches(store.requireProjectPath(projectPath)));
  // A lista do que copiar vem da configuração do projeto, nunca do renderer: ele só diz se quer preparar.
  handle('git:createWorktree', (projectPath, taskName, opts = {}) => {
    const project = store.requireProjectPath(projectPath);
    return git.createWorktree(project, taskName, {
      base: opts.base, briefing: opts.briefing, copy: opts.prepare ? store.setupCopyFor(project) : [],
    });
  });
  handle('projects:suggestSetup', (projectPath) => git.suggestSetup(store.requireProjectPath(projectPath)));
  handle('projects:setSetup', (projectId, setup) => store.setProjectSetup(projectId, setup));
  handle('git:removeWorktree', (projectPath, worktreePath) =>
    git.removeWorktree(store.requireProjectPath(projectPath), worktreePath));
  handle('git:diff', (projectPath, worktreePath) => git.diff(store.requireProjectPath(projectPath), worktreePath));
  handle('git:diffFile', (projectPath, worktreePath, mergeBase, file) =>
    git.diffFile(store.requireProjectPath(projectPath), worktreePath, mergeBase, file));
  handle('git:conclude', async (projectPath, worktreePath, opts) => {
    const project = store.requireProjectPath(projectPath);
    const result = await git.conclude(project, worktreePath, opts);
    if (result.mode !== 'nothing') store.recordDone(project, result);
    return result;
  });
  handle('tasks:addBacklog', (item) => store.addBacklog(item || {}));
  handle('agents:recent', () => agents.recentConversations(store.publicState().profiles, (dir) => {
    try {
      return !!store.requireAllowedPath(dir);
    } catch {
      return false;
    }
  }));
  handle('tasks:updateBacklog', (id, item) => store.updateBacklog(id, item || {}));
  handle('tasks:removeBacklog', (id) => store.removeBacklog(id));
  handle('tasks:removeDone', (id) => store.removeDone(id));
  handle('git:finishTask', (projectPath, worktreePath) => git.finishTask(store.requireProjectPath(projectPath), worktreePath));

  handle('pty:spawn', (opts) => {
    const profile = opts.profileId ? store.profile(opts.profileId) : null;
    const cwd = store.requireCwd(opts.cwd);
    // Comando de preparo: o que você configurou no projeto dono dessa worktree, nunca texto do renderer.
    return ptys.spawn({ ...opts, cwd, profile, setupCommand: opts.prepare ? store.setupCommandFor(cwd) : null });
  });
  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:kill', (_e, id) => ptys.kill(id));

  handle('session:load', () => store.getSession());
  ipcMain.on('session:save', (_e, session) => {
    if (!closing) store.saveSession(session);
  });

  handle('fs:list', (dir) => files.list(store.requireAllowedPath(dir)));
  handle('fs:read', (file) => files.read(store.requireAllowedPath(file)));
  handle('fs:write', (file, content) => files.write(store.requireAllowedPath(file), content));

  handle('open:vscode', (dir) => {
    const target = store.requireAllowedPath(dir);
    require('node:child_process').spawn('code', [`"${target}"`], { shell: true, detached: true, stdio: 'ignore' }).unref();
  });
  // Agente pedindo atenção com o app em segundo plano: notificação do Windows e a barra de tarefas
  // piscando até a janela ganhar foco. Clicar na notificação traz o app e abre a aba (tabId).
  // Fica no main: no renderer (origem app://) a permissão de notificação vem negada.
  ipcMain.on('window:notify', (_e, { title, body, tabId } = {}) => {
    // Quem decide se o app está em segundo plano é o renderer (document.hasFocus); o isFocused daqui
    // continua true com a janela minimizada.
    if (!win || win.isDestroyed()) return;
    if (!win.isFocused() || win.isMinimized()) win.flashFrame(true);
    if (!Notification.isSupported()) return;
    const note = new Notification({ title: String(title || 'Agent Deck').slice(0, 120), body: String(body || '').slice(0, 300) });
    notes.add(note);
    note.on('close', () => notes.delete(note));
    note.on('click', () => {
      notes.delete(note);
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.focus();
      if (Number.isInteger(tabId)) win.webContents.send('window:openTab', tabId);
    });
    note.show();
  });
  handle('open:external', (url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

// Teste usa estado próprio, para não mexer no seu state.json.
if (process.env.AGENT_DECK_SMOKE) app.setPath('userData', path.join(process.env.AGENT_DECK_SMOKE, 'userData'));

// Sem isso as notificações do Windows saem como "electron.app.Electron".
app.setAppUserModelId('Agent Deck');

app.whenReady().then(() => {
  // Ditado (Wispr Flow e afins) escreve no campo focado via UI Automation. Sem isso o Chromium só liga
  // a acessibilidade quando acha um leitor de tela, e para o Windows o campo focado é um "Pane" sem texto.
  app.setAccessibilitySupportEnabled(true);
  protocol.handle('app', serveApp);
  store.load(app.getPath('userData'));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  ptys.killAll();
  app.quit();
});
