import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { homedir } from "node:os";
import WebSocket from "ws";
import { MailError } from "./errors.ts";
import type { Actor, CodexWake, Mail, Store } from "./store.ts";
import { noticeText } from "./wake.ts";

export interface CodexRpc {
  call(method: string, params: Record<string,unknown>): Promise<any>;
  close(): void;
}

// Attach to the existing local daemon. Never start, resume or subscribe to a thread.
export class CodexConnection implements CodexRpc {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private serial = 0;
  private ended = false;
  private pending = new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private socketPath: string;
  private timeout: number;

  constructor(socketPath = process.env.PEERLETTER_CODEX_SOCKET
    || path.join(process.env.CODEX_HOME || path.join(homedir(),".codex"),"app-server-control","app-server-control.sock"), timeout = 3000) {
    this.socketPath = socketPath; this.timeout = timeout;
  }

  private fail(socket: WebSocket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); socket.terminate();
  }

  private async connect(): Promise<void> {
    if (this.ended) throw new MailError("WAKE_UNAVAILABLE","Codex connection is closed.");
    if (this.connecting) return this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const task = (async () => {
      if (!path.isAbsolute(this.socketPath)) throw new MailError("WAKE_UNAVAILABLE","Codex control socket path must be absolute.");
      // Codex publishes a symlink to a private short socket path on some systems.
      const published = fs.lstatSync(this.socketPath), resolved = fs.realpathSync(this.socketPath), stat = fs.statSync(resolved);
      if (!stat.isSocket() || (process.getuid && (published.uid !== process.getuid() || stat.uid !== process.getuid())))
        throw new MailError("WAKE_UNAVAILABLE","Codex control socket and its published path must belong to this user.");
      const socket = new WebSocket("ws://localhost/",{
        createConnection: () => net.createConnection({path:resolved}),
        handshakeTimeout:this.timeout, maxPayload:1024*1024, perMessageDeflate:false,
      });
      this.socket = socket;
      socket.on("error",()=>this.fail(socket,new MailError("WAKE_UNAVAILABLE","Codex daemon connection failed.")));
      socket.on("close",()=>this.fail(socket,new MailError("WAKE_UNAVAILABLE","Codex daemon disconnected.")));
      socket.on("message",bytes=>{
        if (this.socket !== socket) return;
        try {
          const message = JSON.parse(String(bytes));
          const request = this.pending.get(message.id);
          if (!request) return; // No thread subscription; ignore unrelated notifications.
          clearTimeout(request.timer); this.pending.delete(message.id);
          if (message.error) request.reject(new MailError("WAKE_UNAVAILABLE",`Codex ${message.error.code}: ${String(message.error.message).slice(0,300)}`));
          else if ("result" in message) request.resolve(message.result);
          else request.reject(new MailError("WAKE_UNAVAILABLE","Malformed Codex response."));
        } catch { this.fail(socket,new MailError("WAKE_UNAVAILABLE","Malformed Codex protocol message.")); }
      });
      await new Promise<void>((resolve,reject)=>{socket.once("open",resolve);socket.once("error",reject);socket.once("close",()=>reject(new Error("Codex connection closed before initialization.")));});
      await this.request("initialize",{clientInfo:{name:"peerletter_wake",title:"PeerLetter local wake adapter",version:"0.1.0"},
        capabilities:{experimentalApi:true,requestAttestation:false}});
      socket.send(JSON.stringify({method:"initialized"}));
    })();
    this.connecting = task;
    try { await task; }
    catch (error) { if (this.socket) this.fail(this.socket,error instanceof Error ? error : new Error(String(error))); throw error; }
    finally { if (this.connecting === task) this.connecting = undefined; }
  }

  private request(method: string, params: Record<string,unknown>): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new MailError("WAKE_UNAVAILABLE","Codex daemon is not connected."));
    return new Promise((resolve,reject)=>{
      const id = ++this.serial;
      const timer = setTimeout(()=>this.fail(socket,new MailError("WAKE_UNAVAILABLE",`Codex ${method} timed out.`)),this.timeout);
      this.pending.set(id,{resolve,reject,timer});
      socket.send(JSON.stringify({id,method,params}),error=>{if(error)this.fail(socket,new MailError("WAKE_UNAVAILABLE","Codex request failed."));});
    });
  }

  async call(method: string, params: Record<string,unknown>): Promise<any> {
    await this.connect(); return this.request(method,params);
  }

  close(): void {
    this.ended = true;
    if (this.socket) this.fail(this.socket,new MailError("WAKE_UNAVAILABLE","Codex connection closed."));
  }
}

