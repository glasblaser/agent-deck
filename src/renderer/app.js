// UI do Agent Deck: sidebar (projetos/worktrees, contas/uso) e abas (terminal, editor, navegador).
import { Terminal } from '/xterm/lib/xterm.mjs';
import { FitAddon } from '/xterm-fit/lib/addon-fit.mjs';
import { renderBoard, mainAgent } from './views.js';
import { openPalette } from './palette.js';

const deck = window.deck;
const $ = (sel) => document.querySelector(sel);

let state = { profiles: [], projects: [], home: '' };
const worktreesByProject = new Map();
const usageByProfile = new Map();
const tabs = [];
let activeTab = null;
let tabSeq = 0;

// ---------- utilidades ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const basename = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const profileById = (id) => state.profiles.find((p) => p.id === id);

// Cor de cada conta: a escolhida no card da conta ou uma automática pela ordem. Fora da paleta:
// vermelho e amarelo puros, que já querem dizer "esperando você" e "terminou".
const ACCOUNT_COLORS = ['#c792ea', '#89ddff', '#c3e88d', '#f78c6c', '#ff9cac', '#82aaff', '#80cbc4', '#a1887f'];
const profileColor = (profile) => profile?.color || (profile ? ACCOUNT_COLORS[Math.max(0, state.profiles.indexOf(profile)) % ACCOUNT_COLORS.length] : null);
// Conta de uma aba de agente: a escolhida ao abrir, ou a padrão do tipo.
const tabProfile = (tab) => (tab.isAgent ? profileById(tab.profileId) || defaultProfile(tab.kindClass) : profileById(tab.profileId)) || null;

function toast(message, kind = 'error') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

const errorText = (error) => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(errorText(error));
    return undefined;
  }
}

