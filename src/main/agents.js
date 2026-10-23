// Acompanha os agentes das abas: id da sessão (para reabrir depois) e status (trabalhando/ocioso).
// Claude: o Claude Code mantém <conta>/sessions/<pid>.json com sessionId e status: busy, idle ou
// waiting (com waitingFor, ex.: "permission prompt") quando para esperando você responder.
// Codex: não publica status; o id sai do arquivo de sessão (rollout) mais novo na mesma pasta, e o
// status do próprio rollout: task_started abre um turno, task_complete fecha.
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

// Rollout de uma conversa do Codex retomada (o id veio de fora): procura o arquivo pelo id nos últimos 30 dias.
function codexRolloutById(dir, id) {
  for (let daysAgo = 0; daysAgo < 30; daysAgo += 1) {
    const d = new Date(Date.now() - daysAgo * 86400000);
    const folder = path.join(dir, 'sessions', String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try {
      const name = fs.readdirSync(folder).find((n) => n.endsWith(`${id}.jsonl`));
      if (name) return path.join(folder, name);
    } catch {}
  }
  return null;
}

// Turno sem task_complete e sem nada escrito há tanto tempo: foi interrompido (Esc não deixa marca no arquivo).
// O tempo vem do timestamp da última linha: o Windows não atualiza a data de um arquivo que segue aberto.
const CODEX_STALE_MS = 5 * 60 * 1000;

// Última fala do Codex numa linha do rollout: mensagem do assistente ou chamada de ferramenta.
function codexSaid(entry) {
  const p = entry.payload || {};
  if (entry.type === 'event_msg' && p.type === 'agent_message' && p.message?.trim()) return { kind: 'text', text: p.message };
  if (entry.type !== 'response_item') return null;
  if (p.type === 'message' && p.role === 'assistant') {
    const text = (p.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join(' ').trim();
    return text ? { kind: 'text', text } : null;
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    let detail = p.input ?? p.arguments ?? '';
    try {
      const args = JSON.parse(detail);
      detail = args.command ? [].concat(args.command).join(' ') : args.path || args.file_path || detail;
    } catch {}
    return { kind: 'tool', text: `${p.name}${detail ? `: ${String(detail).split('\n')[0]}` : ''}` };
  }
  return null;
}

// Status e última fala, do fim do rollout: o último task_started/task_complete diz se está trabalhando.
function codexState(file) {
  let fd;
  let status = null;
  let lastMessage = null;
  let lastAt = 0;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    let pos = size;
    let carry = Buffer.alloc(0);
    while (pos > 0 && size - pos < MAX_TAIL && (!status || !lastMessage)) {
      const length = Math.min(CHUNK, pos);
      pos -= length;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, pos);
      const lines = Buffer.concat([buf, carry]).toString('utf8').split('\n');
      carry = pos > 0 ? Buffer.from(lines.shift(), 'utf8') : Buffer.alloc(0);
      for (let i = lines.length - 1; i >= 0 && (!status || !lastMessage); i -= 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (!lastAt) lastAt = Date.parse(/"timestamp":"([^"]+)"/.exec(line.slice(0, 200))?.[1] || '') || 0;
        if (!/"type":"(event_msg|response_item)"/.test(line.slice(0, 200))) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const type = entry.payload?.type;
        if (!status && type === 'task_started') status = Date.now() - lastAt > CODEX_STALE_MS ? 'idle' : 'busy';
        if (!status && type === 'task_complete') status = 'idle';
        const said = !lastMessage && codexSaid(entry);
        if (said) lastMessage = { kind: said.kind, text: said.text.trim().replace(/\s+/g, ' ').slice(0, said.kind === 'tool' ? 300 : 400) };
      }
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { status: status || 'idle', lastMessage, lastAt };
}

// Relê o rollout quando ele cresce, e de tempos em tempos enquanto "trabalhando" (para notar turno interrompido).
function pollCodex(ptyId, entry) {
  entry.rollout ??= codexRolloutById(entry.dir, entry.sessionId);
  if (!entry.rollout) return;
  let size;
  try {
    size = fs.statSync(entry.rollout).size;
  } catch {
    entry.rollout = null;
    return;
  }
  const stale = entry.status === 'busy' && Date.now() - (entry.rolloutAt || 0) > CODEX_STALE_MS;
  if (size === entry.rolloutSize && !stale) return;
  entry.rolloutSize = size;
  const { status, lastMessage, lastAt } = codexState(entry.rollout);
  entry.rolloutAt = lastAt;
  update(ptyId, entry, entry.sessionId, status, null, lastMessage);
}

// Arquivo da conversa: <conta>/projects/<pasta>/<id>.jsonl (a pasta é o cwd com outra grafia; procura pelo id).
function claudeTranscript(dir, sessionId) {
  const projects = path.join(dir, 'projects');
  try {
    for (const folder of fs.readdirSync(projects)) {
      const file = path.join(projects, folder, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  } catch {}
  return null;
}

// Resumo de uma chamada de ferramenta: o argumento que diz o que ela vai fazer. Caminho dentro da
// pasta do agente vira relativo, senão o caminho inteiro engole o card.
function toolSummary(block, cwd) {
  const input = block.input || {};
  const detail = input.command || input.file_path || input.notebook_path || input.path || input.url
    || input.pattern || input.query || input.description || Object.values(input).find((v) => typeof v === 'string') || '';
  let shown = detail;
  if (cwd && typeof detail === 'string' && path.isAbsolute(detail)) {
    const rel = path.relative(cwd, detail);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) shown = rel;
  }
  return `${block.name}${shown ? `: ${shown}` : ''}`;
}

const MAX_TAIL = 4 * 1024 * 1024;
const CHUNK = 256 * 1024;

// Última coisa que o Claude disse (texto) ou pediu (ferramenta), do fim da conversa em disco.
// O arquivo tem linhas enormes no meio (a requisição inteira), então lê de trás pra frente em
// blocos, só até achar uma resposta do agente principal (não de subagente), e no máximo 4 MB.
function claudeLastMessage(file, cwd) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    let pos = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (pos > 0 && carry.length < MAX_TAIL) {
      const size = Math.min(CHUNK, pos);
      pos -= size;
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, pos);
      const data = Buffer.concat([buf, carry]);
      const lines = data.toString('utf8').split('\n');
      // A primeira linha pode estar cortada: volta para o próximo bloco, a não ser no começo do arquivo.
      carry = pos > 0 ? Buffer.from(lines.shift(), 'utf8') : Buffer.alloc(0);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line.includes('"type":"assistant"')) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type !== 'assistant' || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
        for (const block of [...entry.message.content].reverse()) {
          if (block.type === 'text' && block.text?.trim()) return { kind: 'text', text: block.text.trim().replace(/\s+/g, ' ').slice(0, 400) };
          if (block.type === 'tool_use') return { kind: 'tool', text: toolSummary(block, cwd).replace(/\s+/g, ' ').slice(0, 300) };
        }
      }
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

