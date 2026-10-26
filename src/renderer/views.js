// Visões das tarefas: só desenham. O modelo (tarefas, agentes, estado) e as ações vêm do app.js.
//
// Uma tarefa: { id, name, project, wt (null = raiz do projeto), briefing, agents: [{ tab, state }],
// column, ahead, dirty, managed }. A coluna sai do estado real dos agentes e do git:
// esperando você > trabalhando > pra revisar (parada com mudanças) > parada. Arrastar um card para
// outra coluna faz a ação dela (começar, abrir agente, diff, concluir), não muda a coluna à força.

// Card sendo arrastado. Enquanto houver um, o quadro não redesenha (senão o arraste se perde).
let dragging = null;
export const isDragging = () => !!dragging;

function draggable(payload) {
  return {
    draggable: 'true',
    ondragstart: (e) => {
      dragging = payload;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', 'card');
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => {
      dragging = null;
      e.currentTarget.classList.remove('dragging');
      document.querySelectorAll('.column.drop').forEach((c) => c.classList.remove('drop'));
    },
  };
}

function dropZone(column, actions) {
  return {
    ondragover: (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.currentTarget.classList.add('drop');
    },
    ondragleave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop');
    },
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('drop');
      const drag = dragging;
      dragging = null;
      if (drag) actions.drop(drag, column);
    },
  };
}

export const COLUMNS = [
  { id: 'waiting', label: 'Esperando você', empty: 'Ninguém esperando resposta.' },
  { id: 'busy', label: 'Trabalhando', empty: 'Nenhum agente trabalhando.' },
  { id: 'review', label: 'Pra revisar', empty: 'Nada parado com mudanças.' },
  { id: 'idle', label: 'Parada', empty: 'Nenhuma tarefa parada.' },
];

export const STATE_TEXT = { waiting: 'esperando você', busy: 'trabalhando', done: 'terminou', idle: 'no prompt' };

// "agora", "há 4 min", "há 2 h", "há 3 d".
export function ago(ms) {
  if (!ms) return '';
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `há ${hours} h` : `há ${Math.floor(hours / 24)} d`;
}

// Agente que mais merece sua atenção numa tarefa: o que espera você, depois o que terminou sem ser visto.
export function mainAgent(task) {
  const rank = { waiting: 0, done: 1, busy: 2, idle: 3 };
  return [...task.agents].sort((a, b) => (rank[a.state] ?? 4) - (rank[b.state] ?? 4))[0] || null;
}

function card(task, actions, h) {
  const agent = mainAgent(task);
  const said = agent?.lastMessage;
  return h('article', {
    ...draggable({ kind: 'task', task }),
    class: `card col-${task.column} ${task.agents.some((a) => a.state === 'done') ? 'done' : ''}`,
    style: agent?.account ? `--account: ${agent.account.color}` : null,
    title: [task.wt?.path || task.project.path, task.briefing].filter(Boolean).join('\n\n'),
    onclick: () => (agent ? actions.focus(agent.tab) : actions.openAgent(task)),
  },
  h('header', {},
    h('strong', {}, task.name),
    h('span', { class: 'muted small' }, task.project.name)),
  task.briefing ? h('p', { class: 'briefing' }, task.briefing.split('\n')[0]) : null,
  task.agents.length
    ? h('ul', { class: 'agents' }, task.agents.map((a) => h('li', {
      class: `agent st-${a.state || 'off'}`,
      onclick: (e) => { e.stopPropagation(); actions.focus(a.tab); },
    }, h('span', { class: `dot ${a.tab.kindClass} ${a.state === 'busy' || a.state === 'waiting' ? 'busy' : ''}` }),
    a.account ? h('span', { class: 'account-tag', style: `--account: ${a.account.color}`, title: `Conta: ${a.account.name}` }, a.account.name) : null,
    h('span', { class: 'who' }, a.tab.kindClass === 'codex' ? 'Codex' : 'Claude'),
    h('span', { class: 'state', title: a.since ? new Date(a.since).toLocaleString('pt-BR') : '' },
      [STATE_TEXT[a.state] || 'parado', ago(a.since)].filter(Boolean).join(' · ')))))
    : h('p', { class: 'muted small' }, 'Nenhum agente aberto.'),
  said ? h('blockquote', { class: `said ${said.kind}`, title: said.text },
    said.kind === 'tool' ? (agent.state === 'waiting' ? 'Pediu: ' : 'Última ação: ') : '', said.text) : null,
  h('footer', {},
    task.ahead ? h('span', { class: 'badge', title: 'commits à frente da base' }, `↑${task.ahead}`) : null,
    task.dirty ? h('span', { class: 'badge dirty', title: 'arquivos sem commit' }, `●${task.dirty}`) : null,
    !task.agents.length && task.lastCommitAt ? h('span', { class: 'muted small' }, `commit ${ago(task.lastCommitAt)}`) : null,
    h('span', { class: 'spacer' }),
    task.agents.length ? null : h('button', { title: 'Abrir Claude nessa tarefa', onclick: (e) => { e.stopPropagation(); actions.openAgent(task); } }, 'Abrir Claude'),
    // Agente direto na pasta do projeto: não há worktree para concluir; o fim é fechar os agentes.
    !task.wt && task.agents.length ? h('button', { title: 'Fechar os agentes dessa pasta (o trabalho já está nos arquivos)', onclick: (e) => { e.stopPropagation(); actions.endRoot(task); } }, '■ Encerrar') : null,
    task.wt ? h('button', { title: 'Revisar o que mudou', onclick: (e) => { e.stopPropagation(); actions.diff(task); } }, '± Diff') : null,
    task.wt ? h('button', { title: 'Integrar, enviar para o git e limpar (ou arraste para Concluídas)', onclick: (e) => { e.stopPropagation(); actions.conclude(task); } }, '✓ Concluir') : null));
}