// Mesma pasta ou dentro dela (Windows: sem diferença de maiúsculas nem de barra).
function isInside(child, parent) {
  const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}\\`);
}

// Formulário modal genérico (Electron não tem window.prompt).
function form(title, fields, okLabel = 'OK') {
  const dialog = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-ok').textContent = okLabel;
  $('#modal-error').textContent = '';
  const box = $('#modal-fields');
  box.replaceChildren();
  const inputs = {};
  for (const field of fields) {
    let input;
    if (field.type === 'select') {
      input = h('select', { name: field.name },
        field.options.map((o) => h('option', { value: o.value, selected: o.value === field.value }, o.label)));
      if (field.onChange) input.addEventListener('change', () => field.onChange(input.value, inputs));
    } else if (field.type === 'textarea') {
      input = h('textarea', { name: field.name, rows: 5, placeholder: field.placeholder || '', required: field.required });
      input.value = field.value || '';
    } else {
      input = h('input', { name: field.name, value: field.value || '', placeholder: field.placeholder || '', required: field.required });
    }
    inputs[field.name] = input;
    box.append(h('label', {}, h('span', {}, field.label), input));
  }
  // returnValue sobrevive entre aberturas: sem zerar, Esc depois de um OK anterior contaria como OK.
  dialog.returnValue = '';
  dialog.showModal();
  (Object.values(inputs)[0])?.focus();
  return new Promise((resolve) => {
    const formEl = $('#modal-form');
    const finish = (ok) => {
      formEl.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      resolve(ok ? Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()])) : null);
    };
    // O submit é síncrono; o evento close pode atrasar (ex.: janela em segundo plano). close fica para o Esc.
    const onSubmit = (e) => finish(e.submitter?.value === 'ok');
    const onClose = () => finish(dialog.returnValue === 'ok');
    formEl.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

// ---------- abas ----------

// Painéis: 1, 2 (lado a lado) ou 4 (2×2). Cada painel mostra uma aba; slots[i] é a aba do painel i.
// Os frames nunca mudam de lugar no DOM (mover um <webview> recarrega a página): a posição vem
// do grid, pela ordem do slot, e quem não está em nenhum slot fica escondido.
let layout = 1;
let slots = [null];
let focusedSlot = 0;

// slot: só na restauração (índice do painel, ou -1 para aba fora da tela). Sem ele, a aba nova
// vai para o primeiro painel vazio; se não houver, substitui a do painel focado.
function addTab(tab, slot) {
  tab.id = ++tabSeq;
  tab.pane.classList.add('pane');
  tab.headLabel = h('span', { class: 'label' });
  tab.headDot = h('span', { class: 'dot' });
  tab.headStatus = h('span', { class: 'status' });
  tab.frame = h('div', { class: 'frame', hidden: true, onmousedown: () => focusTab(tab) },
    h('div', { class: 'frame-head' },
      tab.headDot,
      tab.headLabel,
      tab.headStatus,
      tab.pinned ? null : h('button', { class: 'close', title: 'Fechar', onclick: () => closeTab(tab) }, '×')),
    tab.pane);
  $('#panes').append(tab.frame);
  // Aba fixa (o quadro) fica sempre em primeiro.
  if (tab.pinned) tabs.unshift(tab);
  else tabs.push(tab);
  if (slot !== undefined) {
    if (slot >= 0 && slot < layout) slots[slot] = tab;
    layoutPanes();
    return tab;
  }
  const empty = slots.indexOf(null);
  if (empty !== -1) focusedSlot = empty;
  activate(tab);
  return tab;
}

// Mostra a aba: se já está num painel, só foca ele; senão entra no painel focado.
function activate(tab) {
  if (tab) {
    const index = slots.indexOf(tab);
    if (index !== -1) focusedSlot = index;
    else slots[focusedSlot] = tab;
  }
  activeTab = slots[focusedSlot] || null;
  if (activeTab) activeTab.attention = false;
  layoutPanes();
  requestAnimationFrame(() => activeTab?.onShow?.());
}

// Clique dentro de um painel: só troca o foco, sem mexer no layout.
function focusTab(tab) {
  const index = slots.indexOf(tab);
  if (index === -1 || activeTab === tab) return;
  focusedSlot = index;
  activeTab = tab;
  tab.attention = false;
  renderTabs();
}

function setLayout(count) {
  const visible = slots.filter(Boolean);
  const focused = activeTab;
  layout = count;
  // Mantém a aba focada visível e completa os painéis com as abas que já estavam na tela e depois as outras.
  const order = [focused, ...visible, ...tabs].filter((t, i, all) => t && all.indexOf(t) === i);
  slots = Array.from({ length: count }, (_, i) => order[i] || null);
  focusedSlot = Math.max(0, slots.indexOf(focused));
  activeTab = slots[focusedSlot] || null;
  layoutPanes();
  requestAnimationFrame(() => activeTab?.onShow?.());
}

function layoutPanes() {
  const panes = $('#panes');
  panes.dataset.layout = String(layout);
  for (const t of tabs) {
    const index = slots.indexOf(t);
    t.frame.hidden = index === -1;
    t.frame.style.order = String(index);
    t.frame.classList.toggle('focused', index === focusedSlot && layout > 1);
  }
  // Painel sem aba: um espaço reservado clicável, que vira o painel focado.
  for (const el of panes.querySelectorAll('.slot-empty')) el.remove();
  slots.forEach((t, index) => {
    if (t || !tabs.length) return;
    panes.append(h('div', {
      class: `slot-empty ${index === focusedSlot ? 'focused' : ''}`,
      style: `order:${index}`,
      onmousedown: () => { focusedSlot = index; activeTab = null; layoutPanes(); },
    }, 'Painel vazio: clique aqui e escolha uma aba lá em cima'));
  });
  $('#empty').hidden = tabs.length > 0;
  renderTabs();
  saveSession();
}

// ---------- sessão: reabrir as abas na próxima vez ----------

// Fica ligado até a restauração terminar, para o estado vazio do começo não apagar a sessão salva.
let restoring = true;
let saveTimer;

function saveSession() {
  if (restoring) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => deck.session.save({
    layout,
    focusedSlot,
    tabs: tabs.map((t) => {
      const saved = t.persist?.();
      return saved && { ...saved, slot: slots.indexOf(t) };
    }).filter(Boolean),
  }), 400);
}

async function restoreSession() {
  try {
    const saved = await attempt(() => deck.session.load());
    if (!saved?.tabs?.length) return;
    setLayout([1, 2, 4].includes(saved.layout) ? saved.layout : 1);
    for (const t of saved.tabs) {
      const slot = Number.isInteger(t.slot) && t.slot < layout ? t.slot : -1;
      if (t.type === 'browser') openBrowser(t.url, slot);
      else if (t.type === 'editor') openEditor(t.cwd, slot);
      else if (t.type === 'diff') openDiff(t.projectPath, t.cwd, slot);
      else if (t.type === 'board') openBoard(slot);
      else {
        const agent = ['claude', 'codex'].includes(t.type) ? t.type : null;
        openTerminal({ cwd: t.cwd, profileId: t.profileId, agent, resumeId: agent && t.sessionId, slot });
      }
    }
    focusedSlot = Number.isInteger(saved.focusedSlot) && saved.focusedSlot < layout ? saved.focusedSlot : 0;
    activate(null);
  } finally {
    // O quadro é a tela inicial: ao abrir o app ele vem para o painel focado; as abas da sessão
    // continuam lá, a um clique.
    if (!tabs.some((t) => t.viewKind === 'board')) openBoard(-1);
    activate(tabs.find((t) => t.viewKind === 'board'));
    restoring = false;
    saveSession();
  }
}

// quiet: fechamento feito pelo próprio app (concluir tarefa), sem o aviso de conversa salva.
function closeTab(tab, { quiet = false } = {}) {
  if (tab.pinned) return;
  if (tab.isDirty?.() && !confirm(`"${tab.title}" tem alterações não salvas. Fechar mesmo assim?`)) return;
  if (!quiet && tab.isAgent && tab.sessionId && tab.kindClass === 'claude') {
    toast('Conversa salva. Para voltar: Ctrl+Shift+T, ou no Quadro em "Conversas fechadas".', 'info');
    setTimeout(refreshRecent, 1500);
  }
  tab.dispose?.();
  tab.frame.remove();
  tabs.splice(tabs.indexOf(tab), 1);
  const index = slots.indexOf(tab);
  if (index !== -1) {
    // O painel que ficou vago recebe a aba mais recente que não está na tela.
    slots[index] = [...tabs].reverse().find((t) => !slots.includes(t)) || null;
  }
  activate(null);
}

// Estado do agente como você enxerga: esperando você (pediu permissão/resposta) vence tudo,
// depois "terminou" (acabou numa aba que você não estava olhando), depois trabalhando.
function agentState(tab) {
  if (tab.status === 'waiting') return 'waiting';
  if (tab.attention) return 'done';
  if (tab.status === 'busy') return 'busy';
  return tab.status === 'idle' ? 'idle' : null;
}
const STATE_LABEL = { busy: 'trabalhando…', waiting: 'esperando você', done: 'terminou' };
const stateText = (tab) => {
  const state = agentState(tab);
  return state === 'waiting' && tab.waitingFor ? `esperando você: ${tab.waitingFor}` : STATE_LABEL[state] || '';
};

function renderTabs() {
  $('#tabs').replaceChildren(...tabs.map((tab) =>
    h('div', {
      class: `tab ${tab === activeTab ? 'active' : ''} ${slots.includes(tab) ? 'visible' : ''} ${tab.exited ? 'exited' : ''} ${tab.attention ? 'attention' : ''} ${tab.status === 'waiting' ? 'waiting' : ''}`,
      title: [tab.title, tabProfile(tab) && `conta ${tabProfile(tab).name}`, tab.tooltip, stateText(tab)].filter(Boolean).join('\n'),
      'data-status': tab.status || null,
      'data-session': tab.sessionId || null,
      'data-account': tabProfile(tab)?.name || null,
      'data-kind': tab.kindClass || null,
      style: tabProfile(tab) ? `--account: ${profileColor(tabProfile(tab))}` : null,
      onclick: () => activate(tab),
      onauxclick: (e) => e.button === 1 && closeTab(tab),
    },
    h('span', { class: `dot ${tab.kindClass || ''} ${tab.status === 'busy' ? 'busy' : ''}` }),
    h('span', { class: 'label' }, tab.shortTitle || tab.title),
    tab.pinned ? null : h('button', { class: 'close', title: 'Fechar', onclick: (e) => { e.stopPropagation(); closeTab(tab); } }, '×'))));
  for (const tab of tabs) {
    tab.headLabel.textContent = tab.title;
    tab.headLabel.title = tab.tooltip || tab.title;
    tab.headDot.className = `dot ${tab.kindClass || ''} ${tab.status === 'busy' ? 'busy' : ''}`;
    const account = tabProfile(tab);
    tab.frame.style.setProperty('--account', account ? profileColor(account) : 'transparent');
    tab.headStatus.textContent = stateText(tab);
    tab.headStatus.classList.toggle('attention', !!tab.attention);
    tab.headStatus.classList.toggle('waiting', tab.status === 'waiting');
    tab.frame.classList.toggle('exited', !!tab.exited);
  }
  for (const button of document.querySelectorAll('#layouts button')) {
    button.classList.toggle('on', Number(button.dataset.layout) === layout);
  }
  // A aba ativa sempre à vista, mesmo com a barra rolada.
  $('#tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  refreshViews();
}

// ---------- terminal ----------

const terminalsByPty = new Map();

const AGENTS = {
  claude: { label: 'Claude', kind: 'claude' },
  codex: { label: 'Codex', kind: 'codex' },
  'codex-login': { label: 'Login Codex', kind: 'codex' },
};

// briefing: primeira mensagem para o Claude, enviada quando ele chega no prompt (ver deliverBriefing).
function openTerminal({ cwd, profileId, agent, resumeId, slot, briefing, prepare }) {
  const pane = h('div', { class: 'terminal' });
  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: false,
    scrollback: 10000,
    theme: { background: '#14161a', foreground: '#d7dae0', cursor: '#e6b450', selectionBackground: '#3a3f4b' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const profile = profileById(profileId);
  const what = agent ? AGENTS[agent].label : 'Terminal';
  const tab = {
    pane,
    title: [what, profile?.name, basename(cwd)].filter(Boolean).join(' · '),
    agentLabel: [what, profile?.name].filter(Boolean).join(' · '),
    // Na barra de abas basta a pasta: a bolinha diz o tipo (Claude/Codex/terminal) e o sublinhado, a conta.
    shortTitle: basename(cwd),
    tooltip: cwd,
    profileId: profileId || null,
    kindClass: agent ? AGENTS[agent].kind : 'shell',
    cwd,
    term,
    isAgent: !!agent && agent !== 'codex-login',
    briefing: agent === 'claude' ? briefing || null : null,
    // Reabre como estava: agente com o id da conversa, terminal na mesma pasta e conta. Login não volta.
    persist: () => (agent === 'codex-login' ? null
      : { type: agent || 'terminal', cwd, profileId: profileId || null, sessionId: tab.sessionId || null }),
    onShow: () => {
      fit.fit();
      term.focus();
    },
    dispose: () => {
      observer.disconnect();
      if (tab.ptyId) deck.pty.kill(tab.ptyId);
      term.dispose();
    },
  };
  addTab(tab, slot);
  term.open(pane);
  fit.fit();

  // Ctrl+C copia quando há seleção; Ctrl+V cola. Sem seleção, Ctrl+C vai pro processo.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    if (e.key === 'c' && term.hasSelection()) {
      navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    // paste() aplica bracketed paste quando o programa pede: colar várias linhas no agente não envia cada uma.
    if (e.key === 'v') {
      navigator.clipboard.readText().then((text) => tab.ptyId && text && term.paste(text));
      return false;
    }
    return true;
  });

  // Botão direito: copiar e mandar texto para outra aba de agente.
  pane.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const selection = term.getSelection();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Copiar', disabled: !selection, onclick: () => navigator.clipboard.writeText(selection) },
      { label: 'Colar', onclick: () => navigator.clipboard.readText().then((text) => tab.ptyId && text && term.paste(text)) },
      ...sendItems(tab, 'Enviar seleção para', selection && (() => selection)),
      ...sendItems(tab, 'Enviar área de transferência para', () => navigator.clipboard.readText()),
    ]);
  });

  const observer = new ResizeObserver(() => {
    if (pane.hidden || !pane.offsetWidth) return;
    fit.fit();
  });
  observer.observe(pane);
  // Qualquer mudança de tamanho do xterm (observer, onShow, fonte carregando) vai para o pty.
  // Se o pty não souber, o agente desenha para um terminal menor e o prompt fica no meio da tela.
  term.onResize(({ cols, rows }) => {
    pane.dataset.size = `${cols}x${rows}`;
    if (tab.ptyId) deck.pty.resize(tab.ptyId, cols, rows);
  });

  attempt(() => deck.pty.spawn({ cwd, profileId, agent, resumeId, prepare: !!prepare, cols: term.cols, rows: term.rows })).then((res) => {
    if (!res) {
      term.write('\r\n\x1b[31mNão foi possível abrir o terminal.\x1b[0m\r\n');
      return;
    }
    tab.ptyId = res.id;
    tab.sessionId = res.sessionId;
    saveSession();
    terminalsByPty.set(res.id, { term, tab });
    term.onData((data) => deck.pty.write(res.id, data));
    // O tamanho pode ter mudado enquanto o pty abria (ptyId ainda vazio): sincroniza agora.
    deck.pty.resize(res.id, term.cols, term.rows);
  });
  return tab;
}

// ---------- troca de texto entre agentes ----------

// Só abas de agente recebem: num terminal puro o texto colado viraria comando do shell.
function agentTargets(from) {
  return tabs.filter((t) => t !== from && t.isAgent && t.ptyId && !t.exited);
}

// Cola no prompt do agente de destino, com a origem no topo, e leva você até lá.
// Não aperta Enter: você revisa e envia.
// Só com bracketed paste ligado: sem ele cada quebra de linha vira Enter, e num diálogo
// (ex.: "trust this folder", com "No, exit" selecionado) isso responderia por você.
// O bracketed paste sozinho não prova que o agente está no prompt: o pwsh já liga o modo antes
// do agente abrir. No Claude o sinal confiável é o status do arquivo de sessão, que só existe
// depois do "trust this folder" e some quando ele sai. O Codex não publica nada: fica só o bracketed paste.
async function sendToAgent(from, target, getText) {
  const text = (await attempt(getText))?.trim();
  if (!text) return toast('Nada para enviar.');
  if (!target.ptyId) return toast('A aba de destino foi encerrada.');
  if (target.kindClass === 'claude' && !['idle', 'busy'].includes(target.status)) {
    activate(target);
    return toast(target.status === 'off'
      ? 'O Claude dessa aba saiu (a aba voltou ao shell). Nada foi colado.'
      : 'O Claude de destino ainda não chegou no prompt (carregando ou no diálogo "trust this folder"). Nada foi colado.');
  }
  if (!target.term.modes.bracketedPasteMode) {
    activate(target);
    return toast('O agente de destino não está no prompt (diálogo aberto ou ainda carregando). Nada foi colado.');
  }
  target.term.paste(`[Recebido da aba "${from.title}"]\n${text}`);
  activate(target);
}

function sendItems(from, label, getText) {
  const targets = agentTargets(from);
  if (!getText || !targets.length) {
    return [{ label, disabled: true, hint: !targets.length ? 'nenhuma outra aba de agente' : 'nada selecionado' }];
  }
  return [{ label, header: true }, ...targets.map((t) => ({
    label: t.title, kindClass: t.kindClass, indent: true, onclick: () => sendToAgent(from, t, getText),
  }))];
}

function contextMenu(x, y, items) {
  document.querySelector('.context-menu')?.remove();
  const menu = h('div', { class: 'context-menu' }, items.map((item) => {
    if (item.header) return h('div', { class: 'menu-header' }, item.label);
    return h('button', {
      class: item.indent ? 'indent' : null,
      disabled: item.disabled,
      onclick: () => { menu.remove(); item.onclick?.(); },
    },
    item.kindClass ? h('span', { class: `dot ${item.kindClass}` }) : null,
    h('span', {}, item.label),
    item.hint ? h('span', { class: 'muted small' }, item.hint) : null);
  }));
  document.body.append(menu);
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - height - 4)}px`;
  const close = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'mousedown' && menu.contains(e.target)) return;
    menu.remove();
    removeEventListener('mousedown', close, true);
    removeEventListener('keydown', close, true);
    removeEventListener('blur', close);
  };
  addEventListener('mousedown', close, true);
  addEventListener('keydown', close, true);
  addEventListener('blur', close);
}

