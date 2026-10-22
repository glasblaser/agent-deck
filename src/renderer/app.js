// UI do Agent Deck: sidebar (projetos/worktrees, contas/uso) e abas (terminal, editor, navegador).
import { Terminal } from '/xterm/lib/xterm.mjs';
import { FitAddon } from '/xterm-fit/lib/addon-fit.mjs';

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

function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
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

function addTab(tab) {
  tab.id = ++tabSeq;
  tab.pane.classList.add('pane');
  $('#panes').append(tab.pane);
  tabs.push(tab);
  renderTabs();
  activate(tab);
  return tab;
}

function activate(tab) {
  activeTab = tab;
  for (const t of tabs) t.pane.hidden = t !== tab;
  $('#empty').hidden = tabs.length > 0;
  renderTabs();
  requestAnimationFrame(() => tab?.onShow?.());
}

function closeTab(tab) {
  if (tab.isDirty?.() && !confirm(`"${tab.title}" tem alterações não salvas. Fechar mesmo assim?`)) return;
  tab.dispose?.();
  tab.pane.remove();
  tabs.splice(tabs.indexOf(tab), 1);
  if (activeTab === tab) activate(tabs[tabs.length - 1] || null);
  else renderTabs();
  $('#empty').hidden = tabs.length > 0;
}

function renderTabs() {
  $('#tabs').replaceChildren(...tabs.map((tab) =>
    h('div', {
      class: `tab ${tab === activeTab ? 'active' : ''} ${tab.exited ? 'exited' : ''}`,
      title: tab.tooltip || tab.title,
      onclick: () => activate(tab),
      onauxclick: (e) => e.button === 1 && closeTab(tab),
    },
    h('span', { class: `dot ${tab.kindClass || ''}` }),
    h('span', { class: 'label' }, tab.title),
    h('button', { class: 'close', title: 'Fechar', onclick: (e) => { e.stopPropagation(); closeTab(tab); } }, '×'))));
}

// ---------- terminal ----------

const terminalsByPty = new Map();

const AGENTS = {
  claude: { label: 'Claude', kind: 'claude' },
  codex: { label: 'Codex', kind: 'codex' },
  'codex-login': { label: 'Login Codex', kind: 'codex' },
};

function openTerminal({ cwd, profileId, agent }) {
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
    tooltip: cwd,
    kindClass: agent ? AGENTS[agent].kind : 'shell',
    cwd,
    term,
    isAgent: !!agent && agent !== 'codex-login',
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
  addTab(tab);
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
    if (tab.ptyId) deck.pty.resize(tab.ptyId, term.cols, term.rows);
  });
  observer.observe(pane);

  attempt(() => deck.pty.spawn({ cwd, profileId, agent, cols: term.cols, rows: term.rows })).then((res) => {
    if (!res) {
      term.write('\r\n\x1b[31mNão foi possível abrir o terminal.\x1b[0m\r\n');
      return;
    }
    tab.ptyId = res.id;
    terminalsByPty.set(res.id, { term, tab });
    term.onData((data) => deck.pty.write(res.id, data));
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
async function sendToAgent(from, target, getText) {
  const text = (await attempt(getText))?.trim();
  if (!text) return toast('Nada para enviar.');
  if (!target.ptyId) return toast('A aba de destino foi encerrada.');
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

deck.pty.onData((id, data) => terminalsByPty.get(id)?.term.write(data));
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

async function openEditor(root) {
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
    tooltip: root,
    kindClass: 'editor',
    onShow: () => editor?.layout(),
    isDirty: () => [...models.values()].some((m) => m.dirty()),
    dispose: () => {
      for (const m of models.values()) m.model.dispose();
      editor?.dispose();
    },
  });

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

// ---------- navegador ----------

function normalizeUrl(text) {
  const value = text.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(value)) return `https://${value}`;
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function openBrowser(url = 'https://www.google.com') {
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

  const tab = addTab({ pane, title: 'Navegador', kindClass: 'browser', onShow: () => {} });
  address.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') view.loadURL(normalizeUrl(address.value));
  });
  view.addEventListener('did-navigate', (e) => { address.value = e.url; });
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
        h('button', { class: 'ghost', title: 'Remover do app (não apaga nada)', onclick: () => removeProject(project) }, '×')),
      project.isRepo
        ? h('button', { class: 'new-task', onclick: () => newTask(project) }, '+ nova tarefa (worktree)')
        : h('div', { class: 'muted hint' }, 'Sem git: worktrees indisponíveis'),
      h('ul', { class: 'worktrees' }, worktrees.map((wt) =>
        h('li', { class: 'row', title: wt.path },
          h('span', { class: 'branch' }, wt.branch || basename(wt.path)),
          agentButtons(wt.path),
          h('button', { class: 'ghost', title: 'Remover worktree', onclick: () => removeWorktree(project, wt) }, '×')))));
  }));
}

async function addProject() {
  const project = await attempt(() => deck.projects.add());
  if (!project) return;
  await refreshState();
}

async function removeProject(project) {
  if (!confirm(`Remover "${project.name}" da lista? Nenhum arquivo é apagado.`)) return;
  await attempt(() => deck.projects.remove(project.id));
  await refreshState();
}

async function newTask(project) {
  const values = await form(`Nova tarefa em ${project.name}`, [
    { name: 'name', label: 'Nome da tarefa (vira branch task/<nome>)', placeholder: 'ex.: corrigir-login', required: true },
    {
      name: 'agent', label: 'Agente', type: 'select', value: 'claude',
      options: [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }, { value: '', label: 'Só terminal' }],
      onChange: (agent, inputs) => fillProfiles(inputs.profile, agent),
    },
    { name: 'profile', label: 'Conta', type: 'select', options: profileOptions('claude'), value: defaultProfile('claude')?.id },
  ], 'Criar');
  if (!values?.name) return;
  const created = await attempt(() => deck.git.createWorktree(project.path, values.name));
  if (!created) return;
  await loadWorktrees(project);
  renderProjects();
  openTerminal({ cwd: created.path, agent: values.agent || null, profileId: values.agent ? values.profile : null });
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
    return h('div', { class: `account ${profile.kind}` },
      h('div', { class: 'row' },
        h('span', { class: `dot ${profile.kind}` }),
        h('strong', {}, profile.name),
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

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey) return;
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
  }
}, true);

window.addEventListener('focus', () => {
  for (const project of state.projects) loadWorktrees(project).then(renderProjects);
});

setInterval(() => refreshUsage(), 5 * 60 * 1000);
setInterval(renderAccounts, 60 * 1000);

refreshState();
