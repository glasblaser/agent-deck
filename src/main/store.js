// Estado persistido (perfis de conta e projetos) em %APPDATA%/agent-deck/state.json.
// Também é quem decide quais caminhos o renderer pode tocar.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const HOME = os.homedir();
let file;
let state = { profiles: [], projects: [] };

function save() {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function slug(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

// Perfis padrão: a conta default de cada CLI, mais os diretórios ~/.claude-* / ~/.codex-* que já existirem.
function seedProfiles() {
  const found = [
    { name: 'Claude', kind: 'claude', dir: path.join(HOME, '.claude'), isDefault: true },
    { name: 'GPT (Codex)', kind: 'codex', dir: path.join(HOME, '.codex'), isDefault: true },
  ];
  for (const entry of fs.readdirSync(HOME, { withFileTypes: true })) {
    const match = entry.isDirectory() && /^\.(claude|codex)-(.+)$/.exec(entry.name);
    if (!match) continue;
    const kind = match[1];
    found.push({ name: `${kind === 'claude' ? 'Claude' : 'GPT'} ${match[2]}`, kind, dir: path.join(HOME, entry.name), isDefault: false });
  }
  return found.map((p) => ({ id: crypto.randomUUID(), ...p }));
}

function load(userData) {
  fs.mkdirSync(userData, { recursive: true });
  file = path.join(userData, 'state.json');
  if (fs.existsSync(file)) {
    state = { profiles: [], projects: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } else {
    state.profiles = seedProfiles();
    save();
  }
  // Itens antigos da fila sem a pasta: grava a do projeto, para sobreviverem se ele sair e voltar.
  for (const item of state.backlog || []) {
    if (!item.projectPath) item.projectPath = state.projects.find((p) => p.id === item.projectId)?.path;
  }
  applyRecovery(path.join(userData, 'recovery.json'));
  // Primeira vez com pastas-raiz: a pasta onde já moram dois ou mais projetos cadastrados vira raiz.
  if (!state.workspaces) {
    const parents = state.projects.map((p) => path.dirname(p.path));
    state.workspaces = [...new Set(parents)].filter((dir) => parents.filter((p) => p === dir).length >= 2);
    save();
  }
  discover();
}

// ---------- pastas-raiz: toda subpasta delas é projeto, sem cadastro ----------

// Fora da descoberta: pastas de apoio (_referencia-rm, .git) e as irmãs onde ficam as worktrees.
const NOT_PROJECT = /^[._]|\.worktrees$/i;

const inWorkspace = (dir) => (state.workspaces || []).some((root) => path.dirname(dir).toLowerCase() === root.toLowerCase());

// Sincroniza a lista com o disco: subpasta nova entra, pasta descoberta que sumiu sai.
// Cadastradas à mão (fora das raízes) ficam como estão.
function discover() {
  let changed = false;
  for (const root of state.workspaces || []) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || NOT_PROJECT.test(entry.name)) continue;
      const dir = path.join(root, entry.name);
      if (state.projects.some((p) => p.path.toLowerCase() === dir.toLowerCase())) continue;
      state.projects.push({ id: crypto.randomUUID(), name: entry.name, path: dir });
      changed = true;
    }
  }
  const kept = state.projects.filter((p) => !inWorkspace(p.path) || fs.existsSync(p.path));
  if (kept.length !== state.projects.length) {
    state.projects = kept;
    changed = true;
  }
  state.projects.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' }));
  if (changed) save();
}

function addWorkspace(dir) {
  const resolved = path.resolve(dir);
  if (!(state.workspaces || []).some((w) => w.toLowerCase() === resolved.toLowerCase())) {
    state.workspaces = [...(state.workspaces || []), resolved];
    save();
  }
  discover();
  return publicState();
}

// Parar de ler uma raiz: os projetos dela saem da lista, menos os que têm card na fila.
function removeWorkspace(dir) {
  const target = String(dir).toLowerCase();
  const queued = new Set((state.backlog || []).map((b) => b.projectId));
  state.projects = state.projects.filter((p) => path.dirname(p.path).toLowerCase() !== target || queued.has(p.id));
  state.workspaces = (state.workspaces || []).filter((w) => w.toLowerCase() !== target);
  save();
  return publicState();
}

// Fixado = sempre em "Em uso" na barra lateral, mesmo sem nada aberto.
function setProjectPinned(projectId, pinned) {
  const project = requireProject(projectId);
  if (pinned) project.pinned = true;
  else delete project.pinned;
  save();
  return publicState();
}