deck.pty.onData((id, data) => {
  const entry = terminalsByPty.get(id);
  if (!entry) return;
  entry.tab.lastOutput = Date.now();
  entry.term.write(data);
});

// Briefing de tarefa nova: cola e envia quando o Claude chega no prompt. O sinal é o primeiro
// status do arquivo de sessão, que só nasce depois do diálogo "trust this folder" (worktree nova
// sempre passa por ele); o bracketed paste não serve, o próprio pwsh já liga. Antes disso, o texto
// cairia no diálogo. Espera ainda a tela parar de mudar, para não colar no meio do desenho do prompt.
function deliverBriefing(tab) {
  const text = tab.briefing;
  tab.briefing = null;
  const tick = () => {
    if (!tab.ptyId) return;
    if (Date.now() - (tab.lastOutput || 0) < 800) return setTimeout(tick, 200);
    tab.term.paste(text);
    setTimeout(() => tab.ptyId && deck.pty.write(tab.ptyId, '\r'), 400);
  };
  tick();
}
// Notificação do Windows (e a barra de tarefas piscando) só quando o app está em segundo plano;
// com ele na frente, o destaque na aba basta. Clicar na notificação traz o app e abre a aba.
function notify(tab, title, body) {
  if (!document.hasFocus()) deck.window.notify(title, body, tab.id);
}
deck.window.onOpenTab((tabId) => {
  const tab = tabs.find((t) => t.id === tabId);
  if (tab) activate(tab);
});

// Status vindo do main: id de sessão (pode mudar com /clear ou /resume), trabalhando/ocioso e
// esperando você (permissão). Agente que termina numa aba que você não está olhando ganha o aviso
// "terminou" até receber foco.
deck.pty.onStatus((id, info) => {
  const tab = terminalsByPty.get(id)?.tab;
  if (!tab) return;
  const sessionChanged = info.sessionId && info.sessionId !== tab.sessionId;
  const unseen = tab !== activeTab || !document.hasFocus();
  if (tab.status === 'busy' && info.status === 'idle') {
    if (unseen) tab.attention = true;
    notify(tab, `${tab.title} terminou`, 'O agente parou e está no prompt.');
  }
  if (info.status === 'waiting' && tab.status !== 'waiting') {
    notify(tab, `${tab.title} está esperando você`, `Pediu: ${info.waitingFor || 'uma resposta'}.`);
  }
  const previous = tab.status;
  tab.waitingFor = info.waitingFor || null;
  tab.lastMessage = info.lastMessage || null;
  tab.status = info.status;
  if (previous !== info.status) tab.statusSince = Date.now();
  if (info.sessionId) tab.sessionId = info.sessionId;
  if (tab.briefing && info.status === 'idle') deliverBriefing(tab);
  // Parou (terminou ou pediu algo): é quando commits e arquivos mudam; atualiza os contadores da tarefa.
  if (['idle', 'waiting'].includes(info.status) && previous === 'busy') {
    const project = state.projects.find((p) => (worktreesByProject.get(p.id) || []).some((w) => isInside(tab.cwd, w.path)));
    if (project) loadWorktrees(project).then(renderProjects);
  }
  renderTabs();
  if (sessionChanged) saveSession();
});

deck.pty.onExit((id, code) => {
  const entry = terminalsByPty.get(id);
  if (!entry) return;
  entry.term.write(`\r\n\x1b[90m[processo encerrado: ${code}]\x1b[0m\r\n`);
  entry.tab.exited = true;
  entry.tab.ptyId = null;
  terminalsByPty.delete(id);
  renderTabs();
});

// ---------- editor (Monaco) ----------

let monacoReady;

function loadMonaco() {
  if (monacoReady) return monacoReady;
  monacoReady = new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: '/monaco/vs/editor/editor.main.css' }));
    const script = h('script', { src: '/monaco/vs/loader.js' });
    script.onload = () => {
      window.require.config({ paths: { vs: '/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    script.onerror = reject;
    document.head.append(script);
  });
  return monacoReady;
}

async function openEditor(root, slot) {
  const tree = h('div', { class: 'tree' });
  const pathLabel = h('span', { class: 'path muted' }, 'Selecione um arquivo');
  const saveButton = h('button', { disabled: true, title: 'Salvar (Ctrl+S)' }, 'Salvar');
  const host = h('div', { class: 'monaco' });
  const pane = h('div', { class: 'editor' },
    h('div', { class: 'toolbar' },
      pathLabel,
      h('span', { class: 'spacer' }),
      saveButton,
      h('button', { onclick: () => attempt(() => deck.open.vscode(root)) }, 'Abrir no VS Code')),
    h('div', { class: 'editor-body' }, tree, host));

  const models = new Map();
  let editor;
  let current = null;

  const tab = addTab({
    pane,
    title: `Editor · ${basename(root)}`,
    shortTitle: basename(root),
    tooltip: root,
    kindClass: 'editor',
    cwd: root,
    persist: () => ({ type: 'editor', cwd: root }),
    onShow: () => editor?.layout(),
    isDirty: () => [...models.values()].some((m) => m.dirty()),
    dispose: () => {
      for (const m of models.values()) m.model.dispose();
      editor?.dispose();
    },
  }, slot);

  const monaco = await loadMonaco();
  editor = monaco.editor.create(host, {
    theme: 'vs-dark',
    automaticLayout: true,
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: 13,
    minimap: { enabled: false },
  });

  const refreshStatus = () => {
    const entry = current && models.get(current);
    saveButton.disabled = !entry?.dirty();
    pathLabel.textContent = current ? `${current}${entry?.dirty() ? '  ●' : ''}` : 'Selecione um arquivo';
  };

  async function save() {
    const entry = current && models.get(current);
    if (!entry) return;
    await attempt(async () => {
      await deck.fs.write(current, entry.model.getValue());
      entry.savedVersion = entry.model.getAlternativeVersionId();
      refreshStatus();
    });
  }
  saveButton.addEventListener('click', save);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);

  async function openFile(file) {
    if (!models.has(file)) {
      const content = await attempt(() => deck.fs.read(file));
      if (content === undefined) return;
      const model = monaco.editor.createModel(content, undefined, monaco.Uri.file(file));
      const entry = { model, savedVersion: model.getAlternativeVersionId() };
      entry.dirty = () => entry.model.getAlternativeVersionId() !== entry.savedVersion;
      model.onDidChangeContent(refreshStatus);
      models.set(file, entry);
    }
    current = file;
    editor.setModel(models.get(file).model);
    for (const el of tree.querySelectorAll('.file.selected')) el.classList.remove('selected');
    tree.querySelector(`[data-path="${CSS.escape(file)}"]`)?.classList.add('selected');
    refreshStatus();
    editor.focus();
  }

  async function renderDir(dir, container, depth) {
    const entries = await attempt(() => deck.fs.list(dir));
    if (!entries) return;
    container.replaceChildren(...entries.map((entry) => {
      const row = h('div', {
        class: entry.dir ? 'dir' : 'file',
        'data-path': entry.path,
        style: `padding-left:${8 + depth * 12}px`,
      }, entry.dir ? '▸ ' : '', entry.name);
      if (!entry.dir) {
        row.addEventListener('click', () => openFile(entry.path));
        return row;
      }
      const children = h('div', { hidden: true });
      row.addEventListener('click', async () => {
        const opening = children.hidden;
        children.hidden = !opening;
        row.firstChild.textContent = opening ? '▾ ' : '▸ ';
        if (opening && !children.dataset.loaded) {
          children.dataset.loaded = '1';
          await renderDir(entry.path, children, depth + 1);
        }
      });
      return h('div', {}, row, children);
    }));
  }

  await renderDir(root, tree, 0);
  return tab;
}

