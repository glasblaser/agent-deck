// Worktree por tarefa: cada tarefa ganha branch task/<nome> numa pasta irmã
// <repo>.worktrees/<nome>, então agentes em paralelo não pisam um no outro.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { slug } = require('./store');

function run(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(stdout);
    });
  });
}

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

async function listWorktrees(projectPath) {
  if (!(await isRepo(projectPath))) return { repo: false, worktrees: [] };
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
  const main = canonical(projectPath);
  return {
    repo: true,
    worktrees: worktrees
      .filter((w) => canonical(w.path) !== main)
      .map((w) => ({ ...w, managed: isManaged(projectPath, w.path) })),
  };
}

async function createWorktree(projectPath, taskName) {
  const name = slug(taskName);
  if (!name) throw new Error('Nome de tarefa inválido.');
  if (!(await isRepo(projectPath))) throw new Error('Esse projeto não é um repositório git.');
  const target = path.join(`${projectPath}.worktrees`, name);
  await run(projectPath, ['worktree', 'add', '-b', `task/${name}`, target]);
  return { path: target, branch: `task/${name}` };
}

// Sem --force: se houver mudança não commitada, o git recusa e o erro volta pra tela.
async function removeWorktree(projectPath, worktreePath) {
  const target = path.resolve(worktreePath);
  if (!isManaged(projectPath, target)) {
    throw new Error('Só removo worktrees criadas pelo app.');
  }
  await run(projectPath, ['worktree', 'remove', target]);
}

module.exports = { listWorktrees, createWorktree, removeWorktree };