// Recuperação preparada com o app fechado (o app em uso sobrescreveria o state.json): recadastra pastas,
// religa cards da fila e devolve abas de agente. Aplicada uma vez e renomeada para recovery.applied.json.
function applyRecovery(recoveryFile) {
  if (!fs.existsSync(recoveryFile)) return;
  try {
    const plan = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
    for (const dir of plan.addProjects || []) {
      if (typeof dir === 'string' && fs.existsSync(dir)) addProject(dir);
    }
    for (const [id, dir] of Object.entries(plan.relinkBacklog || {})) {
      const item = (state.backlog || []).find((b) => b.id === id);
      const project = state.projects.find((p) => canonical(p.path) === canonical(dir));
      if (item && project) Object.assign(item, { projectId: project.id, projectPath: project.path });
    }
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const tab of plan.reopenTabs || []) {
      if (tab?.type !== 'claude' || !UUID.test(tab.sessionId || '') || !fs.existsSync(tab.cwd || '')) continue;
      state.session ??= { layout: 1, focusedSlot: 0, tabs: [] };
      if (state.session.tabs.some((t) => t.sessionId === tab.sessionId)) continue;
      state.session.tabs.push({ type: 'claude', cwd: tab.cwd, profileId: tab.profileId || null, sessionId: tab.sessionId, slot: -1 });
    }
    save();
  } finally {
    fs.renameSync(recoveryFile, recoveryFile.replace(/\.json$/, '.applied.json'));
  }
}

function publicState() {
  discover();
  return {
    profiles: state.profiles, home: HOME, backlog: state.backlog || [], done: state.done || [], workspaces: state.workspaces || [],
    dismissed: state.dismissed || [],
    projects: state.projects.map((p) => ({ ...p, inWorkspace: inWorkspace(p.path) })),
  };
}

// ---------- quadro: "A fazer" (tarefas ainda sem worktree) e "Concluídas" (histórico) ----------

const text = (value, max) => String(value ?? '').trim().slice(0, max);

function requireProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  return project;
}

function addBacklog({ projectId, name, briefing }) {
  requireProject(projectId);
  const item = { id: crypto.randomUUID(), projectId, projectPath: requireProject(projectId).path, name: text(name, 80), briefing: text(briefing, 8000), createdAt: Date.now() };
  if (!item.name) throw new Error('Dê um nome à tarefa.');
  state.backlog = [...(state.backlog || []), item].slice(-200);
  save();
  return publicState();
}

function updateBacklog(id, { projectId, name, briefing }) {
  const item = (state.backlog || []).find((b) => b.id === id);
  if (!item) throw new Error('Item não encontrado.');
  requireProject(projectId);
  if (!text(name, 80)) throw new Error('Dê um nome à tarefa.');
  Object.assign(item, { projectId, projectPath: requireProject(projectId).path, name: text(name, 80), briefing: text(briefing, 8000) });
  save();
  return publicState();
}

function removeBacklog(id) {
  state.backlog = (state.backlog || []).filter((b) => b.id !== id);
  save();
  return publicState();
}

// Chamado pelo main quando um merge, squash ou PR deu certo: o histórico não depende da UI.
function recordDone(projectPath, { mode, branch, base, url, description }) {
  const project = state.projects.find((p) => p.path.toLowerCase() === String(projectPath).toLowerCase());
  state.done = [...(state.done || []), {
    id: crypto.randomUUID(), projectId: project?.id || null, projectName: project?.name || path.basename(projectPath),
    name: String(branch).replace(/^task\//, ''), branch, base, mode, url: url || null,
    briefing: text(description, 2000), at: Date.now(),
  }].slice(-100);
  save();
}

// Conversa fechada que você não quer mais ver em "Conversas fechadas" (ela continua no Claude, /resume acha).
function dismissConversation(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(sessionId))) throw new Error('Conversa inválida.');
  state.dismissed = [...new Set([...(state.dismissed || []), sessionId])].slice(-1000);
  save();
  return publicState();
}

function removeDone(id) {
  state.done = (state.done || []).filter((d) => d.id !== id);
  save();
  return publicState();
}

function profile(id) {
  const found = state.profiles.find((p) => p.id === id);
  if (!found) throw new Error('Perfil não encontrado.');
  return found;
}

// Conta nova = diretório de configuração próprio (~/.claude-<nome> ou ~/.codex-<nome>).
function addProfile({ name, kind }) {
  if (!['claude', 'codex'].includes(kind)) throw new Error('Tipo de conta inválido.');
  const s = slug(name);
  if (!s) throw new Error('Dê um nome à conta.');
  const dir = path.join(HOME, `.${kind}-${s}`);
  if (state.profiles.some((p) => p.dir.toLowerCase() === dir.toLowerCase())) {
    throw new Error('Já existe uma conta com esse nome.');
  }
  fs.mkdirSync(dir, { recursive: true });
  const created = { id: crypto.randomUUID(), name, kind, dir, isDefault: false };
  state.profiles.push(created);
  save();
  return created;
}