// ---------- diff da tarefa ----------

const STATUS_NAME = { A: 'adicionado', M: 'modificado', D: 'apagado', T: 'tipo mudou', '?': 'novo, sem git add' };

// Tudo que a worktree mudou desde que saiu da base, commitado ou não, lado a lado.
async function openDiff(projectPath, worktreePath, slot) {
  const list = h('div', { class: 'tree' });
  const summary = h('span', { class: 'path muted' }, 'Carregando…');
  const host = h('div', { class: 'monaco' });
  const concludeButton = h('button', { class: 'primary', title: 'Integrar na base e limpar' }, 'Concluir tarefa…');
  const pane = h('div', { class: 'editor' },
    h('div', { class: 'toolbar' },
      summary,
      h('span', { class: 'spacer' }),
      h('button', { title: 'Ler de novo o que mudou', onclick: () => refresh() }, '↻ Atualizar'),
      concludeButton),
    h('div', { class: 'editor-body' }, list, host));

  let editor;
  let data;
  let current = null;
  const disposeModels = () => {
    const models = editor?.getModel();
    editor?.setModel(null);
    models?.original.dispose();
    models?.modified.dispose();
  };
  const tab = addTab({
    pane,
    title: `Diff · ${basename(worktreePath)}`,
    shortTitle: `± ${basename(worktreePath)}`,
    tooltip: worktreePath,
    kindClass: 'diff',
    cwd: worktreePath,
    persist: () => ({ type: 'diff', cwd: worktreePath, projectPath }),
    onShow: () => editor?.layout(),
    dispose: () => {
      disposeModels();
      editor?.dispose();
    },
  }, slot);

  concludeButton.addEventListener('click', () => {
    const project = state.projects.find((p) => p.path === projectPath);
    const wt = (worktreesByProject.get(project?.id) || []).find((w) => isInside(w.path, worktreePath));
    if (!project || !wt) return toast('Essa worktree não está mais na lista do projeto.');
    if (!wt.managed) return toast('Worktree criada fora do app: conclua por onde ela foi criada.');
    concludeTask(project, wt);
  });

  const monaco = await loadMonaco();
  editor = monaco.editor.createDiffEditor(host, {
    theme: 'vs-dark',
    automaticLayout: true,
    readOnly: true,
    originalEditable: false,
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: 13,
    minimap: { enabled: false },
  });

  async function show(file) {
    const content = await attempt(() => deck.git.diffFile(projectPath, worktreePath, data.mergeBase, file.path));
    if (!content) return;
    current = file.path;
    disposeModels();
    // Uri por aba e lado: o Monaco tira a linguagem da extensão e não aceita dois modelos com a mesma.
    const uri = (side) => monaco.Uri.from({ scheme: 'diff', path: `/${tab.id}/${side}/${file.path}` });
    editor.setModel({
      original: monaco.editor.createModel(content.original, undefined, uri('a')),
      modified: monaco.editor.createModel(content.modified, undefined, uri('b')),
    });
    for (const el of list.querySelectorAll('.file')) el.classList.toggle('selected', el.dataset.path === file.path);
  }

  async function refresh() {
    data = await attempt(() => deck.git.diff(projectPath, worktreePath));
    if (!data) {
      summary.textContent = 'Não foi possível ler o diff.';
      return;
    }
    summary.textContent = `${data.branch} vs ${data.base} · ${data.files.length} arquivo(s)`;
    list.replaceChildren(...data.files.map((f) => h('div', {
      class: 'file', 'data-path': f.path, title: `${f.path} (${STATUS_NAME[f.status] || f.status})`, onclick: () => show(f),
    }, h('span', { class: `st st-${f.status === '?' ? 'u' : f.status.toLowerCase()}` }, f.status === '?' ? 'U' : f.status), ' ', f.path)));
    if (!data.files.length) {
      disposeModels();
      list.append(h('div', { class: 'muted hint pad' }, 'Nada mudou em relação à base.'));
      return;
    }
    const again = data.files.find((f) => f.path === current) || data.files[0];
    await show(again);
  }

  await refresh();
  return tab;
}

// ---------- navegador ----------

function normalizeUrl(text) {
  const value = text.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function openBrowser(url = 'https://www.google.com', slot) {
  const address = h('input', { class: 'address', value: url, spellcheck: 'false' });
  const view = h('webview', { src: url, partition: 'persist:browser', allowpopups: false });
  const pane = h('div', { class: 'browser' },
    h('div', { class: 'toolbar' },
      h('button', { title: 'Voltar', onclick: () => view.canGoBack() && view.goBack() }, '←'),
      h('button', { title: 'Avançar', onclick: () => view.canGoForward() && view.goForward() }, '→'),
      h('button', { title: 'Recarregar', onclick: () => view.reload() }, '↻'),
      address,
      h('button', { title: 'Abrir no navegador do sistema', onclick: () => deck.open.external(view.getURL()) }, '↗'),
      h('button', { title: 'DevTools', onclick: () => view.openDevTools() }, '⚙')),
    view);

  const tab = addTab({
    pane,
    title: 'Navegador',
    kindClass: 'browser',
    onShow: () => {},
    persist: () => ({ type: 'browser', url: address.value }),
  }, slot);
  address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') view.loadURL(normalizeUrl(address.value));
  });
  view.addEventListener('did-navigate', (e) => {
    address.value = e.url;
    saveSession();
  });
  view.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) address.value = e.url; });
  view.addEventListener('page-title-updated', (e) => {
    tab.title = e.title.slice(0, 40) || 'Navegador';
    renderTabs();
  });
  return tab;
}

// ---------- sidebar: projetos e worktrees ----------

function locations() {
  const list = [];
  for (const project of state.projects) {
    list.push({ value: project.path, label: project.name });
    for (const wt of worktreesByProject.get(project.id) || []) {
      list.push({ value: wt.path, label: `   ↳ ${wt.branch || basename(wt.path)}` });
    }
  }
  return list;
}

async function loadWorktrees(project) {
  const res = await attempt(() => deck.git.worktrees(project.path));
  project.isRepo = !!res?.repo;
  worktreesByProject.set(project.id, res?.worktrees || []);
}

function defaultProfile(kind) {
  return state.profiles.find((p) => p.kind === kind && p.isDefault) || state.profiles.find((p) => p.kind === kind);
}

function agentButtons(cwd) {
  return h('span', { class: 'actions' },
    h('button', { title: 'Abrir Claude aqui', onclick: (e) => { e.stopPropagation(); newTabDialog({ cwd, type: 'claude' }); } }, 'C'),
    h('button', { title: 'Abrir Codex aqui', onclick: (e) => { e.stopPropagation(); newTabDialog({ cwd, type: 'codex' }); } }, 'X'),
    h('button', { title: 'Terminal aqui', onclick: (e) => { e.stopPropagation(); openTerminal({ cwd }); } }, '>_'),
    h('button', { title: 'Editor aqui', onclick: (e) => { e.stopPropagation(); openEditor(cwd); } }, '✎'));
}

