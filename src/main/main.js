// Processo principal: janela, protocolo app:// e todos os handlers IPC.
// O renderer roda em sandbox, sem Node; tudo que toca disco, rede ou processo passa por aqui.
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, screen } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const store = require('./store');
const ptys = require('./pty');
const usage = require('./usage');
const git = require('./git');
const files = require('./files');

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
    },
  });
  if (process.env.AGENT_DECK_SMOKE) require('./smoke')(app, win, process.env.AGENT_DECK_SMOKE);
  win.loadURL('app://deck/renderer/index.html');
  ptys.attach(win.webContents);
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
  handle('profiles:usage', (id, force) => usage.forProfile(store.profile(id), force));

  handle('projects:add', async () => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return null;
    return store.addProject(result.filePaths[0]);
  });
  handle('projects:remove', (id) => store.removeProject(id));

  handle('git:worktrees', (projectPath) => git.listWorktrees(store.requireProjectPath(projectPath)));
  handle('git:createWorktree', async (projectPath, taskName) => {
    const created = await git.createWorktree(store.requireProjectPath(projectPath), taskName);
    return created;
  });
  handle('git:removeWorktree', (projectPath, worktreePath) =>
    git.removeWorktree(store.requireProjectPath(projectPath), worktreePath));

  handle('pty:spawn', (opts) => {
    const profile = opts.profileId ? store.profile(opts.profileId) : null;
    return ptys.spawn({ ...opts, cwd: store.requireCwd(opts.cwd), profile });
  });
  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:kill', (_e, id) => ptys.kill(id));

  handle('fs:list', (dir) => files.list(store.requireAllowedPath(dir)));
  handle('fs:read', (file) => files.read(store.requireAllowedPath(file)));
  handle('fs:write', (file, content) => files.write(store.requireAllowedPath(file), content));

  handle('open:vscode', (dir) => {
    const target = store.requireAllowedPath(dir);
    require('node:child_process').spawn('code', [`"${target}"`], { shell: true, detached: true, stdio: 'ignore' }).unref();
  });
  handle('open:external', (url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

// Teste usa estado próprio, para não mexer no seu state.json.
if (process.env.AGENT_DECK_SMOKE) app.setPath('userData', path.join(process.env.AGENT_DECK_SMOKE, 'userData'));

app.whenReady().then(() => {
  protocol.handle('app', serveApp);
  store.load(app.getPath('userData'));
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => {
  ptys.killAll();
  app.quit();
});
