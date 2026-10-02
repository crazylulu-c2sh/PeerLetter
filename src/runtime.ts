import { randomUUID } from "node:crypto";
import { agentKind, ancestors, claudeSession, hostProcess, isProcessAlive } from "./process.ts";
import { resolveProject } from "./project.ts";
import { Store, hasHostSession } from "./store.ts";
import type { Agent } from "./store.ts";
import { MailError, validSession, validUuid } from "./errors.ts";
import { claudeWakes, externalClaudeWake } from "./claude.ts";

export interface RuntimeOptions {
  project?: string; name?: string; kind?: string; session?: string; wake?: string;
  state?: string; wakeBacklog?: boolean;
}

export interface HostBinding { session_id: string; source: string }

// This probe must not open the database or allocate a name. A PID mapping can be
// the last of several Codex threads, even when the table contains just one row.
export function startupRegistration(clientName: string, options: RuntimeOptions = {}, env: NodeJS.ProcessEnv = process.env): { binding?: HostBinding; reason: string } {
  const kind = options.kind || env.PEERLETTER_KIND || agentKind(clientName);
  const wake = options.wake || env.PEERLETTER_WAKE || "none";
  if (wake === "none") return { reason: "Wake is disabled; join on the first tool call." };
  const expected: Record<string,string> = { claude:"claude-channel", codex:"codex-queue", pi:"pi-extension" };
  if (!(kind === "claude" ? claudeWakes.includes(wake as typeof claudeWakes[number]) : expected[kind] === wake)) return { reason: "Wake adapter does not match the client kind; join on the first tool call." };

  // An explicit --session pins this MCP connection. Inherited Codex environment
  // variables and hook records cannot prove which shared-daemon thread loaded it.
  const configured = options.session || (kind !== "codex" ? env.PEERLETTER_SESSION_ID : undefined);
  const environment = kind === "claude" ? env.CLAUDE_CODE_SESSION_ID : undefined;
  const session = configured || environment;
  if (!session) return { reason: kind === "codex"
    ? "Codex thread is not verified for this connection; wait for native threadId metadata or an explicit --session."
    : "No verified host session is available at startup; join on the first tool call." };
  const source = configured ? "configured" : "environment";
  try {
    validSession(session);
    if (!hasHostSession(kind,session,source)) throw new Error("Unbound identity");
    if (kind === "codex") validUuid(session,"INVALID_THREAD_ID");
    if (externalClaudeWake(wake)) validUuid(session,"INVALID_SESSION_ID");
  } catch { return { reason: "Startup host session is invalid or unbound; join on the first tool call." }; }
  return { binding: {session_id:session,source}, reason: "Wake is enabled and this connection has a verified host session." };
}

export class Runtime {
  store: Store;
  actor: Agent;
  private options: RuntimeOptions;
  private hostPids: number[];
  private closed = false;
  private sessionSource: string;
  private registrationMode: "startup" | "tool-call";

  constructor(clientName: string, options: RuntimeOptions = {}, meta?: Record<string,unknown>, recoverySession?: string, startup?: HostBinding) {
    this.options = options;
    this.registrationMode = startup ? "startup" : "tool-call";
    const kind = options.kind || process.env.PEERLETTER_KIND || agentKind(clientName);
    const configured = options.session || process.env.PEERLETTER_SESSION_ID;
    if (kind === "codex" && configured) validUuid(configured,"INVALID_THREAD_ID");
    const native = kind === "codex" && meta?.threadId !== undefined ? validUuid(String(meta.threadId),"INVALID_THREAD_ID") : undefined;
    const recovery = kind === "codex" && recoverySession ? validUuid(recoverySession,"INVALID_THREAD_ID") : undefined;
    if (native && configured && native !== configured) throw new MailError("SESSION_MISMATCH","Configured session differs from the calling Codex thread.");
    const host = hostProcess(kind);
    const registry = kind === "claude" ? claudeSession() : undefined;
    const project = options.project || process.env.PEERLETTER_PROJECT || registry?.cwd || host?.cwd || process.cwd();
    this.store = new Store(resolveProject(project, options.state));
    this.hostPids = ancestors().map(p => p.pid);
    const environment = kind === "codex" ? process.env.CODEX_THREAD_ID : registry?.session_id;
    const mapped = this.store.sessionFor(kind,this.hostPids);
    const hooked = mapped && hasHostSession(kind,mapped,"hook") ? mapped : undefined;
    const session = native || startup?.session_id || configured || environment || hooked || recovery || `runtime:${randomUUID()}`;
    this.sessionSource = native ? "mcp-metadata" : startup ? startup.source : configured ? "configured" : environment ? "environment" : hooked ? "hook" : recovery ? "self-binding" : "unbound";
    const wake = options.wake || process.env.PEERLETTER_WAKE || "none";
    if (![...claudeWakes, "codex-queue", "pi-extension"].includes(wake)
      || (wake.startsWith("claude-") && kind !== "claude")) {
      this.store.close(); throw new MailError("INVALID_WAKE", "Use none, claude-monitor, claude-async-rewake, claude-channel, codex-queue or pi-extension for the matching client.");
    }
    try {
      this.actor = this.store.register({ name: options.name || process.env.PEERLETTER_NAME,
        kind, session_id: session, host_pid: host?.pid, wake, session_source:this.sessionSource });
      if (externalClaudeWake(wake)) this.store.setWake(this.actor,wake,"Waiting for the Claude watch process.");
      // Only host hooks/adapters write PID mappings: a Codex daemon can parent several threads.
    } catch (error) { this.store.close(); throw error; }
  }