function renderProjects() {
  const list = $('#projects');
  if (!state.projects.length) {
    list.replaceChildren(h('li', { class: 'muted hint' }, 'Clique em + para adicionar uma pasta.'));
    return;
  }
  list.replaceChildren(...state.projects.map((project) => {
    const worktrees = worktreesByProject.get(project.id) || [];
    return h('li', { class: 'project' },
      h('div', { class: 'row', title: project.path },
        h('strong', {}, project.name),
        agentButtons(project.path),
        project.isRepo ? h('button', {
          class: `ghost setup ${project.setup ? 'on' : ''}`,
          title: project.setup ? `Preparo de worktree: ${setupSummary(project.setup)}` : 'Configurar preparo de worktree nova (.env, npm ci…)',
          onclick: () => editSetup(project),
        }, '⚙') : null,
        h('button', { class: 'ghost', title: 'Remover do app (não apaga nada)', onclick: () => removeProject(project) }, '×')),
      project.isRepo
        ? h('button', { class: 'new-task', onclick: () => newTask(project) }, '+ nova tarefa (worktree)')
        : h('div', { class: 'muted hint' }, 'Sem git: worktrees indisponíveis'),
      h('ul', { class: 'worktrees' }, worktrees.map((wt) =>
        h('li', { class: 'row', title: [wt.path, wt.description].filter(Boolean).join('\n\n') },
          h('span', { class: 'branch' }, (wt.branch || basename(wt.path)).replace(/^task\//, '')),
          wt.ahead ? h('span', { class: 'badge', title: `${wt.ahead} commit(s) à frente de ${wt.base}` }, `↑${wt.ahead}`) : null,
          wt.dirty ? h('span', { class: 'badge dirty', title: `${wt.dirty} arquivo(s) sem commit` }, `●${wt.dirty}`) : null,
          agentButtons(wt.path),
          h('span', { class: 'actions' },
            h('button', { title: 'Revisar o que a tarefa mudou (diff)', onclick: () => openDiff(project.path, wt.path) }, '±'),
            wt.managed ? h('button', { title: 'Concluir tarefa: integrar na base e limpar', onclick: () => concludeTask(project, wt) }, '✓') : null),
          wt.managed
            ? h('button', { class: 'ghost', title: 'Remover worktree', onclick: () => removeWorktree(project, wt) }, '×')
            : h('span', { class: 'external muted small', title: `Criada fora do app (${wt.path}); remova por onde ela foi criada.` }, 'externa')))));
  }));
  refreshViews();
}

// ---------- tarefas: modelo comum do quadro e do escritório ----------

// Cada worktree de cada projeto é uma tarefa, com as abas de agente abertas nela e uma coluna
// derivada do estado real. Agentes rodando direto na pasta do projeto viram a "tarefa" raiz dele.
function taskModel() {
  const list = [];
  const agentsIn = (match) => tabs.filter((t) => t.isAgent && t.cwd && match(t.cwd))
    .map((tab) => {
      const account = tabProfile(tab);
      return { tab, state: agentState(tab), since: tab.statusSince || null, lastMessage: tab.lastMessage || null,
        account: account && { name: account.name, color: profileColor(account) } };
    });
  const columnOf = (agents, changed) => {
    const states = agents.map((a) => a.state);
    if (states.includes('waiting')) return 'waiting';
    if (states.includes('busy')) return 'busy';
    return changed ? 'review' : 'idle';
  };
  for (const project of state.projects) {
    const worktrees = worktreesByProject.get(project.id) || [];
    const rootAgents = agentsIn((cwd) => isInside(cwd, project.path) && !worktrees.some((w) => isInside(cwd, w.path)));
    if (rootAgents.length) {
      list.push({ id: project.path, name: `${project.name} (raiz)`, project, wt: null, briefing: '', agents: rootAgents,
        column: columnOf(rootAgents, false), ahead: 0, dirty: 0, managed: false });
    }
    for (const wt of worktrees) {
      const agents = agentsIn((cwd) => isInside(cwd, wt.path));
      list.push({
        id: wt.path, name: (wt.branch || basename(wt.path)).replace(/^task\//, ''), project, wt,
        briefing: wt.description || '', agents, column: columnOf(agents, wt.ahead || wt.dirty),
        ahead: wt.ahead || 0, dirty: wt.dirty || 0, managed: !!wt.managed, lastCommitAt: wt.lastCommitAt || null,
      });
    }
  }
  return list;
}

const taskActions = {
  focus: (tab) => tabs.includes(tab) && activate(tab),
  openAgent: (task) => newTabDialog({ cwd: task.wt?.path || task.project.path, type: 'claude' }),
  diff: (task) => openDiff(task.project.path, task.wt.path),
  conclude: (task) => concludeTask(task.project, task.wt),
  newTask: () => newTaskAnywhere(),
  addTodo: () => editTodo(),
  editTodo: (item) => editTodo(item),
  removeTodo: async (item) => {
    if (!confirm(`Tirar "${item.name}" da fila?`)) return;
    const next = await attempt(() => deck.tasks.removeBacklog(item.id));
    if (next) setBoardData(next);
  },
  startTodo: async (item) => {
    const project = backlogProject(item);
    if (!project?.isRepo) return toast('O projeto dessa tarefa não está mais cadastrado (ou não tem git).');
    if (!(await newTask(project, item))) return;
    const next = await attempt(() => deck.tasks.removeBacklog(item.id));
    if (next) setBoardData(next);
  },
  removeDone: async (item) => {
    const next = await attempt(() => deck.tasks.removeDone(item.id));
    if (next) setBoardData(next);
  },
  openUrl: (url) => openBrowser(url),
  reopen: (c) => reopenConversation(c),
  chooseProject: (item) => editTodo(item),
  endRoot: (task) => {
    const running = task.agents.filter((a) => ['busy', 'waiting'].includes(a.state)).length;
    const message = [
      `Encerrar ${task.agents.length === 1 ? 'o agente' : `os ${task.agents.length} agentes`} em ${task.project.name}?`,
      'O que foi feito já está nos arquivos da pasta: isso só fecha as abas. A conversa continua salva no Claude (/resume).',
      running ? `Atenção: ${running === 1 ? 'um deles ainda está' : `${running} ainda estão`} trabalhando ou esperando você e vai ser interrompido.` : '',
    ].filter(Boolean).join('\n\n');
    if (!confirm(message)) return;
    for (const a of task.agents) closeTab(a.tab);
  },
};

// Projeto de um card da fila: pelo id, ou pela pasta (o projeto saiu da lista e foi cadastrado de novo).
function backlogProject(item) {
  return state.projects.find((p) => p.id === item.projectId)
    || (item.projectPath && state.projects.find((p) => p.path.toLowerCase() === item.projectPath.toLowerCase()))
    || null;
}

// ---------- conversas fechadas: reabrir o que saiu das abas ----------

let recentConversations = [];
async function refreshRecent() {
  const list = await attempt(() => deck.agents.recent());
  if (!list) return;
  recentConversations = list;
  refreshViews();
}

// Recentes que não estão abertas em nenhuma aba (uma por conversa).
function recentClosed() {
  const open = new Set(tabs.map((t) => t.sessionId).filter(Boolean));
  return recentConversations.filter((c) => !open.has(c.sessionId)).slice(0, 8).map((c) => ({
    ...c,
    project: state.projects.find((p) => isInside(c.cwd, p.path) || isInside(c.cwd, `${p.path}.worktrees`)) || null,
    account: profileById(c.profileId),
  }));
}

function reopenConversation(c) {
  openTerminal({ cwd: c.cwd, profileId: c.profileId, agent: 'claude', resumeId: c.sessionId });
}

function setBoardData(next) {
  state.backlog = next.backlog;
  state.done = next.done;
  refreshViews();
}

// Item de "A fazer": nome, projeto e briefing, sem worktree ainda.
// Seletor de projeto com "Outra pasta…" no fim: a pasta escolhida no Windows vira projeto na hora.
// Tarefa vira worktree, então só entra pasta com git.
function projectField(name, value) {
  const repos = state.projects.filter((p) => p.isRepo);
  return {
    name, label: 'Projeto', type: 'select', value: value || repos[0]?.id || '',
    options: [
      ...(repos.length ? [] : [{ value: '', label: 'Escolha uma pasta…' }]),
      ...repos.map((p) => ({ value: p.id, label: p.name })),
      { value: PICK_FOLDER, label: 'Outra pasta…' },
    ],
    onChange: (picked, inputs) => (picked === PICK_FOLDER ? pickProjectInto(inputs[name]) : (inputs[name].dataset.previous = picked)),
  };
}

async function pickProjectInto(select) {
  const previous = select.dataset.previous ?? [...select.options].find((o) => o.defaultSelected)?.value ?? '';
  const added = await attempt(() => deck.projects.add());
  if (!added) {
    select.value = previous;
    return;
  }
  await refreshState();
  const project = state.projects.find((p) => p.id === added.id);
  if (!project?.isRepo) {
    select.value = previous;
    toast(`"${added.name}" não é um repositório git, e tarefa vira worktree. Rode "git init" nela (e um primeiro commit) antes.`);
    return;
  }
  if (![...select.options].some((o) => o.value === project.id)) {
    select.insertBefore(h('option', { value: project.id }, project.name), select.querySelector(`option[value="${PICK_FOLDER}"]`));
  }
  select.value = project.id;
  select.dataset.previous = project.id;
}

async function editTodo(item) {
  const values = await form(item ? 'Editar tarefa da fila' : 'Nova tarefa na fila (A fazer)', [
    { name: 'name', label: 'Nome', required: true, value: item?.name, placeholder: 'ex.: corrigir-login' },
    projectField('projectId', item?.projectId),
    { name: 'briefing', label: 'O que fazer (vira a primeira mensagem do agente ao começar)', type: 'textarea', value: item?.briefing },
  ], item ? 'Salvar' : 'Adicionar');
  if (!values?.name) return;
  if (!values.projectId || values.projectId === PICK_FOLDER) return toast('Escolha o projeto da tarefa.');
  const next = await attempt(() => (item ? deck.tasks.updateBacklog(item.id, values) : deck.tasks.addBacklog(values)));
  if (next) setBoardData(next);
}

// Visões vivas (quadro, escritório): redesenham sempre que abas, status ou worktrees mudam.
const liveViews = new Set();
let viewsQueued = false;
function refreshViews() {
  if (viewsQueued || !liveViews.size) return;
  viewsQueued = true;
  requestAnimationFrame(() => {
    viewsQueued = false;
    const tasks = taskModel();
    for (const render of liveViews) render(tasks);
  });
}

// Uma aba de visão por tipo: abrir de novo só traz a que já existe.
function openView(kind, title, draw, slot, { pinned = false } = {}) {
  const existing = tabs.find((t) => t.viewKind === kind);
  if (existing) return activate(existing);
  const pane = h('div', { class: `view view-${kind}` });
  const render = (tasks) => draw(pane, tasks);
  const tab = addTab({
    pane,
    title,
    kindClass: 'view',
    viewKind: kind,
    pinned,
    persist: () => ({ type: kind }),
    onShow: () => render(taskModel()),
    dispose: () => liveViews.delete(render),
  }, slot);
  liveViews.add(render);
  render(taskModel());
  return tab;
}

function openBoard(slot) {
  return openView('board', 'Quadro', (pane, tasks) => renderBoard(pane, tasks, taskActions, h, {
    backlog: (state.backlog || []).map((b) => ({ ...b, project: backlogProject(b) })),
    recent: recentClosed(),
    done: [...(state.done || [])].reverse(),
  }), slot, { pinned: true });
}

// Nova tarefa sem estar num projeto: com um repositório só, vai direto; com vários, pergunta qual.
async function newTaskAnywhere() {
  const values = await form('Nova tarefa', [projectField('project')], 'Continuar');
  const project = values && state.projects.find((p) => p.id === values.project && p.isRepo);
  if (project) newTask(project);
  else if (values) toast('Escolha o projeto da tarefa.');
}

async function addProject() {
  const project = await attempt(() => deck.projects.add());
  if (!project) return;
  await refreshState();
}

const setupSummary = (setup) => [
  setup.copy.length && `copiar ${setup.copy.length === 1 ? setup.copy[0] : `${setup.copy.length} arquivos`}`,
  setup.command && `rodar ${setup.command}`,
].filter(Boolean).join(' e ').replace(/^./, (c) => c.toUpperCase());

// Preparo de worktree nova do projeto. Sem configuração ainda, abre com a sugestão (arquivos que o git
// ignora na raiz e comando pelo lockfile/.NET) para você revisar.
async function editSetup(project) {
  const suggestion = project.setup ? null : await attempt(() => deck.projects.suggestSetup(project.path));
  const current = project.setup || suggestion || { copy: [], command: '' };
  const values = await form(`Preparo de worktree: ${project.name}`, [
    {
      name: 'copy', type: 'textarea', value: current.copy.join('\n'),
      label: `Copiar do projeto para cada worktree nova, um caminho por linha${suggestion ? ' (sugestão: o que o git ignora na raiz)' : ''}`,
      placeholder: '.env\nappsettings.Development.json',
    },
    {
      name: 'command', value: current.command,
      label: `Comando que roda no terminal da tarefa antes do agente${suggestion?.command ? ' (sugestão)' : ''}`,
      placeholder: 'npm ci',
    },
  ], 'Salvar');
  if (!values) return;
  const next = await attempt(() => deck.projects.setSetup(project.id, values));
  if (!next) return;
  // Só o preparo muda: trocar a lista inteira perderia o que o renderer calcula (isRepo).
  project.setup = next.projects.find((p) => p.id === project.id)?.setup;
  renderProjects();
  toast(project.setup || values.copy || values.command ? 'Preparo salvo. Vale para as próximas tarefas desse projeto.' : 'Preparo removido.', 'info');
}

async function removeProject(project) {
  const queued = (state.backlog || []).filter((b) => b.projectId === project.id).length;
  const open = tabs.filter((t) => t.cwd && isInside(t.cwd, project.path)).length;
  if (!confirm([
    `Remover "${project.name}" da lista do app?`,
    'Nenhum arquivo é apagado: dá para cadastrar a pasta de novo pelo + de Projetos.',
    queued ? `${queued} tarefa(s) na fila "A fazer" são desse projeto: ficam esperando e voltam a funcionar quando a pasta for cadastrada de novo.` : '',
    open ? `${open} aba(s) abertas nele continuam abertas.` : '',
  ].filter(Boolean).join('\n\n'))) return;
  await attempt(() => deck.projects.remove(project.id));
  await refreshState();
}

// preset: nome e briefing vindos de um card de "A fazer". Devolve true se a tarefa foi criada.
async function newTask(project, preset = {}) {
  const branches = await attempt(() => deck.git.branches(project.path));
  if (!branches) return false;
  const values = await form(`Nova tarefa em ${project.name}`, [
    { name: 'name', label: 'Nome da tarefa (vira branch task/<nome>)', placeholder: 'ex.: corrigir-login', required: true, value: preset.name },
    {
      name: 'base', label: 'Sai de (base, onde ela volta no final)', type: 'select', value: branches.current,
      options: branches.list.map((b) => ({ value: b, label: b })),
    },
    {
      name: 'briefing', label: 'O que fazer (opcional: vai como primeira mensagem do agente)', type: 'textarea',
      placeholder: 'ex.: O login quebra quando o e-mail tem maiúscula. Corrija e cubra com teste.', value: preset.briefing,
    },
    {
      name: 'agent', label: 'Agente', type: 'select', value: 'claude',
      options: [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }, { value: '', label: 'Só terminal' }],
      onChange: (agent, inputs) => fillProfiles(inputs.profile, agent),
    },
    { name: 'profile', label: 'Conta', type: 'select', options: profileOptions('claude'), value: defaultProfile('claude')?.id },
    ...(project.setup ? [{
      name: 'prepare', label: 'Preparar a worktree', type: 'select', value: 'yes',
      options: [{ value: 'yes', label: setupSummary(project.setup) }, { value: '', label: 'Não preparar' }],
    }] : []),
  ], 'Criar');
  if (!values?.name) return false;
  const prepare = values.prepare === 'yes';
  const created = await attempt(() => deck.git.createWorktree(project.path, values.name, { base: values.base, briefing: values.briefing, prepare }));
  if (!created) return false;
  if (prepare && project.setup.copy.length && created.copied.length < project.setup.copy.length) {
    const missing = project.setup.copy.filter((c) => !created.copied.includes(c));
    toast(`Preparo: não encontrei no projeto ${missing.join(', ')}.`);
  }
  await loadWorktrees(project);
  renderProjects();
  const agent = values.agent || null;
  openTerminal({ cwd: created.path, agent, profileId: agent ? values.profile : null, briefing: values.briefing, prepare });
  // O Codex não publica quando chega no prompt: o briefing vai pela área de transferência.
  if (values.briefing && agent !== 'claude') {
    navigator.clipboard.writeText(values.briefing);
    toast('Briefing copiado: cole com Ctrl+V quando o agente abrir.', 'info');
  }
  return true;
}

// Fecha as abas da tarefa e remove worktree + branch. As abas saem antes: no Windows, pasta que
// é cwd de um shell não pode ser apagada. O shell demora um pouco a soltar, daí as tentativas.
async function finishTask(project, wt) {
  const here = tabs.filter((t) => t.cwd && isInside(t.cwd, wt.path));
  for (const t of here) closeTab(t, { quiet: true });
  if (here.some((t) => tabs.includes(t))) return toast('Feche as abas da tarefa para remover a worktree.');
  let result;
  for (let i = 0; i < 6 && !result; i += 1) {
    if (i) await new Promise((r) => setTimeout(r, 700));
    try {
      result = await deck.git.finishTask(project.path, wt.path);
    } catch (error) {
      if (i === 5 || /modified or untracked/.test(error.message)) {
        toast(errorText(error));
        break;
      }
    }
  }
  await loadWorktrees(project);
  renderProjects();
  return result;
}

async function concludeTask(project, wt) {
  await loadWorktrees(project);
  renderProjects();
  wt = (worktreesByProject.get(project.id) || []).find((w) => isInside(w.path, wt.path)) || wt;
  if (!wt.ahead && !wt.dirty) {
    if (!confirm(`${wt.branch} não tem nada além de ${wt.base}. Fechar as abas dela e remover worktree e branch?`)) return;
    const done = await finishTask(project, wt);
    if (done) toast(`${wt.branch} removida.`, 'info');
    return;
  }
  const fields = [{
    name: 'mode', label: `Integrar ${wt.branch} em ${wt.base}`, type: 'select', value: 'merge',
    options: [
      { value: 'merge', label: 'Merge local (mantém os commits)' },
      { value: 'squash', label: 'Squash local (um commit só)' },
      { value: 'pr', label: 'Pull request no GitHub (push + gh pr create)' },
    ],
  }];
  if (wt.dirty) {
    fields.push({
      name: 'message', label: `${wt.dirty} arquivo(s) sem commit: entram num commit com a mensagem`,
      value: wt.description?.split('\n')[0] || '', required: true,
    });
  }
  const values = await form(`Concluir ${wt.branch}`, fields, 'Concluir');
  if (!values) return;
  const res = await attempt(() => deck.git.conclude(project.path, wt.path, values));
  if (res && res.mode !== 'nothing') {
    const fresh = await attempt(() => deck.state());
    if (fresh) setBoardData(fresh);
  }
  if (!res) {
    // O commit das pendências pode ter entrado antes da falha: atualiza os contadores.
    await loadWorktrees(project);
    return renderProjects();
  }
  if (res.mode === 'pr') {
    await loadWorktrees(project);
    renderProjects();
    toast(`PR aberto para ${res.branch} → ${res.base}. A worktree fica até o merge; depois conclua de novo para limpar.`, 'info');
    if (res.url) openBrowser(res.url);
    return;
  }
  const done = await finishTask(project, wt);
  if (!done) return toast(`${res.branch} foi integrada em ${res.base}, mas a worktree não saiu. Remova pelo ×.`);
  toast(res.mode === 'nothing'
    ? `${res.branch} não tinha nada além de ${res.base}. Worktree removida${done.branchKept ? '' : ' e branch apagada'}.`
    : `${res.branch} integrada em ${res.base}. Worktree removida${done.branchKept ? '; a branch ficou' : ' e branch apagada'}.`, 'info');
}

async function removeWorktree(project, wt) {
  if (!confirm(`Remover a worktree ${wt.branch}?\n\nA branch continua existindo. Se houver mudança não commitada, o git recusa.`)) return;
  const ok = await attempt(async () => { await deck.git.removeWorktree(project.path, wt.path); return true; });
  if (!ok) return;
  await loadWorktrees(project);
  renderProjects();
}

// ---------- nova aba ----------

function profileOptions(kind) {
  return state.profiles.filter((p) => p.kind === kind).map((p) => ({ value: p.id, label: p.name }));
}

// Agente: só contas do tipo dele. Terminal: qualquer conta (ou nenhuma), para usar a CLI à mão.
function profileChoices(type) {
  if (type === 'claude' || type === 'codex') return profileOptions(type);
  if (type === 'terminal') {
    return [{ value: '', label: 'Nenhuma' }, ...state.profiles.map((p) => ({ value: p.id, label: p.name }))];
  }
  return [{ value: '', label: '—' }];
}

function fillProfiles(select, type) {
  select.replaceChildren(...profileChoices(type).map((o) => h('option', { value: o.value }, o.label)));
  const preferred = (type === 'claude' || type === 'codex') && defaultProfile(type);
  select.value = preferred ? preferred.id : '';
  select.disabled = !['claude', 'codex', 'terminal'].includes(type);
}

const PICK_FOLDER = '__pick__';

// Pasta fora da lista: escolhe no seletor do Windows e cadastra como projeto
// (terminal e editor só abrem dentro de projetos cadastrados).
async function pickFolderInto(select) {
  const previous = select.dataset.previous || [...select.options].find((o) => o.defaultSelected)?.value || select.options[0].value;
  const project = await attempt(() => deck.projects.add());
  if (!project) {
    select.value = previous;
    return;
  }
  await refreshState();
  if (![...select.options].some((o) => o.value === project.path)) {
    select.insertBefore(h('option', { value: project.path }, project.name), select.querySelector(`option[value="${PICK_FOLDER}"]`));
  }
  select.value = project.path;
  select.dataset.previous = project.path;
}

async function newTabDialog(preset = {}) {
  const places = locations();
  const type = preset.type || 'claude';
  const values = await form('Nova aba', [
    {
      name: 'type', label: 'Tipo', type: 'select', value: type,
      options: [
        { value: 'claude', label: 'Agente Claude' },
        { value: 'codex', label: 'Agente Codex' },
        { value: 'terminal', label: 'Terminal' },
        { value: 'editor', label: 'Editor' },
        { value: 'browser', label: 'Navegador' },
      ],
      onChange: (value, inputs) => fillProfiles(inputs.profile, value),
    },
    {
      name: 'profile', label: 'Conta', type: 'select',
      options: profileChoices(type),
      value: preset.profileId || defaultProfile(type)?.id,
    },
    {
      name: 'cwd', label: 'Pasta', type: 'select', value: preset.cwd || places[0]?.value || state.home,
      options: [...places, { value: state.home, label: `Home (${state.home})` }, { value: PICK_FOLDER, label: 'Outra pasta…' }],
      onChange: (value, inputs) => (value === PICK_FOLDER ? pickFolderInto(inputs.cwd) : (inputs.cwd.dataset.previous = value)),
    },
  ], 'Abrir');
  if (!values) return;
  if (values.type === 'browser') return openBrowser();
  if (values.type === 'editor') {
    if (values.cwd === state.home) return toast('O editor só abre pastas de projeto.');
    return openEditor(values.cwd);
  }
  const agent = ['claude', 'codex'].includes(values.type) ? values.type : null;
  openTerminal({ cwd: values.cwd, agent, profileId: values.profile || null });
}

// ---------- contas e uso ----------

function formatReset(iso) {
  if (!iso) return '';
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return 'renova agora';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.round((ms % 3600000) / 60000);
  if (hours >= 24) return `renova em ${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours ? `renova em ${hours}h ${minutes}min` : `renova em ${minutes}min`;
}

function renderAccounts() {
  $('#accounts').replaceChildren(...state.profiles.map((profile) => {
    const usage = usageByProfile.get(profile.id);
    const bars = usage?.status === 'ok'
      ? usage.windows.map((w) => h('div', { class: 'usage', title: w.resetsAt ? new Date(w.resetsAt).toLocaleString('pt-BR') : '' },
        h('div', { class: 'usage-head' }, h('span', {}, w.label), h('span', {}, `${Math.round(w.used)}%`)),
        h('div', { class: 'bar' }, h('div', { class: `fill ${w.used >= 90 ? 'hot' : w.used >= 70 ? 'warm' : ''}`, style: `width:${w.used}%` })),
        h('div', { class: 'muted small' }, formatReset(w.resetsAt))))
      : [h('div', { class: `muted small ${usage?.status === 'error' ? 'error' : ''}` }, usage ? usage.message : 'Carregando…')];
    return h('div', { class: `account ${profile.kind}`, style: `--account: ${profileColor(profile)}` },
      h('div', { class: 'row' },
        h('span', { class: `dot ${profile.kind}` }),
        h('strong', {}, profile.name),
        h('input', {
          type: 'color', class: 'account-color', value: profileColor(profile),
          title: 'Cor dessa conta nas abas e no quadro (clique para trocar)',
          onchange: async (e) => {
            const next = await attempt(() => deck.profiles.setColor(profile.id, e.target.value));
            if (!next) return;
            state.profiles = next.profiles;
            renderAccounts();
            renderTabs();
          },
        }),
        usage?.plan ? h('span', { class: 'plan' }, usage.plan) : null,
        h('button', { title: 'Abrir agente com essa conta', onclick: () => newTabDialog({ type: profile.kind, profileId: profile.id }) }, '▶'),
        h('button', { title: 'Fazer login nessa conta', onclick: () => loginProfile(profile) }, 'Login'),
        profile.isDefault ? null : h('button', { class: 'ghost', title: 'Remover do app (o login fica no disco)', onclick: () => removeProfile(profile) }, '×')),
      usage?.email ? h('div', { class: 'muted small email' }, usage.email) : null,
      h('div', { class: 'muted small dir', title: profile.dir }, profile.dir),
      ...bars);
  }));
}

async function refreshUsage(force = false) {
  await Promise.all(state.profiles.map(async (profile) => {
    const usage = await attempt(() => deck.profiles.usage(profile.id, force));
    if (usage) usageByProfile.set(profile.id, usage);
  }));
  renderAccounts();
}

function loginProfile(profile) {
  // Claude: abrir a CLI num diretório sem login já leva ao fluxo de login (ou use /login).
  openTerminal({ cwd: state.home, profileId: profile.id, agent: profile.kind === 'claude' ? 'claude' : 'codex-login' });
}

async function addProfile() {
  const values = await form('Nova conta', [
    {
      name: 'kind', label: 'Tipo', type: 'select', value: 'claude',
      options: [{ value: 'claude', label: 'Claude (Claude Code)' }, { value: 'codex', label: 'GPT (Codex CLI)' }],
    },
    { name: 'name', label: 'Nome (ex.: trabalho, cliente-x)', required: true },
  ], 'Criar');
  if (!values?.name) return;
  const created = await attempt(() => deck.profiles.add({ name: values.name, kind: values.kind }));
  if (!created) return;
  await refreshState();
  loginProfile(created);
  toast(`Conta criada em ${created.dir}. Faça o login no terminal que abriu.`);
}

async function removeProfile(profile) {
  if (!confirm(`Remover a conta "${profile.name}" do app?\n\nO diretório ${profile.dir} (e o login) continua no disco.`)) return;
  await attempt(() => deck.profiles.remove(profile.id));
  await refreshState();
}

// ---------- inicialização ----------

async function refreshState() {
  state = await deck.state();
  await Promise.all(state.projects.map(loadWorktrees));
  renderProjects();
  renderAccounts();
  refreshUsage();
}

$('#add-project').addEventListener('click', addProject);
$('#add-profile').addEventListener('click', addProfile);
$('#refresh-usage').addEventListener('click', () => refreshUsage(true));
$('#new-tab').addEventListener('click', () => newTabDialog());
$('#open-board').addEventListener('click', () => openBoard());
$('#open-palette').addEventListener('click', () => showPalette());
// Roda do mouse rola a barra de abas na horizontal.
$('#tabs').addEventListener('wheel', (e) => {
  if (!e.deltaY || e.shiftKey) return;
  e.preventDefault();
  $('#tabs').scrollLeft += e.deltaY;
}, { passive: false });

// ---------- paleta de comandos ----------

// Tudo que dá para fazer pelo teclado: abas, tarefas (e diff/concluir de cada uma), fila, projetos, layout.
function paletteCommands() {
  const cmds = [];
  const add = (group, label, run, hint) => cmds.push({ group, label, run, hint });
  for (const tab of tabs) add('Aba', tab.title, () => activate(tab), stateText(tab));
  for (const task of taskModel()) {
    const agent = mainAgent(task);
    const where = task.project.name;
    add('Tarefa', task.name, () => (agent ? activate(agent.tab) : taskActions.openAgent(task)),
      [where, agent ? STATE_LABEL[agent.state] || 'no prompt' : 'sem agente'].join(' · '));
    if (task.wt) add('Diff', task.name, () => taskActions.diff(task), where);
    if (task.managed) add('Concluir', task.name, () => taskActions.conclude(task), where);
  }
  for (const item of state.backlog || []) {
    add('Começar', item.name, () => taskActions.startTodo(item), state.projects.find((p) => p.id === item.projectId)?.name);
  }
  for (const c of recentClosed()) {
    add('Retomar', c.title || basename(c.cwd), () => reopenConversation(c), [basename(c.cwd), c.account?.name].filter(Boolean).join(' · '));
  }
  add('Comando', 'Nova tarefa', () => newTaskAnywhere());
  add('Comando', 'Adicionar à fila (A fazer)', () => editTodo());
  add('Comando', 'Quadro', () => openBoard(), 'Ctrl+Shift+Q');
  add('Comando', 'Nova aba', () => newTabDialog(), 'Ctrl+T');
  for (const project of state.projects) {
    add('Projeto', `Claude em ${project.name}`, () => newTabDialog({ cwd: project.path, type: 'claude' }));
    add('Projeto', `Codex em ${project.name}`, () => newTabDialog({ cwd: project.path, type: 'codex' }));
    add('Projeto', `Terminal em ${project.name}`, () => openTerminal({ cwd: project.path }));
    add('Projeto', `Editor em ${project.name}`, () => openEditor(project.path));
    if (project.isRepo) add('Projeto', `Nova tarefa em ${project.name}`, () => newTask(project));
  }
  for (const n of [1, 2, 4]) add('Layout', `${n === 1 ? 'Um painel' : n === 2 ? 'Dois lado a lado' : 'Quatro (2×2)'}`, () => setLayout(n), `Ctrl+Shift+${n}`);
  add('Layout', 'Mostrar/esconder barra lateral', () => toggleSidebar(), 'Ctrl+Shift+B');
  return cmds;
}

const showPalette = () => openPalette(paletteCommands(), h);

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
  // Ctrl+Shift+P de qualquer lugar. Ctrl+K só fora do terminal e do editor: no prompt do agente ele
  // apaga até o fim da linha, e no Monaco começa atalhos de duas teclas.
  if ((e.code === 'KeyP' && e.shiftKey && !e.altKey)
    || (e.code === 'KeyK' && !e.shiftKey && !e.altKey && !document.activeElement?.closest('.terminal, .monaco'))) {
    e.preventDefault();
    e.stopPropagation();
    showPalette();
    return;
  }
  if (e.key === 't' && !e.shiftKey) {
    e.preventDefault();
    newTabDialog();
  } else if (e.key === 'w' && activeTab) {
    e.preventDefault();
    closeTab(activeTab);
  } else if (e.key === 'Tab' && tabs.length > 1) {
    e.preventDefault();
    const index = tabs.indexOf(activeTab);
    activate(tabs[(index + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]);
  } else if (e.code === 'KeyT' && e.shiftKey && !e.altKey) {
    // Reabre a conversa fechada mais recente.
    e.preventDefault();
    const last = recentClosed()[0];
    if (last) reopenConversation(last);
    else toast('Nenhuma conversa fechada recente para reabrir.', 'info');
  } else if (e.code === 'KeyQ' && e.shiftKey && !e.altKey) {
    e.preventDefault();
    openBoard();
  } else if (e.code === 'KeyB' && e.shiftKey && !e.altKey) {
    // Ctrl+Shift: o Ctrl+B sozinho é do agente (no Claude Code, manda o comando pra segundo plano).
    e.preventDefault();
    toggleSidebar();
  } else if (e.shiftKey && !e.altKey && ['Digit1', 'Digit2', 'Digit4'].includes(e.code)) {
    // e.code: tecla física, igual em qualquer layout de teclado. Ctrl+Alt ficaria com o AltGr (¹ ² £ no ABNT2).
    e.preventDefault();
    setLayout(Number(e.code.slice(-1)));
  }
}, true);

// Sidebar: arrastar a borda muda a largura (220-600 px), duplo clique volta a 290, Ctrl+Shift+B esconde.
const SIDEBAR_DEFAULT = 290;
function setSidebarWidth(px) {
  const width = Math.round(Math.min(600, Math.max(220, px)));
  document.body.style.setProperty('--sidebar', `${width}px`);
  try { localStorage.setItem('sidebar', String(width)); } catch {}
}
function toggleSidebar() {
  const hidden = document.body.classList.toggle('sidebar-hidden');
  try { localStorage.setItem('sidebarHidden', hidden ? '1' : ''); } catch {}
}
const resizer = $('#sidebar-resizer');
resizer.addEventListener('pointerdown', (e) => {
  resizer.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
});
resizer.addEventListener('pointermove', (e) => {
  if (resizer.hasPointerCapture(e.pointerId)) setSidebarWidth(e.clientX);
});
resizer.addEventListener('pointerup', (e) => {
  resizer.releasePointerCapture(e.pointerId);
  document.body.classList.remove('resizing');
});
resizer.addEventListener('dblclick', () => setSidebarWidth(SIDEBAR_DEFAULT));
try {
  const saved = Number(localStorage.getItem('sidebar'));
  if (saved) setSidebarWidth(saved);
  if (localStorage.getItem('sidebarHidden')) toggleSidebar();
} catch {}

for (const button of document.querySelectorAll('#layouts button')) {
  button.addEventListener('click', () => setLayout(Number(button.dataset.layout)));
}

window.addEventListener('focus', () => {
  for (const project of state.projects) loadWorktrees(project).then(renderProjects);
  // Voltou para o app: a aba que está na sua frente já foi vista.
  if (activeTab?.attention) {
    activeTab.attention = false;
    renderTabs();
  }
});

setInterval(() => refreshUsage(), 5 * 60 * 1000);
setInterval(renderAccounts, 60 * 1000);
setInterval(refreshViews, 30 * 1000);
setInterval(refreshRecent, 60 * 1000);

// Primeiro o estado (contas, projetos), depois as abas da última sessão: elas dependem dos dois.
refreshState().then(restoreSession).then(refreshRecent);