// Relê a última fala quando o agente para (parou ou pediu algo) e enquanto a conversa no disco
// continuar mudando: a resposta pode chegar ao arquivo um instante depois do status.
function refreshLastMessage(entry) {
  if (!entry.sessionId || !['idle', 'waiting'].includes(entry.status)) return;
  entry.transcript ??= claudeTranscript(entry.dir, entry.sessionId);
  if (!entry.transcript) return;
  let mtime;
  try {
    mtime = fs.statSync(entry.transcript).mtimeMs;
  } catch {
    entry.transcript = null;
    return;
  }
  if (mtime === entry.transcriptMtime) return;
  entry.transcriptMtime = mtime;
  entry.lastMessage = claudeLastMessage(entry.transcript, entry.cwd);
}

// message: última fala já lida (Codex); o Claude relê a dele aqui.
function update(ptyId, entry, sessionId, status, waitingFor = null, message = undefined) {
  if (entry.sessionId !== sessionId) entry.transcript = null;
  const before = JSON.stringify([entry.sessionId, entry.status, entry.waitingFor, entry.lastMessage]);
  if (message !== undefined) entry.lastMessage = message;
  entry.sessionId = sessionId;
  entry.status = status;
  entry.waitingFor = waitingFor;
  if (entry.kind === 'claude') refreshLastMessage(entry);
  if (before === JSON.stringify([sessionId, status, waitingFor, entry.lastMessage])) return;
  listener?.(ptyId, { sessionId, status, waitingFor, lastMessage: entry.lastMessage || null });
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
          entry.rollout = file;
          update(ptyId, entry, meta.id, null);
          break;
        }
      }
    }
    if (entry.kind === 'codex' && entry.sessionId) pollCodex(ptyId, entry);
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

// Lê só um trecho do arquivo (as conversas chegam a vários MB).
function readSlice(file, start, length) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    return buf.subarray(0, fs.readSync(fd, buf, 0, length, start)).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Conversas do Claude dos últimos dias, em pastas que existem e que o app pode abrir (projetos e worktrees):
// título (ai-title do fim do arquivo), pasta (cwd do começo), conta e quando. Para reabrir com --resume.
function recentConversations(profiles, allowed, days = 3) {
  const since = Date.now() - days * 86400000;
  const list = [];
  for (const profile of profiles.filter((p) => p.kind === 'claude')) {
    // Rodando agora em algum lugar (outra aba, outro terminal, app desktop): reabrir daria duas instâncias na mesma conversa.
    const live = new Set(claudeSessions(configDir('claude', profile)).map((s) => s.sessionId));
    const projects = path.join(configDir('claude', profile), 'projects');
    let folders = [];
    try {
      folders = fs.readdirSync(projects);
    } catch {}
    for (const folder of folders) {
      let names = [];
      try {
        names = fs.readdirSync(path.join(projects, folder)).filter((n) => /^[0-9a-f-]{36}\.jsonl$/i.test(n));
      } catch {}
      for (const name of names) {
        const file = path.join(projects, folder, name);
        let stat;
        try {
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        if (stat.mtimeMs < since || stat.size < 2000 || live.has(name.slice(0, 36))) continue;
        const head = readSlice(file, 0, Math.min(stat.size, 256 * 1024));
        const cwdRaw = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
        let cwd;
        try {
          cwd = cwdRaw && JSON.parse(`"${cwdRaw}"`);
        } catch {}
        if (!cwd || !fs.existsSync(cwd) || !allowed(cwd)) continue;
        const tail = readSlice(file, Math.max(0, stat.size - 256 * 1024), Math.min(stat.size, 256 * 1024));
        const titles = [...tail.matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)];
        let title = '';
        try {
          title = titles.length ? JSON.parse(`"${titles.at(-1)[1]}"`) : '';
        } catch {}
        // Sem título = conversa aberta e fechada sem mensagem: não há o que retomar.
        if (title) list.push({ sessionId: name.slice(0, 36), profileId: profile.id, cwd, title, at: stat.mtimeMs });
      }
    }
  }
  return list.sort((a, b) => b.at - a.at).slice(0, 40);
}

module.exports = { track, untrack, onChange, claudeTranscriptExists, recentConversations };
