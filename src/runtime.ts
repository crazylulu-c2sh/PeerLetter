import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { agentKind, ancestors, claudeSession, hostProcess, isProcessAlive, processInfo } from "./process.ts";
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

function unusedSession(): MailError {
  return new MailError("UNUSED_SESSION", "This host session has not used PeerLetter; it joins on its first PeerLetter tool call.");
}

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
  private recordedUse?: string;

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
    const project = resolveProject(options.project || process.env.PEERLETTER_PROJECT || registry?.cwd || host?.cwd || process.cwd(), options.state);
    // Without a database no session here has used PeerLetter; do not create one for a startup probe.
    if (startup && !fs.existsSync(project.database)) throw unusedSession();
    this.store = new Store(project);
    this.hostPids = ancestors().map(p => p.pid);
    const environment = kind === "codex" ? process.env.CODEX_THREAD_ID : registry?.session_id;
    const mapped = this.store.sessionFor(kind,this.hostPids);
    const mapping=kind === "claude" && host ? this.store.hostSession(kind,host.pid) : undefined;
    const registryNewer=registry?.host_pid === host?.pid && (registry?.updated_at || 0) > (mapping?.updated_at || 0);
    const hooked = mapped && !registryNewer && hasHostSession(kind,mapped,"hook") ? mapped : undefined;
    const session = native || configured || (kind === "claude" ? hooked : undefined) || registry?.session_id || startup?.session_id || environment || hooked || recovery || `runtime:${randomUUID()}`;
    this.sessionSource = native ? "mcp-metadata" : configured ? "configured" : kind === "claude" && hooked ? "hook" : registry?.session_id ? "environment" : startup ? startup.source : environment ? "environment" : hooked ? "hook" : recovery ? "self-binding" : "unbound";
    const wake = options.wake || process.env.PEERLETTER_WAKE || "none";
    if (![...claudeWakes, "codex-queue", "pi-extension"].includes(wake)
      || (wake.startsWith("claude-") && kind !== "claude")) {
      this.store.close(); throw new MailError("INVALID_WAKE", "Use none, claude-monitor, claude-async-rewake, claude-channel, codex-queue or pi-extension for the matching client.");
    }
    if (startup && !this.store.usedSession(kind,session)) { this.store.close(); throw unusedSession(); }
    try {
      this.actor = this.store.register({ name: options.name || process.env.PEERLETTER_NAME,
        kind, session_id: session, host_pid: host?.pid, wake, session_source:this.sessionSource });
      if (externalClaudeWake(wake)) this.store.setWake(this.actor,wake,"Waiting for the Claude watch process.");
      // Only host hooks/adapters write PID mappings: a Codex daemon can parent several threads.
    } catch (error) { this.store.close(); throw error; }
  }

  // automatic: a background check that may follow the host only into a session that has used PeerLetter.
  refresh(automatic = false): void {
    if (this.closed) return;
    if (!this.options.session && !process.env.PEERLETTER_SESSION_ID
      && this.sessionSource !== "mcp-metadata" && this.sessionSource !== "self-binding") {
      const registry=this.actor.kind === "claude" ? claudeSession() : undefined;
      const mapping=this.actor.kind === "claude" && this.actor.host_pid ? this.store.hostSession("claude",this.actor.host_pid) : undefined;
      const registryNewer=registry?.host_pid === this.actor.host_pid && (registry.updated_at || 0) > (mapping?.updated_at || 0);
      const mapped=registryNewer ? undefined : mapping?.session_id || this.store.sessionFor(this.actor.kind,this.actor.kind === "claude" && this.actor.host_pid ? [this.actor.host_pid] : this.hostPids);
      const environment = (this.actor.kind === "codex" ? process.env.CODEX_THREAD_ID : undefined) || registry?.session_id;
      const session = this.actor.kind === "claude" ? mapped || environment : environment || mapped;
      if (session && hasHostSession(this.actor.kind,session,environment ? "environment" : "hook") && session !== this.actor.session_id) {
        if (this.actor.kind === "claude" && agentKind(processInfo(this.actor.host_pid!)?.name) === "claude"
          && (mapped || registry?.host_pid === this.actor.host_pid)) {
          this.followClaude(session,mapped ? "hook" : "environment",registry?.cwd,automatic);
        } else this.adoptSession(session,environment ? "environment" : "hook");
      }
    }
    this.store.touch(this.actor);
  }

  private followClaude(session: string, source: string, cwd: string | undefined, automatic: boolean): void {
    validUuid(session,"INVALID_SESSION_ID");
    const project = resolveProject(this.options.project || process.env.PEERLETTER_PROJECT || cwd || this.store.project.cwd,this.options.state);
    const same = project.key === this.store.project.key;
    if (automatic && !same && !fs.existsSync(project.database)) throw unusedSession();
    const nextStore = same ? this.store : new Store(project);
    try {
      // Throwing leaves this participant unchanged; the caller decides whether to close it.
      if (automatic && !nextStore.usedSession("claude",session)) throw unusedSession();
      const next = nextStore.register({name:this.options.name || process.env.PEERLETTER_NAME,
        kind:"claude",session_id:session,session_source:source,host_pid:this.actor.host_pid!,wake:this.actor.wake,
        ...(nextStore === this.store ? {replace:this.actor} : {})});
      if (nextStore !== this.store) { this.store.closeAgent(this.actor); this.store.close(); this.store=nextStore; }
      // Channel watchers retain the actor object; keep their identity in sync.
      Object.assign(this.actor,next);
      this.sessionSource=source;
      if (externalClaudeWake(this.actor.wake)) this.store.setWake(this.actor,this.actor.wake,"Waiting for the Claude watch process.");
    } catch(error) { if (nextStore !== this.store) nextStore.close(); throw error; }
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
    this.recordUse();
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

  // Called for every tool call. A later connection of this host session may then join automatically.
  recordUse(): void {
    const { kind, session_id } = this.actor;
    if (this.closed || this.recordedUse === session_id || !hasHostSession(kind,session_id,this.sessionSource)) return;
    this.store.recordUse(kind,session_id);
    this.recordedUse = session_id;
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
