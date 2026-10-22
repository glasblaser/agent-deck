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
}

function publicState() {
  return { profiles: state.profiles, projects: state.projects, home: HOME };
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
function removeProfile(id) {
  state.profiles = state.profiles.filter((p) => p.id !== id);
  save();
}

function addProject(dir) {
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

function removeProject(id) {
  state.projects = state.projects.filter((p) => p.id !== id);
  save();
}

function within(target, root) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Raízes editáveis: cada projeto e a pasta irmã onde ficam as worktrees dele.
function projectRoots() {
  return state.projects.flatMap((p) => [p.path, `${p.path}.worktrees`]);
}

function requireProjectPath(dir) {
  const target = path.resolve(dir);
  if (!state.projects.some((p) => path.resolve(p.path).toLowerCase() === target.toLowerCase())) {
    throw new Error('Projeto não registrado.');
  }
  return target;
}

function requireAllowedPath(target) {
  const resolved = path.resolve(target);
  if (!projectRoots().some((root) => within(resolved.toLowerCase(), path.resolve(root).toLowerCase()))) {
    throw new Error(`Caminho fora dos projetos: ${resolved}`);
  }
  return resolved;
}

// Terminais podem abrir também na home (ex.: login de uma conta nova).
function requireCwd(target) {
  const resolved = path.resolve(target || HOME);
  if (resolved.toLowerCase() === HOME.toLowerCase()) return resolved;
  return requireAllowedPath(resolved);
}

module.exports = {
  load, publicState, profile, addProfile, removeProfile, addProject, removeProject, getSession, saveSession,
  requireProjectPath, requireAllowedPath, requireCwd, slug, HOME,
};