  refresh(): void {
    if (this.closed) return;
    if (!this.options.session && !process.env.PEERLETTER_SESSION_ID
      && this.sessionSource !== "mcp-metadata" && this.sessionSource !== "self-binding") {
      const environment = (this.actor.kind === "codex" ? process.env.CODEX_THREAD_ID : undefined)
        || (this.actor.kind === "claude" ? claudeSession()?.session_id : undefined);
      const session = environment
        || this.store.sessionFor(this.actor.kind, this.hostPids);
      if (session && hasHostSession(this.actor.kind,session,environment ? "environment" : "hook") && session !== this.actor.session_id) {
        this.adoptSession(session,environment ? "environment" : "hook");
      }
    }
    this.store.touch(this.actor);
  }

  observeRequest(meta?: Record<string,unknown>): void {
    // Codex attaches the executing thread ID to tools/call, even when the MCP subprocess
    // does not receive CODEX_THREAD_ID. sessionId can be a fork's root and is not the queue target.
    if (this.actor.kind !== "codex" || meta?.threadId === undefined) return;
    const thread = validUuid(String(meta.threadId),"INVALID_THREAD_ID");
    if (this.sessionSource === "configured" && thread !== this.actor.session_id) {
      throw new MailError("SESSION_MISMATCH","Configured session differs from the calling Codex thread.");
    }
    if (this.sessionSource === "mcp-metadata" && thread !== this.actor.session_id) {
      throw new MailError("SESSION_MISMATCH","This MCP process is already bound to a different Codex thread.");
    }
    this.adoptSession(thread,"mcp-metadata");
  }

  bindOwnSession(session: string) {
    if (this.actor.kind !== "codex") throw new MailError("UNSUPPORTED_CLIENT","Explicit thread binding is for Codex; other clients use their own session adapter.");
    validUuid(session,"INVALID_THREAD_ID");
    if ((this.sessionSource === "configured" || hasHostSession(this.actor.kind,this.actor.session_id,this.sessionSource)) && this.actor.session_id !== session) {
      throw new MailError("SESSION_MISMATCH","This participant already has another host session. Use the thread ID from your own current session.");
    }
    if (!hasHostSession(this.actor.kind,this.actor.session_id,this.sessionSource)) this.adoptSession(session,"self-binding");
    return this.whoami();
  }

  private adoptSession(session: string, source: string): void {
    if (session !== this.actor.session_id) {
      if (hasHostSession(this.actor.kind,this.actor.session_id,this.sessionSource)) {
        throw new MailError("SESSION_MISMATCH","Host session changed on an existing participant. Reconnect MCP so the new session gets its own mailbox.");
      }
      this.store.updateSession(this.actor,session,true,source);
    }
    else if (source !== this.sessionSource) this.store.setSessionSource(this.actor,source);
    this.sessionSource = source;
  }

  codexTarget(): string {
    this.refresh();
    if (this.actor.kind !== "codex" || !isProcessAlive(this.actor.host_pid, this.actor.host_start)) {
      throw new MailError("WAKE_UNAVAILABLE", "Codex host process is not available.");
    }
    try { return validUuid(this.actor.session_id); }
    catch { throw new MailError("WAKE_UNAVAILABLE", "Codex thread is unbound. Call whoami from Codex so request metadata binds it, or review /hooks and start a new session. You can also bind your own CODEX_THREAD_ID with peerletter_bind_session."); }
  }

  whoami() {
    this.refresh();
    const bound = hasHostSession(this.actor.kind,this.actor.session_id,this.sessionSource);
    return { ...this.store.publicAgent(this.store.agent(this.actor.name)!), project_key: this.store.project.key,
      project: this.store.project.cwd, database: this.store.project.database,
      session_binding: { state: bound ? "bound" : "unbound", source: this.sessionSource,
        ...(this.actor.kind === "codex" && !bound ? { reason: "No Codex thread ID received; queue wake and session-specific hooks are unavailable until binding.",
          next: "Call peerletter_whoami from Codex (native request metadata), or review /hooks and restart; if needed read your own CODEX_THREAD_ID and use peerletter_bind_session." }
          : this.actor.kind === "pi" && !bound ? { reason:"Manual MCP has no Pi session identity and cannot observe /new.",
            next:"Use the session-bound Pi extension for actual session IDs and /new transitions; call whoami after reloading." } : {}) },
      registration: { mode:this.registrationMode },
      ...(externalClaudeWake(this.actor.wake) ? { wake_runner:this.store.watchStatus(this.actor.session_id) } : {}),
      protocol: "stdio", delivery: "at-least-once", ack_means: "processed; completion requires a reply" };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.store.closeAgent(this.actor); } finally { this.store.close(); }
  }
}
