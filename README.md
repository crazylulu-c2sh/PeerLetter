# PeerLetter

Agents in one local workspace exchange durable mail through **stdio MCP + shared SQLite**. Each client starts its own process. No listener, port, token service or Pi host is required.

This repository is for **GitHub clone based testing with pnpm**. Registry and marketplace publishing are disabled. Node **24.18+** runs the TypeScript sources directly; no build is needed.

## Install and verify

```bash
git clone https://github.com/crazylulu-c2sh/PeerLetter.git ~/dev/PeerLetter
cd ~/dev/PeerLetter
pnpm install --frozen-lockfile
pnpm run check
pnpm test
```

The checkout pins pnpm 11.18.0 in `packageManager`. Use that version through your pnpm installation or Corepack. Runtime dependencies are the MCP SDK and Zod; SQLite is built into Node. The Pi package is a development dependency for checking the optional extension's API.

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

## Connect new MCP sessions

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

By default all three use manual inbox checks. After connecting, call `peerletter_whoami` and `peerletter_peers` to verify the project and name before sending. Claude's PostToolUse hook can signal new mail during ongoing work; Stop signals at the end of a turn. Each signal is body-free, is deduplicated across adapters, and never ACKs.

### Participation and mailbox names

With `wake=none`, clients join on their **first PeerLetter tool call**. Initialization and `tools/list` do not reserve a name or start a watcher, even when a host session ID is known. This keeps unused manual clients, loaded threads and subagents out of presence. Hooks tolerate sessions that have not joined.

With an opt-in wake adapter, a connection whose actual host session is known joins after MCP initialization and starts its wake adapter **without a tool call**:

| Client | Identity accepted for startup registration |
|---|---|
| Claude channel | `CLAUDE_CODE_SESSION_ID`, or an explicitly configured session |
| Pi extension | The actual session ID the extension supplies with `--session`; Pi connects extension MCP servers at startup |
| Codex queue | An explicit `--session <thread UUID>` that deliberately pins this MCP connection |

Missing, invalid or temporary identities stay lazy. Claude's PID registry and hook-only identities are not used for startup registration. Codex's inherited `CODEX_THREAD_ID`/`PEERLETTER_SESSION_ID` and PID hook mappings cannot prove which shared-daemon thread loaded an unused connection. The mapping table stores only the latest session for a PID; **one row does not establish one thread**. Normal Codex connections therefore still need their first tool call's native `_meta.threadId`. Do not add a fixed `--session` to shared configuration used by unrelated threads; reserve it for a deliberately managed connection.

Call `peerletter_whoami` to inspect the exact name, binding and wake status. `registration.mode` is `startup` or `tool-call`. Eligible startup registration failures are logged to stderr and retried with bounded backoff; tool calls report the original error and can also retry. A live owner is never displaced. Reload must close the old connection before its replacement can own the same session. Startup participation does not grant host channel permission or hook trust.

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

### Claude channel

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client claude --wake claude-channel --apply
cd /path/to/project
claude --dangerously-load-development-channels server:peerletter
```

This opts into the experimental `claude/channel` capability and `notifications/claude/channel`. The development flag is required for this local server; it is not a published marketplace plugin. Check account and version availability in the [official channels documentation](https://code.claude.com/docs/en/channels-reference). Stop hooks provide a body-free fallback while a turn is already ending; they cannot start an idle session on their own.

When the restarted MCP inherits `CLAUDE_CODE_SESSION_ID`, it registers and watches without an initial whoami call. If the actual session cannot be identified at initialization, call whoami once to join. A saved `--wake` flag alone does not bypass channel enablement in the Claude host.

### Codex queue

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client codex --wake codex-queue --apply
```

This adapter uses the installed `codex queue --thread UUID --message ...` command. It is **undocumented and version dependent**, and requires the host's existing shared daemon. PeerLetter does not start a daemon. It uses its own thread ID from native tool-call metadata, explicit self-binding, `CODEX_THREAD_ID` or the SessionStart hook's PID mapping, and verifies the host process. Without a usable UUID or daemon it reports an error and retries. Stop hooks and explicit receive remain available. Review `/hooks`, start a new session and call whoami after installing.

