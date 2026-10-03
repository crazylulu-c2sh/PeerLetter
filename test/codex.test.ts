import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { CodexQueue, CodexConnection } from "../src/codex.ts";
import { MailWatcher } from "../src/wake.ts";
import { codexDaemon } from "./codex-fixture.ts";

function fixture(t: test.TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-codex-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state));
  const actor=store.register({name:"codex",kind:"codex",session_id:randomUUID(),wake:"codex-queue"});
  const sender=store.register({name:"sender",kind:"claude",session_id:randomUUID()});
  const rpc={status:"active",queued:[] as any[],calls:[] as string[],beforeRead:undefined as (()=>Promise<void>)|undefined,
    afterAdd:undefined as (()=>Promise<void>)|undefined,failDelete:false,loseAdd:false,cursor:false,
    async call(method:string,params:any):Promise<any> {
      this.calls.push(method);
      if(method === "thread/read") {await this.beforeRead?.();return {thread:{id:actor.session_id,status:{type:this.status}}};}
      if(method === "thread/queue/list") return {data:this.queued,nextCursor:null};
      if(method === "thread/queue/add") {
        const row={id:randomUUID(),input:params.input,clientUserMessageId:params.clientUserMessageId};this.queued.push(row);
        await this.afterAdd?.();if(this.loseAdd)throw new Error("lost response");return {queuedSubmission:row};
      }
      if(method === "thread/queue/delete") {
        if(this.failDelete)throw new Error("delete failed");
        const i=this.queued.findIndex(q=>q.id === params.queuedSubmissionId);if(i>=0)this.queued.splice(i,1);return {deleted:i>=0};
      }
      throw new Error(method);
    }, close(){} };
  const queue=new CodexQueue(store,actor,()=>actor.session_id,rpc);
  const watcher=new MailWatcher(store,actor,"codex-queue",m=>queue.signal(m),{maintain:()=>queue.reconcile()});
  let n=0;const mail=()=>store.send(sender,{to:actor.name,text:"SECRET-MAIL-BODY",idempotency_key:`mail-${++n}`}).message;
  t.after(async()=>{await watcher.stop();queue.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,project,state,store,actor,sender,rpc,queue,watcher,mail};
}

test("busy N mail read and ACK produces no queued wake; unread mail wakes once after idle",async t=>{
  const f=fixture(t),mails=Array.from({length:5},()=>f.mail());
  await f.watcher.tick();assert.equal(f.rpc.queued.length,0);assert.equal(f.store.all("SELECT * FROM notices").length,0);
  assert.equal(f.store.agent(f.actor.name)?.wake_error,null);
  await f.store.receive(f.actor);f.store.ack(f.actor,mails.map(m=>m.id));f.rpc.status="idle";await f.watcher.tick();
  assert.equal(f.rpc.calls.filter(c=>c === "thread/queue/add").length,0);
  f.rpc.status="active";const next=Array.from({length:5},()=>f.mail());await f.watcher.tick();assert.equal(f.rpc.queued.length,0);
  f.rpc.status="idle";await f.watcher.tick();assert.equal(f.rpc.queued.length,1);
  assert.ok(!JSON.stringify(f.rpc.queued).includes("SECRET-MAIL-BODY"));
  assert.match(f.rpc.queued[0].input[0].text,/If receive returns no messages, continue any task already in progress; end the turn only if there is none/);
  assert.ok(next.every(m=>f.store.status(f.sender,m.id).state === "notified"));
  await f.watcher.tick();assert.equal(f.rpc.queued.length,1);assert.equal(f.store.peek(f.actor).messages.length,5);
});

test("one pending batch coalesces later mail without losing it, then receive withdraws only owned input",async t=>{
  const f=fixture(t);f.rpc.status="idle";const first=f.mail();await f.watcher.tick();const second=f.mail();await f.watcher.tick();
  assert.equal(f.rpc.queued.length,1);assert.equal(f.store.status(f.sender,second.id).state,"accepted");
  f.rpc.queued.push({id:"user-queue",clientUserMessageId:"user",input:[{type:"text",text:"User task"}]});
  await f.store.receive(f.actor);await f.watcher.tick();assert.deepEqual(f.rpc.queued.map(q=>q.id),["user-queue"]);
  assert.equal(f.store.codexWake(f.actor),undefined);assert.equal(f.store.status(f.sender,first.id).state,"delivered");
  // A queued wake consumed before second mail is read must not swallow that mail's next wake.
  f.mail();await f.watcher.tick();f.rpc.queued=f.rpc.queued.filter(q=>q.id === "user-queue");const fourth=f.mail();await f.watcher.tick();
  assert.equal(f.rpc.queued.length,2);assert.equal(f.store.status(f.sender,fourth.id).state,"notified");
});

