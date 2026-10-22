# Agent Deck

Terminal multi-agente pessoal para Windows: abas de Claude Code e Codex, várias contas de cada,
worktree git por tarefa, painel de uso por conta, editor (Monaco) e navegador embutidos.

## Rodar

```bash
npm install
npm start
```

Teste de fumaça (abre as abas, tira screenshots, grava o console e fecha):

```bash
AGENT_DECK_SMOKE=/caminho/saida npm start
```

## Como funciona

| Parte | Onde | O que faz |
| --- | --- | --- |
| Janela, IPC, protocolo `app://` | `src/main/main.js` | Único lugar com acesso a disco, rede e processos |
| Terminais | `src/main/pty.js` | ConPTY via `node-pty`; o agente é digitado no shell, à vista |
| Contas | `src/main/store.js` | Cada conta = um diretório (`~/.claude-<nome>`, `~/.codex-<nome>`) |
| Uso/limites | `src/main/usage.js` | Lê o token salvo pela CLI e consulta o endpoint de uso |
| Worktrees | `src/main/git.js` | `git worktree add -b task/<nome>` em `<repo>.worktrees/<nome>` |
| Arquivos do editor | `src/main/files.js` | Leitura/escrita restritas às pastas de projeto |
| UI | `src/renderer/` | Sandbox, sem Node, só fala com o main pela ponte do `preload` |

### Contas

- **Claude**: abas com conta não-padrão recebem `CLAUDE_CONFIG_DIR=<dir da conta>`. A conta padrão
  usa `~/.claude` + `~/.claude.json`, como a CLI faz sem a variável.
- **GPT**: idem com `CODEX_HOME`. Precisa do Codex CLI instalado (`npm i -g @openai/codex`).
- Na primeira execução o app já importa `~/.claude`, `~/.codex` e qualquer `~/.claude-*` / `~/.codex-*` existente.
- "Login" abre um terminal com a conta: Claude pede login sozinho (ou `/login`), Codex roda `codex login`.
- Nada de trocar arquivo de credencial de lugar: cada conta tem o seu diretório, sempre.

## Segurança: o que este app faz e não faz

- **Sem auto-update, sem telemetria, sem download em tempo de execução.** O app só sai para a rede
  em dois endpoints de uso (abaixo) e no que você abrir no navegador embutido.
- **Tokens não saem do processo principal.** A UI recebe só porcentagens e horários.
  Tokens nunca são renovados pelo app (renovar rotaciona o refresh token e desloga a CLI).
- **Endpoints de uso são internos e não documentados:**
  `api.anthropic.com/api/oauth/usage` e `chatgpt.com/backend-api/wham/usage`. Podem mudar ou sumir;
  se quebrar, só o painel de uso para de funcionar. Consulta no máximo a cada 5 min por conta.
- **Renderer em sandbox** (`contextIsolation`, `sandbox`, sem `nodeIntegration`), CSP restrita,
  janela principal não navega para fora de `app://`, e `app://` só serve `src/renderer` e três pastas de `node_modules`.
- **Navegador embutido** (`<webview>`) sem preload e sem Node, popups abrem na própria aba.
- **Editor/arquivos** só dentro das pastas de projeto cadastradas (e das worktrees delas).
- **O renderer não manda comando livre para o shell**: só escolhe entre `claude`, `codex` e `codex login`.
  Depois disso é um terminal normal, então o que o agente executa é responsabilidade das permissões do próprio agente.
- **Remover worktree** usa `git worktree remove` sem `--force`: com mudança não commitada, o git recusa.

## Dependências (versões fixas)

`electron`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `monaco-editor`. Nada de bundler.
O `npm audit` acusa 2 avisos *low* no DOMPurify dentro do Monaco; irrelevante para um editor que só abre seus arquivos.

## Antivírus

O `.exe` do Electron é assinado pela própria Electron, mas o app em si não é empacotado nem assinado.
Rodando via `npm start`, quem executa é o `electron.exe` oficial. Se algum dia empacotar, assine
(ou o Bitdefender vai reagir igual reagiu ao Ghostex: exe sem assinatura que abre shells).
