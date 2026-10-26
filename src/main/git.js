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
    // Sem prompt de senha no terminal invisível (travaria): o login vem do Git Credential Manager, que abre janela própria.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile(exe, args, { cwd, env, windowsHide: true, maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
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
  if (!found || canonical(found.path) === canonical(projectPath)) throw new Error('Essa tarefa não existe mais (já foi concluída ou removida). O quadro foi atualizado.');
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

// Remotos do projeto, com o link de "abrir pull request" de cada um (GitHub e Azure DevOps).
async function remotes(projectPath) {
  const out = await quiet(projectPath, ['remote', '-v']);
  const seen = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [name, url] = line.split(/\s+/);
    if (name && url && !seen.has(name)) seen.set(name, { name, url: url.replace(/\/\/[^/@]+@/, '//') });
  }
  return [...seen.values()];
}

function prUrl(remoteUrl, base, branch) {
  const enc = encodeURIComponent;
  let m = /github\.com[:/]([^/]+)\/(.+?)(\.git)?$/.exec(remoteUrl);
  // O GitHub quer a barra das branches (task/x) literal no caminho.
  const ref = (b) => enc(b).replace(/%2F/g, '/');
  if (m) return `https://github.com/${m[1]}/${m[2]}/compare/${ref(base)}...${ref(branch)}?expand=1`;
  m = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(\.git)?$/.exec(remoteUrl)
    || /ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+?)(\.git)?$/.exec(remoteUrl);
  if (m) return `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}/pullrequestcreate?sourceRef=${enc(branch)}&targetRef=${enc(base)}`;
  m = /([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(\.git)?$/.exec(remoteUrl);
  if (m) return `https://dev.azure.com/${m[1]}/${m[2]}/_git/${m[3]}/pullrequestcreate?sourceRef=${enc(branch)}&targetRef=${enc(base)}`;
  return null;
}

// Tudo que a caixa de concluir precisa: base sugerida, branches, remotos e o que há para integrar.
async function concludeInfo(projectPath, worktreePath) {
  const wt = await requireWorktree(projectPath, worktreePath);
  const [base, list, remoteList, status] = await Promise.all([
    taskBase(projectPath, wt.branch),
    run(projectPath, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    remotes(projectPath),
    quiet(wt.path, ['status', '--porcelain']),
  ]);
  const branchList = list.split(/\r?\n/).filter((b) => b && b !== wt.branch);
  const ahead = base ? Number(await quiet(projectPath, ['rev-list', '--count', `${base}..${wt.branch}`, '--'])) || 0 : 0;
  const upstream = base ? await quiet(projectPath, ['config', '--get', `branch.${base}.remote`]) : '';
  return {
    branch: wt.branch, base, branches: branchList, remotes: remoteList.map((r) => r.name), upstream,
    ahead, dirty: status ? status.split(/\r?\n/).length : 0, managed: isManaged(projectPath, wt.path),
    description: await quiet(projectPath, ['config', '--get', `branch.${wt.branch}.description`]),
  };
}

// Erro do git em português, com o que fazer.
function explainPush(remote, branch, error) {
  const msg = error.message;
  if (/rejected|non-fast-forward|fetch first/i.test(msg)) return `${remote} tem commits em ${branch} que você não tem aqui. Rode "git pull ${remote} ${branch}" na pasta do projeto e conclua de novo.`;
  if (/Authentication|could not read Username|403|401|terminal prompts disabled/i.test(msg)) return `O ${remote} pediu login e ele não aconteceu. Faça um push qualquer por um terminal uma vez (o Git Credential Manager guarda o login) e tente de novo.`;
  return `Falha ao enviar para ${remote}: ${msg}`;
}

// Concluir em um passo (o merge/squash não remove a worktree: as abas dela fecham antes, no finishTask). base: onde integrar. push: remotos para enviar (vazio = só local). pr: em vez de
// integrar aqui, envia a branch da tarefa e devolve o link do pull request de cada remoto.
// Sem a base aberta em nenhuma pasta, integra numa worktree temporária e apaga ela no fim.
async function conclude(projectPath, worktreePath, { base: chosenBase, push = [], pr = false, squash = false, message } = {}) {
  const wt = await requireWorktree(projectPath, worktreePath);
  const base = await requireBranch(projectPath, chosenBase || (await taskBase(projectPath, wt.branch)));
  const known = (await remotes(projectPath)).map((r) => r.name);
  const targets = [].concat(push).filter(Boolean);
  for (const r of targets) if (!known.includes(r)) throw new Error(`Remoto desconhecido: ${r}`);
  if (pr && !targets.length) throw new Error('Escolha para qual git abrir o pull request.');
  const description = await quiet(projectPath, ['config', '--get', `branch.${wt.branch}.description`]);

  if (await quiet(wt.path, ['status', '--porcelain'])) {
    const text = (message || description.split(/\r?\n/)[0] || wt.branch).trim();
    await run(wt.path, ['add', '-A']);
    await run(wt.path, ['commit', '-m', text]);
  }
  const ahead = Number(await quiet(projectPath, ['rev-list', '--count', `${base}..${wt.branch}`, '--'])) || 0;
  if (!ahead) return { mode: 'nothing', branch: wt.branch, base };
  const title = (message || description.split(/\r?\n/)[0] || wt.branch).trim();

  if (pr) {
    const urls = [];
    for (const remote of targets) {
      try {
        await run(wt.path, ['push', '-u', remote, wt.branch]);
      } catch (error) {
        throw new Error(explainPush(remote, wt.branch, error));
      }
      const url = prUrl((await remotes(projectPath)).find((r) => r.name === remote).url, base, wt.branch);
      if (url) urls.push(url);
    }
    return { mode: 'pr', branch: wt.branch, base, description, url: urls[0] || null, urls, pushed: targets };
  }

  try {
    await run(projectPath, ['merge-tree', '--write-tree', '--name-only', base, wt.branch]);
  } catch (error) {
    throw Object.assign(new Error(`${wt.branch} e ${base} mexeram nas mesmas linhas (conflito).`), { conflict: true });
  }

  let target = (await rawWorktrees(projectPath)).find((w) => w.branch === base);
  let temp = null;
  if (!target) {
    temp = path.join(`${projectPath}.worktrees`, `.integrar-${Date.now()}`);
    await run(projectPath, ['worktree', 'add', temp, base]);
    target = { path: temp, branch: base };
  }
  try {
    if (await quiet(target.path, ['diff', '--cached', '--name-only'])) {
      throw new Error(`A pasta ${target.path} (em ${base}) tem arquivos em stage; eles entrariam no commit. Faça commit ou tire do stage e tente de novo.`);
    }
    try {
      if (squash) {
        await run(target.path, ['merge', '--squash', wt.branch]);
        await run(target.path, ['commit', '-m', [title, description !== title ? description : ''].filter(Boolean).join('\n\n')]);
      } else {
        await run(target.path, ['merge', '--no-ff', '-m', `Merge ${wt.branch}: ${title}`, wt.branch]);
      }
    } catch (error) {
      // Nunca deixa a pasta da base no meio de um merge.
      await quiet(target.path, ['reset', '--merge']);
      if (/would be overwritten|untracked working tree files/i.test(error.message)) {
        throw new Error(`A pasta ${target.path} tem mudanças sem commit nos mesmos arquivos da tarefa. Faça commit delas (ou descarte) e conclua de novo.`);
      }
      throw error;
    }
  } finally {
    if (temp) await quiet(projectPath, ['worktree', 'remove', '--force', temp]);
  }

  const pushed = [];
  const failed = [];
  for (const remote of targets) {
    try {
      await run(projectPath, ['push', remote, base]);
      pushed.push(remote);
    } catch (error) {
      failed.push(explainPush(remote, base, error));
    }
  }
  return { mode: squash ? 'squash' : 'merge', branch: wt.branch, base, description, into: target.path, pushed, failed };
}

// Fim da tarefa: remove a worktree (sem --force: com mudança não commitada, o git recusa) e
// apaga a branch se tudo dela já está na base. Senão a branch fica, e a resposta diz isso.
// base: a escolhida ao concluir (pode não ser a gravada). Worktree de fora do app (ex.: do Claude Code)
// também sai; travada (lock), fica e a resposta diz.
async function finishTask(projectPath, worktreePath, chosenBase) {
  const wt = await requireWorktree(projectPath, worktreePath);
  const base = chosenBase || (await taskBase(projectPath, wt.branch));
  try {
    await run(projectPath, ['worktree', 'remove', wt.path]);
  } catch (error) {
    if (/locked/i.test(error.message)) return { branch: wt.branch, branchKept: true, worktreeKept: 'travada (o Claude Code ainda usa)' };
    if (/modified or untracked/i.test(error.message)) return { branch: wt.branch, branchKept: true, worktreeKept: 'tem arquivos sem commit' };
    throw error;
  }
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

module.exports = { listWorktrees, branches, createWorktree, suggestSetup, diff, diffFile, conclude, concludeInfo, finishTask, removeWorktree };
