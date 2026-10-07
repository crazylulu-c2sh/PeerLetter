import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { MailError, boundedInt, validName, validUuid, validSession } from "./errors.ts";
import { isProcessAlive, processInfo } from "./process.ts";
import type { Project } from "./project.ts";

export interface Actor { name: string; session_id: string; runtime_id?: string }
export interface Agent extends Actor {
  kind: string; runtime_id: string; pid: number | null; proc_start: string | null;
  host_pid: number | null; host_start: string | null; wake: string; wake_error: string | null;
  cwd: string; last_seen: number; online: number;
}
export interface Mail {
  seq: number; id: string; from_name: string; from_session: string; to_name: string;
  to_session: string | null; thread_id: string; reply_to: string | null; text: string;
  importance: "normal" | "high"; idempotency_key: string; created_at: number;
  state: "accepted" | "notified" | "delivered" | "acknowledged";
  notified_at: number | null; delivered_at: number | null; acked_at: number | null;
}
export interface SendInput {
  to: string; text: string; idempotency_key: string; to_session?: string;
  thread_id?: string; reply_to?: string; importance?: "normal" | "high";
}
export interface Lease {
  id: string; owner: string; owner_session: string; globs: string[];
  exclusive: boolean; expires_at: number;
}
export interface CodexWake {
  session_id: string; agent_name: string; client_message_id: string;
  queue_id: string | null; message_ids: string; input: string; created_at: number;
}
type SqlValue = string | number | null;

export function hasHostSession(kind: string, session: string, source = "configured"): boolean {
  if (source === "unbound" || kind === "cli" || /^(runtime|cli):/.test(session)) return false;
  if (kind === "codex") {
    try { validUuid(session); } catch { return false; }
  }
  return true;
}

const mailSelect = `SELECT m.*, d.state, d.notified_at, d.delivered_at, d.acked_at
  FROM messages m JOIN deliveries d ON d.message_id = m.id`;
const priority = "CASE m.importance WHEN 'high' THEN 0 ELSE 1 END";

export class Store {
  readonly project: Project;
  readonly db: DatabaseSync;
  private closed = false;

