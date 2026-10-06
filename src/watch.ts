import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "./store.ts";
import type { Agent } from "./store.ts";
import { locateProject, prepareProject } from "./project.ts";
import { agentKind, ancestors, isProcessAlive, claudeSession } from "./process.ts";
import { MailError, validName, validUuid } from "./errors.ts";
import { configuredClaudeWake } from "./claude.ts";
import { noticeText } from "./wake.ts";

export interface WatchOptions {
  project?: string; state?: string; name?: string; session?: string;
  sink?: "claude-monitor" | "claude-async-rewake";
  backlog?: boolean; once?: boolean; timeoutMs?: number; signal?: AbortSignal;
  emit?: (line:string) => Promise<void>; diagnostic?: (message:string) => void;
  pollMs?: number;
}
function stdout(line: string): Promise<void> {
  return new Promise((resolve,reject)=>process.stdout.write(line+"\n",error=>error ? reject(error) : resolve()));
}

// Attach to an existing bound, live MCP actor. Never register a mailbox, ACK,
// touch presence, close the MCP participant or change its leases.
export async function watchMail(options: WatchOptions): Promise<boolean> {
  let session=validUuid(options.session || claudeSession()?.session_id || "","INVALID_SESSION_ID");
  if (options.name) validName(options.name);
  const sink=options.sink || "claude-monitor",token=randomUUID();
  const timeout=options.timeoutMs ?? 0;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 86400000) throw new MailError("INVALID_ARGUMENT","timeout-ms must be 0–86400000.");
  const deadline=timeout ? Date.now()+timeout : Infinity;
  let project=locateProject(options.project || claudeSession()?.cwd,options.state);
  const emit=options.emit || stdout;
  const diagnostic=options.diagnostic || ((message:string)=>console.error(`PeerLetter watch: ${message}`));
  let store:Store|undefined,claimed=false,notified=false,actor:Agent|undefined;
  const parent=ancestors().find(p=>agentKind(p.name) === "claude");
  const follow=!!parent && !options.session && sink === "claude-monitor";
  let host=parent ? {pid:parent.pid,start:parent.start} : undefined;
  let failures=0,lastError="";
  const report=(error:unknown)=> {
    const message=error instanceof Error ? error.message : String(error);
    if (message !== lastError) { diagnostic(message); lastError=message; }
  };
  try {
    while (!options.signal?.aborted && Date.now()<deadline) {
      let sleep=options.pollMs ?? 750;
      try {
        if (host && !isProcessAlive(host.pid,host.start)) return notified;
        if (follow) {
          const registry=claudeSession();
          const mapping=store?.hostSession("claude",parent!.pid);
          const newer=registry?.host_pid === parent!.pid && (registry.updated_at || 0) > (mapping?.updated_at || 0);
          const mapped=newer ? undefined : mapping?.session_id;
          const next=mapped || (registry?.host_pid === parent!.pid ? registry.session_id : undefined);
          if (next && next !== session) {
            validUuid(next,"INVALID_SESSION_ID");
            const nextProject=locateProject(options.project || registry?.cwd || project.cwd,options.state);
            if (claimed) store!.releaseWatch(session,token);
            claimed=false; actor=undefined; session=next;
            if (nextProject.key !== project.key) {store?.close();store=undefined;project=nextProject;}
          }
        }
        if (!store) {
          // A workspace that never used PeerLetter has no database: wait without creating one.
          // A one-shot waiter has nothing to wait for before this session's next turn.
          if (!fs.existsSync(project.database)) {
            if (options.once) return notified;
            report("Waiting for this workspace to use PeerLetter.");
            await delay(options.pollMs ?? 750,undefined,{signal:options.signal});
            continue;
          }
          store=new Store(prepareProject(project));
        }
        if (!claimed) {
          if (!store.claimWatch(session,sink,token)) return false;
          claimed=true;
        }
        if (!store.ownsWatch(session,token)) return notified;
        const configured=configuredClaudeWake(project.cwd);
        if (configured !== undefined && configured !== sink) return notified;
        if (store.gate(session).blocked_reasons.includes("session_end")) {
          if (!follow) return notified;
          // /resume and /clear have a SessionEnd -> SessionStart gap. Stay
          // alive with the same host, but do not emit into the ended session.
          await delay(options.pollMs ?? 750,undefined,{signal:options.signal});
          continue;
        }
        actor=store.agentForSession(session,"claude");
        if (actor && parent && actor.host_pid !== parent.pid) throw new MailError("SESSION_MISMATCH","The registered session belongs to another Claude host; watch will not inject into this one.");
        if (actor?.host_pid) {
          if (!isProcessAlive(actor.host_pid,actor.host_start)) return notified;
          host ||= {pid:actor.host_pid,start:actor.host_start};
        }
        if (actor && options.name && actor.name !== options.name) throw new MailError("SESSION_MISMATCH","The requested name belongs to another session; watch will not follow it.");
        if (!actor || !isProcessAlive(actor.pid,actor.proc_start)) {
          actor=undefined; report("Waiting for this session's live Claude MCP registration.");
        } else {
          if (store.publicAgent(actor).session_binding.state !== "bound") throw new MailError("UNBOUND_SESSION","Watch requires a bound Claude session.");
          if (actor.wake !== sink) return notified;
          if (actor.host_pid && !isProcessAlive(actor.host_pid,actor.host_start)) return notified;
          if (actor.wake_error) store.setWake(actor,sink);
          const mail=store.pendingNotices(actor,sink,options.backlog ? 0 : store.noticeBaseline(actor));
          // Revalidate immediately before handing a body-free line to the host.
          if (mail.length && !options.signal?.aborted && Date.now()<deadline
            && store.ownsWatch(session,token) && store.gate(session).state === "ready"
            && store.assertActor(actor).wake === sink
            && (configuredClaudeWake(project.cwd) ?? sink) === sink) {
            await emit(noticeText(mail));
            store.markNotified(actor,sink,mail.map(m=>m.id));
            notified=true;
            if (options.once) return true;
          }
          lastError="";
        }
        failures=0;
      } catch (error) {
        report(error);
        if (error instanceof MailError && ["SESSION_MISMATCH","UNBOUND_SESSION"].includes(error.code)) return notified;
        try { if (actor) store?.setWake(actor,sink,error instanceof Error ? error.message : String(error)); } catch { /* Old owner disconnected. */ }
        failures++;
        sleep=Math.min(30000,250*2**Math.min(failures-1,7));
      }
      try { await delay(Math.min(sleep,Math.max(1,deadline-Date.now())),undefined,{signal:options.signal}); }
      catch { if (!options.signal?.aborted) throw new Error("Watch delay failed."); }
    }
    return notified;
  } finally {
    if (store) {
      try { if (claimed) store.releaseWatch(session,token); }
      finally { store.close(); }
    }
  }
}
