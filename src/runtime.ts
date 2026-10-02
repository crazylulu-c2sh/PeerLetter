import { randomUUID } from "node:crypto";
import { agentKind, ancestors, claudeSession, hostProcess, isProcessAlive } from "./process.ts";
import { resolveProject } from "./project.ts";
import { Store } from "./store.ts";
import type { Agent } from "./store.ts";
import { MailError, validUuid } from "./errors.ts";

export interface RuntimeOptions {
  project?: string; name?: string; kind?: string; session?: string; wake?: string;
  state?: string; wakeBacklog?: boolean;
}

export class Runtime {
  store: Store;
  actor: Agent;
  private options: RuntimeOptions;
  private hostPids: number[];
  private closed = false;
  private sessionSource: string;

  constructor(clientName: string, options: RuntimeOptions = {}) {
    this.options = options;
    const kind = options.kind || process.env.PEERLETTER_KIND || agentKind(clientName);
    const host = hostProcess(kind);
    const registry = kind === "claude" ? claudeSession() : undefined;
    const project = options.project || process.env.PEERLETTER_PROJECT || registry?.cwd || host?.cwd || process.cwd();
    this.store = new Store(resolveProject(project, options.state));
    this.hostPids = ancestors().map(p => p.pid);
    const configured = options.session || process.env.PEERLETTER_SESSION_ID;
    const environment = kind === "codex" ? process.env.CODEX_THREAD_ID : registry?.session_id;
    const hooked = this.store.sessionFor(kind,this.hostPids);
    const session = configured || environment || hooked || `runtime:${randomUUID()}`;
    this.sessionSource = configured ? "configured" : environment ? "environment" : hooked ? "hook" : "unbound";
    const wake = options.wake || process.env.PEERLETTER_WAKE || "none";
    if (!["none", "claude-channel", "codex-queue", "pi-extension"].includes(wake)) {
      this.store.close(); throw new MailError("INVALID_WAKE", "Use none, claude-channel, codex-queue or pi-extension.");
    }
    try {
      this.actor = this.store.register({ name: options.name || process.env.PEERLETTER_NAME,
        kind, session_id: session, host_pid: host?.pid, wake });
      // A fallback runtime UUID must not overwrite a hook's host-to-session mapping.
      if (host && this.sessionSource !== "unbound") this.store.bindSession(kind, host.pid, session);
    } catch (error) { this.store.close(); throw error; }
  }

  refresh(): void {
    if (this.closed) return;
    if (!this.options.session && !process.env.PEERLETTER_SESSION_ID
      && this.sessionSource !== "mcp-metadata" && this.sessionSource !== "self-binding") {
      const session = (this.actor.kind === "codex" ? process.env.CODEX_THREAD_ID : undefined)
        || (this.actor.kind === "claude" ? claudeSession()?.session_id : undefined)
        || this.store.sessionFor(this.actor.kind, this.hostPids);
      if (session && !session.startsWith("runtime:") && session !== this.actor.session_id) {
        this.store.updateSession(this.actor, session,this.sessionSource === "unbound");
        this.sessionSource = "hook";
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
    if (this.sessionSource !== "unbound" && this.actor.session_id !== session) {
      throw new MailError("SESSION_MISMATCH","This participant already has another host session. Use the thread ID from your own current session.");
    }
    if (this.sessionSource === "unbound") this.adoptSession(session,"self-binding");
    return this.whoami();
  }

  private adoptSession(session: string, source: string): void {
    if (session !== this.actor.session_id) this.store.updateSession(this.actor,session,this.sessionSource === "unbound");
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
    let bound = this.sessionSource !== "unbound" && !this.actor.session_id.startsWith("runtime:");
    if (bound && this.actor.kind === "codex") {
      try { validUuid(this.actor.session_id); } catch { bound = false; }
    }
    return { ...this.store.publicAgent(this.store.agent(this.actor.name)!), project_key: this.store.project.key,
      project: this.store.project.cwd, database: this.store.project.database,
      session_binding: { state: bound ? "bound" : "unbound", source: this.sessionSource,
        ...(this.actor.kind === "codex" && !bound ? { reason: "No Codex thread ID received; queue wake and session-specific hooks are unavailable until binding.",
          next: "Call peerletter_whoami from Codex (native request metadata), or review /hooks and restart; if needed read your own CODEX_THREAD_ID and use peerletter_bind_session." } : {}) },
      protocol: "stdio", delivery: "at-least-once", ack_means: "processed; completion requires a reply" };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.store.closeAgent(this.actor); } finally { this.store.close(); }
  }
}
