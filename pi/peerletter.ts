import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/store.ts";
import { locateProject, prepareProject } from "../src/project.ts";
import type { Project } from "../src/project.ts";
import { isProcessAlive } from "../src/process.ts";
import { noticeText } from "../src/wake.ts";

export default function peerletter(pi: ExtensionAPI, options: {node?:string} = {}) {
  let store: Store | undefined;
  let workspace: Project | undefined;
  let context: ExtensionContext | undefined;
  let session = "";
  let timer: ReturnType<typeof setInterval> | undefined;
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

  // A workspace that never used PeerLetter has no database. Attach once the first PeerLetter call creates it.
  function attach(): Store | undefined {
    if (store || closed || !workspace || !fs.existsSync(workspace.database)) return store;
    store = new Store(prepareProject(workspace));
    store.bindSession("pi",process.pid,session);
    // Never clear a user's persisted pause just because the extension reloaded.
    gate();
    return store;
  }

  function canManageGate(): boolean {
    const current = attach();
    return !!current && !!session && (!current.agentForSession(session,"pi") || !!ownedActor());
  }

  function pause(reason: string | null) {
    if (canManageGate()) store?.pause(session,reason);
  }

  function gate() {
    const current = canManageGate() ? store : undefined;
    if (!current) return;
    current.block(session,"ui",dialogs > 0);
    current.block(session,"compact",compact);
  }
  function poll() {
    const current = context && !busy && !closed ? attach() : undefined;
    if (!current || !context) return;
    busy = true;
    let actor: Agent | undefined;
    try {
      // While the user's abort of the current run is settling, inject nothing; the settled
      // "aborted" outcome then records the pause. No terminal input is observed.
      if (context.signal?.aborted) return;
      actor = ownedActor();
      if (!actor) return;
      const baseline = process.env.PEERLETTER_WAKE_BACKLOG === "1" ? 0 : current.noticeBaseline(actor);
      const messages = current.pendingNotices(actor,"pi-extension",baseline);
      if (!messages.length) return;
      pi.sendMessage({ customType: "peerletter-notice", content: noticeText(messages), display: true },
        { triggerTurn: true, deliverAs: "steer" });
      current.markNotified(actor,"pi-extension",messages.map(m=>m.id));
      current.setWake(actor,"pi-extension");
    } catch (error) {
      const reason=error instanceof Error ? error.message : String(error);
      try { if(actor)current.setWake(actor,"pi-extension",reason); } catch { /* DB status will be retried on the next poll. */ }
      context.ui.setStatus("peerletter",`PeerLetter: ${reason}`);
    }
    finally { busy = false; }
  }
  function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    try {
      const actor = ownedActor();
      if (actor) store?.closeAgent(actor);
      store?.unbindSession("pi",process.pid,session);
    } catch (error) {
      context?.ui.setStatus("peerletter",`PeerLetter: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      store?.close(); store = undefined; workspace = undefined; session = ""; context = undefined;
      pi.unregisterMcpServer("peerletter");
    }
  }
  pi.on("session_start",async (_,ctx) => {
    close(); context = ctx; closed = false; dialogs = 0; compact = false;
    session = ctx.sessionManager.getSessionId();
    workspace = locateProject(ctx.cwd);
    attach();
    // Pi connects extension servers at startup. --session makes the opt-in wake connection
    // register on initialized if this session used PeerLetter; the extension never registers a second actor.
    pi.registerMcpServer("peerletter", { command: options.node || process.execPath, exposure: "direct", timeout: 45,
      args: [fileURLToPath(new URL("../src/stdio.ts",import.meta.url)),"--project",ctx.cwd,"--kind","pi",
        "--session",session,"--wake","pi-extension", ...(process.env.PEERLETTER_NAME ? ["--name",process.env.PEERLETTER_NAME] : [])] });
    timer = setInterval(poll,750); timer.unref();
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
    const current = attach();
    if (!current) { ctx.ui.notify("PeerLetter is not used in this workspace yet.","info"); return; }
    if (args.trim() === "pause") pause("manual");
    else if (args.trim() === "resume") { pause(null); poll(); }
    ctx.ui.notify(JSON.stringify(current.gate(session)),"info");
  } });
}
