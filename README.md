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
| Terminais | `src/main/pty.js` | Decide shell, ambiente da conta e comando; o agente é digitado no shell, à vista |
| ConPTY | `src/main/pty-host.js` | Processo filho (Node) que roda o `node-pty`: no main do Electron o ConPTY travava |
| Status e sessões | `src/main/agents.js` | Lê `<conta>/sessions/<pid>.json` (Claude) e os rollouts do Codex: status e id da conversa |
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

### No dia a dia

- **Painéis**: 1, 2 lado a lado ou 4 (2×2) — botões no canto da barra de abas ou Ctrl+Shift+1/2/4.
  Clicar numa aba fora da tela coloca ela no painel focado (borda amarela).
- **Sidebar**: arraste a borda para mudar a largura; Ctrl+Shift+B esconde.
- **Status**: a bolinha da aba pulsa enquanto o Claude trabalha; quando ele termina numa aba que você
  não está olhando, ela fica destacada ("terminou") até receber foco. O Codex não publica status.
- **Reabrir**: ao abrir, o app recria as abas da última vez. Claude volta com `claude --resume <id>`
  (cada aba na sua conversa; o app abre cada uma com `--session-id` próprio). Sem nenhuma mensagem
  enviada, não há conversa em disco e abre uma nova. Codex volta com `codex resume <id>` quando o id
  foi descoberto. O que estava rodando no momento de fechar é interrompido.
- **Entre agentes**: botão direito num terminal → "Enviar seleção/área de transferência para" outra aba de
  agente. Cola no prompt (bracketed paste), sem Enter. No Claude, selecione com Shift+arrastar.
  Abas de Claude da **mesma conta** também conversam nativamente (`ListAgents`/`SendMessage` do Claude Code).

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
- **O renderer não manda comando livre para o shell**: só escolhe entre `claude`, `codex` e `codex login`,
  mais um id de sessão para reabrir, que o main valida como UUID antes de pôr no comando.
  Depois disso é um terminal normal, então o que o agente executa é responsabilidade das permissões do próprio agente.
- **Envio entre abas** só cola em abas de agente (num terminal puro viraria comando) e só com bracketed paste
  ativo no destino: num diálogo do agente (ex.: "trust this folder") uma quebra de linha responderia por você.
- **Remover worktree** usa `git worktree remove` sem `--force`: com mudança não commitada, o git recusa.

## Dependências (versões fixas)

`electron`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `monaco-editor`. Nada de bundler.
O `npm audit` acusa 2 avisos *low* no DOMPurify dentro do Monaco; irrelevante para um editor que só abre seus arquivos.

## Antivírus

O `.exe` do Electron é assinado pela própria Electron, mas o app em si não é empacotado nem assinado.
Rodando via `npm start`, quem executa é o `electron.exe` oficial. Se algum dia empacotar, assine
(ou o Bitdefender vai reagir igual reagiu ao Ghostex: exe sem assinatura que abre shells).
