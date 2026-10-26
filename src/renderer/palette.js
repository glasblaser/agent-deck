// Paleta de comandos: lista filtrável por busca aproximada (sem acento, sem maiúsculas), navegável
// por teclado. Os comandos vêm prontos do app.js: { label, hint, group, run }.

const fold = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Pontua quando todas as letras da busca aparecem em ordem; letras seguidas e começo de palavra valem mais.
function score(query, text) {
  if (!query) return 1;
  const q = fold(query);
  const t = fold(text);
  let at = 0;
  let total = 0;
  let streak = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, at);
    if (found === -1) return 0;
    streak = found === at ? streak + 1 : 0;
    total += 1 + streak * 2 + (found === 0 || /[\s·:/(-]/.test(t[found - 1]) ? 3 : 0);
    at = found + 1;
  }
  return total - t.length * 0.01;
}

let open = null;

export function openPalette(commands, h) {
  if (open) return open.focus();
  const input = h('input', { class: 'palette-input', placeholder: 'Ir para aba, tarefa ou comando…', spellcheck: 'false' });
  const list = h('ul', { class: 'palette-list', role: 'listbox' });
  const box = h('div', { class: 'palette', role: 'dialog' }, input, list);
  const backdrop = h('div', { class: 'palette-backdrop' }, box);
  let shown = [];
  let selected = 0;

  // O input some junto com a paleta e o foco cairia no body: Ctrl+V e digitação não chegariam
  // ao terminal. Se o comando não focou nada, volta para onde estava.
  const previous = document.activeElement;
  const close = () => {
    backdrop.remove();
    open = null;
    setTimeout(() => {
      if (document.activeElement === document.body && previous?.isConnected) previous.focus();
    });
  };
  const choose = (cmd) => {
    close();
    cmd?.run();
  };
  const paint = () => {
    for (const [i, el] of [...list.children].entries()) el.classList.toggle('selected', i === selected);
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  };
  const filter = () => {
    const query = input.value.trim();
    shown = commands
      .map((cmd) => ({ cmd, s: score(query, `${cmd.group} ${cmd.label} ${cmd.hint || ''}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (query ? b.s - a.s : 0))
      .slice(0, 60)
      .map((x) => x.cmd);
    selected = 0;
    list.replaceChildren(...(shown.length ? shown.map((cmd, i) => h('li', {
      role: 'option',
      onmousemove: () => { if (selected !== i) { selected = i; paint(); } },
      onmousedown: (e) => { e.preventDefault(); choose(cmd); },
    },
    h('span', { class: 'group' }, cmd.group),
    h('span', { class: 'label' }, cmd.label),
    cmd.hint ? h('span', { class: 'hint muted' }, cmd.hint) : null)) : [h('li', { class: 'empty muted' }, 'Nada encontrado.')]));
    paint();
  };

  input.addEventListener('input', filter);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      e.preventDefault();
      selected = Math.min(shown.length - 1, selected + 1);
      paint();
    } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      selected = Math.max(0, selected - 1);
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[selected]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  filter();
  input.focus();
  open = { focus: () => input.focus() };
}
