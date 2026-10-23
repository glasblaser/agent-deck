# Agent Deck

*[Leia em português](README.pt-BR.md)*

A multi-agent terminal for Windows: tabs of Claude Code and Codex, several accounts of each,
a git worktree per task, per-account usage panel, and a built-in editor (Monaco) and browser.

![Agent Deck](docs/screenshot.png)

> Personal tool, built for my own workflow. Windows only, not packaged, not signed. Use at your own risk.

## Run

Requires Node.js, Git, and the [Claude Code](https://docs.claude.com/en/docs/claude-code) and/or
[Codex](https://github.com/openai/codex) CLIs.

```bash
npm install
npm start
```

Smoke test (opens the tabs, takes screenshots, records the console, and closes):

```bash
AGENT_DECK_SMOKE=/output/path npm start
```

## How it works

| Part | Where | What it does |
| --- | --- | --- |
| Window, IPC, `app://` protocol | `src/main/main.js` | The only place with disk, network and process access |
| Terminals | `src/main/pty.js` | Picks shell, account environment and command; the agent is typed into the shell, in plain sight |
| ConPTY | `src/main/pty-host.js` | Child (Node) process running `node-pty`: in Electron's main process ConPTY hung |
| Status and sessions | `src/main/agents.js` | Reads `<account>/sessions/<pid>.json` (Claude) and Codex rollouts: status and conversation id |
| Accounts | `src/main/store.js` | Each account = one directory (`~/.claude-<name>`, `~/.codex-<name>`) |
| Usage/limits | `src/main/usage.js` | Reads the token saved by the CLI and queries the usage endpoint |
| Worktrees | `src/main/git.js` | `git worktree add -b task/<name>` in `<repo>.worktrees/<name>` |
| Editor files | `src/main/files.js` | Read/write restricted to registered project folders |
| UI | `src/renderer/` | Sandboxed, no Node, talks to main only through the `preload` bridge |

### Accounts

- **Claude**: tabs on a non-default account get `CLAUDE_CONFIG_DIR=<account dir>`. The default account
  uses `~/.claude` + `~/.claude.json`, just like the CLI does without the variable.
- **GPT**: same with `CODEX_HOME`. Requires the Codex CLI (`npm i -g @openai/codex`).
- On first run the app imports `~/.claude`, `~/.codex` and any existing `~/.claude-*` / `~/.codex-*`.
- "Login" opens a terminal on that account: Claude asks for login on its own (or `/login`), Codex runs `codex login`.
- Credential files are never moved around: each account always has its own directory.

### Tasks (worktree from start to finish)

- **Create**: "+ new task" asks for a name, a **base** (where it branches from and merges back to) and an
  optional **briefing**. In Claude, the briefing is sent as the first message as soon as it reaches the prompt,
  after the "trust this folder" dialog (the signal is the session file, which only appears after the dialog).
  In Codex, which doesn't publish status, it goes to the clipboard.
- Base and briefing live in git itself: `branch.<b>.deckbase` and `branch.<b>.description`.
- **Sidebar**: `↑N` = commits ahead of base, `●N` = uncommitted files. Buttons on hover.
- **± Diff**: everything the task changed since the base, committed or not, in Monaco's diff view.
- **Ready-to-use worktree** (⚙ on the project): files to copy into each new worktree (what git ignores, e.g.
  `.env`, `appsettings.Development.json`) and a command typed in the task's terminal before the agent
  (`npm ci`, `dotnet restore`…). The first time it's pre-filled with a suggestion (ignored files at the
  project root, command from the lockfile/`.sln`/`.csproj`). New tasks then offer "Prepare the worktree".
- **✓ Finish**: commits what's left (asks for the message), checks for conflicts first (`git merge-tree`) and does
  a `--no-ff` merge, squash, or PR (`git push` + `gh pr create`). On merge/squash it closes the task's tabs,
  removes the worktree and deletes the branch, but only if everything in it is already in the base. On conflict
  nothing is touched and the message says what to ask the agent. PR keeps the worktree; finish again after the merge to clean up.

Full-cycle test (creates a throwaway repo, opens a real Claude with briefing, diff, finish):
`AGENT_DECK_SMOKE=<short path> AGENT_DECK_SMOKE_TASK=1 npm start`. Use a short path: git on Windows
fails on very long paths. The test marks the temp folder as trusted in `~/.claude.json`.

### Board (home screen)

The board is the first tab, always open (Ctrl+Shift+Q brings it to front). Columns are not dragged:
they come from the real state of the agents and of git, so the board can't drift from reality.

| Column | What's there |
| --- | --- |
| To do | Queued tasks: name, project and briefing, no worktree yet. "▶ Start" opens the new-task form pre-filled |
| Waiting for you | Some agent of the task asked for permission or an answer |
| Working | Some agent is busy |
| To review | Agents stopped and the task has commits or uncommitted changes |
| Idle | No agent, or stopped with nothing changed |
| Done | Merges, squashes and PRs, recorded by the main process when they succeed (with PR link) |

Each card shows the briefing, each agent with its state and for how long ("working · 4 min ago"), and the
agent's **last message**, read from the end of the conversation on disk: text, or the tool it is asking
for while waiting ("Asked: Write: src/a.js"). Agents running in the project folder itself show up as the
project's "(root)" task. Codex doesn't publish status or a readable last message.

### Day to day

- **Panes**: 1, 2 side by side, or 4 (2×2) — buttons at the corner of the tab bar or Ctrl+Shift+1/2/4.
  Clicking an off-screen tab puts it in the focused pane (yellow border).
- **Sidebar**: drag the edge to resize; Ctrl+Shift+B hides it.
- **Command palette**: Ctrl+Shift+P anywhere, or Ctrl+K outside the terminal and editor (in the agent's prompt
  Ctrl+K deletes to end of line). Fuzzy search over tabs, tasks (plus diff/finish), the to-do queue, per-project actions and layout.
- **Account colors**: each account has a color (automatic, or pick it on the account card). It shows as the stripe
  and tag on board cards, the tab underline and the pane header, so you can tell which account an agent is on.
- **Status**: the tab dot pulses while Claude works; when it finishes in a tab you're not looking at, the tab
  stays highlighted ("done") until it gets focus. When Claude asks for permission the tab turns red
  ("waiting for you": the session file says `status: "waiting"`). With the app in the background, both
  raise a Windows notification and flash the taskbar; clicking the notification opens the tab.
  Codex doesn't publish status.
- **Reopen**: on start, the app recreates the tabs from last time. Claude comes back with `claude --resume <id>`
  (each tab in its own conversation; the app opens each one with its own `--session-id`). With no message
  sent there's no conversation on disk, so a new one opens. Codex comes back with `codex resume <id>` when the id
  was discovered. Whatever was running when the app closed is interrupted.
- **Between agents**: right-click a terminal → "Send selection/clipboard to" another agent tab. Pastes into
  the prompt (bracketed paste), no Enter. In Claude, select with Shift+drag.
  Claude tabs on the **same account** can also talk natively (Claude Code's `ListAgents`/`SendMessage`).

## Security: what this app does and doesn't do

- **No auto-update, no telemetry, no runtime downloads.** The app only goes to the network for two usage
  endpoints (below) and whatever you open in the built-in browser.
- **Tokens never leave the main process.** The UI only receives percentages and times.
  Tokens are never refreshed by the app (refreshing rotates the refresh token and logs the CLI out).
- **The usage endpoints are internal and undocumented — not an official API:**
  `api.anthropic.com/api/oauth/usage` and `chatgpt.com/backend-api/wham/usage`. They may change or disappear
  without notice; if they break, only the usage panel stops working. Queried at most every 5 min per account.
- **Sandboxed renderer** (`contextIsolation`, `sandbox`, no `nodeIntegration`), strict CSP,
  the main window never navigates outside `app://`, and `app://` only serves `src/renderer` and three `node_modules` folders.
- **Built-in browser** (`<webview>`) with no preload and no Node; popups open in the same tab.
- **Editor/files** only inside registered project folders (and their worktrees).
- **The renderer never sends free-form commands to the shell**: it can only pick between `claude`, `codex` and
  `codex login`, plus a session id to resume, which main validates as a UUID before putting it in the command,
  and a "prepare" flag: the worktree setup command is the one *you* saved on the project, read by main from
  `state.json` (one line, typed in plain sight before the agent). The files to copy also come from there,
  relative to the project only. After that it's a normal terminal, so what the agent runs is governed by the agent's own permissions.
- **Sending between tabs** only pastes into agent tabs (in a plain terminal it would become a command). For Claude,
  only once its session file reports it at the prompt (it doesn't exist during the "trust this folder" dialog,
  where pasted text could answer for you). Bracketed paste alone doesn't prove that: pwsh turns it on itself.
- **Removing a worktree** uses `git worktree remove` without `--force`: with uncommitted changes, git refuses.

## Dependencies (pinned versions)

`electron`, `node-pty`, `@xterm/xterm`, `@xterm/addon-fit`, `monaco-editor`. No bundler.
`npm audit` reports 2 *low* warnings in DOMPurify inside Monaco; irrelevant for an editor that only opens your own files.

## Antivirus

Electron's `.exe` is signed by Electron itself, but the app is neither packaged nor signed.
With `npm start`, the official `electron.exe` is what runs. If you ever package it, sign it — otherwise
antivirus software tends to flag an unsigned exe that spawns shells.

## License

[MIT](LICENSE)