test("delivery during status/read or add, pause and high priority never force an obsolete pending wake",async t=>{
  const f=fixture(t);f.rpc.status="idle";f.mail();f.rpc.beforeRead=async()=>{await f.store.receive(f.actor);};
  await f.watcher.tick();assert.equal(f.rpc.queued.length,0);assert.equal(f.store.codexWake(f.actor),undefined);
  f.rpc.beforeRead=undefined;f.mail();f.rpc.afterAdd=async()=>{await f.store.receive(f.actor);};await f.watcher.tick();assert.equal(f.rpc.queued.length,0);
  f.rpc.afterAdd=undefined;
  const high=f.store.send(f.sender,{to:f.actor.name,text:"high",importance:"high",idempotency_key:"high"}).message;
  f.store.pause(f.actor.session_id,"manual");await f.watcher.tick();assert.equal(f.rpc.queued.length,0);
  f.store.pause(f.actor.session_id,null);f.rpc.afterAdd=async()=>{f.store.pause(f.actor.session_id,"user_abort");};
  await f.watcher.tick();assert.equal(f.rpc.queued.length,0);assert.equal(f.store.status(f.sender,high.id).state,"accepted");
  f.rpc.afterAdd=undefined;f.store.pause(f.actor.session_id,null);f.store.block(f.actor.session_id,"ui",true);await f.watcher.tick();assert.equal(f.rpc.queued.length,0);
  f.store.block(f.actor.session_id,"ui",false);await f.watcher.tick();assert.equal(f.rpc.queued.length,1);
  f.store.pause(f.actor.session_id,"manual");await f.watcher.tick();assert.equal(f.rpc.queued.length,0);
  f.store.pause(f.actor.session_id,null);await f.watcher.tick();assert.equal(f.rpc.queued.length,1);
});

test("lost add response survives restart, delete failure retains ownership, edited user input is preserved",async t=>{
  const f=fixture(t);f.rpc.status="idle";const mail=f.mail();f.rpc.loseAdd=true;
  await assert.rejects(f.queue.signal([mail]),/lost response/);assert.equal(f.store.codexWake(f.actor)?.queue_id,null);
  const reopened=new Store(f.store.project);t.after(()=>reopened.close());
  const recovered=new CodexQueue(reopened,f.actor,()=>f.actor.session_id,f.rpc);await recovered.reconcile();
  assert.equal(f.rpc.queued.length,1);assert.equal(f.store.status(f.sender,mail.id).state,"notified");
  await f.store.receive(f.actor);f.rpc.failDelete=true;await assert.rejects(recovered.reconcile(),/delete failed/);
  assert.ok(f.store.codexWake(f.actor));f.rpc.failDelete=false;await recovered.reconcile();assert.equal(f.rpc.queued.length,0);
  f.rpc.loseAdd=false;const next=f.mail();await recovered.signal([next]);f.rpc.queued[0].input[0].text="User edited task";
  await assert.rejects(recovered.reconcile(),/edited/);assert.equal(f.rpc.queued[0].input[0].text,"User edited task");
  assert.equal(f.store.codexWake(f.actor),undefined);assert.equal(f.store.status(f.sender,next.id).state,"accepted");
});

test("Stop defers to healthy queue; failure fallback and atomic claimed batch cannot double-signal",async t=>{
  const f=fixture(t);const m=f.mail();
  const hook=()=>execFileSync(process.execPath,[path.resolve("hooks/hook.ts"),"codex"],{input:JSON.stringify({hook_event_name:"Stop",session_id:f.actor.session_id,cwd:f.project}),
    env:{...process.env,PEERLETTER_STATE_DIR:f.state},encoding:"utf8"});
  assert.equal(hook(),"");assert.equal(f.store.status(f.sender,m.id).state,"accepted");
  const intent=f.store.beginCodexWake(f.actor,[m],()=>"PeerLetter notice")!;f.store.setWake(f.actor,"codex-queue","API failed");
  assert.equal(hook(),"");f.store.clearCodexWake(f.actor,intent.client_message_id,true);
  assert.equal(JSON.parse(hook()).decision,"block");assert.equal(f.store.pendingNotices(f.actor,"codex-queue").length,0);
  f.rpc.status="idle";await f.watcher.tick();assert.equal(f.rpc.queued.length,0);
});

