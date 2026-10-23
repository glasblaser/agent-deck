// Teste de fumaça: AGENT_DECK_SMOKE=<pasta de saída> npm start
// Abre terminal (com conta não-padrão), agente Claude, navegador e editor; tira screenshots
// e grava console + estado em <saída>/console.txt; depois fecha o app.
const fs = require('node:fs');
const path = require('node:path');
const ptys = require('./pty');

// Último tamanho que cada pty recebeu (no spawn ou em resize), para comparar com o que o xterm mostra.
const ptySizes = new Map();
const realSpawn = ptys.spawn;
const realResize = ptys.resize;
ptys.spawn = (opts) => {
  const res = realSpawn(opts);
  ptySizes.set(res.id, { cols: opts.cols, rows: opts.rows });
  return res;
};
ptys.resize = (id, cols, rows) => {
  if (cols > 0 && rows > 0) ptySizes.set(id, { cols, rows });
  realResize(id, cols, rows);
};

module.exports = function smoke(app, win, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  require('./store').addProject(path.join(__dirname, '..', '..'));
  const log = [];
  win.webContents.on('console-message', (event) => log.push(`[console ${event.level}] ${event.message}`));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // capturePage falha (UnknownVizError) com a tela bloqueada ou a janela oculta; não derruba o teste.
  const shot = async (name) => {
    try {
      fs.writeFileSync(path.join(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    } catch (error) {
      log.push(`screenshot ${name} falhou: ${error.message}`);
    }
  };
  const run = (js) => win.webContents.executeJavaScript(js, true);
  const status = async (step) => log.push(`${step}: ${await run(`JSON.stringify({
    tabs: [...document.querySelectorAll('.tab .label')].map((e) => e.textContent),
    toast: [...document.querySelectorAll('.toast')].map((e) => e.textContent),
    tela: [...document.querySelectorAll('.frame:not([hidden]) .pane .xterm-rows > div')].map((e) => e.textContent.trimEnd()).filter(Boolean).slice(0, 14),
  })`)}`);
  const newTab = async (type, profileName) => {
    await run(`document.querySelector('#new-tab').click()`);
    await sleep(400);
    log.push(`newTab(${type}) modal=${await run(`document.querySelector('#modal').open + ' campos=' + document.querySelectorAll('#modal-fields select').length + ' abas=' + document.querySelectorAll('.tab').length`)}`);
    await run(`(() => { const s = document.querySelector('#modal select[name=type]'); s.value = '${type}';
      s.dispatchEvent(new Event('change'));
      const p = document.querySelector('#modal select[name=profile]');
      const want = ${JSON.stringify(profileName || null)};
      if (want) p.value = [...p.options].find((o) => o.textContent === want)?.value ?? p.value;
      document.querySelector('#modal-ok').click(); })()`);
    await sleep(200);
    log.push(`  depois do OK: ${await run(`document.querySelector('#modal').returnValue + ' abas=' + document.querySelectorAll('.tab').length + ' erros=' + JSON.stringify(window.__smokeErrors)`)}`);
    const stuck = await run(`(() => { const d = document.querySelector('#modal'); if (!d.open) return null;
      return [...d.querySelectorAll('select, input')].map((e) => e.name + '=' + e.value + ' ' + e.validationMessage).join(' | ') || 'aberto'; })()`);
    if (stuck) log.push(`MODAL NÃO FECHOU (${type}): ${stuck}`);
  };

  const tabsInfo = () => run(`JSON.stringify([...document.querySelectorAll('.tab')].map((e) =>
    [e.querySelector('.label').textContent, e.dataset.status || '-', e.dataset.session || '-', e.classList.contains('attention') ? 'terminou' : '']))`);

  // AGENT_DECK_SMOKE_TASK=1: ciclo de uma tarefa num repo descartável. Cria com briefing (Claude de verdade),
  // responde o "trust this folder", confere que o briefing só entra depois dele, abre o diff e conclui com merge.
  if (process.env.AGENT_DECK_SMOKE_TASK) {
    const { execFileSync } = require('node:child_process');
    const repo = path.join(outDir, `repo-${Date.now()}`);
    fs.mkdirSync(repo, { recursive: true });
    const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    g(repo, 'init', '-b', 'main');
    g(repo, 'config', 'user.email', 'smoke@local');
    g(repo, 'config', 'user.name', 'smoke');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'linha 1\nlinha 2\n');
    g(repo, 'add', '.');
    g(repo, 'commit', '-m', 'init');
    require('./store').addProject(repo);
    const MARK = 'SMOKE-BRIEFING';
    const writes = [];
    const write = ptys.write;
    ptys.write = (id, data) => { writes.push({ id, data, at: Date.now() }); write(id, data); };

    const { clipboard } = require('electron');
    // Nesse Electron o readText do main devolve Promise; o finally espera por ela.
    const savedClipboard = Promise.resolve(clipboard.readText());
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(2500);
        log.push(`abas ao abrir: ${await run(`JSON.stringify([...document.querySelectorAll('.tab')].map((t) => t.querySelector('.label').textContent + (t.querySelector('.close') ? '' : ' (fixa)')))`)}`);
        await run(`[...document.querySelectorAll('.project')].find((p) => p.textContent.includes('${path.basename(repo)}')).querySelector('.new-task').click()`);
        for (let i = 0; i < 30 && !(await run('!!document.querySelector("#modal [name=briefing]")')); i += 1) await sleep(500);
        log.push(`form: ${await run(`JSON.stringify([...document.querySelectorAll('#modal-fields label')].map((l) => l.querySelector('span').textContent + ' = ' + (l.querySelector('select, input, textarea').value)))`)}`);
        await run(`(() => {
          document.querySelector('#modal [name=name]').value = 'Teste Briefing';
          document.querySelector('#modal [name=briefing]').value = '${MARK}: responda apenas OK, sem usar ferramentas.';
          document.querySelector('#modal-ok').click(); })()`);
        const screen = () => run(`[...document.querySelectorAll('.frame:not([hidden]) .xterm-rows > div')].map((e) => e.textContent).join('\\n')`);
        await run(`window.__toasts = []; new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach((n) =>
          n.classList?.contains('toast') && __toasts.push(n.textContent)))).observe(document.body, { childList: true })`);
        // "Enviar área de transferência para" a partir de um terminal no repo: o Claude de destino tem que recusar
        // enquanto está no diálogo de trust e aceitar depois. A área de transferência sua volta ao fim.
        const SEND = 'SMOKE-ENVIO';
        const sendFromTerminal = async (label) => {
          win.focus(); // ler a área de transferência exige o documento em foco
          await sleep(300);
          clipboard.writeText(`${SEND} ${label}`);
          const before = await run('__toasts.length');
          await run(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('Terminal')).click()`);
          await sleep(500);
          await run(`document.querySelector('.frame:not([hidden]) .pane').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }))`);
          await sleep(300);
          await run(`[...document.querySelectorAll('.context-menu button.indent')].filter((b) => b.textContent.includes('teste-briefing')).at(-1)?.click()`);
          await sleep(1000);
          log.push(`envio ${label}: colado=${writes.some((w) => w.data.includes(`${SEND} ${label}`))} toast=${JSON.stringify((await run('__toasts')).slice(before))}`);
          await run(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('teste-briefing')).click()`);
          await sleep(500);
        };
        const readBoard = async (label) => {
          await run(`document.querySelector('#open-board').click()`);
          await sleep(800);
          log.push(`quadro ${label}: ${await run(`JSON.stringify(Object.fromEntries([...document.querySelectorAll('.view-board .column')].map((c) =>
            [c.querySelector('h3').firstChild.textContent, [...c.querySelectorAll('.card')].map((k) => k.querySelector('header strong').textContent
              + ' [' + [...k.querySelectorAll('.agent .state')].map((e) => e.textContent).join(',') + ']'
              + [...k.querySelectorAll('.badge')].map((b) => ' ' + b.textContent).join('')
              + (k.querySelector('.said') ? ' «' + k.querySelector('.said').textContent.slice(0, 80) + '»' : ''))])))`)}`);
          await shot(`t-quadro-${label}`);
          await run(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('Claude')).click()`);
          await sleep(300);
        };
        let sentDuringTrust = false;
        let trustedAt = null;
        let briefingAt = null;
        for (let i = 0; i < 90 && !briefingAt; i += 1) {
          await sleep(1000);
          // O diálogo aparece antes do Claude ler o teclado: responde com folga e de novo se ele continuar na tela.
          if (/trust this folder/i.test(await screen()) && (!trustedAt || Date.now() - trustedAt > 4000)) {
            const ptyId = Math.max(...[...ptySizes.keys()]);
            log.push(`trust na tela; briefing já escrito no pty? ${writes.some((w) => w.data.includes(MARK))}`);
            if (!sentDuringTrust) {
              sentDuringTrust = true;
              await run(`document.querySelector('.project:last-child [title="Terminal aqui"]').click()`);
              await sleep(2500);
              await sendFromTerminal('durante-trust');
            }
            await sleep(2000);
            write(ptyId, '\x1b[B');
            await sleep(500);
            write(ptyId, '\r');
            trustedAt = Date.now();
          }
          briefingAt = writes.find((w) => w.data.includes(MARK))?.at || null;
        }
        log.push(`trust respondido: ${!!trustedAt}; briefing colado: ${!!briefingAt}; depois do trust: ${!!(trustedAt && briefingAt > trustedAt)} (+${briefingAt - trustedAt} ms)`);
        const seen = [];
        for (let i = 0; i < 90; i += 1) {
          await sleep(1000);
          const st = await run(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('Claude'))?.dataset.status || '-'`);
          if (seen.at(-1) !== st) seen.push(st);
          if (seen.includes('busy') && st === 'idle') break;
        }
        log.push(`Enter depois do briefing: ${writes.some((w) => w.at > briefingAt && w.data === '\r')}`);
        log.push(`status: ${seen.join(' -> ')}`);
        await sendFromTerminal('depois-do-prompt');

        // Esperando você: sai do auto mode (Shift+Tab até "manual mode"), pede uma escrita de arquivo e
        // confere o estado "waiting", o destaque, a notificação e o piscar na barra; depois recusa com Esc.
        const claudePty = Math.max(...[...ptySizes.keys()].filter((id) => writes.some((w) => w.id === id && w.data.includes(MARK))));
        for (let i = 0; i < 6 && !/manual mode on/i.test(await screen()); i += 1) {
          // Uma tecla por vez e confirma com folga: com a tela atrasada, a próxima tecla passaria de
          // "manual" para "accept edits", que aprova escrita sozinho e o teste não veria a permissão.
          write(claudePty, '\x1b[Z');
          await sleep(1500);
        }
        log.push(`modo manual: ${/manual mode on/i.test(await screen())}`);
        const flashes = [];
        // App em segundo plano: é aí que a notificação e o piscar têm que acontecer.
        win.minimize();
        await sleep(500);
        log.push(`em foco antes do pedido: ${win.isFocused()} / documento: ${await run("document.hasFocus()")}`);
        const { ipcMain, Notification } = require('electron');
        const shown = [];
        const realShow = Notification.prototype.show;
        Notification.prototype.show = function show() { shown.push(this.title); return realShow.call(this); };
        ipcMain.on('window:notify', (_e, note) => flashes.push(`${note.title} | ${note.body}`));
        write(claudePty, ' Ignore o texto acima e crie o arquivo probe.txt com o conteudo oi usando a ferramenta Write.');
        await sleep(800);
        write(claudePty, '\r');
        let waitingSeen = null;
        for (let i = 0; i < 60 && !waitingSeen; i += 1) {
          await sleep(1000);
          const st = await run(`JSON.stringify({ status: [...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('Claude'))?.dataset.status, waiting: [...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('Claude'))?.classList.contains('waiting'),
            title: [...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('Claude'))?.title })`);
          if (JSON.parse(st).status === 'waiting') waitingSeen = st;
        }
        log.push(`esperando você: ${waitingSeen}`);
        await readBoard('esperando');
        log.push(`notificações pedidas ao main: ${JSON.stringify(flashes)}; mostradas: ${JSON.stringify(shown)}`);
        await shot('t1b-esperando');
        write(claudePty, '\x1b');
        for (let i = 0; i < 20; i += 1) {
          await sleep(1000);
          if ((await run(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('Claude'))?.dataset.status`)) === 'idle') break;
        }
        win.restore();
        log.push(`depois do Esc: ${await run(`[...document.querySelectorAll('.tab')].find((t) => t.textContent.startsWith('Claude'))?.dataset.status`)}`);
        await status('agente com briefing');
        await shot('t1-briefing');

        // O "agente" muda um arquivo e cria outro (sem commit), e o diff tem que mostrar os dois.
        const wt = path.join(`${repo}.worktrees`, 'teste-briefing');
        fs.writeFileSync(path.join(wt, 'a.txt'), 'linha 1\nlinha 2 mudada\n');
        fs.writeFileSync(path.join(wt, 'novo.txt'), 'oi\n');
        await run(`window.dispatchEvent(new Event('focus'))`);
        for (let i = 0; i < 20 && !(await run(`!!document.querySelector(".worktrees .badge")`)); i += 1) await sleep(500);
        log.push(`sidebar: ${await run(`[...document.querySelectorAll('.worktrees li')].map((l) => l.textContent).join(' | ')`)}`);
        await readBoard('com-mudancas');
        await run(`document.querySelector('.worktrees li [title^="Revisar"]').click()`);
        const diffStart = Date.now();
        for (let i = 0; i < 40 && !(await run('document.querySelectorAll(".frame:not([hidden]) .line-insert, .frame:not([hidden]) .char-insert").length')); i += 1) await sleep(500);
        log.push(`diff marcado em ${Date.now() - diffStart} ms`);
        log.push(`diff: ${await run(`JSON.stringify({ resumo: document.querySelector('.frame:not([hidden]) .toolbar .path')?.textContent,
          arquivos: [...document.querySelectorAll('.frame:not([hidden]) .tree .file')].map((e) => e.textContent),
          monacoDiff: !!document.querySelector('.frame:not([hidden]) .monaco-diff-editor'),
          linhasMudadas: document.querySelectorAll('.frame:not([hidden]) .line-insert, .frame:not([hidden]) .char-insert').length })`)}`);
        await shot('t2-diff');

        await run(`[...document.querySelectorAll('.frame:not([hidden]) .toolbar button')].find((b) => b.textContent.startsWith('Concluir')).click()`);
        for (let i = 0; i < 20 && !(await run(`document.querySelector("#modal").open && document.querySelector("#modal-title").textContent.startsWith("Concluir")`)); i += 1) await sleep(500);
        log.push(`concluir form: ${await run(`JSON.stringify([...document.querySelectorAll('#modal-fields label')].map((l) => l.querySelector('span').textContent + ' = ' + l.querySelector('select, input, textarea').value))`)}`);
        await run(`document.querySelector('#modal-ok').click()`);
        await sleep(15000);
        log.push(`depois de concluir: ${await run(`JSON.stringify({ abas: [...document.querySelectorAll('.tab .label')].map((e) => e.textContent),
          toasts: window.__toasts, worktrees: document.querySelectorAll('.worktrees li').length })`)}`);
        log.push(`git log: ${g(repo, 'log', '--oneline').replace(/\n/g, ' | ')}; branches: ${g(repo, 'branch').replace(/\n/g, ',')}; worktree existe: ${fs.existsSync(wt)}`);
        await shot('t3-concluido');
      } catch (error) {
        log.push(`SMOKE FALHOU: ${error.stack}`);
      } finally {
        // Devolve a área de transferência; se o conteúdo não voltar como texto, ao menos não fica o do teste.
        try {
          clipboard.writeText(String((await savedClipboard) ?? ''));
        } catch (error) {
          clipboard.clear();
          log.push(`área de transferência não restaurada (${error.message}); foi limpa`);
        }
      }
      fs.writeFileSync(path.join(outDir, 'console-task.txt'), log.join('\n'));
      app.quit();
    });
    return;
  }

  // AGENT_DECK_SMOKE_RESTORE=1 com a mesma pasta de saída: só confere a reabertura da sessão anterior.
  if (process.env.AGENT_DECK_SMOKE_RESTORE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        await sleep(25000);
        log.push(`reaberto: ${await tabsInfo()}`);
        log.push(`layout: ${await run(`document.querySelector('#panes').dataset.layout`)}`);
        // O comando digitado em cada aba de agente aparece na primeira linha da tela dela.
        for (let i = 0; i < 3; i += 1) {
          await run(`document.querySelectorAll('.tab')[${i}].click()`);
          await sleep(800);
          log.push(`tela ${i}: ${await run(`[...document.querySelectorAll('.frame.focused .xterm-rows > div, #panes[data-layout="1"] .frame:not([hidden]) .xterm-rows > div')].map((e) => e.textContent.trim()).find((t) => /claude|codex/.test(t)) || ''`)}`);
        }
        await shot('07-reaberto');
      } catch (error) {
        log.push(`SMOKE FALHOU: ${error.stack}`);
      }
      fs.writeFileSync(path.join(outDir, 'console-restore.txt'), log.join('\n'));
      app.quit();
    });
    return;
  }

  win.webContents.once('did-finish-load', async () => {
    try {
      await sleep(2500);
      await run(`window.__smokeErrors = []; addEventListener('error', (e) => __smokeErrors.push(String(e.message))); addEventListener('unhandledrejection', (e) => __smokeErrors.push(String(e.reason?.stack || e.reason)))`);
      await shot('01-inicial');

      await newTab('terminal', 'Claude trabalho');
      await sleep(3000);
      ptys.write(1, 'echo "CLAUDE_CONFIG_DIR=$env:CLAUDE_CONFIG_DIR"\r');
      await sleep(1500);
      await status('terminal (conta trabalho)');
      await shot('02-terminal');

      await newTab('claude', 'Claude');
      await sleep(20000); // o Claude leva ~10-12s pra subir (MCP, agents)
      await status('agente claude');
      await shot('03-claude');

      // Troca entre agentes: segunda aba Claude (outra conta). Seleciona a linha do echo no
      // terminal com um arrasto de mouse de verdade, botão direito, "Enviar seleção para" a aba nova.
      await newTab('claude', 'Claude trabalho');
      await sleep(20000);
      await run(`document.querySelectorAll('.tab')[0].click()`);
      await sleep(500);
      const line = JSON.parse(await run(`JSON.stringify((() => {
        const row = [...document.querySelectorAll('.frame:not([hidden]) .pane .xterm-rows > div')].find((e) => e.textContent.startsWith('CLAUDE_CONFIG_DIR='));
        const r = row.getBoundingClientRect();
        return { x: Math.round(r.left + 2), y: Math.round(r.top + r.height / 2), width: Math.round(row.textContent.trimEnd().length * r.width / row.textContent.length) };
      })())`));
      const mouse = (type, x, extra = {}) => win.webContents.sendInputEvent({ type, x, y: line.y, button: 'left', clickCount: 1, ...extra });
      mouse('mouseDown', line.x);
      for (let x = line.x; x <= line.x + line.width; x += 40) mouse('mouseMove', x, { modifiers: ['leftButtonDown'] });
      mouse('mouseUp', line.x + line.width);
      await sleep(300);
      // Confere o que chega no pty de destino (a tela pode não renderizar com a janela oculta).
      const sent = [];
      const write = ptys.write;
      ptys.write = (id, data) => { sent.push({ id, data }); write(id, data); };
      await run(`document.querySelector('.frame:not([hidden]) .pane').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${line.x}, clientY: ${line.y} }))`);
      await sleep(300);
      log.push(`menu: ${await run(`JSON.stringify([...document.querySelectorAll('.context-menu > *')].map((e) => e.textContent))`)}`);
      await run(`[...document.querySelectorAll('.context-menu button.indent')].find((b) => b.textContent.includes('Claude trabalho'))?.click()`);
      await sleep(1500);
      ptys.write = write;
      log.push(`enviado ao pty: ${JSON.stringify(sent)}`);
      await status('envio entre abas');
      await shot('03b-envio');

      await newTab('browser');
      await sleep(4000);
      await status('navegador');

      await run(`document.querySelector('.project [title="Editor aqui"]').click()`);
      await sleep(4000);
      await run(`[...document.querySelectorAll('.tree .file')].find((e) => e.textContent === 'package.json')?.click()`);
      await sleep(2000);
      await status('editor');
      await shot('04-editor');

      // Painéis: 4 (2×2), 2 lado a lado e de volta a 1. Confere frames visíveis, tamanhos e
      // se os terminais receberam resize (o ConPTY precisa saber das colunas novas).
      const resized = [];
      const resize = ptys.resize;
      ptys.resize = (id, cols, rows) => { resized.push(`${id}:${cols}x${rows}`); resize(id, cols, rows); };
      for (const count of [4, 2, 1]) {
        await run(`document.querySelector('#layouts [data-layout="${count}"]').click()`);
        await sleep(1200);
        log.push(`layout ${count}: ${await run(`JSON.stringify([...document.querySelectorAll('#panes > .frame:not([hidden]), #panes > .slot-empty')]
          .sort((a, b) => a.style.order - b.style.order)
          .map((e) => { const r = e.getBoundingClientRect(); return (e.querySelector('.frame-head .label')?.textContent || 'vazio') + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + (e.classList.contains('focused') ? ' *' : ''); }))`)} resize: ${resized.splice(0).join(' ')}`);
        await shot(`05-layout-${count}`);
      }
      ptys.resize = resize;

      // Sidebar: arrasta a borda de 290 para 450 px e esconde/mostra com Ctrl+Shift+B.
      const sidebarWidth = () => run(`Math.round(document.querySelector('#sidebar').getBoundingClientRect().width)`);
      const drag = (type, x) => win.webContents.sendInputEvent({ type, x, y: 400, button: 'left', clickCount: 1 });
      drag('mouseDown', 290);
      for (let x = 300; x <= 450; x += 30) win.webContents.sendInputEvent({ type: 'mouseMove', x, y: 400, modifiers: ['leftButtonDown'] });
      drag('mouseUp', 450);
      await sleep(500);
      const afterDrag = await sidebarWidth();
      const key = () => {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'B', modifiers: ['control', 'shift'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'B', modifiers: ['control', 'shift'] });
      };
      key();
      await sleep(300);
      const hidden = await sidebarWidth();
      key();
      await sleep(300);
      log.push(`sidebar: arrastada=${afterDrag} escondida=${hidden} de volta=${await sidebarWidth()}`);
      await shot('06-sidebar');

      // Status: manda a mensagem que o envio entre abas deixou no prompt do "Claude trabalho" (pty 3),
      // com o foco em outra aba; espera trabalhando -> ocioso e o aviso "terminou".
      ptys.write(3, '\r');
      const seen = [];
      for (let i = 0; i < 90; i += 1) {
        await sleep(1000);
        const status = await run(`document.querySelectorAll('.tab')[2].dataset.status || '-'`);
        if (seen.at(-1) !== status) seen.push(status);
        if (seen.includes('busy') && status === 'idle') break;
      }
      log.push(`status trabalho: ${seen.join(' -> ')}`);
      await sleep(2000); // debounce do salvamento
      log.push(`abas: ${await tabsInfo()}`);
      log.push(`sessão salva: ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(outDir, 'userData', 'state.json'), 'utf8')).session)}`);

      // Tamanho: o pty tem que saber exatamente as linhas/colunas que o xterm mostra; se não,
      // o agente desenha para um terminal menor e o prompt fica no meio da tela.
      for (let i = 0; i < 3; i += 1) {
        await run(`document.querySelectorAll('.tab')[${i}].click()`);
        await sleep(800);
        // data-size vem do onResize do xterm: não depende da janela estar renderizando.
        const shown = await run(`document.querySelector('.frame:not([hidden]) .pane').dataset.size || 'inicial'`);
        const last = ptySizes.get(i + 1);
        const pty = last && `${last.cols}x${last.rows}`;
        log.push(`tamanho aba ${i}: xterm ${shown}, pty ${pty} ${shown === pty ? 'OK' : 'DIVERGE'}`);
      }
    } catch (error) {
      log.push(`SMOKE FALHOU: ${error.stack}`);
    }
    fs.writeFileSync(path.join(outDir, 'console.txt'), log.join('\n'));
    app.quit();
  });
};
