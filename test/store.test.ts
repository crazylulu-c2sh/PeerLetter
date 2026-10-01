import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { MailError } from "../src/errors.ts";
import { MailWatcher, noticeText } from "../src/wake.ts";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-test-"));
  const cwd = path.join(root,"project"); fs.mkdirSync(cwd);
  const project = resolveProject(cwd,path.join(root,"state"));
  const a = new Store(project), b = new Store(project);
  const sender = a.register({name:"sender",kind:"codex",session_id:randomUUID()});
  const receiver = b.register({name:"receiver",kind:"claude",session_id:randomUUID()});
  t.after(()=>{a.close();b.close();fs.rmSync(root,{recursive:true,force:true});});
  return {a,b,sender,receiver,root,project};
}
const code = (wanted: string) => (error: unknown) => error instanceof MailError && error.code === wanted;

test("durable send, full UUID replies, atomic ACK and idempotency",async t=>{
  const {a,b,sender,receiver} = fixture(t);
  const input = {to:"receiver",text:"task",idempotency_key:"task-1"};
  const sent = a.send(sender,input);
  assert.equal(sent.message.state,"accepted");
  assert.equal(a.send(sender,input).message.id,sent.message.id);
  assert.throws(()=>a.send(sender,{...input,text:"changed"}),code("IDEMPOTENCY_CONFLICT"));
  assert.throws(()=>a.send(sender,{...input,to:"absent",idempotency_key:"absent"}),code("PEER_NOT_FOUND"));
  assert.throws(()=>a.send(sender,{...input,to:"sender",idempotency_key:"self"}),code("SELF_SEND"));
  const received = await b.receive(receiver);
  assert.equal(received.messages[0].id,sent.message.id);
  assert.equal(a.status(sender,sent.message.id).state,"delivered");
  assert.equal((await b.receive(receiver)).messages.length,1);
  assert.throws(()=>a.ack(sender,[sent.message.id]),code("ACK_DIRECTION_MISMATCH"));
  assert.throws(()=>b.ack(receiver,[sent.message.id,randomUUID()]),code("MESSAGE_NOT_FOUND"));
  assert.equal(a.status(sender,sent.message.id).state,"delivered");
  assert.throws(()=>b.send(receiver,{to:"sender",text:"done",idempotency_key:"badreply",reply_to:sent.message.id.slice(0,8)}),code("INVALID_REPLY_ID"));
  const reply = b.send(receiver,{to:"sender",text:"done",idempotency_key:"reply",reply_to:sent.message.id});
  assert.equal(reply.message.thread_id,sent.message.thread_id);
  assert.deepEqual(a.status(sender,sent.message.id).reply_ids,[reply.message.id]);
  b.ack(receiver,[sent.message.id]); b.ack(receiver,[sent.message.id]);
  assert.equal(b.peek(receiver).messages.length,0);
  assert.equal(a.status(sender,sent.message.id).state,"acknowledged");
});

test("priority pagination does not lose earlier normal mail",t=>{
  const {a,b,sender,receiver} = fixture(t);
  const normal = a.send(sender,{to:"receiver",text:"normal",idempotency_key:"normal"}).message;
  const high = a.send(sender,{to:"receiver",text:"high",importance:"high",idempotency_key:"high"}).message;
  const first = b.peek(receiver,{limit:1});
  assert.equal(first.messages[0].id,high.id); assert.equal(first.has_more,true);
  const second = b.peek(receiver,{limit:1,after_id:first.next_after_id!});
  assert.equal(second.messages[0].id,normal.id);
});

test("names collide only online; unscoped mail survives session replacement",t=>{
  const {a,b,sender,receiver} = fixture(t);
  assert.throws(()=>a.register({name:"receiver",kind:"claude",session_id:randomUUID()}),code("NAME_IN_USE"));
  assert.equal(a.register({kind:"claude",session_id:randomUUID()}).name,"claude");
  assert.equal(b.register({kind:"claude",session_id:randomUUID()}).name,"claude-2");
  a.send(sender,{to:"receiver",text:"retained",idempotency_key:"retained"});
  a.send(sender,{to:"receiver",text:"session-only",idempotency_key:"targeted",to_session:receiver.session_id});
  b.closeAgent(receiver);
  const next = a.register({name:"receiver",kind:"claude",session_id:randomUUID()});
  assert.deepEqual(a.peek(next).messages.map(m=>m.text),["retained"]);
  assert.throws(()=>b.peek(receiver),code("SESSION_CHANGED"));
  const targeted = a.send(sender,{to:"receiver",text:"session-only",idempotency_key:"targeted",to_session:receiver.session_id});
  assert.equal(targeted.duplicate,true);
  assert.throws(()=>a.send(sender,{to:"receiver",text:"stale",idempotency_key:"stale",to_session:receiver.session_id}),code("SESSION_CHANGED"));
});

