# PeerLetter

[![English](https://img.shields.io/badge/lang-English-blue)](README.md)
[![한국어](https://img.shields.io/badge/lang-%ED%95%9C%EA%B5%AD%EC%96%B4-red)](README.ko.md)

Agents in one local workspace exchange durable mail through **stdio MCP + shared SQLite**. Each client starts its own process. No listener, port, token service or Pi host is required.

This repository is for **GitHub clone based testing with pnpm**. Registry and marketplace publishing are disabled. Node **24.18+** runs the TypeScript sources directly; no build is needed.

## Install once for your user

```bash
git clone https://github.com/crazylulu-c2sh/PeerLetter.git ~/dev/PeerLetter
~/dev/PeerLetter/setup all
# Or select one host: setup claude | setup codex | setup pi
```

`setup` finds Node **24.18+** on PATH or in the usual nvm installation, pins its real absolute executable, and installs dependencies with **pnpm 10+ / Corepack** (pnpm switches itself to the `packageManager` version), `--frozen-lockfile --ignore-scripts`. No build or dependency build approval is needed. If Node/pnpm is missing, it prints the required installation step and exits. Set `PEERLETTER_NODE=/absolute/path/to/node` to choose Node explicitly. Bash is required. Keep this checkout at the installed path; rerun setup after changing it or the Node installation.

Setup configures automatic wake and the PeerLetter skill **for your user across projects**. It prints a readable report: installation checks, a workspace SQLite `doctor` result, private backup paths, possible project conflicts, and remaining host steps. Add `--json` for the full machine-readable result on stdout; progress then goes to stderr. Other settings remain intact. It uses a private directory catalog for Claude; nothing is uploaded or published.

| Host | User configuration | Default wake | Finish in the host |
|---|---|---|---|
| Claude | `~/.claude/peerletter-plugin`, user plugin catalog/installation, `~/.claude/peerletter.json` | `claude-monitor` | Accept plugin/workspace trust; reload for a first install, restart for an existing MCP runtime update. Check `whoami.wake_runner.online`. |
| Codex | `~/.codex/config.toml`, `~/.codex/hooks.json`, `~/.agents/skills/peerletter` | `codex-queue` | Review `/hooks`, reconnect MCP or start a new session, then ask Codex to use PeerLetter so its first whoami binds the thread. |
| Pi | `~/.pi/agent/settings.json`, generated extension with pinned Node, skill path | `pi-extension` | `/reload` or restart. User extensions and skills load before project trust; project resources remain subject to trust. Pi itself needs Node 24.18+. |

`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and `XDG_STATE_HOME` override their usual locations. Installation ownership is recorded in `$XDG_STATE_HOME/peerletter/installation.json` (default `~/.local/state/peerletter/installation.json`). Global entries do not pin a project or an agent name: each host session joins its real working directory/Git root. Codex reads only the calling native thread's cwd through its existing local app-server socket; if that socket is unavailable it reports an error instead of selecting the daemon's cwd. A project-pinned install remains available below for other integrations.

Then open the agents in the **same project** and say:

> Use PeerLetter to communicate with the other agents.
>
> PeerLetter 사용해서 다른 에이전트와 통신해줘.

The skill calls **whoami → peers**, reports its actual name, peers, binding and wake status, then receives mail. Only sessions that use PeerLetter join: a session that never calls a PeerLetter tool stays out of presence even with automatic wake installed, and a session that has used it rejoins automatically after an MCP reconnect, restart or resume. The first whoami is an **agent MCP tool call**, not the shell's `whoami` command. With Codex, this first call is required after every new MCP connection; global installation alone cannot identify a shared daemon's thread. `/mcp` shows status and does not restart the server. For Codex 0.160.0, exiting the TUI, intentionally restarting its shared app-server daemon, and resuming the same thread reconnects MCP; a daemon restart disconnects other clients too.

Old project-local PeerLetter entries can override or compete with user entries. Setup reports matching files in its current directory but does not edit projects or search arbitrary checkouts. Back up and remove/disable only the old PeerLetter MCP, plugin, hooks, extension and skill entries before switching; keep unrelated configuration. Also check other projects where you installed PeerLetter. A stale project `.claude/peerletter.json` can select `none` and stop the global monitor: update/remove that owned mode file when switching to global setup. Never run two PeerLetter MCP entries for the same session.

```bash
~/dev/PeerLetter/setup all --preview          # no dependencies/settings changed
~/dev/PeerLetter/setup --uninstall all       # or claude, codex, pi
```

Uninstall removes owned MCP/hooks/extension/skill entries and the user Claude plugin/catalog, preserving settings added later. It silences a running Claude monitor first; restart/reload the host afterward to disconnect an already running MCP. Backups remain private. Edited generated files are retained and reported; an edited managed Codex block must be reviewed before uninstall. The installer never restores an old full config over later user edits. Installation/uninstall does not delete mail or leases from the workspace DB.

### Update

```bash
~/dev/PeerLetter/setup update                # --preview lists incoming commits and the plan only
```

`setup update` fast-forwards this checkout to its upstream branch, installs dependencies from the frozen lockfile and refreshes every agent recorded in the installation manifest: the generated Claude plugin and skill copy, Codex and Pi entries, and the pinned Node. The updated setup script finishes the run. Nothing is changed if tracked files have local edits, the branch has no upstream, or the checkout has commits that are not upstream. Afterwards restart Claude (plugin reload does not respawn a running MCP), reconnect Codex MCP or start a new session, and `/reload` Pi. Project-local installs are not refreshed; rerun `scripts/install.ts --project DIR --apply` for them.

### Verify or develop the checkout

```bash
cd ~/dev/PeerLetter
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
```

Runtime dependencies are the MCP SDK, Zod and `ws`; SQLite is built into Node. The Pi SDK is a development dependency for extension checks. No registry publication is enabled.

## Test with agents already running

Prepare a wrapper and a prompt for your current workspace:

```bash
node ~/dev/PeerLetter/scripts/prepare.ts --project /path/to/project
```

This creates `output/peerletter-test/peerletter`, `AGENT-PROMPT.txt` and a short guide. It initializes an empty workspace database and sends no mail. Give the prompt to each participating agent and choose distinct names.

```bash
MAIL=/path/to/project/output/peerletter-test/peerletter

# Run each registration as the corresponding participant.
"$MAIL" --name codex-review register
"$MAIL" --name claude-build register
"$MAIL" peers

"$MAIL" --name codex-review send --to claude-build \
  --text 'PeerLetter connection test' --idempotency-key test-001
"$MAIL" --name claude-build receive
# After processing the message, copy its complete UUID:
"$MAIL" --name claude-build ack <MESSAGE_UUID>
"$MAIL" --name codex-review status <MESSAGE_UUID>
```

`register` creates an offline mailbox. Mail to that name is durable and can be read immediately through CLI. For online presence, run `"$MAIL" --name codex-review --kind codex serve` in a separate terminal and stop it with Ctrl-C. Repeated `receive` returns the message until ACK. For an actual reply, use `send --reply-to <MESSAGE_UUID>` with a new stable key.

Existing host sessions can use this CLI immediately. New MCP tools require a new Codex/Claude session or the host's reconnection flow; Pi can use `/reload`.

## Project-local setup (optional)

The installer previews **project-local** configuration, preserving other server entries, settings and hook handlers. Apply after reviewing the generated files:

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project --apply
```

| Client | Project files | Skill |
|---|---|---|
| Codex | `.codex/config.toml`, `.codex/hooks.json` | `.agents/skills/peerletter` |
| Claude | `.mcp.json`, `.claude/settings.local.json` | `.claude/skills/peerletter` |
| Pi | `.pi/mcp.json` | `.pi/skills/peerletter` |

Changed files receive private `.backup-<timestamp>-<id>` copies. Run again to update the managed Codex block or the same checkout's entries. Conflicting skill links and unrelated PeerLetter registrations are rejected. Restore a backup to undo a change, or remove the generated entry and its hook handlers. Skill links point at this checkout. Local configuration contains absolute paths; keep it out of a shared project's commits if those paths are machine specific.

Host trust rules still apply: approve the Claude project MCP server, use Pi `/trust` to save trust for this project and then `/reload`, and review Codex hooks using `/hooks`. Codex skips new or modified hooks until reviewed. Its project configuration also requires a trusted project. Pi `-a` trusts only that invocation; it does not make a running session trust project MCP configuration. The installer does not change host trust decisions. See the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks), [Claude hooks reference](https://code.claude.com/docs/en/hooks), and [Pi project trust documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md#project-trust).

By default all three use manual inbox checks. After connecting, call `peerletter_whoami` and `peerletter_peers` to verify the project and name before sending. In Claude's manual mode, PostToolUse can signal new mail during work and Stop signals at the end of a turn. Automatic Claude modes use one notification adapter and suppress those foreground mail notices. Signals are body-free and never ACK.

### Participation and mailbox names

With `wake=none`, clients join on their **first PeerLetter tool call**. Initialization and `tools/list` do not reserve a name or start a watcher, even when a host session ID is known. This keeps unused manual clients, loaded threads and subagents out of presence. Hooks tolerate sessions that have not joined.

With an opt-in wake adapter, a connection whose actual host session is known **and has used PeerLetter before** joins after MCP initialization and starts its wake adapter **without a tool call**. A session that has never made a PeerLetter tool call (a new Claude or Pi session, Pi `/new`, Claude `/clear`) stays out of presence like a manual client until its first tool call. That call records the host session as used in the workspace database; later connections of the same session (reconnect, restart with resume, `/resume`) join automatically. A declined startup creates no database. Identities accepted for startup registration:

| Client | Identity accepted for startup registration |
|---|---|
| Claude monitor / async-rewake / channel | `CLAUDE_CODE_SESSION_ID`, or an explicitly configured session (watch modes require a UUID) |
| Pi extension | The actual session ID the extension supplies with `--session`; Pi connects extension MCP servers at startup |
| Codex queue | An explicit `--session <thread UUID>` that deliberately pins this MCP connection |

Missing, invalid or temporary identities stay lazy. Claude's PID registry and hook-only identities are not used for startup registration. Codex's inherited `CODEX_THREAD_ID`/`PEERLETTER_SESSION_ID` and PID hook mappings cannot prove which shared-daemon thread loaded an unused connection. The mapping table stores only the latest session for a PID; **one row does not establish one thread**. Normal Codex connections therefore still need their first tool call's native `_meta.threadId`. Do not add a fixed `--session` to shared configuration used by unrelated threads; reserve it for a deliberately managed connection.

Call `peerletter_whoami` to inspect the exact name, binding and wake status. `registration.mode` is `startup` (any join without a tool call) or `tool-call`. A startup deferred for an unused session is logged to stderr once and not retried. Other eligible startup registration failures are logged to stderr and retried with bounded backoff; tool calls report the original error and can also retry. A live owner is never displaced. Reload must close the old connection before its replacement can own the same session. Startup participation does not grant host channel permission or hook trust.

Automatic names (`codex`, `codex-2`, `claude`, `pi`, etc.) are reserved for their original host session. A reconnect with the same bound session ID reuses its offline automatic name. A different session gets a new unused name, including when the old process is offline and its inbox has unread mail. Unbound `runtime:...` identities cannot reuse an old automatic name. Always use the exact name returned by whoami.

For a durable **role mailbox**, set `PEERLETTER_NAME`; file MCP configuration also accepts `--name` when installing one client. Pi extension mode takes its role name from `PEERLETTER_NAME` when launching Pi and rejects an installer `--name` that would not reach the extension. Explicitly reusing an offline role name intentionally inherits its unscoped, unacknowledged mail. An automatic allocation does not take an explicitly named role mailbox. A live name owner yields `NAME_IN_USE`; a second live connection for the same bound host session yields `SESSION_IN_USE`. Ownership is never transferred from a live runtime. After its owner disconnects, retrying the tool can register successfully.

`whoami` and `peers` report `naming` (`automatic`, `explicit`, or `legacy`) and `session_binding` (`bound` or `unbound`, with its source). `online` means the registered MCP process is alive; it does not prove that a TUI is attached or will read mail. Existing legacy mailboxes remain stored and are not reassigned automatically to unrelated sessions. Reconnect old MCP processes after updating to apply this registration policy.

Once a participant has a bound host identity, a different identity on the same connection returns `SESSION_MISMATCH`. Reconnect to register the new session; this keeps automatic mailboxes separate. Binding an initially unbound runtime to its own session remains supported.

### Codex session binding

On the tested Codex 0.159.3, each MCP tool call carries the current thread in `_meta.threadId`. PeerLetter validates it before first registration, including `peerletter_whoami`; this works when the MCP subprocess has no `CODEX_THREAD_ID` and SessionStart hooks are unreviewed. A fork's `_meta.sessionId` can identify the root session, so it is not used as a queue target. This is a version-specific integration verified against the installed client and the [Codex tool-call source](https://github.com/openai/codex/blob/main/codex-rs/core/src/mcp_tool_call.rs).

Inspect `whoami.session_binding`: `bound` identifies a host session, while `unbound` means only a temporary `runtime:...` mailbox identity is available. Basic send/receive still work, but queue wake needs a real thread ID. Fallback IDs are never written as host session mappings. If a hook runs later, the runtime can adopt its mapping. Binding a temporary identity preserves its pause, advisory leases and wake baseline.

For older clients that omit native thread metadata, read **your own** `CODEX_THREAD_ID` from the agent's shell, then call `peerletter_bind_session({session_id: "<that full UUID>"})`. Alternatively review `/hooks` and start a new session so SessionStart can bind it. Never choose a recent rollout, a peer's ID or a guessed ID. Stop and Interrupt hooks still require host review even when native metadata already bound the thread.

To recover an automatic name on an older client without another identity source, make `peerletter_bind_session` your first PeerLetter call. An initial unbound whoami allocates a fresh mailbox; binding it later preserves that mailbox's address, pause, leases and wake baseline.

If you want to continue an existing Codex conversation, you can launch directly with `codex resume <thread-id>` or `codex resume --last`. Normal shared-daemon connections still wait for a PeerLetter tool call to identify the resumed thread, including when queue wake is configured.

If a configured name is already online, tools return `NAME_IN_USE` with an actionable message. Retry after the owner disconnects, or restart with another name for a different session. A failed registration does not hide the cause behind `NOT_READY` or permanently prevent retry.

For one client only, add `--client codex|claude|pi`. An explicit name uses `--client codex --name codex-review`; otherwise live sessions get `codex`, `codex-2`, etc. Set `PEERLETTER_NAME` when launching a host to name each participant independently; Codex configuration forwards it to the MCP subprocess.

### Manual registration instead of the installer

Use the **absolute Node path** from `node -p process.execPath`; nvm's PATH may be absent in MCP subprocesses.

```bash
NODE=/absolute/path/to/node
REPO=/absolute/path/to/PeerLetter
PROJECT=/absolute/path/to/project

claude mcp add -s local peerletter -- "$NODE" "$REPO/src/stdio.ts" --project "$PROJECT" --kind claude
codex mcp add peerletter -- "$NODE" "$REPO/src/stdio.ts" --project "$PROJECT" --kind codex
pi mcp add peerletter --local --exposure direct --cwd "$PROJECT" -- \
  "$NODE" "$REPO/src/stdio.ts" --project "$PROJECT" --kind pi
```

Run these from the project directory. Codex's command registers a user-scope server pinned to that project; use the installer for project scope. Hook scripts remain optional for manual receive.

## Optional wake adapters

All signals contain a count and a request to check the inbox, **never the mail body**. Notifications never ACK. Successful notifications are tracked per message, session and sink. Failures remain retryable and appear in `whoami` / `peers`; basic receive continues to work.

### Claude monitor (recommended)

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake monitor --apply
```

The **project-local** installer generates a private local Claude plugin containing the MCP server, skill, lifecycle hooks and `experimental.monitors` entry. It registers a local directory catalog and installs the plugin with **local scope**: enabled for this user in this project. Nothing is uploaded or published. The plugin uses this checkout's installed dependencies and absolute Node path; continue to manage dependencies with pnpm. Claude Code **2.1.283+** is required by the installer. See the [manifest reference](https://code.claude.com/docs/en/plugins-reference#monitors) and [local plugin installation](https://code.claude.com/docs/en/discover-plugins).

Restart Claude normally. For a first plugin install, `/reload-plugins` can discover it in an existing session; replacing an already running MCP runtime requires restart. **No channel launch flag is needed.** Accept the host's normal workspace/plugin trust prompts. The installer does not approve them for you. The generated monitor arms at session start and plugin reload. Monitors require an interactive session with the Monitor tool; they do not arm in `claude -p` and are unavailable on some cloud providers, including Bedrock, Google Cloud Agent Platform and Foundry.

The installer removes this checkout's competing project `.mcp.json` entry, its server approval-list entries, hook handlers and skill link, preserving unrelated settings and backing up changed files. Claude's plugin CLI also updates user settings (`extraKnownMarketplaces`) and plugin registries; apply snapshots their existing files and prints `plugin_state_backups`, including whether each file existed. Close/reload the old connection before the plugin MCP takes ownership. Remove any separate user-scope PeerLetter MCP registration yourself before switching; a second live MCP cannot take an existing session. Plugin MCP tool names may carry Claude's plugin namespace. Use the tools actually exposed by the host.

The plugin runs the equivalent of:

```bash
node /path/to/PeerLetter/src/cli.ts --project /path/to/project watch
# An explicitly managed watcher can instead use its own exact session/name:
node /path/to/PeerLetter/src/cli.ts --project /path/to/project \
  --session <CLAUDE_SESSION_UUID> --name <EXACT_NAME> watch
```

`watch` requires the current own-host registry/session environment or an explicit UUID. The installed 2.1.287 monitor uses the shell executor that exports its current session ID; no recent-session search or role-name guess is used. A missing/invalid ID fails without creating a participant. Watch waits if its own MCP has not joined, follows its verified own host through MCP reconnects and same-process session transitions, and never registers a CLI mailbox, closes MCP presence, releases MCP leases, reads mail as delivered or ACKs. A mismatching name is rejected. The normal wake baseline skips earlier mail; `--wake-backlog` intentionally includes it.

Each successful signal prints one short count/receive instruction to stdout and records a `claude-monitor` notice. Diagnostics go to stderr. SQLite ensures one live watch process per project/session, rejects competing watches and recovers ownership after a crash. Failed output is retryable; a crash between external output and recording can repeat a signal. There is no exactly-once guarantee. `SIGINT`/`SIGTERM`, host exit or selecting another mode releases watch ownership without disconnecting MCP. An implicit monitor with a verified Claude ancestor waits through the SessionEnd → SessionStart gap; an explicitly pinned watcher exits on session end. `--timeout-ms MS` sets an optional limit; the monitor defaults to continuous watching.

Inspect `whoami.wake_runner.online` and `wake_error` after reload. MCP startup registration alone does not prove the monitor is running or the TUI will react. Switching project-local mode writes `.claude/peerletter.json` (global setup uses the Claude user directory), which an old monitor reads to stop promptly even before reload. Claude plugin disable alone does **not** terminate an already armed monitor; use the installer to select `none`, or stop its task. See [monitor lifecycle](https://code.claude.com/docs/en/plugins/components#monitors).

### Claude `/resume` and `/clear`

Claude can replace its current session without respawning MCP. The inherited `CLAUDE_CODE_SESSION_ID` is then stale. PeerLetter follows the current registry of its **own Claude ancestor** or that live host's validated SessionStart mapping; it does not choose another process's recent session. The continuous monitor releases its old watch claim and attaches to the new actual session. This requires verifiable host identity; if the host cannot be verified, reconnect instead.

The old automatic participant goes offline and releases its leases. The MCP joins the new session without a tool call only if that session has used PeerLetter, for example `/resume` of a session that joined before; it then recovers that session's automatic name. After `/clear`, or a switch to a conversation that never used PeerLetter, the MCP waits without a participant: the first PeerLetter tool call joins with another automatic mailbox, and a later switch to a used session rejoins automatically. Mail and manual pause remain with their original session. Explicit role names still retain their intended unscoped mail, while `--session` stays pinned and does not follow. Live-owner conflicts fail without taking the other participant or releasing the old actor's leases. The watch process itself never changes MCP presence or leases.

After updating this checkout, **restart Claude** to replace already loaded MCP code. `/reload-plugins` refreshes plugin discovery but does not reliably respawn an existing MCP or rearm an existing monitor; it is not sufficient for loading this runtime fix. Until reconnected, launching `claude --resume <SESSION_UUID>` directly is a workaround for an old MCP that still holds its startup session. Check `whoami.session_id`, exact name, `wake_runner.online`, `wake_error` and `delivery_gate` after a transition.

### Claude async-rewake (time-limited alternative)

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake async-rewake --apply
```

This local plugin uses a background Stop hook with `asyncRewake: true`. After each completed turn it waits for new mail using the same watch core. On a real notice it writes the body-free instruction to stderr, records the notice without ACK, and exits **2**, allowing Claude to start an idle turn. A timeout, malformed input or technical failure never exits 2. A duplicate waiting hook exits normally instead of starting a second watcher.

The host timeout is **600 seconds**; the waiter ends after **595 seconds** to leave time for cleanup. After expiry there is a **gap until the next Stop event**. It also has no waiter before the first turn completes. Extending the timeout is not equivalent to continuous monitoring. This is why monitor is recommended for session-long wake. The host's timeout and exit-2 behavior are documented in the [hooks reference](https://code.claude.com/docs/en/hooks). `wake_runner.online` is false during that gap; explicit receive remains available.

### Claude gates and changing mode

All Claude adapters obey persisted manual pause and the reported UI/compaction/session-end gates. PermissionRequest opens a gate for its exact tool call; PostToolUse/PostToolUseFailure close that call's gate. Elicitation/ElicitationResult and PreCompact/PostCompact report their corresponding gates. SessionEnd stops watching, StopFailure pauses after provider errors, and an explicit UserPromptSubmit resumes manual pause. When supplied, PostToolUseFailure `is_interrupt:true` also pauses.

Claude does not provide a reliable hook for every Escape/cancel or every UI dialog. Cancelling a running tool does not necessarily fire PostToolUseFailure. The adapter cannot infer an unreported host pause: use `peerletter --name <EXACT_NAME> pause` to persist a pause that all adapters respect, and `resume` or explicit new user input to clear it. Gates depend on the lifecycle hooks being loaded/trusted. No gate is inferred from idle time, mail priority or error text.

Choose exactly one Claude mode with `--client claude --wake monitor|async-rewake|channel|none` (the full `claude-*` values also work). For example:

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake none --apply
```

Selecting none/channel disables this project's generated plugin entry and restores the file MCP/skill/hook setup. Reload the host connections after switching. Existing inboxes, ACKs and pauses are preserved. Restore the printed setting backups to undo file changes; the catalog remains local and can be removed separately using Claude's plugin commands.

### Claude channel

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake claude-channel --apply
cd /path/to/project
claude --dangerously-load-development-channels server:peerletter
```

This opts into the experimental `claude/channel` capability and `notifications/claude/channel`. The development flag is required for this local server; it is not a published marketplace plugin. Check account and version availability in the [official channels documentation](https://code.claude.com/docs/en/channels-reference). Foreground mail notices are suppressed in this mode to avoid racing the channel. Switch to none for manual Stop/PostToolUse notices.

When the restarted MCP inherits the `CLAUDE_CODE_SESSION_ID` of a session that has used PeerLetter, it registers and watches without an initial whoami call. For a new session, or if the actual session cannot be identified at initialization, call whoami once to join. A saved `--wake` flag alone does not bypass channel enablement in the Claude host.

### Codex queue

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client codex --wake codex-queue --apply
```

This adapter attaches to the host's existing local app-server daemon over its Unix WebSocket control socket. It uses `thread/read` to check its own thread, then the experimental `thread/queue/add|list|delete` methods; this is **version dependent**, verified with Codex 0.160.0. PeerLetter does not start a daemon, resume a thread or subscribe to other threads. It uses its own thread ID from native tool-call metadata, explicit self-binding, `CODEX_THREAD_ID` or the SessionStart hook's PID mapping, and verifies the host process. Without a usable UUID, daemon or compatible API it reports `wake_error` and retries. Approved Stop hooks provide fallback when the queue adapter has reported an error; explicit receive remains available. Review `/hooks`, restart/reconnect the MCP and call whoami after installing or updating.

Only an `idle` thread may get a new queue item. Active turns, including approval or user-input waits, defer notification without recording a receipt or reporting busy as an error. Once idle, the adapter rechecks mail delivery and pause/gates. Mail received during the active turn therefore creates no later queued turn. The default socket is `$CODEX_HOME/app-server-control/app-server-control.sock` (otherwise `~/.codex/...`); `PEERLETTER_CODEX_SOCKET` selects another absolute local socket. The published path and resolved socket must belong to the current user; Codex's own socket symlinks are supported. Remote WebSocket daemons are not handled by this adapter.

An additive `codex_wakes` table saves one owned pending submission per thread, its unique client message ID, queue ID and mail batch. While it is pending, later mail does not create extra queued submissions and remains available to receive or a subsequent wake. Successful receive/ACK reconciles the saved item before returning; the watcher also reconciles even with an empty inbox. It deletes only a matching, unchanged PeerLetter queue item after the batch is delivered or a gate pauses the session. User queue items, edited submissions and old items with no saved ownership ID are preserved. Healthy automatic queue mode defers the Stop hook to the watcher; a claimed batch excludes competing hook notices.

State-check/add/delivery cannot be atomic across SQLite and app-server. A submission already consumed into a turn cannot be recalled, and a crash or lost response in that window can still cause an extra turn. Pending add intents recover by exact client message ID; failed deletion keeps ownership for retry. Notice wording tells the receiver to finish immediately if the inbox is already empty and no task is in progress; an empty inbox never interrupts ongoing work. Delivery remains at-least-once.

The Interrupt hook records a user pause, which blocks queue wake even for high priority mail. New explicit user input or CLI `resume` clears it. This protection depends on that hook running; an unreviewed or disabled Interrupt hook cannot report the host's pause state.

Startup queue registration requires a connection pinned with `--session <your actual thread UUID>` for a thread that has used PeerLetter. Shared-daemon PID mappings and inherited environment IDs remain insufficient for startup registration, even after approving SessionStart hooks. In the normal installer configuration, restart and call whoami once; the first tool request supplies the actual thread. Restart alone cannot guarantee automatic wake for an unidentified Codex thread.

### Pi extension

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client pi --pi-mode extension --apply
```

Reload Pi or start a new session. The extension dynamically registers the same stdio MCP core and binds the actual Pi session ID. The installer removes its own file MCP entry so it cannot override this registration. Do not retain a global `mcp.json` entry named `peerletter` when using the extension; Pi gives file configuration precedence. You can instead launch with `pi -e ~/dev/PeerLetter/pi/peerletter.ts --skill ~/dev/PeerLetter/skills/peerletter`.

The default file MCP mode has no Pi session ID and cannot observe `/new`; whoami reports it as `unbound`. Use extension mode for real session identity and transitions. On `/new`, resume, fork, reload or quit, the extension closes only its own participant, releases its leases and stops polling. The next session's MCP joins at initialization when that session has used PeerLetter (resume, reload), and its extension can notify without an initial tool call. A `/new` session waits for its first PeerLetter tool call. The extension does not allocate another participant or call whoami internally. Resuming the same actual session reuses its offline automatic name; `/new` receives a different automatic name. A role name set explicitly continues its durable inbox. Loading the same session in another Pi process does not grant ownership of the first process's participant.

The extension watches the inbox and sends a body-free `pi.sendMessage(..., {triggerTurn:true, deliverAs:'steer'})`. Manual pause, abort, provider errors, UI dialogs and compaction gate injection. `/peerletter pause`, `/peerletter resume` and `/peerletter status` control or inspect it. New explicit user input resumes a pause. The adapter targets the installed Pi 0.99.2 extension API; see [Pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).

### Restart and previous mail

Messages stay in their named inbox. The same bound session can recover its automatic mailbox on reconnect; another session gets a separate automatic mailbox. Explicit role names intentionally retain mail across sessions when `to_session` is omitted. Session-specific messages remain tied to that session. On a new session, wake adapters skip previously stored mail; explicitly call receive to inspect it. To intentionally wake for the existing backlog, pass `--wake-backlog` to stdio, or set `PEERLETTER_WAKE_BACKLOG=1` for the Pi extension. The Stop hook skips mail predating its session registration.

## Tools and delivery

| Tool | Purpose |
|---|---|
| `peerletter_whoami`, `peerletter_peers` | Name, session, workspace, presence, wake status, naming policy and session binding |
| `peerletter_bind_session` | Recovery for Codex clients without native metadata; binds only this participant to its own current full thread UUID |
| `peerletter_send` | `to`, `text`, required `idempotency_key`; optional full UUID `reply_to`, `thread_id`, `to_session`, `importance` |
| `peerletter_receive`, `peerletter_peek` | At most 20 unacknowledged messages; priority then acceptance order; optional cursor |
| `peerletter_ack` | Atomic batch acknowledgment by the recipient after processing |
| `peerletter_status` | Accepted, notified, delivered or acknowledged timestamps and reply IDs |
| `peerletter_lease_claim`, `peerletter_lease_release`, `peerletter_lease_list` | Advisory project-relative file leases with TTL and renewal |

`receive(wait_ms)` accepts 0–30000 and marks returned mail delivered, without ACK. `peek` has no delivery side effect. Reading and notifications can repeat after a crash; there is no exactly-once guarantee for external work. Keep message IDs in any downstream deduplication mechanism that needs it. ACK means processed, and completion requires an explicit result or reply.

Names are unique among online participants. Explicit collisions fail with `NAME_IN_USE`; automatic names use unclaimed suffixes or recover the same offline bound session. A duplicate live host session fails with `SESSION_IN_USE`. Presence uses the MCP PID and process start time, not a heartbeat timeout. EOF/SIGTERM mark the process offline and release its leases. SIGKILL is detected on the next presence scan; crashed leases expire by TTL. A registered live but idle process is still online.

## SQLite and maintenance

- Workspace key: SHA-256 of the real Git root, or real cwd outside Git. Subdirectories of one checkout share a mailbox; different worktrees have separate paths and mailboxes.
- Default database: `~/.local/state/peerletter/<key>/peerletter.db`. `PEERLETTER_STATE_DIR` overrides the state root and `PEERLETTER_PROJECT` overrides the workspace.
- Directories are 0700 and database/WAL/SHM files are 0600. The local OS account is the trust boundary. CLI is allowed to act as any local named mailbox; it is not cross-user authentication.
- SQLite uses WAL, 5000 ms busy timeout, foreign keys and `synchronous=FULL`. Long polls hold no write transaction. Use local storage; WAL is unsuitable for a network filesystem.
- Schema 2 adds naming and session-source metadata in a separate table. Existing schema 1 mailboxes, messages, delivery states and leases are preserved in an atomic migration. Legacy names can be recovered by the same bound session and stay reserved for other automatic sessions. Older checkouts cannot open a migrated database; update all clients to this checkout and reconnect.
- An additive `watch_owners` table coordinates Claude watch processes. It does not replace agent/session identity, expire inboxes or change delivery/ACK records.
- An additive `used_sessions` table records host sessions that made a PeerLetter tool call; only those join automatically. A database from an earlier checkout has no records yet, so call whoami once in each session after updating.
- An additive `codex_wakes` table persists ownership of pending Codex queue notices. Cancelling a still-pending notice can make its unread mail eligible for another notice; receive and ACK states are preserved.
- Retention is manual: `prune --days 30` previews removal of whole threads whose messages are all ACKed and whose ACKs are older than 30 days. `--apply` removes them. There is no automatic deletion.
- `doctor` checks permissions and SQLite integrity. `doctor --checkpoint` requests a TRUNCATE checkpoint; run during low activity and inspect its busy result.

Leases accept `*`, `**` and `?` only, are atomically acquired and renewed, and belong to the owner's session. Wildcard overlap uses conservative prefixes and may over-report conflicts. Leases do not enforce edits by other tools. Coordinate git state changes separately.

Read the shared [collaboration skill](skills/peerletter/SKILL.md) for inbox timing, ACK rules, file coordination and reply loop limits. Mail content cannot authorize new work or replace user instructions.

## Tests and GitHub workflow

`pnpm run check` checks core, hook, script and Pi extension types. `pnpm test` covers shared SQLite semantics and launches real SDK stdio clients as Codex, Claude and Pi. Tests use temporary state, not live agent mailboxes. The GitHub Actions workflow runs from a clean checkout on Node 24, installs the frozen pnpm lockfile, checks types and runs tests. It has no publishing step.

The suite checks concurrent writes, deduplication, reply direction, priority cursors, atomic ACK ownership, cancellation, leases, durable restart, SIGKILL presence, permissions, notification gates and Claude channel framing. It also covers manual lazy registration for all clients, conditional startup registration, wake-enabled sessions that never used PeerLetter staying out without creating a database, Claude/Pi wake before any receiver tool call, the Codex queue adapter with a local Unix WebSocket fixture, ambiguous shared-PID hook mappings, first-call Codex identity, same-session name recovery, mail isolation, schema 1 migration, live-owner protection, Pi `/new`/resume using real stdio MCP clients, explicit recovery, registration retry and Claude mid-turn hooks. Codex fixtures check busy/read deferral, one pending batch, delivery/add and pause races, hook competition, lost responses, ownership recovery, deletion failure, changed input, socket symlinks and reconnect. Tests never send mail to production agents.

Watch fixtures cover a real SDK MCP starting after watch, no-tool startup, same-session reconnect, exact-name checks, actor/lease preservation, one live watcher, dead-owner recovery, old backlog, pause/UI/compact, output failure, mode changes, foreground-adapter exclusion and async-rewake exit status without ACK. These fixtures verify the adapters, not the host's actual interactive UI behavior. Validate generated plugin and catalog manifests with `claude plugin validate --strict`, then check idle wake in the actual interactive client without channel flags.

`pnpm run test:native-codex` runs a regression for an installed Codex executable. It runs real `codex exec` against a loopback mock Responses provider in an isolated configuration, strips `CODEX_THREAD_ID` from the MCP environment, and verifies native metadata binds the same thread ID that Codex emits. GitHub Actions runs both native Codex fixtures with Codex 0.160.0 temporarily installed using pnpm. No external model or production mailbox is used. This installed-client identity test is separate from the default SDK suite and does not prove that an idle TUI wakes.

`pnpm run test:native-codex-queue -- --global` verifies the user installer with no project-pinned MCP entry; CI uses this mode. `pnpm run test:native-codex-queue` requires installed Codex, Python 3 and a Unix PTY. It starts an isolated app-server and a real interactive TUI with a loopback mock Responses provider. It checks multiple mails received/ACKed during a busy turn produce zero extra turns, unread mail wakes once after the turn, and idle mail wakes once. Normal UI trust prompts are accepted only for the generated fixture. No production daemon, mailbox or configuration is changed and no external model is called. Tested with Codex 0.160.0; mock responses validate actual host/adapter behavior.

`pnpm run test:native-claude` requires installed Claude Code, Python 3 and a Unix PTY. It installs **async-rewake** into a temporary project with isolated Claude settings and PeerLetter state, accepts the normal UI prompts only for that generated fixture, and points a dummy API key at a loopback mock Anthropic provider. It launches a session recorded as used, so it joins without a tool call, and verifies that mail alone starts a subsequent interactive model turn containing a body-free notice, without channel flags or external model calls. The fixture never ACKs and never changes real host settings or production inboxes. Onboarding UI automation is version dependent; tested with Claude Code 2.1.287. That client's loopback/API-key configuration does not expose Monitor, so the native monitor path must be checked in an interactive account/provider that supports it. `pnpm run test:native-claude -- --session-transitions` additionally issues real `/clear` and `/resume <UUID>` UI commands, checks that `/clear` leaves without joining the unused session and that resume recovers the actual session/name without MCP respawn, and checks idle async-rewake afterward. It still does not validate Monitor on a provider that omits it. This optional installed-client test is separate from the default CI SDK suite.

Global setup tests use temporary HOME settings for all hosts, preserve unrelated/later edits on uninstall, reject foreign/modified configs, load the actual Pi user extension/skill while project resources stay untrusted, and resolve global Codex calls to the native thread's Git root. Claude transition fixtures run an actual ancestor process, MCP and watcher, simulating documented registry/hook changes: `/clear`, `/resume`, stale environment, no tool call, leaving unused sessions, rejoining used ones, automatic name recovery, pause/mail/lease isolation, explicit pinning and failed replacement rollback. They do not prove that every host/provider exposes Monitor.

`pnpm run test:native-pi` starts the installed Pi 0.99.2 CLI in RPC mode with an isolated user installation, loopback chat provider and untrusted project resources. It verifies that a new session does not join before its first PeerLetter tool call, then one native idle wake with no body injection or ACK. It uses no external model; CI runs this test.

`pnpm run test:native-global-setup` additionally requires installed Claude Code and network access for pnpm. It copies the current sources into a fresh dependency-free checkout, uses an empty HOME, runs the actual `setup all` and normal user plugin CLI, checks SQLite, installation scope, the readable report and repeated installation, fast-forwards the checkout from a local bare remote with `setup update` and checks the refreshed skill copy, then runs `setup --uninstall all`. It makes no external model calls and changes no production settings.

Update with `setup update` (see [Update](#update)), then reconnect/restart the clients; restart Claude when MCP runtime code changed. No version bump, registry upload or marketplace publication is needed.
