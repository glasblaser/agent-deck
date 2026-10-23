// Worktree por tarefa: cada tarefa ganha branch task/<nome> numa pasta irmã
// <repo>.worktrees/<nome>, então agentes em paralelo não pisam um no outro.
// O resto da tarefa fica no próprio git: a base em branch.<b>.deckbase e o briefing
// em branch.<b>.description (o mesmo campo do `git branch --edit-description`).
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { slug } = require('./store');

function exec(exe, cwd, args) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { cwd, windowsHide: true, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error((stderr || error.message).trim()), { code: error.code }));
      else resolve(stdout);
    });
  });
}
const run = (cwd, args) => exec('git', cwd, args);
const quiet = (cwd, args) => run(cwd, args).then((out) => out.trim(), () => '');

// Caminho comparável: resolve nomes curtos 8.3 (EDUARD~1) e maiúsculas/minúsculas do Windows.
function canonical(p) {
  try {
    return fs.realpathSync.native(p).toLowerCase();
  } catch {
    return path.resolve(p).toLowerCase();
  }
}

// Só as worktrees em <repo>.worktrees são do app; as outras (ex.: .claude/worktrees do Claude Code) não se removem daqui.
function isManaged(projectPath, worktreePath) {
  return canonical(worktreePath).startsWith(canonical(`${projectPath}.worktrees`) + path.sep);
}