test("long polls leave the write lock free and accept cancellation",async t=>{
  const {a,b,sender,receiver} = fixture(t);
  const poll = b.receive(receiver,{wait_ms:2000});
  const now = Date.now();
  const sent = a.send(sender,{to:"receiver",text:"concurrent",idempotency_key:"concurrent"});
  assert.ok(Date.now()-now < 1000);
  assert.equal((await poll).messages[0].id,sent.message.id);
  b.ack(receiver,[sent.message.id]);
  const abort = new AbortController(); const pending = b.receive(receiver,{wait_ms:2000,signal:abort.signal});
  abort.abort(); await assert.rejects(pending,code("CANCELLED"));
  await assert.rejects(b.receive(receiver,{wait_ms:30001}),code("INVALID_ARGUMENT"));
});

test("atomic advisory leases enforce owner, overlap, renewal and expiry",t=>{
  const {a,b,sender,receiver} = fixture(t);
  const lease = a.leaseClaim(sender,["src/**"],1);
  assert.throws(()=>b.leaseClaim(receiver,["src/main.ts"]),code("LEASE_CONFLICT"));
  assert.throws(()=>b.leaseRelease(receiver,[lease.id]),code("LEASE_NOT_OWNED"));
  assert.equal(a.leaseClaim(sender,["src/**"],2).id,lease.id);
  b.leaseClaim(receiver,["docs/**"]);
  assert.throws(()=>a.leaseClaim(sender,["../secret"]),code("INVALID_GLOB"));
  assert.throws(()=>a.leaseClaim(sender,["src//**"]),code("INVALID_GLOB"));
  assert.throws(()=>a.leaseClaim(sender,["src/./**"]),code("INVALID_GLOB"));
  a.run("UPDATE leases SET expires_at=0 WHERE id=?",lease.id);
  b.leaseClaim(receiver,["src/main.ts"]);
});

test("wake has no body, never ACKs, respects pause and deduplicates",async t=>{
  const {a,b,sender,receiver} = fixture(t);
  const sent = a.send(sender,{to:"receiver",text:"SECRET-MAIL-BODY",importance:"high",idempotency_key:"wake"});
  let calls = 0;
  const watcher = new MailWatcher(b,receiver,"test",async mails=>{calls++;assert.ok(!noticeText(mails).includes("SECRET-MAIL-BODY"));},{backlog:true});
  b.pause(receiver.session_id,"manual"); await watcher.tick(); assert.equal(calls,0);
  b.pause(receiver.session_id,null); b.block(receiver.session_id,"ui",true); await watcher.tick(); assert.equal(calls,0);
  b.block(receiver.session_id,"ui",false); await watcher.tick(); await watcher.tick();
  assert.equal(calls,1); assert.equal(a.status(sender,sent.message.id).state,"notified");
  assert.equal(b.peek(receiver).messages.length,1); await watcher.stop();
});

test("failed wake remains retryable; startup backlog is explicit",async t=>{
  const {a,b,sender,receiver} = fixture(t);
  const mail = a.send(sender,{to:"receiver",text:"prior session",idempotency_key:"prior"}).message;
  let calls=0;
  b.closeAgent(receiver);
  const renewed = b.register({name:receiver.name,kind:"claude",session_id:randomUUID()});
  const fresh = new MailWatcher(b,renewed,"fresh",async()=>{calls++;});
  await fresh.tick(); assert.equal(calls,0); await fresh.stop();
  const failed = new MailWatcher(b,renewed,"failed",async()=>{throw new Error("no host");},{backlog:true});
  await failed.tick(); assert.equal(a.status(sender,mail.id).state,"accepted");
  assert.equal(b.pendingNotices(renewed,"failed").length,1); assert.equal(b.agent(receiver.name)?.wake_error,"no host");
  await failed.stop();
  const retry = new MailWatcher(b,renewed,"failed",async()=>{calls++;},{backlog:true});
  await retry.tick(); assert.equal(calls,1); await retry.stop();
});

test("workspace isolation, private files, crash presence and whole-thread retention",t=>{
  const {a,b,sender,receiver,root,project} = fixture(t);
  const otherDir=path.join(root,"other"); fs.mkdirSync(otherDir);
  const other=new Store(resolveProject(otherDir,path.join(root,"state"))); t.after(()=>other.close());
  assert.equal(other.peers().length,0);
  assert.equal(fs.statSync(project.directory).mode & 0o777,0o700);
  assert.equal(fs.statSync(project.database).mode & 0o777,0o600);
  const dead=a.register({name:"dead",kind:"pi",session_id:randomUUID(),pid:2147483000});
  assert.equal(a.peers().find(p=>p.name===dead.name)?.online,false);
  const mail=a.send(sender,{to:"receiver",text:"prune",idempotency_key:"prune"}).message;
  b.ack(receiver,[mail.id]); a.run("UPDATE deliveries SET acked_at=0 WHERE message_id=?",mail.id);
  assert.equal(a.prune(30).messages,1); assert.equal(b.peek(receiver).messages.length,0);
  assert.equal(a.status(sender,mail.id).state,"acknowledged"); a.prune(30,true);
  assert.throws(()=>a.status(sender,mail.id),code("MESSAGE_NOT_FOUND"));
});
