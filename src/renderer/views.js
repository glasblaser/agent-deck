// Visões das tarefas: só desenham. O modelo (tarefas, agentes, estado) e as ações vêm do app.js.
//
// Uma tarefa: { id, name, project, wt (null = raiz do projeto), briefing, agents: [{ tab, state }],
// column, ahead, dirty, managed }. A coluna sai do estado real dos agentes e do git, nunca de arrastar:
// esperando você > trabalhando > pra revisar (parada com mudanças) > parada.

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
    class: `card col-${task.column} ${task.agents.some((a) => a.state === 'done') ? 'done' : ''}`,
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
    h('span', { class: 'who' }, a.tab.agentLabel || a.tab.title),
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
    task.wt ? h('button', { title: 'Revisar o que mudou', onclick: (e) => { e.stopPropagation(); actions.diff(task); } }, '± Diff') : null,
    task.managed ? h('button', { title: 'Integrar na base e limpar', onclick: (e) => { e.stopPropagation(); actions.conclude(task); } }, '✓ Concluir') : null));
}

export function renderBoard(root, tasks, actions, h) {
  const counts = Object.fromEntries(COLUMNS.map((c) => [c.id, tasks.filter((t) => t.column === c.id).length]));
  root.replaceChildren(
    h('div', { class: 'toolbar' },
      h('strong', {}, 'Quadro'),
      h('span', { class: 'muted small' }, `${tasks.length} tarefa(s)`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'primary', onclick: () => actions.newTask() }, '+ Nova tarefa')),
    h('div', { class: 'columns' }, COLUMNS.map((col) =>
      h('section', { class: `column col-${col.id}` },
        h('h3', {}, col.label, h('span', { class: 'count' }, String(counts[col.id]))),
        h('div', { class: 'cards' },
          counts[col.id]
            ? tasks.filter((t) => t.column === col.id).map((t) => card(t, actions, h))
            : h('p', { class: 'muted small empty-col' }, col.empty))))));
}
