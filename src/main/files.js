// Leitura/escrita de arquivos para o editor. Os caminhos já chegam validados pelo store.
const fs = require('node:fs/promises');
const path = require('node:path');

const HIDDEN = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '__pycache__', '.venv']);
const MAX_SIZE = 5 * 1024 * 1024;

async function list(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !HIDDEN.has(e.name))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), dir: e.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

async function read(file) {
  const stat = await fs.stat(file);
  if (stat.size > MAX_SIZE) throw new Error('Arquivo grande demais para o editor (>5 MB).');
  const buffer = await fs.readFile(file);
  if (buffer.includes(0)) throw new Error('Arquivo binário.');
  return buffer.toString('utf8');
}

async function write(file, content) {
  await fs.writeFile(file, content, 'utf8');
}

module.exports = { list, read, write };
