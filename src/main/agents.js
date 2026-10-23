// Acompanha os agentes das abas: id da sessão (para reabrir depois) e status (trabalhando/ocioso).
// Claude: o Claude Code mantém <conta>/sessions/<pid>.json com sessionId e status: busy, idle ou
// waiting (com waitingFor, ex.: "permission prompt") quando para esperando você responder.
// Codex: não publica status; o id sai do arquivo de sessão (rollout) mais novo na mesma pasta.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const POLL_MS = 1500;
const tracked = new Map(); // ptyId -> { kind, dir, cwd, sessionId, startedAt, pid, status }
let timer = null;
let listener = null;

function configDir(kind, profile) {
  return profile?.dir || path.join(HOME, kind === 'claude' ? '.claude' : '.codex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// A conversa só existe em disco depois da primeira mensagem: <conta>/projects/<pasta>/<id>.jsonl.
function claudeTranscriptExists(profile, sessionId) {
  const projects = path.join(configDir('claude', profile), 'projects');
  try {
    return fs.readdirSync(projects).some((dir) => fs.existsSync(path.join(projects, dir, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}

function claudeSessions(dir) {
  const folder = path.join(dir, 'sessions');
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(folder, n))).filter(Boolean);
}

// O Codex grava em sessions/AAAA/MM/DD (data local); olha hoje e ontem, por causa da meia-noite.
function codexCandidates(dir, since) {
  const files = [];
  for (const daysAgo of [0, 1]) {
    const d = new Date(Date.now() - daysAgo * 86400000);
    const folder = path.join(dir, 'sessions', String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    let names;
    try {
      names = fs.readdirSync(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const file = path.join(folder, name);
      try {
        if (fs.statSync(file).birthtimeMs >= since - 2000) files.push(file);
      } catch {}
    }
  }
  return files;
}

// A primeira linha (session_meta) carrega as instruções inteiras e pode ter centenas de KB;
// id e cwd vêm logo no começo, então basta ler o início e extrair com regex.
function codexMeta(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(4096);
      head = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const id = /"id":"([0-9a-f-]{36})"/.exec(head)?.[1];
  const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
  if (!id || !cwd) return null;
  try {
    return { id, cwd: JSON.parse(`"${cwd}"`) };
  } catch {
    return null;
  }
}

function update(ptyId, entry, sessionId, status, waitingFor = null) {
  if (entry.sessionId === sessionId && entry.status === status && entry.waitingFor === waitingFor) return;
  entry.sessionId = sessionId;
  entry.status = status;
  entry.waitingFor = waitingFor;
  listener?.(ptyId, { sessionId, status, waitingFor });
}

function poll() {
  const claimed = new Set([...tracked.values()].filter((t) => t.kind === 'codex' && t.sessionId).map((t) => t.sessionId));
  const sessionsByDir = new Map();
  for (const [ptyId, entry] of tracked) {
    if (entry.kind === 'claude') {
      if (!sessionsByDir.has(entry.dir)) sessionsByDir.set(entry.dir, claudeSessions(entry.dir));
      const list = sessionsByDir.get(entry.dir);
      // Depois de achar o processo, segue pelo pid: /clear ou /resume trocam o sessionId dentro da mesma aba.
      const found = entry.pid ? list.find((s) => s.pid === entry.pid) : list.find((s) => s.sessionId === entry.sessionId);
      if (found) {
        entry.pid = found.pid;
        update(ptyId, entry, found.sessionId || entry.sessionId, found.status || null,
          found.status === 'waiting' ? String(found.waitingFor || 'resposta') : null);
      } else if (entry.pid) {
        // O registro sumiu: o agente saiu e a aba voltou para o shell.
        entry.pid = null;
        update(ptyId, entry, entry.sessionId, 'off');
      }
    } else if (entry.kind === 'codex' && !entry.sessionId) {
      for (const file of codexCandidates(entry.dir, entry.startedAt)) {
        const meta = codexMeta(file);
        if (meta && !claimed.has(meta.id) && samePath(meta.cwd, entry.cwd)) {
          claimed.add(meta.id);
          update(ptyId, entry, meta.id, null);
          break;
        }
      }
    }
  }
}

function track(ptyId, { kind, profile, cwd, sessionId }) {
  tracked.set(ptyId, { kind, dir: configDir(kind, profile), cwd, sessionId, startedAt: Date.now(), pid: null, status: null });
  timer ??= setInterval(poll, POLL_MS);
}

function untrack(ptyId) {
  tracked.delete(ptyId);
  if (!tracked.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function onChange(fn) {
  listener = fn;
}

module.exports = { track, untrack, onChange, claudeTranscriptExists };