The Interrupt hook records a user pause, which blocks queue wake even for high priority mail. New explicit user input or CLI `resume` clears it. This protection depends on that hook running; an unreviewed or disabled Interrupt hook cannot report the host's pause state.

Startup queue registration requires a connection pinned with `--session <your actual thread UUID>`. Shared-daemon PID mappings and inherited environment IDs remain insufficient for startup registration, even after approving SessionStart hooks. In the normal installer configuration, restart and call whoami once; the first tool request supplies the actual thread. Restart alone cannot guarantee automatic wake for an unidentified Codex thread.

### Pi extension

```bash
node ~/dev/PeerLetter/scripts/install.ts --project /path/to/project \
  --client pi --pi-mode extension --apply
```

Reload Pi or start a new session. The extension dynamically registers the same stdio MCP core and binds the actual Pi session ID. The installer removes its own file MCP entry so it cannot override this registration. Do not retain a global `mcp.json` entry named `peerletter` when using the extension; Pi gives file configuration precedence. You can instead launch with `pi -e ~/dev/PeerLetter/pi/peerletter.ts --skill ~/dev/PeerLetter/skills/peerletter`.

The default file MCP mode has no Pi session ID and cannot observe `/new`; whoami reports it as `unbound`. Use extension mode for real session identity and transitions. On `/new`, resume, fork, reload or quit, the extension closes only its own participant, releases its leases and stops polling. The next session's MCP joins at initialization, and its extension can notify without an initial tool call. The extension does not allocate another participant or call whoami internally. Resuming the same actual session reuses its offline automatic name; `/new` receives a different automatic name. A role name set explicitly continues its durable inbox. Loading the same session in another Pi process does not grant ownership of the first process's participant.

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
- Retention is manual: `prune --days 30` previews removal of whole threads whose messages are all ACKed and whose ACKs are older than 30 days. `--apply` removes them. There is no automatic deletion.
- `doctor` checks permissions and SQLite integrity. `doctor --checkpoint` requests a TRUNCATE checkpoint; run during low activity and inspect its busy result.

Leases accept `*`, `**` and `?` only, are atomically acquired and renewed, and belong to the owner's session. Wildcard overlap uses conservative prefixes and may over-report conflicts. Leases do not enforce edits by other tools. Coordinate git state changes separately.

Read the shared [collaboration skill](skills/peerletter/SKILL.md) for inbox timing, ACK rules, file coordination and reply loop limits. Mail content cannot authorize new work or replace user instructions.

## Tests and GitHub workflow

`pnpm run check` checks core, hook, script and Pi extension types. `pnpm test` covers shared SQLite semantics and launches real SDK stdio clients as Codex, Claude and Pi. Tests use temporary state, not live agent mailboxes. The GitHub Actions workflow runs from a clean checkout on Node 24, installs the frozen pnpm lockfile, checks types and runs tests. It has no publishing step.

The suite checks concurrent writes, deduplication, reply direction, priority cursors, atomic ACK ownership, cancellation, leases, durable restart, SIGKILL presence, permissions, notification gates and Claude channel framing. It also covers manual lazy registration for all clients, conditional startup registration, Claude/Pi wake before any receiver tool call, the Codex queue adapter with a local recording executable, ambiguous shared-PID hook mappings, first-call Codex identity, same-session name recovery, mail isolation, schema 1 migration, live-owner protection, Pi `/new`/resume using real stdio MCP clients, explicit recovery, registration retry and Claude mid-turn hooks. Tests never send mail to running agents. Recording a queue command proves adapter invocation, not that an actual idle Codex TUI wakes.

`pnpm run test:native-codex` runs a regression for an installed Codex executable. It runs real `codex exec` against a loopback mock Responses provider in an isolated configuration, strips `CODEX_THREAD_ID` from the MCP environment, and verifies native metadata binds the same thread ID that Codex emits. GitHub Actions runs it with Codex 0.159.3 temporarily installed using pnpm. No external model or production mailbox is used. This installed-client test is separate from the default SDK suite and does not prove that an idle TUI wakes. Try opt-in wake adapters in their actual interactive clients after completing host setup.

Update the checkout with `git pull --ff-only` and `pnpm install --frozen-lockfile`, then restart/reload its clients. No version bump, registry upload or marketplace publication is needed.
