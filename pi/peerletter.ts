import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { isProcessAlive } from "../src/process.ts";
import { noticeText } from "../src/wake.ts";

export default function peerletter(pi: ExtensionAPI, options: {node?:string} = {}) {
  let store: Store | undefined;
  let context: ExtensionContext | undefined;
  let session = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let unlisten: (()=>void) | undefined;
  let busy = false;
  let dialogs = 0;
  let compact = false;
  let closed = true;

  function ownedActor(): Agent | undefined {
    const actor = store?.agentForSession(session,"pi");
    // An extension in another Pi process can load the same session file. It must not
    // inject mail for, or close, the MCP connection owned by the first process.
    return actor?.host_pid === process.pid && isProcessAlive(actor.host_pid,actor.host_start) ? actor : undefined;
  }

  function canManageGate(): boolean {
    return !!store && !!session && (!store.agentForSession(session,"pi") || !!ownedActor());
  }

  function pause(reason: string | null) {
    if (canManageGate()) store?.pause(session,reason);
  }

  function gate() {
    if (!store || !canManageGate()) return;
    store.block(session,"ui",dialogs > 0);
    store.block(session,"compact",compact);
  }
  function poll() {
    if (!store || !context || busy || closed) return;
    busy = true;
    let actor: Agent | undefined;
    try {
      actor = ownedActor();
      if (!actor) return;
      const baseline = process.env.PEERLETTER_WAKE_BACKLOG === "1" ? 0 : store.noticeBaseline(actor);
      const messages = store.pendingNotices(actor,"pi-extension",baseline);
      if (!messages.length) return;
      pi.sendMessage({ customType: "peerletter-notice", content: noticeText(messages), display: true },
        { triggerTurn: true, deliverAs: "steer" });
      store.markNotified(actor,"pi-extension",messages.map(m=>m.id));
      store.setWake(actor,"pi-extension");
    } catch (error) {
      const reason=error instanceof Error ? error.message : String(error);
      try { if(actor)store.setWake(actor,"pi-extension",reason); } catch { /* DB status will be retried on the next poll. */ }
      context.ui.setStatus("peerletter",`PeerLetter: ${reason}`);
    }
    finally { busy = false; }
  }
  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    unlisten?.(); unlisten = undefined;
    try {
      const actor = ownedActor();
      if (actor) store?.closeAgent(actor);
      store?.unbindSession("pi",process.pid,session);
    } catch (error) {
      context?.ui.setStatus("peerletter",`PeerLetter: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      store?.close(); store = undefined; session = ""; context = undefined;
      pi.unregisterMcpServer("peerletter");
    }
  }
  pi.on("session_start",async (_,ctx) => {
    close(); context = ctx; closed = false; dialogs = 0; compact = false;
    session = ctx.sessionManager.getSessionId();
    store = new Store(resolveProject(ctx.cwd));
    store.bindSession("pi",process.pid,session);
    // Never clear a user's persisted pause just because the extension reloaded.
    gate();
    // Pi connects extension servers at startup. --session makes the opt-in wake
    // connection register on initialized; the extension never registers a second actor.
    pi.registerMcpServer("peerletter", { command: options.node || process.execPath, exposure: "direct", timeout: 45,
      args: [fileURLToPath(new URL("../src/stdio.ts",import.meta.url)),"--project",ctx.cwd,"--kind","pi",
        "--session",session,"--wake","pi-extension", ...(process.env.PEERLETTER_NAME ? ["--name",process.env.PEERLETTER_NAME] : [])] });
    timer = setInterval(poll,750); timer.unref();
    if (ctx.mode === "tui") unlisten = ctx.ui.onTerminalInput(data => {
      if (data === "\u001b" && !ctx.isIdle()) pause("user_abort");
      return undefined;
    });
  });
  pi.on("session_shutdown",close);
  pi.on("input",event => { if (event.source !== "extension") pause(null); });
  pi.on("agent_before_settle",event => {
    if (event.outcome === "aborted") pause("user_abort");
    if (event.outcome === "error") pause("provider_error");
  });
  pi.on("ui_prompt_start",() => { dialogs++; gate(); });
  pi.on("ui_prompt_end",() => { dialogs = Math.max(0,dialogs-1); gate(); poll(); });
  pi.on("session_before_compact",() => { compact = true; gate(); });
  pi.on("session_compact",() => { compact = false; gate(); poll(); });
  pi.on("session_compact_failed",event => { compact = false; gate(); if (event.aborted) pause("user_abort"); });
  pi.registerCommand("peerletter", { description: "PeerLetter pause, resume or status", handler: async (args,ctx) => {
    if (!store) return;
    if (args.trim() === "pause") pause("manual");
    else if (args.trim() === "resume") { pause(null); poll(); }
    ctx.ui.notify(JSON.stringify(store.gate(session)),"info");
  } });
}
