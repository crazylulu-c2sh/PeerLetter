import * as fs from "node:fs";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { ancestors, agentKind } from "../src/process.ts";
import { noticeText } from "../src/wake.ts";
import { configuredClaudeWake } from "../src/claude.ts";

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
  const clearUi = (all = false) => {
    for (const reason of store!.gate(session).blocked_reasons) {
      if (reason.startsWith("permission:") && (all || reason === `permission:${input.tool_use_id || "unknown"}`)) store!.block(session,reason,false);
    }
  };
  const clearElicitation = () => {
    for (const reason of store!.gate(session).blocked_reasons) if (reason.startsWith("elicitation")) store!.block(session,reason,false);
  };
  const elicitation=`elicitation:${input.mcp_server_name || "unknown"}:${input.elicitation_id || "form"}`;
  const foreground = (actor: {wake:string;wake_error:string|null}) => kind === "claude"
    ? (configuredClaudeWake(store!.project.cwd) ?? actor.wake) === "none"
    : actor.wake !== "codex-queue" || !!actor.wake_error;
  if (event === "SessionStart") {
    if (host) store.bindSession(kind,host.pid,session);
    if (kind === "claude") { store.block(session,"session_end",false); store.block(session,"compact",false); clearUi(true); clearElicitation(); }
  } else if (event === "UserPromptSubmit") {
    // An explicit new user prompt resumes a manually paused session.
    store.pause(session,null);
    if (kind === "claude") { clearUi(true); clearElicitation(); }
  } else if (event === "Interrupt") {
    store.pause(session,"user_abort");
  } else if (event === "StopFailure") {
    store.pause(session,"provider_error");
  } else if (kind === "claude" && event === "PermissionRequest") {
    store.block(session,`permission:${input.tool_use_id || "unknown"}`,true);
  } else if (kind === "claude" && event === "Elicitation") {
    store.block(session,elicitation,true);
  } else if (kind === "claude" && event === "ElicitationResult") {
    store.block(session,elicitation,false);
  } else if (kind === "claude" && (event === "PreCompact" || event === "PostCompact")) {
    store.block(session,"compact",event === "PreCompact");
  } else if (kind === "claude" && event === "SessionEnd") {
    store.block(session,"session_end",true);
    if (host) store.unbindSession(kind,host.pid,session);
  } else if (kind === "claude" && event === "PostToolUseFailure") {
    clearUi();
    if (input.is_interrupt === true) store.pause(session,"user_abort");
  } else if (event === "Stop" && !input.stop_hook_active) {
    if (kind === "claude") clearUi(true);
    const actor = store.agentForSession(session,kind);
    if (actor && foreground(actor)) {
      const messages = store.pendingNotices(actor,`${kind}-stop`,store.noticeBaseline(actor));
      if (messages.length) {
        console.log(JSON.stringify({ decision: "block", reason: noticeText(messages) }));
        store.markNotified(actor,`${kind}-stop`,messages.map(m=>m.id));
      }
    }
  } else if (event === "PostToolUse" && kind === "claude") {
    clearUi();
    const actor = store.agentForSession(session,kind);
    const messages = actor && foreground(actor) ? store.pendingNotices(actor,"claude-post-tool",store.noticeBaseline(actor)) : [];
    if (actor && messages.length) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: noticeText(messages) } }));
      store.markNotified(actor,"claude-post-tool",messages.map(m=>m.id));
    }
  }
} catch (error) {
  console.error(`PeerLetter hook: ${error instanceof Error ? error.message : String(error)}`);
  // Hooks never strand the host session when the mailbox is unavailable.
} finally { store?.close(); }
