// Processo separado que hospeda os terminais (como o pty host do VS Code).
// No processo principal do Electron o ConPTY trava logo depois de iniciar o shell;
// aqui, rodando como Node (ELECTRON_RUN_AS_NODE), funciona normalmente.
// Só executa o que o processo principal mandar; ele já resolveu shell, env e comando.
const pty = require('node-pty');

const terminals = new Map();
const send = (msg) => process.connected && process.send(msg);

process.on('message', (msg) => {
  switch (msg.type) {
    case 'spawn': {
      // Falha ao subir um terminal derruba só ele, não o host (e com ele todas as outras abas).
      let term;
      try {
        term = pty.spawn(msg.shell, msg.args, { ...msg.options, useConpty: true });
      } catch (err) {
        send({ type: 'exit', id: msg.id, code: -1, error: err.message });
        break;
      }
      terminals.set(msg.id, term);
      term.onData((data) => send({ type: 'data', id: msg.id, data }));
      term.onExit(({ exitCode }) => {
        terminals.delete(msg.id);
        send({ type: 'exit', id: msg.id, code: exitCode });
      });
      if (msg.input) term.write(msg.input);
      break;
    }
    case 'write':
      terminals.get(msg.id)?.write(msg.data);
      break;
    case 'resize':
      terminals.get(msg.id)?.resize(msg.cols, msg.rows);
      break;
    case 'kill':
      terminals.get(msg.id)?.kill();
      terminals.delete(msg.id);
      break;
  }
});

// O kill do node-pty no Windows varre os processos filhos do shell em segundo plano;
// dá um tempo pra ele terminar antes de sair, senão sobra agente órfão.
process.on('disconnect', () => {
  for (const term of terminals.values()) term.kill();
  setTimeout(() => process.exit(0), 1500);
});