  constructor(project: Project) {
    this.project = project;
    if (fs.existsSync(project.database) && fs.lstatSync(project.database).isSymbolicLink()) {
      throw new MailError("UNSAFE_PATH", "Database must not be a symlink.");
    }
    const fd = fs.openSync(project.database, "a", 0o600);
    fs.closeSync(fd);
    fs.chmodSync(project.database, 0o600);
    this.db = new DatabaseSync(project.database);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.transaction(() => {
        const version = Number(this.get<{ user_version: number }>("PRAGMA user_version")?.user_version || 0);
        if (version > 2) throw new MailError("SCHEMA_TOO_NEW", "This database requires a newer PeerLetter checkout.");
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS agents (
            name TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
            pid INTEGER, proc_start TEXT, host_pid INTEGER, host_start TEXT, wake TEXT NOT NULL,
            wake_error TEXT, cwd TEXT NOT NULL, last_seen INTEGER NOT NULL, online INTEGER NOT NULL CHECK(online IN (0,1))
          );
          CREATE TABLE IF NOT EXISTS agent_bindings (
            name TEXT PRIMARY KEY REFERENCES agents(name),
            naming TEXT NOT NULL CHECK(naming IN ('automatic','explicit','legacy')),
            session_source TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            kind TEXT NOT NULL, host_pid INTEGER NOT NULL, host_start TEXT, session_id TEXT NOT NULL,
            cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(kind, host_pid)
          );
          CREATE TABLE IF NOT EXISTS gates (
            session_id TEXT PRIMARY KEY, pause_reason TEXT, blocks TEXT NOT NULL DEFAULT '[]'
          );
          CREATE TABLE IF NOT EXISTS messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            from_name TEXT NOT NULL REFERENCES agents(name), from_session TEXT NOT NULL,
            to_name TEXT NOT NULL REFERENCES agents(name), to_session TEXT, thread_id TEXT NOT NULL,
            reply_to TEXT, text TEXT NOT NULL, importance TEXT NOT NULL CHECK(importance IN ('normal','high')),
            idempotency_key TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(from_name, idempotency_key)
          );
          CREATE INDEX IF NOT EXISTS messages_inbox ON messages(to_name, to_session, seq);
          CREATE INDEX IF NOT EXISTS messages_threads ON messages(thread_id);
          CREATE TABLE IF NOT EXISTS deliveries (
            message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
            state TEXT NOT NULL CHECK(state IN ('accepted','notified','delivered','acknowledged')),
            notified_at INTEGER, delivered_at INTEGER, acked_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS notices (
            message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            session_id TEXT NOT NULL, sink TEXT NOT NULL, sent_at INTEGER NOT NULL,
            PRIMARY KEY(message_id, session_id, sink)
          );
          CREATE TABLE IF NOT EXISTS wake_baselines (
            agent_name TEXT NOT NULL REFERENCES agents(name), session_id TEXT NOT NULL,
            after_seq INTEGER NOT NULL, PRIMARY KEY(agent_name,session_id)
          );
          CREATE TABLE IF NOT EXISTS leases (
            id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES agents(name), owner_session TEXT NOT NULL,
            globs TEXT NOT NULL, exclusive INTEGER NOT NULL CHECK(exclusive IN (0,1)), expires_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS watch_owners (
            session_id TEXT PRIMARY KEY, token TEXT NOT NULL, sink TEXT NOT NULL,
            pid INTEGER NOT NULL, proc_start TEXT, started_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS codex_wakes (
            session_id TEXT PRIMARY KEY, agent_name TEXT NOT NULL REFERENCES agents(name),
            client_message_id TEXT NOT NULL UNIQUE, queue_id TEXT,
            message_ids TEXT NOT NULL, input TEXT NOT NULL, created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS agent_renames (
            old_name TEXT PRIMARY KEY, new_name TEXT NOT NULL, renamed_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS used_sessions (
            kind TEXT NOT NULL, session_id TEXT NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY(kind, session_id)
          );
          INSERT OR IGNORE INTO agent_bindings SELECT name,'legacy','legacy' FROM agents;
          PRAGMA user_version=2;
        `);
        const existing = this.get<{ value: string }>("SELECT value FROM metadata WHERE key='project'");
        if (existing && existing.value !== project.cwd) throw new MailError("PROJECT_MISMATCH", "Database belongs to another workspace.");
        this.run("INSERT OR IGNORE INTO metadata(key,value) VALUES('project',?)", project.cwd);
      });
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.chmodSync(project.database + suffix, 0o600); } catch { /* Sidecar may not exist. */ }
      }
    } catch (error) { this.db.close(); throw error; }
  }

  get<T>(sql: string, ...args: SqlValue[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T>(sql: string, ...args: SqlValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  run(sql: string, ...args: SqlValue[]) { return this.db.prepare(sql).run(...args); }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  agent(name: string): Agent | undefined { return this.get<Agent>("SELECT * FROM agents WHERE name=?", validName(name)); }

  renamedTo(name: string): string | undefined {
    return this.get<{new_name:string}>("SELECT new_name FROM agent_renames WHERE old_name=?",name)?.new_name;
  }

  renameAgent(actor: Actor, to: string, offlineOnly = false): { agent: Agent; from: string; requested: string; notified: string[] } {
    validName(to);
    const requested = to;
    const renamed = this.transaction(() => {
      this.cleanPresence();
      const current = this.assertActor(actor);
      to = to === current.kind || to.startsWith(current.kind + "-") ? to : `${current.kind}-${to}`;
      validName(to);
      if (to === actor.name) return {agent:current,from:actor.name,requested,notified:[]};
      if (offlineOnly && current.online) throw new MailError("NAME_IN_USE","Mailbox is online; use peerletter_rename in that session.");
      const target = this.agent(to);
      if (target) throw new MailError(target.online ? "NAME_IN_USE" : "NAME_TAKEN",`Mailbox ${to} already exists; mailboxes cannot be merged.`);
      const reserved = this.renamedTo(to);
      if (reserved && reserved !== actor.name) throw new MailError("NAME_RESERVED",`${to} was renamed to ${reserved}.`,{renamed_to:reserved});
      if (reserved) this.run("DELETE FROM agent_renames WHERE old_name=?",to);
      this.db.exec("PRAGMA defer_foreign_keys=ON");
      const old = actor.name;
      for (const [table,column] of [["agents","name"],["agent_bindings","name"],["messages","from_name"],["messages","to_name"],["wake_baselines","agent_name"],["leases","owner"],["codex_wakes","agent_name"]]) {
        this.run(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`,to,old);
      }
      this.run("UPDATE agent_renames SET new_name=? WHERE new_name=?",to,old);
      this.run("INSERT OR REPLACE INTO agent_renames VALUES(?,?,?)",old,to,Date.now());
      const notified = this.all<{name:string}>(`SELECT DISTINCT a.name FROM messages m
        JOIN agents a ON a.name=m.from_name AND a.session_id=m.from_session
        WHERE m.to_name=? AND a.online=1 AND a.name<>? ORDER BY a.name`,to,to).map(a=>a.name);
      for (const name of notified) this.insertMessage({name:to,session_id:actor.session_id}, {
        to:name, text:`PeerLetter rename notice: ${old} is now ${to}. Send future mail to ${to}; mail to ${old} returns PEER_RENAMED. No reply needed.`,
        idempotency_key:`peerletter-rename:${randomUUID()}`,
      },randomUUID(),"normal");
      return {agent:this.agent(to)!,from:old,requested,notified};
    });
    actor.name = renamed.agent.name;
    return renamed;
  }

  private cleanPresence(): void {
    for (const row of this.all<Agent>("SELECT * FROM agents WHERE online=1")) {
      if (!isProcessAlive(row.pid, row.proc_start)) this.run("UPDATE agents SET online=0 WHERE name=? AND runtime_id=?", row.name, row.runtime_id);
    }
  }

  peers() {
    this.transaction(() => this.cleanPresence());
    return this.all<Agent>("SELECT * FROM agents ORDER BY name").map(a => this.publicAgent(a));
  }

  publicAgent(a: Agent) {
    const binding = this.get<{naming:string;session_source:string}>("SELECT * FROM agent_bindings WHERE name=?",a.name);
    const source = binding?.session_source || "legacy";
    return { name: a.name, kind: a.kind, session_id: a.session_id, online: !!a.online,
      naming: binding?.naming || "legacy",
      previous_names: this.all<{old_name:string}>("SELECT old_name FROM agent_renames WHERE new_name=? ORDER BY old_name",a.name).map(r=>r.old_name),
      session_binding: { state: hasHostSession(a.kind,a.session_id,source) ? "bound" : "unbound", source },
      wake: a.wake, wake_error: a.wake_error, cwd: a.cwd, last_seen: a.last_seen,
      delivery_gate: this.gate(a.session_id) };
  }

  private assertSessionAvailable(kind: string, session: string, exceptName = ""): void {
    const owner = this.get<Agent>("SELECT * FROM agents WHERE kind=? AND session_id=? AND online=1 AND name<>? LIMIT 1",kind,session,exceptName);
    if (owner) throw new MailError("SESSION_IN_USE",`Host session is already owned by online agent ${owner.name}; close that MCP connection before reconnecting.`);
  }

  register(input: { name?: string; kind: string; session_id: string; pid?: number; host_pid?: number; wake?: string; session_source?: string; replace?: Agent }): Agent {
    if (input.name) validName(input.name);
    validName(input.kind);
    validSession(input.session_id);
    return this.transaction(() => {
      this.cleanPresence();
      if (input.replace) {
        const old=this.assertActor(input.replace);
        if (old.kind !== "claude" || input.kind !== "claude" || !old.host_pid
          || input.host_pid !== old.host_pid || !isProcessAlive(old.host_pid,old.host_start)) {
          throw new MailError("SESSION_MISMATCH","Only the same live Claude host can replace its participant.");
        }
        this.run("UPDATE agents SET online=0,last_seen=? WHERE name=? AND runtime_id=?",Date.now(),old.name,old.runtime_id);
        this.run("DELETE FROM leases WHERE owner=? AND owner_session=?",old.name,old.session_id);
      }
      const source = input.session_source || (/^(runtime|cli):/.test(input.session_id) ? "unbound" : "configured");
      const bound = hasHostSession(input.kind,input.session_id,source);
      let name = input.name || input.kind;
      const reserved = input.name ? this.renamedTo(name) : undefined;
      if (reserved) throw new MailError("NAME_RESERVED",`${name} was renamed to ${reserved}; update PEERLETTER_NAME/--name.`,{renamed_to:reserved});
      if (input.name && this.agent(name)?.online) throw new MailError("NAME_IN_USE", `Agent ${name} is already online; choose a different name.`);
      if (bound) this.assertSessionAvailable(input.kind,input.session_id);
      if (!input.name) {
        const previous = bound ? this.get<Agent>(`SELECT a.* FROM agents a LEFT JOIN agent_bindings b ON b.name=a.name
          WHERE a.kind=? AND a.session_id=? AND a.online=0 AND COALESCE(b.naming,'legacy')<>'explicit'
          ORDER BY a.last_seen DESC,a.name LIMIT 1`,input.kind,input.session_id) : undefined;
        if (previous) name = previous.name;
        else for (let index = 2; this.agent(name) || this.renamedTo(name); index++) name = `${input.kind}-${index}`;
      }
      const pid = input.pid ?? process.pid;
      const current: Agent = { name, kind: input.kind, session_id: input.session_id, runtime_id: randomUUID(),
        pid, proc_start: processInfo(pid)?.start ?? null, host_pid: input.host_pid ?? null,
        host_start: input.host_pid ? processInfo(input.host_pid)?.start ?? null : null,
        wake: input.wake || "none", wake_error: null, cwd: this.project.cwd, last_seen: Date.now(), online: 1 };
      this.run(`INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET kind=excluded.kind, session_id=excluded.session_id,
        runtime_id=excluded.runtime_id, pid=excluded.pid, proc_start=excluded.proc_start,
        host_pid=excluded.host_pid, host_start=excluded.host_start, wake=excluded.wake,
        wake_error=NULL, cwd=excluded.cwd, last_seen=excluded.last_seen, online=1`,
        current.name, current.kind, current.session_id, current.runtime_id, current.pid, current.proc_start,
        current.host_pid, current.host_start, current.wake, null, current.cwd, current.last_seen, 1);
      this.run(`INSERT INTO agent_bindings VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET
        naming=excluded.naming,session_source=excluded.session_source`,name,input.name ? "explicit" : "automatic",source);
      this.run("INSERT OR IGNORE INTO wake_baselines VALUES(?,?,?)", name,current.session_id,this.maxSequence());
      return current;
    });
  }

  // A CLI command acts as the current user's named mailbox, without claiming online presence.
  cliActor(name: string, session?: string, kind = "cli", reclaim = false): Actor {
    validName(name);
    validName(kind);
    if (session !== undefined) validSession(session);
    return this.transaction(() => {
      this.cleanPresence();
      const reserved = this.renamedTo(name);
      if (reserved && !reclaim) throw new MailError("NAME_RESERVED",`${name} was renamed to ${reserved}; use register to intentionally reclaim it.`,{renamed_to:reserved});
      if (reserved) this.run("DELETE FROM agent_renames WHERE old_name=?",name);
      const existing = this.agent(name);
      if (existing) return { name, session_id: session || existing.session_id };
      const session_id = session || `cli:${name}`;
      this.run("INSERT INTO agents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", name, kind, session_id, randomUUID(),
        null, null, null, null, "none", null, this.project.cwd, Date.now(), 0);
      this.run("INSERT INTO agent_bindings VALUES(?,?,?)",name,"explicit","unbound");
      return { name, session_id };
    });
  }

  assertActor(actor: Actor): Agent {
    let current = this.agent(actor.name);
    if (!current && actor.runtime_id) {
      current = this.get<Agent>("SELECT * FROM agents WHERE runtime_id=? AND session_id=?",actor.runtime_id,actor.session_id);
      if (current) actor.name = current.name;
    }
    if (!current || (actor.runtime_id && (current.runtime_id !== actor.runtime_id || current.session_id !== actor.session_id))) {
      throw new MailError("SESSION_CHANGED", "This runtime no longer owns the registered agent identity.");
    }
    return current;
  }

  touch(actor: Actor): void {
    const current = this.assertActor(actor);
    if (actor.runtime_id && Date.now() - current.last_seen >= 5000) this.run("UPDATE agents SET last_seen=? WHERE name=? AND runtime_id=?", Date.now(), actor.name, actor.runtime_id);
  }

  closeAgent(actor: Actor): void {
    if (!actor.runtime_id) return;
    const runtimeId = actor.runtime_id;
    this.transaction(() => {
      if (this.agent(actor.name)?.runtime_id !== runtimeId) return;
      this.run("UPDATE agents SET online=0,last_seen=? WHERE name=? AND runtime_id=?", Date.now(), actor.name, runtimeId);
      this.run("DELETE FROM leases WHERE owner=? AND owner_session=?", actor.name, actor.session_id);
    });
  }

  bindSession(kind: string, pid: number, session: string, cwd = this.project.cwd): void {
    boundedInt(pid, 1, 2 ** 31 - 1, "host_pid");
    validSession(session);
    this.run(`INSERT INTO sessions VALUES(?,?,?,?,?,?) ON CONFLICT(kind,host_pid) DO UPDATE SET
      host_start=excluded.host_start,session_id=excluded.session_id,cwd=excluded.cwd,updated_at=excluded.updated_at`,
      kind, pid, processInfo(pid)?.start ?? null, session, cwd, Date.now());
  }

  unbindSession(kind: string, pid: number, session: string): void {
    this.run("DELETE FROM sessions WHERE kind=? AND host_pid=? AND session_id=?",kind,pid,session);
  }

  sessionFor(kind: string, pids: number[]): string | undefined {
    for (const pid of pids) {
      const row = this.hostSession(kind,pid);
      if (row) return row.session_id;
    }
    return undefined;
  }

  hostSession(kind: string, pid: number) {
    const row=this.get<{host_start:string|null;session_id:string;cwd:string;updated_at:number}>("SELECT * FROM sessions WHERE kind=? AND host_pid=?",kind,pid);
    return row && isProcessAlive(pid,row.host_start) ? row : undefined;
  }

  // Only a PeerLetter tool call records use. Automatic joins are reserved for used host sessions.
  recordUse(kind: string, session: string): void {
    validSession(session);
    this.run("INSERT OR IGNORE INTO used_sessions VALUES(?,?,?)", kind, session, Date.now());
  }

  usedSession(kind: string, session: string): boolean {
    return !!this.get("SELECT 1 FROM used_sessions WHERE kind=? AND session_id=?", kind, session);
  }

  agentForSession(session: string, kind?: string): Agent | undefined {
    return kind ? this.get<Agent>("SELECT * FROM agents WHERE session_id=? AND kind=? AND online=1 ORDER BY last_seen DESC LIMIT 1", session, kind)
      : this.get<Agent>("SELECT * FROM agents WHERE session_id=? AND online=1 ORDER BY last_seen DESC LIMIT 1", session);
  }

  updateSession(actor: Actor, session: string, preserveRuntimeState = false, source = "configured"): void {
    validSession(session);
    this.transaction(() => {
      const currentActor = this.assertActor(actor);
      this.cleanPresence();
      if (hasHostSession(currentActor.kind,session,source)) this.assertSessionAvailable(currentActor.kind,session,actor.name);
      this.run("UPDATE agents SET session_id=? WHERE name=? AND runtime_id=?", session, actor.name, actor.runtime_id || "");
      this.run("UPDATE agent_bindings SET session_source=? WHERE name=?",source,actor.name);
      this.run("INSERT OR IGNORE INTO wake_baselines VALUES(?,?,?)",actor.name,session,
        preserveRuntimeState ? this.noticeBaseline(actor) : this.maxSequence());
      if(preserveRuntimeState) {
        const previous=this.gate(actor.session_id),current=this.gate(session);
        this.run("INSERT INTO gates VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET pause_reason=excluded.pause_reason,blocks=excluded.blocks",
          session,current.pause_reason || previous.pause_reason,JSON.stringify([...new Set([...previous.blocked_reasons,...current.blocked_reasons])]));
        this.run("UPDATE leases SET owner_session=? WHERE owner=? AND owner_session=?",session,actor.name,actor.session_id);
      }
    });
    actor.session_id = session;
  }

  setSessionSource(actor: Actor, source: string): void {
    this.transaction(() => {
      const current = this.assertActor(actor);
      this.cleanPresence();
      if (hasHostSession(current.kind,actor.session_id,source)) this.assertSessionAvailable(current.kind,actor.session_id,actor.name);
      this.run("UPDATE agent_bindings SET session_source=? WHERE name=?",source,actor.name);
    });
  }

  setWake(actor: Actor, mode: string, error: string | null = null): void {
    this.assertActor(actor);
    this.run("UPDATE agents SET wake=?,wake_error=? WHERE name=?", mode, error?.slice(0,500) ?? null, actor.name);
  }

  // Serialize ownership without stale filesystem-lock races. Never steal a live watcher.
  claimWatch(session: string, sink: string, token: string): boolean {
    validSession(session);
    return this.transaction(() => {
      const owner = this.get<{token:string;pid:number;proc_start:string|null}>("SELECT * FROM watch_owners WHERE session_id=?",session);
      if (owner && owner.token !== token && isProcessAlive(owner.pid,owner.proc_start)) return false;
      this.run("INSERT OR REPLACE INTO watch_owners VALUES(?,?,?,?,?,?)",session,token,sink,process.pid,processInfo(process.pid)?.start ?? null,Date.now());
      return true;
    });
  }

  ownsWatch(session: string, token: string): boolean {
    return this.get<{token:string}>("SELECT token FROM watch_owners WHERE session_id=?",session)?.token === token;
  }

  releaseWatch(session: string, token: string): void {
    this.run("DELETE FROM watch_owners WHERE session_id=? AND token=?",session,token);
  }

  watchStatus(session: string) {
    const owner = this.get<{sink:string;pid:number;proc_start:string|null;started_at:number}>("SELECT * FROM watch_owners WHERE session_id=?",session);
    return { online:!!owner && isProcessAlive(owner.pid,owner.proc_start), sink:owner?.sink ?? null, started_at:owner?.started_at ?? null };
  }

  gate(session: string): { pause_reason: string | null; blocked_reasons: string[]; state: string } {
    const row = this.get<{ pause_reason: string | null; blocks: string }>("SELECT * FROM gates WHERE session_id=?", session);
    const blocked_reasons: string[] = row ? JSON.parse(row.blocks) : [];
    const pause_reason = row?.pause_reason || null;
    return { pause_reason, blocked_reasons, state: pause_reason ? "paused" : blocked_reasons.length ? "blocked" : "ready" };
  }

  pause(session: string, reason: string | null): void {
    this.run("INSERT INTO gates(session_id,pause_reason) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET pause_reason=excluded.pause_reason", session, reason);
  }

  block(session: string, reason: string, active: boolean): void {
    this.transaction(() => {
      const reasons = new Set(this.gate(session).blocked_reasons);
      if (active) reasons.add(reason); else reasons.delete(reason);
      this.run("INSERT INTO gates(session_id,blocks) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET blocks=excluded.blocks", session, JSON.stringify([...reasons]));
    });
  }

  send(actor: Actor, input: SendInput): { message: Mail; duplicate: boolean } {
    this.assertActor(actor);
    validName(input.to);
    if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 65536) throw new MailError("INVALID_TEXT", "text must contain 1–65536 characters.");
    if (typeof input.idempotency_key !== "string" || !input.idempotency_key || input.idempotency_key.length > 256) throw new MailError("INVALID_KEY", "idempotency_key must contain 1–256 characters.");
    if (input.to === actor.name) throw new MailError("SELF_SEND", "Choose another agent as the recipient.");
    if (input.to_session !== undefined) validSession(input.to_session);
    if (input.thread_id && input.thread_id.length > 256) throw new MailError("INVALID_THREAD", "thread_id must contain at most 256 characters.");
    const importance = input.importance || "normal";
    if (importance !== "normal" && importance !== "high") throw new MailError("INVALID_IMPORTANCE", "importance must be normal or high.");
    if (input.reply_to) validUuid(input.reply_to, "INVALID_REPLY_ID");
    return this.transaction(() => {
      let to = input.to;
      const previous = this.get<Mail>(mailSelect + " WHERE m.from_name=? AND m.idempotency_key=?", actor.name, input.idempotency_key);
      const reserved = this.agent(to) ? undefined : this.renamedTo(to);
      if (reserved) {
        if (previous?.to_name === reserved) to = reserved;
        else throw new MailError("PEER_RENAMED",`${to} was renamed to ${reserved}.`,{renamed_to:reserved});
      }
      const recipient = this.agent(to);
      if (!recipient) throw new MailError("PEER_NOT_FOUND", `Unknown recipient ${input.to}. Register that mailbox first.`);
      const original = input.reply_to ? this.get<Mail>(mailSelect + " WHERE m.id=?", input.reply_to) : undefined;
      if (input.reply_to && !original) throw new MailError("REPLY_NOT_FOUND", "Original message does not exist in this workspace.");
      if (original && (original.to_name !== actor.name || original.from_name !== to)) throw new MailError("REPLY_DIRECTION_MISMATCH", "Reply must go to the sender of a message addressed to you.");
      if (original?.to_session && original.to_session !== actor.session_id) throw new MailError("REPLY_SESSION_MISMATCH", "The original message belongs to another recipient session.");
      if (original && input.thread_id && original.thread_id !== input.thread_id) throw new MailError("REPLY_THREAD_MISMATCH", "Reply must retain the original thread ID.");
      const thread = original?.thread_id || input.thread_id || previous?.thread_id || randomUUID();
      if (previous) {
        if (previous.to_name !== to || previous.text !== input.text || previous.to_session !== (input.to_session || null)
          || previous.reply_to !== (input.reply_to || null) || previous.importance !== importance || previous.thread_id !== thread) {
          throw new MailError("IDEMPOTENCY_CONFLICT", "This key was already used with different message content or routing.");
        }
        return { message: previous, duplicate: true };
      }
      if (input.to_session && recipient.session_id !== input.to_session) throw new MailError("SESSION_CHANGED", "Recipient is registered under another session ID.");
      return { message: this.insertMessage(actor,{...input,to},thread,importance), duplicate: false };
    });
  }

  // Call only inside an existing transaction so rename notices and normal mail commit atomically.
  private insertMessage(actor: Actor, input: SendInput, thread: string, importance: "normal" | "high"): Mail {
    const id = randomUUID();
    this.run(`INSERT INTO messages(id,from_name,from_session,to_name,to_session,thread_id,reply_to,text,importance,idempotency_key,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, actor.name, actor.session_id, input.to, input.to_session || null,
      thread, input.reply_to || null, input.text, importance, input.idempotency_key, Date.now());
    this.run("INSERT INTO deliveries(message_id,state) VALUES(?,'accepted')", id);
    return this.get<Mail>(mailSelect + " WHERE m.id=?", id)!;
  }

  peek(actor: Actor, options: { after_id?: string; limit?: number } = {}) {
    this.assertActor(actor);
    const limit = boundedInt(options.limit ?? 20, 1, 20, "limit");
    const args: SqlValue[] = [actor.name, actor.session_id];
    let after = "";
    if (options.after_id) {
      const cursor = this.read(actor, options.after_id);
      if (cursor.to_name !== actor.name) throw new MailError("INVALID_CURSOR", "Cursor must belong to your inbox.");
      const rank = cursor.importance === "high" ? 0 : 1;
      after = ` AND (${priority}>? OR (${priority}=? AND m.seq>?))`;
      args.push(rank, rank, cursor.seq);
    }
    const items = this.all<Mail>(mailSelect + ` WHERE m.to_name=? AND (m.to_session IS NULL OR m.to_session=?)
      AND d.state!='acknowledged'${after} ORDER BY ${priority},m.seq LIMIT ?`, ...args, limit + 1);
    const messages = items.slice(0, limit);
    const count = this.get<{ count: number }>(`SELECT COUNT(*) count FROM messages m JOIN deliveries d ON m.id=d.message_id
      WHERE m.to_name=? AND (m.to_session IS NULL OR m.to_session=?) AND d.state!='acknowledged'`, actor.name, actor.session_id)!.count;
    return { messages, has_more: items.length > limit, unacknowledged_count: count,
      next_after_id: messages.at(-1)?.id ?? null };
  }

  async receive(actor: Actor, options: { after_id?: string; limit?: number; wait_ms?: number; signal?: AbortSignal } = {}) {
    const wait = boundedInt(options.wait_ms ?? 0, 0, 30000, "wait_ms");
    const deadline = Date.now() + wait;
    let page = this.peek(actor, options);
    while (!page.messages.length && Date.now() < deadline) {
      if (options.signal?.aborted) throw new MailError("CANCELLED", "Receive was cancelled.");
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
      page = this.peek(actor, options);
    }
    if (options.signal?.aborted) throw new MailError("CANCELLED", "Receive was cancelled.");
    this.transaction(() => {
      for (const mail of page.messages) this.run(`UPDATE deliveries SET state=CASE WHEN state='acknowledged' THEN state ELSE 'delivered' END,
        delivered_at=COALESCE(delivered_at,?) WHERE message_id=?`, Date.now(), mail.id);
    });
    return { ...page, messages: page.messages.map(m => this.read(actor,m.id)) };
  }

  read(actor: Actor, id: string): Mail {
    this.assertActor(actor); validUuid(id);
    const message = this.get<Mail>(mailSelect + " WHERE m.id=?", id);
    if (!message || (message.from_name !== actor.name && message.to_name !== actor.name)) throw new MailError("MESSAGE_NOT_FOUND", "No accessible message with this ID.");
    if (message.to_name === actor.name && message.to_session && message.to_session !== actor.session_id) throw new MailError("SESSION_CHANGED", "Message targets another recipient session.");
    return message;
  }

  status(actor: Actor, id: string) {
    const m = this.read(actor, id);
    return { message_id: m.id, from: m.from_name, to: m.to_name, to_session: m.to_session, state: m.state,
      accepted_at: m.created_at, notified_at: m.notified_at, delivered_at: m.delivered_at, acknowledged_at: m.acked_at,
      reply_ids: this.all<{ id: string }>("SELECT id FROM messages WHERE reply_to=? ORDER BY seq", id).map(r => r.id) };
  }

  ack(actor: Actor, ids: string[]) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw new MailError("INVALID_ARGUMENT", "Provide 1–100 message IDs.");
    return this.transaction(() => {
      for (const id of ids) {
        const message = this.read(actor, id);
        if (message.to_name !== actor.name) throw new MailError("ACK_DIRECTION_MISMATCH", "Only the recipient can acknowledge a message.");
      }
      for (const id of new Set(ids)) this.run("UPDATE deliveries SET state='acknowledged',acked_at=COALESCE(acked_at,?) WHERE message_id=?", Date.now(), id);
      return { acknowledged: [...new Set(ids)] };
    });
  }

  maxSequence(): number { return this.get<{ seq: number }>("SELECT COALESCE(MAX(seq),0) seq FROM messages")!.seq; }
  noticeBaseline(actor: Actor): number {
    return this.get<{after_seq:number}>("SELECT after_seq FROM wake_baselines WHERE agent_name=? AND session_id=?",actor.name,actor.session_id)?.after_seq ?? this.maxSequence();
  }
  dataVersion(): number { return Number(this.get<{ data_version: number }>("PRAGMA data_version")!.data_version); }

  pendingNotices(actor: Actor, _sink: string, afterSequence = 0): Mail[] {
    this.assertActor(actor);
    if (this.gate(actor.session_id).state !== "ready") return [];
    return this.all<Mail>(mailSelect + ` WHERE m.to_name=? AND (m.to_session IS NULL OR m.to_session=?)
      AND d.state IN ('accepted','notified') AND m.seq>?
      AND NOT EXISTS(SELECT 1 FROM notices n WHERE n.message_id=m.id AND n.session_id=?)
      AND NOT EXISTS(SELECT 1 FROM codex_wakes w,json_each(w.message_ids) j
        WHERE w.session_id=? AND w.agent_name=m.to_name AND j.value=m.id)
      ORDER BY ${priority},m.seq LIMIT 20`, actor.name, actor.session_id, afterSequence, actor.session_id, actor.session_id);
  }

  markNotified(actor: Actor, sink: string, ids: string[]): void {
    this.transaction(() => this.recordNotified(actor,sink,ids));
  }

  private recordNotified(actor: Actor, sink: string, ids: string[]): void {
    for (const id of ids) {
      const message = this.read(actor, id);
      if (message.to_name !== actor.name) throw new MailError("NOTICE_DIRECTION_MISMATCH", "Cannot notify for another inbox.");
      this.run("INSERT OR IGNORE INTO notices VALUES(?,?,?,?)", id, actor.session_id, sink, Date.now());
      this.run("UPDATE deliveries SET state=CASE WHEN state='accepted' THEN 'notified' ELSE state END,notified_at=COALESCE(notified_at,?) WHERE message_id=?", Date.now(), id);
    }
  }

  codexWake(actor: Actor): CodexWake | undefined {
    this.assertActor(actor);
    return this.get<CodexWake>("SELECT * FROM codex_wakes WHERE session_id=? AND agent_name=?",actor.session_id,actor.name);
  }

  beginCodexWake(actor: Actor, messages: Mail[], text: (mail: Mail[]) => string): CodexWake | undefined {
    return this.transaction(() => {
      if (this.codexWake(actor) || this.gate(actor.session_id).state !== "ready") return;
      const wanted = new Set(messages.map(m=>m.id));
      const fresh = this.pendingNotices(actor,"codex-queue").filter(m=>wanted.has(m.id));
      if (!fresh.length) return;
      const client = `peerletter:${this.project.key}:${actor.session_id}:${randomUUID()}`;
      this.run("INSERT INTO codex_wakes VALUES(?,?,?,?,?,?,?)",actor.session_id,actor.name,client,null,
        JSON.stringify(fresh.map(m=>m.id)),text(fresh),Date.now());
      return this.codexWake(actor);
    });
  }

  finishCodexWake(actor: Actor, client: string, queue: string): void {
    this.transaction(() => {
      const row = this.codexWake(actor);
      if (!row || row.client_message_id !== client) throw new MailError("WAKE_OWNERSHIP_CHANGED","Codex wake intent changed.");
      if (row.queue_id && row.queue_id !== queue) throw new MailError("WAKE_OWNERSHIP_CHANGED","Codex queue ID changed.");
      this.run("UPDATE codex_wakes SET queue_id=? WHERE session_id=? AND client_message_id=?",queue,actor.session_id,client);
      this.recordNotified(actor,"codex-queue",JSON.parse(row.message_ids));
    });
  }

  codexWakeUnread(actor: Actor, row: CodexWake): Mail[] {
    this.assertActor(actor);
    return this.all<Mail>(mailSelect + ` WHERE m.to_name=? AND (m.to_session IS NULL OR m.to_session=?)
      AND d.state IN ('accepted','notified') AND m.id IN (SELECT value FROM json_each(?))`,actor.name,actor.session_id,row.message_ids);
  }

  clearCodexWake(actor: Actor, client: string, retryUnread: boolean): void {
    this.transaction(() => {
      const row = this.codexWake(actor);
      if (!row || row.client_message_id !== client) return;
      if (retryUnread) for (const id of JSON.parse(row.message_ids) as string[]) {
        this.run("DELETE FROM notices WHERE message_id=? AND session_id=? AND sink='codex-queue'",id,actor.session_id);
        this.run(`UPDATE deliveries SET state='accepted' WHERE message_id=? AND state='notified'
          AND NOT EXISTS(SELECT 1 FROM notices WHERE message_id=?)`,id,id);
      }
      this.run("DELETE FROM codex_wakes WHERE session_id=? AND client_message_id=?",actor.session_id,client);
    });
  }

  leaseClaim(actor: Actor, globs: string[], ttl = 300, exclusive = true): Lease {
    this.assertActor(actor);
    boundedInt(ttl, 1, 3600, "ttl");
    if (!Array.isArray(globs) || !globs.length || globs.length > 20) throw new MailError("INVALID_GLOB", "Provide 1–20 project-relative globs.");
    const normalized = [...new Set(globs.map(normalizeGlob))].sort();
    return this.transaction(() => {
      this.run("DELETE FROM leases WHERE expires_at<=?", Date.now());
      const active = this.leaseList();
      const conflicts = active.filter(l => !(l.owner === actor.name && l.owner_session === actor.session_id)
        && (exclusive || l.exclusive) && normalized.some(a => l.globs.some(b => globsMayOverlap(a,b))));
      if (conflicts.length) throw new MailError("LEASE_CONFLICT", "Requested paths overlap another agent's active lease.", conflicts);
      const existing = active.find(l => l.owner === actor.name && l.owner_session === actor.session_id
        && l.exclusive === exclusive && JSON.stringify(l.globs) === JSON.stringify(normalized));
      const lease = { id: existing?.id || randomUUID(), owner: actor.name, owner_session: actor.session_id,
        globs: normalized, exclusive, expires_at: Date.now() + ttl * 1000 };
      this.run("INSERT INTO leases VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at",
        lease.id, lease.owner, lease.owner_session, JSON.stringify(lease.globs), exclusive ? 1 : 0, lease.expires_at);
      return lease;
    });
  }

  leaseList(): Lease[] {
    return this.all<{ id: string; owner: string; owner_session: string; globs: string; exclusive: number; expires_at: number }>(
      "SELECT * FROM leases WHERE expires_at>? ORDER BY expires_at", Date.now()).map(l => ({ ...l, globs: JSON.parse(l.globs), exclusive: !!l.exclusive }));
  }

  leaseRelease(actor: Actor, ids?: string[]) {
    this.assertActor(actor);
    return this.transaction(() => {
      const own = this.leaseList().filter(l => l.owner === actor.name && l.owner_session === actor.session_id);
      if (ids && (!ids.length || ids.some(id => !own.some(l => l.id === id)))) throw new MailError("LEASE_NOT_OWNED", "Only leases from your current session can be released.");
      const selected = ids || own.map(l => l.id);
      for (const id of selected) this.run("DELETE FROM leases WHERE id=? AND owner=? AND owner_session=?", id, actor.name, actor.session_id);
      return { released: selected };
    });
  }

  prune(days: number, apply = false) {
    boundedInt(days, 1, 36500, "days");
    return this.transaction(() => {
      const cutoff = Date.now() - days * 86400000;
      const rows = this.all<{ thread_id: string; count: number }>(`SELECT m.thread_id,COUNT(*) count FROM messages m JOIN deliveries d ON m.id=d.message_id
        GROUP BY m.thread_id HAVING MAX(CASE WHEN d.acked_at IS NULL OR d.acked_at>? THEN 1 ELSE 0 END)=0`, cutoff);
      if (apply) for (const row of rows) this.run("DELETE FROM messages WHERE thread_id=?", row.thread_id);
      return { applied: apply, threads: rows.length, messages: rows.reduce((n,r) => n+r.count,0), older_than_days: days };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // PASSIVE never waits for other clients; reads and writes own their short transactions.
    try { this.db.exec("PRAGMA wal_checkpoint(PASSIVE)"); } finally { this.db.close(); }
  }
}

function normalizeGlob(value: string): string {
  if (typeof value !== "string" || !value || value.length > 256 || value.startsWith("/")
    || value.includes("\\") || value.split("/").includes("..") || /[\[\]{}!()\u0000]/.test(value)) {
    throw new MailError("INVALID_GLOB", "Use project-relative paths with *, ** or ?; no absolute paths, .. or extended glob syntax.");
  }
  const normalized = value.replace(/^\.\//, "");
  if(normalized.split("/").some(part=>!part || part === "." || part === "..")) throw new MailError("INVALID_GLOB","Use canonical project-relative paths without empty or dot segments.");
  return normalized;
}

// Conservative prefix overlap can report false conflicts, but never grants overlapping wildcard prefixes.
export function globsMayOverlap(a: string, b: string): boolean {
  const prefix = (g: string) => g.split(/[?*]/,1)[0];
  const left = prefix(a), right = prefix(b);
  return left.startsWith(right) || right.startsWith(left);
}
