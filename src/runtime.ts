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

  constructor(clientName: string, options: RuntimeOptions = {}) {
    this.options = options;
    const kind = options.kind || process.env.PEERLETTER_KIND || agentKind(clientName);
    const host = hostProcess(kind);
    const registry = kind === "claude" ? claudeSession() : undefined;
    const project = options.project || process.env.PEERLETTER_PROJECT || registry?.cwd || host?.cwd || process.cwd();
    this.store = new Store(resolveProject(project, options.state));
    this.hostPids = ancestors().map(p => p.pid);
    const session = options.session || process.env.PEERLETTER_SESSION_ID
      || (kind === "codex" ? process.env.CODEX_THREAD_ID : registry?.session_id)
      || this.store.sessionFor(kind, this.hostPids) || `runtime:${randomUUID()}`;
    const wake = options.wake || process.env.PEERLETTER_WAKE || "none";
    if (!["none", "claude-channel", "codex-queue", "pi-extension"].includes(wake)) {
      this.store.close(); throw new MailError("INVALID_WAKE", "Use none, claude-channel, codex-queue or pi-extension.");
    }
    try {
      this.actor = this.store.register({ name: options.name || process.env.PEERLETTER_NAME,
        kind, session_id: session, host_pid: host?.pid, wake });
      if (host) this.store.bindSession(kind, host.pid, session);
    } catch (error) { this.store.close(); throw error; }
  }

  refresh(): void {
    if (this.closed) return;
    if (!this.options.session && !process.env.PEERLETTER_SESSION_ID) {
      const session = (this.actor.kind === "codex" ? process.env.CODEX_THREAD_ID : undefined)
        || (this.actor.kind === "claude" ? claudeSession()?.session_id : undefined)
        || this.store.sessionFor(this.actor.kind, this.hostPids);
      if (session && session !== this.actor.session_id) this.store.updateSession(this.actor, session);
    }
    this.store.touch(this.actor);
  }

  codexTarget(): string {
    this.refresh();
    if (this.actor.kind !== "codex" || !isProcessAlive(this.actor.host_pid, this.actor.host_start)) {
      throw new MailError("WAKE_UNAVAILABLE", "Codex host process is not available.");
    }
    try { return validUuid(this.actor.session_id); }
    catch { throw new MailError("WAKE_UNAVAILABLE", "No verified Codex thread ID. Install the SessionStart hook and start a new session."); }
  }

  whoami() {
    this.refresh();
    return { ...this.store.publicAgent(this.store.agent(this.actor.name)!), project_key: this.store.project.key,
      project: this.store.project.cwd, database: this.store.project.database,
      protocol: "stdio", delivery: "at-least-once", ack_means: "processed; completion requires a reply" };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.store.closeAgent(this.actor); } finally { this.store.close(); }
  }
}