type Queued = { id: string; clientUserMessageId: string; input: unknown };
const inputFor = (row: CodexWake) => [{type:"text",text:row.input,text_elements:[]}];
const unchangedInput = (queued: Queued, row: CodexWake) => Array.isArray(queued.input)
  && queued.input.length === 1 && queued.input[0]?.type === "text" && queued.input[0]?.text === row.input
  && (queued.input[0].text_elements === undefined || (Array.isArray(queued.input[0].text_elements) && queued.input[0].text_elements.length === 0));

export class CodexQueue {
  private store: Store;
  private actor: Actor;
  private target: () => string;
  private rpc: CodexRpc;
  private active: Promise<unknown> = Promise.resolve();

  constructor(store: Store, actor: Actor, target: () => string, rpc: CodexRpc = new CodexConnection()) {
    this.store = store; this.actor = actor; this.target = target; this.rpc = rpc;
  }

  private check(queued: any, row: CodexWake): asserts queued is Queued {
    if (!queued || typeof queued.id !== "string" || !queued.id || queued.id.length > 256
      || queued.clientUserMessageId !== row.client_message_id || (row.queue_id && queued.id !== row.queue_id))
      throw new MailError("WAKE_OWNERSHIP_CHANGED","Codex queue response does not match our saved wake intent.");
  }

  private async find(row: CodexWake): Promise<Queued | undefined> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page=0;page<100;page++) {
      const result = await this.rpc.call("thread/queue/list",{threadId:this.target(),limit:100,...(cursor?{cursor}:{})});
      if (!Array.isArray(result?.data)) throw new MailError("WAKE_UNAVAILABLE","Malformed Codex queue list.");
      const matches = result.data.filter((q:any)=>q?.clientUserMessageId === row.client_message_id);
      if (matches.length > 1) throw new MailError("WAKE_OWNERSHIP_CHANGED","Codex returned duplicate wake ownership IDs.");
      if (matches.length) { this.check(matches[0],row); return matches[0]; }
      if (result.nextCursor == null) return;
      if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor)) break;
      cursor = result.nextCursor as string; seen.add(cursor);
    }
    throw new MailError("WAKE_UNAVAILABLE","Codex queue pagination did not finish.");
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.active.then(fn,fn); this.active = next.catch(()=>{}); return next;
  }

  reconcile(): Promise<void> { return this.serial(()=>this.reconcileNow()); }

  private async reconcileNow(): Promise<void> {
    const row = this.store.codexWake(this.actor);
    if (!row) return;
    const queued = await this.find(row);
    if (!queued) {
      // A known accepted submission is no longer pending. An unconfirmed intent is retryable.
      this.store.clearCodexWake(this.actor,row.client_message_id,!row.queue_id);
      return;
    }
    if (!unchangedInput(queued,row)) {
      // A user edited our queued message. Preserve their input and relinquish ownership.
      this.store.clearCodexWake(this.actor,row.client_message_id,true);
      throw new MailError("WAKE_OWNERSHIP_CHANGED","Saved PeerLetter queue input was edited; preserved the changed item.");
    }
    this.store.finishCodexWake(this.actor,row.client_message_id,queued.id);
    if (!this.store.codexWakeUnread(this.actor,row).length || this.store.gate(this.actor.session_id).state !== "ready") {
      const result = await this.rpc.call("thread/queue/delete",{threadId:this.target(),queuedSubmissionId:queued.id});
      if (typeof result?.deleted !== "boolean") throw new MailError("WAKE_UNAVAILABLE","Malformed Codex queue deletion response.");
      this.store.clearCodexWake(this.actor,row.client_message_id,result.deleted);
    }
  }

  signal(messages: Mail[]): Promise<false> { return this.serial(()=>this.signalNow(messages)); }

  private async signalNow(messages: Mail[]): Promise<false> {
    if (this.store.codexWake(this.actor)) return false; // At most one owned pending signal.
    const thread = this.target();
    const result = await this.rpc.call("thread/read",{threadId:thread,includeTurns:false});
    if (result?.thread?.id !== thread) throw new MailError("WAKE_UNAVAILABLE","Codex returned a different thread.");
    if (result.thread.status?.type === "active") return false;
    if (result.thread.status?.type !== "idle") throw new MailError("WAKE_UNAVAILABLE","Codex thread is not loaded and idle.");
    // Recheck delivery/gates after the asynchronous status read; claim against Stop hooks atomically.
    const row = this.store.beginCodexWake(this.actor,messages,noticeText);
    if (!row) return false;
    const accepted = await this.rpc.call("thread/queue/add",{threadId:thread,input:inputFor(row),clientUserMessageId:row.client_message_id});
    this.check(accepted?.queuedSubmission,row);
    this.store.finishCodexWake(this.actor,row.client_message_id,accepted.queuedSubmission.id);
    // receive/pause may race with add. Withdraw only a still-pending item that we own.
    await this.reconcileNow();
    return false; // Receipts were recorded for the claimed batch, not the caller's stale snapshot.
  }

  close(): void { this.rpc.close(); }
}