const MODE_TEXT = { merge: 'merge em', squash: 'squash em', pr: 'PR para' };
const DONE_SHOWN = 20;

function todoCard(item, actions, h) {
  return h('article', { ...draggable({ kind: 'todo', item }), class: 'card todo', title: item.briefing || item.name },
    h('header', {},
      h('strong', {}, item.name),
      h('span', { class: 'muted small' }, item.project?.name || 'projeto removido')),
    item.briefing ? h('p', { class: 'briefing' }, item.briefing.split('\n')[0]) : null,
    h('footer', {},
      h('span', { class: 'muted small' }, `na fila ${ago(item.createdAt)}`),
      h('span', { class: 'spacer' }),
      h('button', { title: 'Editar', onclick: () => actions.editTodo(item) }, '✎'),
      h('button', { title: 'Tirar da fila', onclick: () => actions.removeTodo(item) }, '×'),
      item.project
        ? h('button', { class: 'primary', title: 'Criar a worktree e abrir o agente com o briefing', onclick: () => actions.startTodo(item) }, '▶ Começar')
        : h('button', { class: 'primary', title: 'O projeto dessa tarefa saiu da lista: escolha a pasta de novo', onclick: () => actions.chooseProject(item) }, 'Escolher projeto')));
}

function doneCard(item, actions, h) {
  return h('article', { class: `card finished ${item.url ? 'linked' : ''}`, title: [item.briefing, item.url].filter(Boolean).join('\n\n'),
    onclick: () => item.url && actions.openUrl(item.url) },
  h('header', {},
    h('strong', {}, item.name),
    h('span', { class: 'muted small' }, item.projectName)),
  h('footer', {},
    h('span', { class: 'muted small' }, `${MODE_TEXT[item.mode] || item.mode} ${item.base} · ${ago(item.at)}`),
    h('span', { class: 'spacer' }),
    item.url ? h('span', { class: 'badge' }, 'PR ↗') : null,
    h('button', { class: 'ghost', title: 'Tirar do histórico', onclick: (e) => { e.stopPropagation(); actions.removeDone(item); } }, '×')));
}

// Faixa acima das colunas: conversas recentes que não estão em nenhuma aba, com "Reabrir".
function recentStrip(recent, actions, h) {
  if (!recent.length) return null;
  return h('div', { class: 'recent' },
    h('span', { class: 'recent-title', title: 'Conversas do Claude dos últimos 3 dias que não estão abertas. Ctrl+Shift+T reabre a mais recente.' }, 'Conversas fechadas'),
    recent.map((c) => h('button', {
      class: 'recent-item',
      style: c.account?.color ? `--account: ${c.account.color}` : null,
      title: [c.title, c.cwd, c.account && `conta ${c.account.name}`, new Date(c.at).toLocaleString('pt-BR')].filter(Boolean).join('\n'),
      onclick: () => actions.reopen(c),
    }, h('strong', {}, c.title || 'sem título'), h('span', { class: 'muted small' }, `${c.project?.name || ''} · ${ago(c.at)}`), h('span', { class: 'reopen' }, '↺ Reabrir'),
    h('span', {
      class: 'dismiss', role: 'button', title: 'Tirar da lista (a conversa continua salva no Claude)',
      onclick: (e) => { e.stopPropagation(); actions.dismiss(c); },
    }, '×'))));
}

export function renderBoard(root, tasks, actions, h, { backlog = [], done = [], recent = [] } = {}) {
  const counts = Object.fromEntries(COLUMNS.map((c) => [c.id, tasks.filter((t) => t.column === c.id).length]));
  const todoColumn = h('section', { class: 'column col-todo', ...dropZone('todo', actions) },
    h('h3', {}, 'A fazer', h('span', { class: 'count' }, String(backlog.length))),
    h('div', { class: 'cards' },
      backlog.map((item) => todoCard(item, actions, h)),
      h('button', { class: 'add-todo', onclick: () => actions.addTodo() }, '+ adicionar à fila')));
  const doneColumn = h('section', { class: 'column col-finished', title: 'Solte uma tarefa aqui para concluir', ...dropZone('finished', actions) },
    h('h3', {}, 'Concluídas', h('span', { class: 'count' }, String(done.length))),
    h('div', { class: 'cards' }, done.length
      ? [...done.slice(0, DONE_SHOWN).map((item) => doneCard(item, actions, h)),
        done.length > DONE_SHOWN ? h('p', { class: 'muted small empty-col' }, `e mais ${done.length - DONE_SHOWN} antigas`) : null]
      : h('p', { class: 'muted small empty-col' }, 'Nada concluído ainda.')));
  root.replaceChildren(
    h('div', { class: 'toolbar' },
      h('strong', {}, 'Quadro'),
      h('span', { class: 'muted small' }, `${tasks.length} tarefa(s)`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => actions.newTask() }, '+ Nova tarefa')),
    recentStrip(recent, actions, h),
    h('div', { class: 'columns' }, todoColumn, COLUMNS.map((col) =>
      h('section', { class: `column col-${col.id}`, ...dropZone(col.id, actions) },
        h('h3', {}, col.label, h('span', { class: 'count' }, String(counts[col.id]))),
        h('div', { class: 'cards' },
          counts[col.id]
            ? tasks.filter((t) => t.column === col.id).map((t) => card(t, actions, h))
            : h('p', { class: 'muted small empty-col' }, col.empty)))), doneColumn));
}