async function isRepo(dir) {
  try {
    return (await run(dir, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

// Nome vindo da UI vira argumento do git: só branch local que existe, e nada que pareça opção.
async function requireBranch(cwd, name) {
  if (!name || name.startsWith('-') || !/^[\w./-]+$/.test(name)) throw new Error(`Branch inválida: ${name || '(nenhuma)'}`);
  try {
    await run(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
  } catch {
    throw new Error(`A branch ${name} não existe.`);
  }
  return name;
}

async function rawWorktrees(projectPath) {
  const out = await run(projectPath, ['worktree', 'list', '--porcelain']);
  const worktrees = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: path.resolve(line.slice(9)), branch: null };
      worktrees.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice(7).replace('refs/heads/', '');
    } else if (line === 'detached' && current) {
      current.branch = '(detached)';
    }
  }
  return worktrees;
}

// Base da tarefa: a gravada na criação; sem ela (worktree antiga ou externa), a branch atual do projeto.
async function taskBase(projectPath, branch) {
  return (await quiet(projectPath, ['config', '--get', `branch.${branch}.deckbase`]))
    || (await quiet(projectPath, ['branch', '--show-current']));
}

// Quanto a tarefa andou: commits à frente da base e arquivos mexidos ainda sem commit.
async function taskInfo(projectPath, wt) {
  if (!wt.branch || wt.branch === '(detached)') return wt;
  const [base, description, status] = await Promise.all([
    taskBase(projectPath, wt.branch),
    quiet(projectPath, ['config', '--get', `branch.${wt.branch}.description`]),
    quiet(wt.path, ['status', '--porcelain']),
  ]);
  const ahead = base ? Number(await quiet(projectPath, ['rev-list', '--count', `${base}..${wt.branch}`, '--'])) || 0 : 0;
  const lastCommitAt = Number(await quiet(projectPath, ['log', '-1', '--format=%ct', wt.branch, '--'])) * 1000 || null;
  return { ...wt, base, description, ahead, lastCommitAt, dirty: status ? status.split(/\r?\n/).length : 0 };
}

async function listWorktrees(projectPath) {
  if (!(await isRepo(projectPath))) return { repo: false, worktrees: [] };
  const main = canonical(projectPath);
  const worktrees = (await rawWorktrees(projectPath)).filter((w) => canonical(w.path) !== main);
  return {
    repo: true,
    worktrees: await Promise.all(worktrees.map((w) => taskInfo(projectPath, { ...w, managed: isManaged(projectPath, w.path) }))),
  };
}

async function branches(projectPath) {
  const out = await run(projectPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return {
    current: await quiet(projectPath, ['branch', '--show-current']),
    list: out.split(/\r?\n/).filter(Boolean),
  };
}

// Copia do projeto para a worktree nova o que o git não traz (ex.: .env). Só caminhos relativos
// dentro do projeto; o que não existir é ignorado. Devolve o que foi copiado.
function copyIntoWorktree(projectPath, target, copy) {
  const copied = [];
  const root = path.resolve(projectPath);
  for (const rel of copy || []) {
    const from = path.resolve(root, rel);
    if (!from.startsWith(root + path.sep) || !fs.existsSync(from)) continue;
    const to = path.join(target, path.relative(root, from));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    copied.push(rel);
  }
  return copied;
}

const SETUP_BY_FILE = [
  ['pnpm-lock.yaml', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn install --frozen-lockfile'],
  ['bun.lockb', 'bun install'],
  ['package-lock.json', 'npm ci'],
  ['go.mod', 'go mod download'],
];

// Sugestão de preparo: arquivos que o git ignora na raiz do projeto (pastas inteiras e logs ficam de
// fora) e um comando deduzido do lockfile ou do projeto .NET. Só sugestão: você revisa antes de salvar.
async function suggestSetup(projectPath) {
  const ignored = (await quiet(projectPath, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory']))
    .split(/\r?\n/).filter((f) => f && !f.endsWith('/') && !f.includes('/') && !/\.(log|tmp)$/i.test(f));
  const copy = ignored.filter((f) => {
    try {
      return fs.statSync(path.join(projectPath, f)).size < 1024 * 1024;
    } catch {
      return false;
    }
  });
  let command = SETUP_BY_FILE.find(([file]) => fs.existsSync(path.join(projectPath, file)))?.[1] || '';
  if (!command) {
    try {
      if (fs.readdirSync(projectPath).some((f) => /\.(sln|csproj)$/i.test(f))) command = 'dotnet restore';
    } catch {}
  }
  return { copy, command };
}

async function createWorktree(projectPath, taskName, { base, briefing, copy } = {}) {
  const name = slug(taskName);
  if (!name) throw new Error('Nome de tarefa inválido.');
  if (!(await isRepo(projectPath))) throw new Error('Esse projeto não é um repositório git.');
  const from = await requireBranch(projectPath, base || (await quiet(projectPath, ['branch', '--show-current'])));
  const branch = `task/${name}`;
  const target = path.join(`${projectPath}.worktrees`, name);
  await run(projectPath, ['worktree', 'add', '-b', branch, target, from]);
  await run(projectPath, ['config', `branch.${branch}.deckbase`, from]);
  if (briefing) await run(projectPath, ['config', `branch.${branch}.description`, briefing]);
  const copied = copyIntoWorktree(projectPath, target, copy);
  // Caminho longo, igual ao que o `worktree list` devolve: a UI compara os dois para achar as abas da tarefa.
  return { path: fs.realpathSync.native(target), branch, base: from, copied };
}

// Worktree tem que ser uma das listadas pelo git para esse projeto (e criada pelo app, se managed).
async function requireWorktree(projectPath, worktreePath, managed = false) {
  const found = (await rawWorktrees(projectPath)).find((w) => canonical(w.path) === canonical(worktreePath));
  if (!found || canonical(found.path) === canonical(projectPath)) throw new Error('Worktree não encontrada nesse projeto.');
  if (managed && !isManaged(projectPath, found.path)) throw new Error('Só mexo em worktrees criadas pelo app.');
  if (!found.branch || found.branch === '(detached)') throw new Error('A worktree não está numa branch.');
  return found;
}

// O que a tarefa mudou desde que saiu da base, incluindo o que ainda não foi commitado:
// o agente nem sempre commita, e é justamente isso que você quer revisar.
async function diff(projectPath, worktreePath) {
  const wt = await requireWorktree(projectPath, worktreePath);
  const base = await requireBranch(projectPath, await taskBase(projectPath, wt.branch));
  const mergeBase = (await run(wt.path, ['merge-base', base, 'HEAD'])).trim();
  const changed = (await run(wt.path, ['diff', '--name-status', '--no-renames', '-z', mergeBase])).split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i + 1 < changed.length; i += 2) files.push({ status: changed[i], path: changed[i + 1] });
  const untracked = (await run(wt.path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const file of untracked) files.push({ status: '?', path: file });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { branch: wt.branch, base, mergeBase, files };
}

const MAX_DIFF_FILE = 2 * 1024 * 1024;

function asText(content) {
  if (content.length > MAX_DIFF_FILE) return '[arquivo grande demais para o diff]';
  return content.includes('\0') ? '[arquivo binário]' : content;
}

async function diffFile(projectPath, worktreePath, mergeBase, file) {
  const wt = await requireWorktree(projectPath, worktreePath);
  if (!/^[0-9a-f]{40,64}$/.test(mergeBase)) throw new Error('Commit inválido.');
  const target = path.resolve(wt.path, file);
  if (!target.startsWith(path.resolve(wt.path) + path.sep)) throw new Error('Arquivo fora da worktree.');
  // cat-file, não show: o show tenta ler "<commit>:<arquivo>" como caminho e quebra em pasta funda ("Filename too long").
  const original = await run(wt.path, ['cat-file', 'blob', `${mergeBase}:${file.replace(/\\/g, '/')}`]).catch(() => '');
  let modified = '';
  try {
    modified = await fs.promises.readFile(target, 'utf8');
  } catch {}
  return { original: asText(original), modified: asText(modified) };
}

// Juntar a branch na base não muda nada: tudo dela já está lá (merge comum ou squash).
async function alreadyIn(cwd, base, branch) {
  const merged = await quiet(cwd, ['merge-tree', '--write-tree', base, branch]);
  return !!merged && merged.split(/\r?\n/)[0] === (await quiet(cwd, ['rev-parse', `${base}^{tree}`]));
}

// Concluir: commita o que sobrou (se veio mensagem) e integra na base.
// merge/squash rodam na pasta onde a base está em checkout; pr empurra a branch e abre o PR no GitHub.
// Não remove a worktree: as abas dela precisam fechar antes (no Windows, pasta em uso não sai). Isso é o finishTask.
async function conclude(projectPath, worktreePath, { mode, message } = {}) {
  if (!['merge', 'squash', 'pr'].includes(mode)) throw new Error('Modo inválido.');
  const wt = await requireWorktree(projectPath, worktreePath, true);
  const base = await requireBranch(projectPath, await taskBase(projectPath, wt.branch));
  const description = await quiet(projectPath, ['config', '--get', `branch.${wt.branch}.description`]);

  if (await quiet(wt.path, ['status', '--porcelain'])) {
    if (!message) throw new Error('A worktree tem mudanças não commitadas. Informe a mensagem do commit.');
    await run(wt.path, ['add', '-A']);
    await run(wt.path, ['commit', '-m', message]);
  }
  const ahead = Number(await quiet(projectPath, ['rev-list', '--count', `${base}..${wt.branch}`, '--'])) || 0;
  if (!ahead) return { mode: 'nothing', branch: wt.branch, base };

  const title = (message || description.split(/\r?\n/)[0] || wt.branch).trim();
  if (mode === 'pr') {
    await run(wt.path, ['push', '-u', 'origin', wt.branch]);
    const body = [description, `Branch \`${wt.branch}\` → \`${base}\`.`].filter(Boolean).join('\n\n');
    let out;
    try {
      out = await exec('gh', wt.path, ['pr', 'create', '--base', base, '--head', wt.branch, '--title', title, '--body', body]);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('A branch foi enviada, mas o GitHub CLI (gh) não está instalado para abrir o PR.');
      throw error;
    }
    return { mode, branch: wt.branch, base, description, url: out.match(/https:\/\/\S+/)?.[0] || null };
  }

  const target = (await rawWorktrees(projectPath)).find((w) => w.branch === base);
  if (!target) throw new Error(`A base ${base} não está em checkout em nenhuma pasta. Faça checkout dela no projeto e tente de novo.`);
  try {
    await run(projectPath, ['merge-tree', '--write-tree', '--name-only', base, wt.branch]);
  } catch (error) {
    throw new Error(`Conflito entre ${wt.branch} e ${base}. Peça ao agente para rodar "git merge ${base}" na tarefa, resolver e commitar.\n\n${error.message}`);
  }
  if (await quiet(target.path, ['diff', '--cached', '--name-only'])) {
    throw new Error(`Há mudanças em stage em ${target.path}; elas entrariam no commit da tarefa. Resolva antes.`);
  }
  try {
    if (mode === 'merge') {
      await run(target.path, ['merge', '--no-ff', '-m', `Merge ${wt.branch}: ${title}`, wt.branch]);
    } else {
      await run(target.path, ['merge', '--squash', wt.branch]);
      await run(target.path, ['commit', '-m', [title, description !== title ? description : ''].filter(Boolean).join('\n\n')]);
    }
  } catch (error) {
    // Nunca deixa a pasta da base no meio de um merge.
    await quiet(target.path, ['reset', '--merge']);
    throw error;
  }
  return { mode, branch: wt.branch, base, description, into: target.path };
}

// Fim da tarefa: remove a worktree (sem --force: com mudança não commitada, o git recusa) e
// apaga a branch se tudo dela já está na base. Senão a branch fica, e a resposta diz isso.
async function finishTask(projectPath, worktreePath) {
  const wt = await requireWorktree(projectPath, worktreePath, true);
  const base = await taskBase(projectPath, wt.branch);
  await run(projectPath, ['worktree', 'remove', wt.path]);
  if (!base || !(await alreadyIn(projectPath, base, wt.branch))) return { branch: wt.branch, branchKept: true };
  await run(projectPath, ['branch', '-D', wt.branch]);
  return { branch: wt.branch, branchKept: false };
}

// Sem --force: se houver mudança não commitada, o git recusa e o erro volta pra tela.
async function removeWorktree(projectPath, worktreePath) {
  const target = path.resolve(worktreePath);
  if (!isManaged(projectPath, target)) {
    throw new Error('Só removo worktrees criadas pelo app.');
  }
  await run(projectPath, ['worktree', 'remove', target]);
}

module.exports = { listWorktrees, branches, createWorktree, suggestSetup, diff, diffFile, conclude, finishTask, removeWorktree };