// Remove só do app; o diretório (e o login dentro dele) fica no disco.
// Cor da conta (#rrggbb); vazio volta para a cor automática.
function setProfileColor(id, color) {
  const found = profile(id);
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Cor inválida.');
  if (color) found.color = color.toLowerCase();
  else delete found.color;
  save();
  return publicState();
}

function removeProfile(id) {
  state.profiles = state.profiles.filter((p) => p.id !== id);
  save();
}

// Pasta escolhida à mão. Se ela mora numa raiz, já está na lista (a descoberta pôs lá).
function addProject(dir) {
  discover();
  const existing = state.projects.find((p) => p.path.toLowerCase() === dir.toLowerCase());
  if (existing) return existing;
  const created = { id: crypto.randomUUID(), name: path.basename(dir), path: dir };
  state.projects.push(created);
  save();
  return created;
}

// Abas abertas e layout, para reabrir tudo na próxima vez. Os valores voltam ao renderer e
// passam de novo pelas mesmas validações de sempre (requireCwd, perfil, id de sessão) ao reabrir.
function getSession() {
  return state.session || null;
}

function saveSession(session) {
  if (!session || !Array.isArray(session.tabs) || session.tabs.length > 64) return;
  if (JSON.stringify(session).length > 100000) return;
  state.session = session;
  save();
}

// Preparo de worktree nova: o que copiar do projeto (o git ignora, então não vem junto) e um comando
// que roda no terminal da tarefa antes do agente. Configurado por você; o renderer só pede "prepare".
function setProjectSetup(projectId, { copy, command } = {}) {
  const project = state.projects.find((p) => p.id === projectId);
  if (!project) throw new Error('Projeto não encontrado.');
  const list = (Array.isArray(copy) ? copy : String(copy || '').split(/\r?\n/))
    .map((c) => String(c).trim().replace(/\\/g, '/')).filter(Boolean);
  for (const rel of list) {
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`Caminho tem que ser relativo ao projeto: ${rel}`);
  }
  const cmd = String(command || '').trim();
  if (/[\r\n]/.test(cmd) || cmd.length > 300) throw new Error('O comando tem que ser uma linha só (até 300 caracteres).');
  if (list.length > 30) throw new Error('No máximo 30 caminhos.');
  if (list.length || cmd) project.setup = { copy: list, command: cmd };
  else delete project.setup;
  save();
  return publicState();
}

// Projeto dono de uma worktree (pasta dentro de <projeto>.worktrees).
function projectOfWorktree(dir) {
  return state.projects.find((p) => within(dir, `${p.path}.worktrees`) && !within(dir, p.path)) || null;
}

function setupCommandFor(dir) {
  return projectOfWorktree(dir)?.setup?.command || null;
}

function setupCopyFor(projectPath) {
  return state.projects.find((p) => canonical(p.path) === canonical(projectPath))?.setup?.copy || [];
}

// Só projeto cadastrado à mão: o de uma pasta-raiz voltaria na próxima leitura.
function removeProject(id) {
  if (inWorkspace(requireProject(id).path)) throw new Error('Esse projeto vem da pasta-raiz: ele só sai da barra se a pasta sair de lá.');
  state.projects = state.projects.filter((p) => p.id !== id);
  save();
}

// Forma comparável de um caminho: nomes curtos 8.3 (EDUARD~1) viram longos, junctions e links são
// seguidos e caixa não importa. Para caminho que ainda não existe, resolve o ancestral mais próximo que existe.
function canonical(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest).toLowerCase();
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p).toLowerCase();
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function within(target, root) {
  const rel = path.relative(canonical(root), canonical(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Raízes editáveis: cada projeto e a pasta irmã onde ficam as worktrees dele.
function projectRoots() {
  return state.projects.flatMap((p) => [p.path, `${p.path}.worktrees`]);
}

function requireProjectPath(dir) {
  const target = path.resolve(dir);
  if (!state.projects.some((p) => canonical(p.path) === canonical(target))) {
    throw new Error('Projeto não registrado.');
  }
  return target;
}

function requireAllowedPath(target) {
  const resolved = path.resolve(target);
  if (!projectRoots().some((root) => within(resolved, root))) {
    throw new Error(`Caminho fora dos projetos: ${resolved}`);
  }
  return resolved;
}

// Terminais podem abrir também na home (ex.: login de uma conta nova).
function requireCwd(target) {
  const resolved = path.resolve(target || HOME);
  if (canonical(resolved) === canonical(HOME)) return resolved;
  return requireAllowedPath(resolved);
}

module.exports = {
  load, publicState, profile, addProfile, removeProfile, setProfileColor, addProject, setProjectSetup, setupCommandFor, setupCopyFor, removeProject, getSession,
  addWorkspace, removeWorkspace, setProjectPinned, dismissConversation, saveSession,
  addBacklog, updateBacklog, removeBacklog, recordDone, removeDone,
  requireProjectPath, requireAllowedPath, requireCwd, slug, HOME,
};
