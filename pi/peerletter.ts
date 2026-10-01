import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { noticeText } from "../src/wake.ts";

export default function peerletter(pi: ExtensionAPI) {
  let store: Store | undefined;
  let context: ExtensionContext | undefined;
  let session = "";
  let baseline = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unlisten: (()=>void) | undefined;
  let busy = false;
  let dialogs = 0;
  let compact = false;
  let closed = true;

  function gate() {
    if (!store || !session) return;
    store.block(session,"ui",dialogs > 0);
    store.block(session,"compact",compact);
  }
  function poll() {
    if (!store || !context || busy || closed) return;
    busy = true;
    let actor: Agent | undefined;
    try {
      actor = store.agentForSession(session,"pi");
      if (!actor) return;
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
    unlisten?.(); unlisten = undefined;
    store?.close(); store = undefined;
    pi.unregisterMcpServer("peerletter");
  }
  pi.on("session_start",async (_,ctx) => {
    close(); context = ctx; closed = false; dialogs = 0; compact = false;
    session = ctx.sessionManager.getSessionId();
    store = new Store(resolveProject(ctx.cwd));
    store.bindSession("pi",process.pid,session);
    // Never clear a user's persisted pause just because the extension reloaded.
    store.block(session,"ui",false); store.block(session,"compact",false);
    baseline = process.env.PEERLETTER_WAKE_BACKLOG === "1" ? 0 : store.maxSequence();
    pi.registerMcpServer("peerletter", { command: process.execPath, exposure: "direct", timeout: 45,
      args: [fileURLToPath(new URL("../src/stdio.ts",import.meta.url)),"--project",ctx.cwd,"--kind","pi",
        "--session",session,"--wake","pi-extension", ...(process.env.PEERLETTER_NAME ? ["--name",process.env.PEERLETTER_NAME] : [])] });
    timer = setInterval(poll,750); timer.unref();
    if (ctx.mode === "tui") unlisten = ctx.ui.onTerminalInput(data => {
      if (data === "\u001b" && !ctx.isIdle()) store?.pause(session,"user_abort");
      return undefined;
    });
  });
  pi.on("session_shutdown",close);
  pi.on("input",event => { if (event.source !== "extension") store?.pause(session,null); });
  pi.on("agent_before_settle",event => {
    if (event.outcome === "aborted") store?.pause(session,"user_abort");
    if (event.outcome === "error") store?.pause(session,"provider_error");
  });
  pi.on("ui_prompt_start",() => { dialogs++; gate(); });
  pi.on("ui_prompt_end",() => { dialogs = Math.max(0,dialogs-1); gate(); poll(); });
  pi.on("session_before_compact",() => { compact = true; gate(); });
  pi.on("session_compact",() => { compact = false; gate(); poll(); });
  pi.on("session_compact_failed",event => { compact = false; gate(); if (event.aborted) store?.pause(session,"user_abort"); });
  pi.registerCommand("peerletter", { description: "PeerLetter pause, resume or status", handler: async (args,ctx) => {
    if (!store) return;
    if (args.trim() === "pause") store.pause(session,"manual");
    else if (args.trim() === "resume") { store.pause(session,null); poll(); }
    ctx.ui.notify(JSON.stringify(store.gate(session)),"info");
  } });
}
