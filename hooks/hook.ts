import * as fs from "node:fs";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { ancestors, agentKind } from "../src/process.ts";
import { noticeText } from "../src/wake.ts";

// Hook output is protocol JSON only. No mail body and no ACK is emitted here.
let store: Store | undefined;
try {
  const raw = fs.readFileSync(0,"utf8");
  if (raw.length > 1048576) throw new Error("Hook input too large");
  const input = JSON.parse(raw);
  const kind = process.argv[2];
  if (kind !== "claude" && kind !== "codex") throw new Error("Expected claude or codex");
  const event = input.hook_event_name;
  const session = input.session_id || input.thread_id;
  if (typeof session !== "string" || !session || typeof input.cwd !== "string") process.exit(0);
  const host = ancestors().find(p => agentKind(p.name) === kind);
  store = new Store(resolveProject(input.cwd));
  if (event === "SessionStart") {
    if (host) store.bindSession(kind,host.pid,session);
  } else if (event === "UserPromptSubmit") {
    // An explicit new user prompt resumes a manually paused session.
    store.pause(session,null);
  } else if (event === "Interrupt") {
    store.pause(session,"user_abort");
  } else if (event === "StopFailure") {
    store.pause(session,"provider_error");
  } else if (event === "Stop" && !input.stop_hook_active) {
    const actor = store.agentForSession(session,kind);
    if (actor) {
      const messages = store.pendingNotices(actor,`${kind}-stop`,store.noticeBaseline(actor));
      if (messages.length) {
        console.log(JSON.stringify({ decision: "block", reason: noticeText(messages) }));
        store.markNotified(actor,`${kind}-stop`,messages.map(m=>m.id));
      }
    }
  } else if (event === "PostToolUse" && kind === "claude") {
    const actor = store.agentForSession(session,kind);
    const messages = actor ? store.pendingNotices(actor,"claude-post-tool",store.noticeBaseline(actor)) : [];
    if (actor && messages.length) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: noticeText(messages) } }));
      store.markNotified(actor,"claude-post-tool",messages.map(m=>m.id));
    }
  }
} catch (error) {
  console.error(`PeerLetter hook: ${error instanceof Error ? error.message : String(error)}`);
  // Hooks never strand the host session when the mailbox is unavailable.
} finally { store?.close(); }