test("real Unix WebSocket transport negotiates, accepts socket aliases and reconnects after disconnect",async t=>{
  const f=fixture(t),daemon=await codexDaemon(t,f.root,f.actor.session_id);
  const published=path.join(f.root,"published.sock");fs.symlinkSync(daemon.socket,published);
  const rpc=new CodexConnection(published,300),queue=new CodexQueue(f.store,f.actor,()=>f.actor.session_id,rpc);t.after(()=>rpc.close());
  const m=f.mail();await queue.signal([m]);assert.equal(daemon.queued.length,1);assert.equal(daemon.calls[0].params.capabilities.experimentalApi,true);
  for(const connection of daemon.ws.clients)connection.terminate();
  await new Promise(resolve=>setTimeout(resolve,25));
  await f.store.receive(f.actor);await queue.reconcile();assert.equal(daemon.state.deletes,1);
  rpc.close();const replacement=new CodexConnection(daemon.socket,300);t.after(()=>replacement.close());
  const next=new CodexQueue(f.store,f.actor,()=>f.actor.session_id,replacement);const another=f.mail();await next.signal([another]);assert.equal(daemon.state.additions,2);
  const missing=new CodexConnection(path.join(f.root,"missing.sock"),50);t.after(()=>missing.close());
  await assert.rejects(missing.call("thread/read",{}),/ENOENT/);
});

test("unknown runtime status and wrong thread fail closed; simultaneous sends preserve one intent",async t=>{
  const f=fixture(t),mail=f.mail();f.rpc.status="notLoaded";
  await f.watcher.tick();assert.equal(f.rpc.queued.length,0);assert.match(f.store.agent(f.actor.name)!.wake_error!,/not loaded/);
  f.rpc.status="idle";await Promise.all([f.queue.signal([mail]),f.queue.signal([mail]),f.queue.reconcile()]);
  assert.equal(f.rpc.queued.length,1);assert.equal(f.rpc.calls.filter(m=>m === "thread/queue/add").length,1);
  await f.store.receive(f.actor);await f.queue.reconcile();const next=f.mail();
  const rpc={async call(){return {thread:{id:randomUUID(),status:{type:"idle"}}};},close(){}};
  const wrong=new CodexQueue(f.store,f.actor,()=>f.actor.session_id,rpc);
  await assert.rejects(wrong.signal([next]),/different thread/);assert.equal(f.store.codexWake(f.actor),undefined);
});

test("owned queue lookup pages past user input and never deletes mismatched queue ownership",async t=>{
  const f=fixture(t);f.rpc.status="idle";const mail=f.mail();await f.queue.signal([mail]);
  const owned=f.rpc.queued[0],base=f.rpc.call.bind(f.rpc);let pages=0;
  f.rpc.call=async(method,params)=>{
    if(method === "thread/queue/list"){
      pages++;return params.cursor ? {data:[owned],nextCursor:null} : {data:[{id:"user",clientUserMessageId:"user",input:[]}],nextCursor:"next"};
    }
    return base(method,params);
  };
  await f.store.receive(f.actor);await f.queue.reconcile();assert.equal(pages,2);assert.equal(f.rpc.queued.length,0);
  f.rpc.call=base;const next=f.mail();await f.queue.signal([next]);f.rpc.queued[0].id="different-id";
  await assert.rejects(f.queue.reconcile(),/does not match/);assert.equal(f.rpc.queued.length,1);assert.ok(f.store.codexWake(f.actor));
});

test("a new turn after idle check is safe when receive races with add; uncertain unsent intent remains retryable",async t=>{
  const f=fixture(t),mail=f.mail(),base=f.rpc.call.bind(f.rpc);
  f.rpc.call=async(method,params)=>{
    if(method === "thread/read"){f.rpc.status="active";return {thread:{id:f.actor.session_id,status:{type:"idle"}}};}
    return base(method,params);
  };
  f.rpc.afterAdd=async()=>{await f.store.receive(f.actor);};await f.queue.signal([mail]);
  assert.equal(f.rpc.queued.length,0);assert.equal(f.store.status(f.sender,mail.id).state,"delivered");
  f.rpc.call=base;f.rpc.afterAdd=undefined;const next=f.mail();
  const intent=f.store.beginCodexWake(f.actor,[next],()=>"PeerLetter notice")!;
  assert.equal(f.store.pendingNotices(f.actor,"codex-stop").length,0);await f.queue.reconcile();
  assert.equal(f.store.codexWake(f.actor),undefined);assert.equal(f.store.pendingNotices(f.actor,"codex-queue")[0].id,next.id);
  assert.equal(f.store.status(f.sender,next.id).state,"accepted");assert.ok(intent.client_message_id.startsWith("peerletter:"));
});
