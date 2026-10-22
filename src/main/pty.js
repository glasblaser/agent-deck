// Terminais. Aqui se decide shell, ambiente da conta e comando; quem roda o ConPTY
// é o pty-host.js, num processo filho. O agente é digitado no shell, à vista,
// então o que roda é sempre o que você vê na tela.
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

let host;
let sink;
let nextId = 1;
const alive = new Set();

// O renderer só escolhe entre estes; nunca manda comando livre para cá.
const AGENT_COMMANDS = {
  claude: 'claude',
  codex: 'codex',
  'codex-login': 'codex login',
};

function findOnPath(exe) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, exe);
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const SHELL = process.platform === 'win32'
  ? findOnPath('pwsh.exe') || 'powershell.exe'
  : process.env.SHELL || '/bin/bash';

// Se o app foi aberto de dentro de uma sessão do Claude Code, o ambiente traz os marcadores
// dessa sessão (id, socket, proxy em ANTHROPIC_BASE_URL...). Os agentes das abas não podem herdar isso.
function baseEnv() {
  const env = { ...process.env };
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) {
    for (const key of Object.keys(env)) {
      if (/^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_PREVIEW_|ANTHROPIC_BASE_URL$)/.test(key)) delete env[key];
    }
  }
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  return env;
}
const BASE_ENV = baseEnv();

// Isola a conta: a conta padrão usa o diretório default da CLI; as outras apontam pro próprio diretório.
function envFor(profile) {
  const env = { ...BASE_ENV, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  if (profile && !profile.isDefault) {
    env[profile.kind === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = profile.dir;
  }
  return env;
}

function emit(channel, ...args) {
  if (sink && !sink.isDestroyed()) sink.send(channel, ...args);
}

function ensureHost() {
  if (host?.connected) return host;
  host = fork(path.join(__dirname, 'pty-host.js'), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    windowsHide: true,
  });
  host.on('message', (msg) => {
    if (msg.type === 'data') emit('pty:data', msg.id, msg.data);
    if (msg.type === 'exit') {
      alive.delete(msg.id);
      emit('pty:exit', msg.id, msg.code);
    }
  });
  // Se o host cair, todas as abas de terminal são marcadas como encerradas.
  host.on('exit', () => {
    for (const id of alive) emit('pty:exit', id, -1);
    alive.clear();
    host = null;
  });
  return host;
}

function attach(webContents) {
  sink = webContents;
}

function spawn({ cwd, profile, agent, cols = 120, rows = 30 }) {
  if (agent && !AGENT_COMMANDS[agent]) throw new Error('Agente desconhecido.');
  const id = nextId++;
  ensureHost().send({
    type: 'spawn',
    id,
    shell: SHELL,
    args: process.platform === 'win32' ? ['-NoLogo'] : [],
    options: { name: 'xterm-256color', cols, rows, cwd, env: envFor(profile) },
    input: agent ? `${AGENT_COMMANDS[agent]}\r` : null,
  });
  alive.add(id);
  return { id, shell: path.basename(SHELL) };
}

function write(id, data) {
  if (alive.has(id)) host?.send({ type: 'write', id, data });
}

function resize(id, cols, rows) {
  if (alive.has(id) && cols > 0 && rows > 0) host?.send({ type: 'resize', id, cols, rows });
}

function kill(id) {
  if (alive.delete(id)) host?.send({ type: 'kill', id });
}

// O host mata todos os terminais ao perder a conexão.
function killAll() {
  alive.clear();
  host?.disconnect();
}

module.exports = { attach, spawn, write, resize, kill, killAll };
