// Teste de fumaça: AGENT_DECK_SMOKE=<pasta de saída> npm start
// Abre terminal (com conta não-padrão), agente Claude, navegador e editor; tira screenshots
// e grava console + estado em <saída>/console.txt; depois fecha o app.
const fs = require('node:fs');
const path = require('node:path');
const ptys = require('./pty');

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
    tela: [...document.querySelectorAll('.pane:not([hidden]) .xterm-rows > div')].map((e) => e.textContent.trimEnd()).filter(Boolean).slice(0, 14),
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
        const row = [...document.querySelectorAll('.pane:not([hidden]) .xterm-rows > div')].find((e) => e.textContent.startsWith('CLAUDE_CONFIG_DIR='));
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
      await run(`document.querySelector('.pane:not([hidden])').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: ${line.x}, clientY: ${line.y} }))`);
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
    } catch (error) {
      log.push(`SMOKE FALHOU: ${error.stack}`);
    }
    fs.writeFileSync(path.join(outDir, 'console.txt'), log.join('\n'));
    app.quit();
  });
};
