// Terminais. Aqui se decide shell, ambiente da conta e comando; quem roda o ConPTY
// é o pty-host.js, num processo filho. O agente é digitado no shell, à vista,
// então o que roda é sempre o que você vê na tela.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const agents = require('./agents');

let host;
let sink;
let nextId = 1;
const alive = new Set();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// O renderer só escolhe o agente e, para reabrir, um id de sessão; nunca manda comando livre.
// O id é gerado aqui (Claude) ou validado como UUID antes de entrar no comando.
function agentCommand(agent, profile, resumeId) {
  if (resumeId && !UUID.test(resumeId)) throw new Error('Id de sessão inválido.');
  if (agent === 'claude') {
    // Sem conversa em disco (nenhuma mensagem enviada) não há o que retomar: abre uma nova.
    if (resumeId && agents.claudeTranscriptExists(profile, resumeId)) {
      return { command: `claude --resume ${resumeId}`, sessionId: resumeId };
    }
    const sessionId = crypto.randomUUID();
    return { command: `claude --session-id ${sessionId}`, sessionId };
  }
  if (agent === 'codex') return { command: resumeId ? `codex resume ${resumeId}` : 'codex', sessionId: resumeId || null };
  if (agent === 'codex-login') return { command: 'codex login', sessionId: null };
  throw new Error('Agente desconhecido.');
}

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
      agents.untrack(msg.id);
      emit('pty:exit', msg.id, msg.code);
    }
  });
  // Se o host cair, todas as abas de terminal são marcadas como encerradas.
  host.on('exit', () => {
    for (const id of alive) {
      agents.untrack(id);
      emit('pty:exit', id, -1);
    }
    alive.clear();
    host = null;
  });
  return host;
}

function attach(webContents) {
  sink = webContents;
}

agents.onChange((id, info) => emit('agent:status', id, info));

function spawn({ cwd, profile, agent, resumeId, cols = 120, rows = 30 }) {
  const launch = agent ? agentCommand(agent, profile, resumeId) : null;
  const id = nextId++;
  ensureHost().send({
    type: 'spawn',
    id,
    shell: SHELL,
    args: process.platform === 'win32' ? ['-NoLogo'] : [],
    options: { name: 'xterm-256color', cols, rows, cwd, env: envFor(profile) },
    input: launch ? `${launch.command}\r` : null,
  });
  alive.add(id);
  if (agent === 'claude' || agent === 'codex') agents.track(id, { kind: agent, profile, cwd, sessionId: launch.sessionId });
  return { id, shell: path.basename(SHELL), sessionId: launch?.sessionId || null };
}

function write(id, data) {
  if (alive.has(id)) host?.send({ type: 'write', id, data });
}

function resize(id, cols, rows) {
  if (alive.has(id) && cols > 0 && rows > 0) host?.send({ type: 'resize', id, cols, rows });
}

function kill(id) {
  agents.untrack(id);
  if (alive.delete(id)) host?.send({ type: 'kill', id });
}

// O host mata todos os terminais ao perder a conexão.
function killAll() {
  for (const id of alive) agents.untrack(id);
  alive.clear();
  host?.disconnect();
}

module.exports = { attach, spawn, write, resize, kill, killAll };
