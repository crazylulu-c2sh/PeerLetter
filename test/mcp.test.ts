import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { startupRegistration } from "../src/runtime.ts";
import { codexDaemon } from "./codex-fixture.ts";

const script = fileURLToPath(new URL("../src/stdio.ts",import.meta.url));
async function client(name: string | undefined, kind: string, project: string, state: string, extra: string[] = [], expectedReadyError?: string, lazy = false, env: Record<string,string> = {}) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [script,"--project",project,...(name ? ["--name",name] : []),"--state",state,...extra], env, stderr: "pipe" });
  const sdk = new Client({ name: kind, version: "test" });
  let errors = ""; transport.stderr?.on("data",chunk=>{errors+=String(chunk);});
  await sdk.connect(transport);
  async function call(tool: string, args: Record<string,unknown> = {}, meta?: Record<string,unknown>) {
    const response = await sdk.callTool({ name: `peerletter_${tool}`, arguments: args, ...(meta ? {_meta:meta} : {}) });
    const blocks = response.content as {type:string;text?:string}[];
    const value = JSON.parse(blocks.find(b=>b.type==="text")!.text!);
    return { value, error: !!response.isError };
  }
  if(!lazy) {
    const ready = await call("whoami");
    if(expectedReadyError) assert.equal(ready.value.error?.code,expectedReadyError);
    else assert.equal(ready.error,false,JSON.stringify(ready.value));
  }
  return { sdk,transport,call,errors:()=>errors };
}

async function eventually(check:()=>boolean, reason:string) {
  for(let i=0;i<200;i++) { if(check()) return; await new Promise(resolve=>setTimeout(resolve,25)); }
  assert.ok(check(),reason);
}

test("startup probe requires opt-in wake and connection-specific identity without reserving names",()=>{
  const session=randomUUID();
  for(const [kind,wake] of [["claude","claude-channel"],["codex","codex-queue"],["pi","pi-extension"]]) {
    assert.equal(startupRegistration(kind,{kind,session},{}).binding,undefined);
    assert.equal(startupRegistration(kind,{kind,session,wake:"none"},{PEERLETTER_WAKE:wake}).binding,undefined);
    assert.equal(startupRegistration(kind,{kind,session,wake},{}).binding?.session_id,session);
    assert.equal(startupRegistration(kind,{kind,session:"runtime:temporary",wake},{}).binding,undefined);
    assert.equal(startupRegistration(kind,{kind,session:"x".repeat(257),wake},{}).binding,undefined);
  }
  assert.equal(startupRegistration("claude",{wake:"claude-channel"},{CLAUDE_CODE_SESSION_ID:session}).binding?.source,"environment");
  assert.equal(startupRegistration("codex",{wake:"codex-queue"},{CODEX_THREAD_ID:session,PEERLETTER_SESSION_ID:session}).binding,undefined);
  assert.equal(startupRegistration("pi",{wake:"claude-channel",session},{}).binding,undefined);
  assert.equal(startupRegistration("claude",{wake:"claude-channel"},{}).binding,undefined);
  assert.equal(startupRegistration("pi",{wake:"pi-extension"},{}).binding,undefined);
});

test("a used Claude host session joins at initialization and wakes without a receiver tool call",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-startup-channel-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state)),session=randomUUID();store.recordUse("claude",session);
  const receiver=await client(undefined,"claude-code",project,state,["--wake","claude-channel"],undefined,true,{CLAUDE_CODE_SESSION_ID:session});
  t.after(async()=>{await receiver.sdk.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const notices:string[]=[];
  receiver.sdk.setNotificationHandler(z.object({method:z.literal("notifications/claude/channel"),params:z.object({content:z.string()})}),n=>{notices.push(n.params.content);});
  await receiver.sdk.listTools();
  const actor=store.agentForSession(session,"claude")!;assert.ok(actor);assert.equal(actor.wake,"claude-channel");
  const sender=store.register({name:"sender",kind:"pi",session_id:randomUUID()});
  store.pause(session,"manual");
  const mail=store.send(sender,{to:actor.name,text:"SECRET-STARTUP-BODY",importance:"high",idempotency_key:"startup"}).message;
  await new Promise(resolve=>setTimeout(resolve,850));assert.equal(notices.length,0);
  store.block(session,"ui",true);store.pause(session,null);
  await new Promise(resolve=>setTimeout(resolve,850));assert.equal(notices.length,0);
  store.block(session,"ui",false);
  await eventually(()=>notices.length===1,"Startup channel must signal before tools/call");
  assert.ok(!notices[0].includes("SECRET-STARTUP-BODY"));assert.match(notices[0],/peerletter_receive/);
  await eventually(()=>store.status(sender,mail.id).state==="notified","Channel notification receipt follows sending the signal");
  assert.equal(store.status(sender,mail.id).state,"notified");assert.equal(store.peek(actor).messages.length,1);
  await new Promise(resolve=>setTimeout(resolve,850));assert.equal(notices.length,1);
  const identity=(await receiver.call("whoami")).value;
  assert.equal(identity.registration.mode,"startup");assert.equal(identity.session_binding.source,"environment");
});

test("Codex explicitly pinned connection queues a body-free wake before any tools/call",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-startup-queue-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const session=randomUUID(),daemon=await codexDaemon(t,root,session);
  const store=new Store(resolveProject(project,state));store.recordUse("codex",session);
  const receiver=await client(undefined,"codex",project,state,["--wake","codex-queue","--session",session],undefined,true,
    {PEERLETTER_CODEX_SOCKET:daemon.socket});
  t.after(async()=>{await receiver.sdk.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  await receiver.sdk.listTools();
  const actor=store.agentForSession(session,"codex")!;assert.ok(actor);
  const sender=store.register({name:"sender",kind:"claude",session_id:randomUUID()});
  const mail=store.send(sender,{to:actor.name,text:"SECRET-QUEUE-BODY",idempotency_key:"queue-startup"}).message;
  await eventually(()=>daemon.queued.length === 1,"Startup must invoke the queue adapter without receiver tool calls");
  const input=daemon.queued[0].input[0].text;
  assert.equal(daemon.calls.find(c=>c.method === "thread/read")!.params.threadId,session);
  assert.match(input,/peerletter_receive/);assert.ok(!input.includes("SECRET-QUEUE-BODY"));
  await eventually(()=>store.status(sender,mail.id).state==="notified","Queue wake must be recorded");
  assert.equal(store.peek(actor).messages.length,1);
  const who=(await receiver.call("whoami",{},{threadId:session})).value;
  assert.equal(who.registration.mode,"startup");assert.equal(who.session_binding.source,"mcp-metadata");
  assert.equal((await receiver.call("whoami",{},{threadId:randomUUID()})).value.error.code,"SESSION_MISMATCH");
  const received=(await receiver.call("receive",{},{threadId:session})).value;
  assert.equal(received.messages[0].id,mail.id);assert.equal(daemon.queued.length,0,"Receive must withdraw pending owned wake before returning");
  assert.equal(store.status(sender,mail.id).state,"delivered");
});

test("overwritten shared-PID Codex hooks and inherited IDs cannot register an unused wake connection",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-startup-ambiguous-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state)),first=randomUUID(),last=randomUUID();
  store.bindSession("codex",process.pid,first);store.bindSession("codex",process.pid,last);
  assert.equal(store.all("SELECT * FROM sessions WHERE kind='codex'").length,1,"A one-row mapping can conceal several threads");
  const receiver=await client(undefined,"codex",project,state,["--wake","codex-queue"],undefined,true,{CODEX_THREAD_ID:last});
  t.after(async()=>{await receiver.sdk.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  await receiver.sdk.listTools();assert.equal(store.peers().length,0);
  const who=(await receiver.call("whoami",{},{threadId:first})).value;
  assert.equal(who.session_id,first);assert.equal(who.registration.mode,"tool-call");assert.equal(who.session_binding.source,"mcp-metadata");
  assert.notEqual(who.session_id,last);
});

test("a wake-enabled host session that never used PeerLetter stays out until its first tool call, then rejoins at startup",{timeout:20000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-startup-unused-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const connections:Awaited<ReturnType<typeof client>>[]=[];let store:Store|undefined;
  t.after(async()=>{await Promise.all(connections.map(c=>c.sdk.close()));store?.close();fs.rmSync(root,{recursive:true,force:true});});
  const open=async(kind:string,extra:string[])=>{const c=await client(undefined,kind,project,state,extra,undefined,true);connections.push(c);await c.sdk.listTools();return c;};
  await open("claude",["--wake","claude-channel","--session",randomUUID()]);
  assert.equal(fs.existsSync(resolveProject(project,state).database),false,"A declined startup must not create the workspace database");
  store=new Store(resolveProject(project,state));
  for(const [kind,wake] of [["claude","claude-channel"],["codex","codex-queue"],["pi","pi-extension"]]) {
    const session=randomUUID(),extra=["--wake",wake,"--session",session];
    const unused=await open(kind,extra);
    assert.equal(store.agentForSession(session,kind),undefined,`${kind} joined without having used PeerLetter`);
    const first=(await unused.call("whoami")).value;
    assert.equal(first.registration.mode,"tool-call");assert.equal(store.usedSession(kind,session),true);
    await unused.sdk.close();
    await open(kind,extra);
    await eventually(()=>!!store!.agentForSession(session,kind),`${kind} must rejoin a used session at startup`);
    assert.equal(store.agentForSession(session,kind)!.name,first.name);
  }
});

test("wake without a usable startup identity stays lazy for every client",{timeout:15000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-startup-deferred-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state)),connections:Awaited<ReturnType<typeof client>>[]=[];
  t.after(async()=>{await Promise.all(connections.map(c=>c.sdk.close()));store.close();fs.rmSync(root,{recursive:true,force:true});});
  for(const [kind,wake] of [["claude","claude-channel"],["codex","codex-queue"],["pi","pi-extension"]]) {
    for(const session of [undefined,"runtime:unknown","x".repeat(257)]) {
      const receiver=await client(undefined,kind,project,state,["--wake",wake,...(session?["--session",session]:[])],undefined,true);connections.push(receiver);
      await receiver.sdk.listTools();assert.equal(store.peers().length,0);
    }
  }
});

test("startup identity preserves names, separate inboxes, persisted pauses and shutdown ownership",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-startup-resume-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state)),session=randomUUID(),connections:Awaited<ReturnType<typeof client>>[]=[];
  t.after(async()=>{await Promise.all(connections.map(c=>c.sdk.close()));store.close();fs.rmSync(root,{recursive:true,force:true});});
  const open=async(id:string)=>{store.recordUse("claude",id);const c=await client(undefined,"claude",project,state,["--wake","claude-channel","--session",id],undefined,true);connections.push(c);await c.sdk.listTools();return c;};
  const first=await open(session),actor=store.agentForSession(session,"claude")!;assert.ok(actor);
  const sender=store.register({name:"sender",kind:"pi",session_id:randomUUID()});store.pause(session,"manual");
  const mail=store.send(sender,{to:actor.name,text:"private original inbox",idempotency_key:"original-startup"}).message;
  store.leaseClaim(actor,["source/**"]);await first.sdk.close();
  assert.equal(store.agent(actor.name)?.online,0);assert.equal(store.leaseList().length,0);
  const different=randomUUID();await open(different);
  const other=store.agentForSession(different,"claude")!;assert.notEqual(other.name,actor.name);assert.equal(store.peek(other).messages.length,0);
  await open(session);const resumed=store.agentForSession(session,"claude")!;
  assert.equal(resumed.name,actor.name);assert.equal(store.gate(session).pause_reason,"manual");assert.equal(store.peek(resumed).messages[0].id,mail.id);
  store.closeAgent(actor);assert.equal(store.agent(resumed.name)?.online,1,"A stale owner cannot close the startup replacement");
});

test("startup name/session collisions keep original errors and retry when the owner disconnects",{timeout:15000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-startup-conflict-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state)),connections:Awaited<ReturnType<typeof client>>[]=[];
  t.after(async()=>{await Promise.all(connections.map(c=>c.sdk.close()));store.close();fs.rmSync(root,{recursive:true,force:true});});
  for(const name of ["role",undefined]) {
    const session=randomUUID(),extra=["--wake","claude-channel","--session",session];store.recordUse("claude",session);
    const owner=await client(name,"claude",project,state,extra,undefined,true);connections.push(owner);await owner.sdk.listTools();
    const original=store.agentForSession(session,"claude")!;assert.ok(original);
    const duplicate=await client(name,"claude",project,state,extra,undefined,true);connections.push(duplicate);await duplicate.sdk.listTools();
    const failure=await duplicate.call("whoami");assert.equal(failure.value.error.code,name?"NAME_IN_USE":"SESSION_IN_USE");
    assert.equal(store.agent(original.name)?.runtime_id,original.runtime_id);
    await owner.sdk.close();
    await eventually(()=>store.agent(original.name)?.online===1 && store.agent(original.name)?.runtime_id!==original.runtime_id,"Eligible startup retries without taking ownership from a live runtime");
    const joined=(await duplicate.call("whoami")).value;assert.equal(joined.name,original.name);assert.equal(joined.registration.mode,"startup");
    await duplicate.sdk.close();
  }
});

test("wake=none leaves known host sessions unregistered until tools/call",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-manual-known-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state)),connections:Awaited<ReturnType<typeof client>>[]=[];
  t.after(async()=>{await Promise.all(connections.map(c=>c.sdk.close()));store.close();fs.rmSync(root,{recursive:true,force:true});});
  for(const kind of ["claude","codex","pi"]) {
    const session=randomUUID(),c=await client(undefined,kind,project,state,["--session",session,"--wake","none"],undefined,true);connections.push(c);
    await c.sdk.listTools();assert.equal(store.agentForSession(session,kind),undefined);
    const identity=(await c.call("whoami")).value;assert.equal(identity.registration.mode,"tool-call");assert.equal(identity.session_id,session);
  }
});

test("a new startup role owner skips old backlog but leaves it available to receive",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-startup-backlog-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state));store.cliActor("role");
  const sender=store.register({name:"sender",kind:"pi",session_id:randomUUID()});
  const old=store.send(sender,{to:"role",text:"OLD-BODY",idempotency_key:"old-backlog"}).message;
  const session=randomUUID();store.recordUse("claude",session);
  const receiver=await client("role","claude",project,state,["--session",session,"--wake","claude-channel"],undefined,true);
  t.after(async()=>{await receiver.sdk.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const notices:string[]=[];
  receiver.sdk.setNotificationHandler(z.object({method:z.literal("notifications/claude/channel"),params:z.object({content:z.string()})}),n=>{notices.push(n.params.content);});
  await receiver.sdk.listTools();await new Promise(resolve=>setTimeout(resolve,850));assert.equal(notices.length,0);
  assert.equal(store.status(sender,old.id).state,"accepted");
  const fresh=store.send(sender,{to:"role",text:"NEW-BODY",idempotency_key:"fresh-startup"}).message;
  await eventually(()=>notices.length===1,"Fresh mail must wake the new startup owner");
  assert.match(notices[0],/1 new message/);assert.ok(!notices[0].includes("NEW-BODY"));
  await eventually(()=>store.status(sender,fresh.id).state==="notified","The notification receipt is written after sending the signal");
  assert.equal(store.status(sender,fresh.id).state,"notified");
  const mail=(await receiver.call("receive")).value;assert.deepEqual(mail.messages.map((m:any)=>m.id),[old.id,fresh.id]);
});

test("initialize and tools/list never register unused clients or reserve fixed names",{timeout:20000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-lazy-"));const project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state));const clients: Awaited<ReturnType<typeof client>>[]=[];
  t.after(async()=>{await Promise.all(clients.map(c=>c.sdk.close()));store.close();fs.rmSync(root,{recursive:true,force:true});});
  for(const kind of ["codex","claude","pi"]) {
    const name=`fixed-${kind}`;
    const unused=await client(name,kind,project,state,[],undefined,true);clients.push(unused);
    assert.equal((await unused.sdk.listTools()).tools.length,11);
    assert.equal(store.agent(name),undefined);
    const active=await client(name,kind,project,state,[],undefined,true);clients.push(active);
    const thread=randomUUID(),meta=kind === "codex" ? {threadId:thread,sessionId:randomUUID()} : undefined;
    const identity=await active.call("whoami",{},meta);
    assert.equal(identity.error,false);assert.equal(identity.value.name,name);
    if(meta) {assert.equal(identity.value.session_id,thread);assert.equal(identity.value.session_binding.source,"mcp-metadata");}
    const owner=store.agent(name)!.runtime_id;
    assert.equal((await unused.call("whoami")).value.error.code,"NAME_IN_USE");
    assert.equal(store.agent(name)?.runtime_id,owner);
    await active.sdk.close();
    const joined=await unused.call("whoami");assert.equal(joined.error,false,"Registration failure is retryable after the owner disconnects");
    await unused.sdk.close();
  }
});

test("native first-call identity reuses a resumed Codex name and isolates other threads",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-resume-"));const project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state));const clients: Awaited<ReturnType<typeof client>>[]=[];
  t.after(async()=>{await Promise.all(clients.map(c=>c.sdk.close()));store.close();fs.rmSync(root,{recursive:true,force:true});});
  const open=async()=>{const c=await client(undefined,"codex",project,state,[],undefined,true);clients.push(c);return c;};
  const thread=randomUUID(),first=await open();
  const name=(await first.call("whoami",{},{threadId:thread})).value.name;
  const sender=store.register({name:"sender",kind:"claude",session_id:randomUUID()});
  const mail=store.send(sender,{to:name,text:"for original thread",idempotency_key:"original"}).message;
  await first.sdk.close();
  const other=await open();const different=(await other.call("whoami",{},{threadId:randomUUID()})).value;
  assert.notEqual(different.name,name);assert.equal((await other.call("receive")).value.messages.length,0);
  const resumed=await open();const identity=(await resumed.call("whoami",{},{threadId:thread})).value;
  assert.equal(identity.name,name);assert.equal((await resumed.call("receive")).value.messages[0].id,mail.id);
  const duplicate=await open();assert.equal((await duplicate.call("whoami",{},{threadId:thread})).value.error.code,"SESSION_IN_USE");
  assert.equal(store.peers().filter(p=>p.kind === "codex").length,2);
});

test("invalid Codex metadata cannot claim a name and direct recovery binds before registration",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-first-id-"));const project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state));const clients: Awaited<ReturnType<typeof client>>[]=[];
  t.after(async()=>{await Promise.all(clients.map(c=>c.sdk.close()));store.close();fs.rmSync(root,{recursive:true,force:true});});
  const first=await client(undefined,"codex",project,state,[],undefined,true);clients.push(first);
  assert.equal((await first.call("whoami",{},{threadId:"not-a-uuid"})).value.error.code,"INVALID_THREAD_ID");
  assert.equal(store.peers().length,0);
  const thread=randomUUID();const recovered=await first.call("bind_session",{session_id:thread});
  assert.equal(recovered.error,false);assert.equal(recovered.value.session_id,thread);assert.equal(recovered.value.session_binding.source,"self-binding");
  const name=recovered.value.name;await first.sdk.close();
  const resumed=await client(undefined,"codex",project,state,[],undefined,true);clients.push(resumed);
  assert.equal((await resumed.call("bind_session",{session_id:thread})).value.name,name);
  assert.equal((await resumed.call("whoami",{},{threadId:randomUUID()})).value.error.code,"SESSION_MISMATCH");
  assert.equal(store.agent(name)?.session_id,thread,"Native metadata must not switch an already bound session's mailbox");
});

test("a changed host hook identity requires reconnecting and preserves automatic mailbox isolation",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-host-change-"));const project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state)),session=randomUUID();
  store.bindSession("claude",process.pid,session);
  const first=await client(undefined,"claude",project,state,[],undefined,true);
  let next: Awaited<ReturnType<typeof client>> | undefined;
  t.after(async()=>{await first.sdk.close();await next?.sdk.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const identity=(await first.call("whoami")).value;assert.equal(identity.session_id,session);
  const sender=store.register({name:"sender",kind:"pi",session_id:randomUUID()});
  store.send(sender,{to:identity.name,text:"private old session",idempotency_key:"old-host"});
  store.bindSession("claude",process.pid,randomUUID());
  assert.equal((await first.call("receive")).value.error.code,"SESSION_MISMATCH");
  assert.equal(store.agent(identity.name)?.session_id,session);
  await first.sdk.close();next=await client(undefined,"claude",project,state,[],undefined,true);
  assert.notEqual((await next.call("whoami")).value.name,identity.name);
  assert.equal((await next.call("receive")).value.messages.length,0);
});

test("three real stdio MCP processes share mail, identity, concurrent writes and ACK",{timeout:20000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-mcp-"));
  const project=path.join(root,"project"),state=path.join(root,"state"); fs.mkdirSync(project);
  const codex=await client("codex-review","codex",project,state);
  const claude=await client("claude-build","claude-code",project,state);
  const pi=await client("pi-check","pi",project,state);
  t.after(async()=>{await Promise.all([codex.sdk.close(),claude.sdk.close(),pi.sdk.close()]);fs.rmSync(root,{recursive:true,force:true});});
  const who=(await codex.call("whoami")).value;
  assert.equal(who.name,"codex-review");assert.equal(who.kind,"codex");assert.equal(who.project,project);
  assert.equal((await pi.call("peers")).value.peers.filter((p:any)=>p.online).length,3);
  assert.equal((await codex.sdk.listTools()).tools.length,11);
  const pending=claude.call("receive",{wait_ms:3000});
  const send=(await codex.call("send",{to:"claude-build",text:"implementation ready",idempotency_key:"handoff"})).value;
  assert.equal((await pending).value.messages[0].id,send.message.id);
  assert.equal((await codex.call("status",{message_id:send.message.id})).value.state,"delivered");
  const duplicate=await codex.call("send",{to:"claude-build",text:"implementation ready",idempotency_key:"handoff"});
  assert.equal(duplicate.value.duplicate,true);
  const forbidden=await pi.call("ack",{message_ids:[send.message.id]}); assert.equal(forbidden.error,true);
  const reply=(await claude.call("send",{to:"codex-review",text:"checked",reply_to:send.message.id,idempotency_key:"reply"})).value;
  assert.equal(reply.message.thread_id,send.message.thread_id);
  await claude.call("ack",{message_ids:[send.message.id]});
  assert.equal((await codex.call("status",{message_id:send.message.id})).value.state,"acknowledged");
  const sends=Array.from({length:30},(_,i)=> (i%2?claude:codex).call("send",{to:"pi-check",text:`parallel-${i}`,idempotency_key:`parallel-${i}`}));
  const results=await Promise.all(sends);assert.ok(results.every(r=>!r.error));
  const first=(await pi.call("receive")).value;assert.equal(first.messages.length,20);assert.equal(first.has_more,true);
  const second=(await pi.call("receive",{after_id:first.next_after_id})).value;assert.equal(second.messages.length,10);
  assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,30);
  await pi.call("ack",{message_ids:[...first.messages,...second.messages].map(m=>m.id)});
  assert.equal((await pi.call("peek")).value.unacknowledged_count,0);
  assert.ok(!codex.errors().includes("SQLITE_BUSY"));
});

test("Codex request metadata binds the actual thread without environment or trusted hooks",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-binding-"));const project=path.join(root,"project");fs.mkdirSync(project);
  const state=path.join(root,"state"),thread=randomUUID(),rootSession=randomUUID();
  const codex=await client("codex","codex",project,state),sender=await client("claude","claude",project,state);
  const store=new Store(resolveProject(project,state));
  t.after(async()=>{await codex.sdk.close();await sender.sdk.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const fallback=(await codex.call("whoami")).value;
  assert.equal(fallback.session_binding.state,"unbound");
  assert.equal(store.all("SELECT * FROM sessions WHERE kind='codex'").length,0,"An unbound runtime must not seed a fake Codex session mapping");
  store.pause(fallback.session_id,"manual");
  const lease=store.leaseClaim(store.agent("codex")!,["src/**"]);
  await sender.call("send",{to:"codex",text:"arrived before binding",idempotency_key:"before-binding"});
  const bound=(await codex.call("whoami",{},{threadId:thread,sessionId:rootSession})).value;
  assert.equal(bound.session_id,thread,"Use threadId, not a fork's root sessionId");
  assert.equal(bound.session_binding.source,"mcp-metadata");assert.equal(bound.session_binding.state,"bound");
  assert.equal(bound.delivery_gate.pause_reason,"manual");
  assert.equal(store.leaseList().find(l=>l.id===lease.id)?.owner_session,thread);
  store.pause(thread,null);
  assert.equal(store.pendingNotices(store.agent("codex")!,"test",store.noticeBaseline(store.agent("codex")!)).length,1);
  assert.equal((await codex.call("receive",{},{threadId:thread})).value.messages.length,1);
  assert.equal((await codex.call("bind_session",{session_id:thread},{threadId:thread})).value.session_binding.source,"mcp-metadata");
  assert.equal((await codex.call("whoami",{},{threadId:randomUUID()})).value.error.code,"SESSION_MISMATCH");
});

test("explicit Codex self-binding recovers older clients and rejects changing a bound thread",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-self-bind-"));const project=path.join(root,"project");fs.mkdirSync(project);
  const codex=await client("codex","codex",project,path.join(root,"state"));
  t.after(async()=>{await codex.sdk.close();fs.rmSync(root,{recursive:true,force:true});});
  const thread=randomUUID();
  const result=await codex.call("bind_session",{session_id:thread});
  assert.equal(result.error,false);assert.equal(result.value.session_id,thread);assert.equal(result.value.session_binding.source,"self-binding");
  assert.equal((await codex.call("bind_session",{session_id:thread})).error,false);
  assert.equal((await codex.call("bind_session",{session_id:randomUUID()})).value.error.code,"SESSION_MISMATCH");
});

test("duplicate online names report NAME_IN_USE through MCP instead of NOT_READY",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-name-error-"));const project=path.join(root,"project");fs.mkdirSync(project);
  const state=path.join(root,"state");
  const owner=await client("same-name","codex",project,state);
  const duplicate=await client("same-name","codex",project,state,[],"NAME_IN_USE");
  t.after(async()=>{await owner.sdk.close();await duplicate.sdk.close();fs.rmSync(root,{recursive:true,force:true});});
  const result=await duplicate.call("receive");
  assert.equal(result.error,true);assert.equal(result.value.error.code,"NAME_IN_USE");
  assert.match(result.value.error.message,/different name/);
  assert.equal((await owner.call("whoami")).value.name,"same-name");
});

test("Claude channel notification is body-free and pause blocks high priority",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-channel-"));const project=path.join(root,"project");fs.mkdirSync(project);
  const state=path.join(root,"state"),session=randomUUID();
  const claude=await client("claude","claude-code",project,state,["--wake","claude-channel","--session",session]);
  const sender=await client("codex","codex",project,state);
  const store=new Store(resolveProject(project,state));
  t.after(async()=>{await claude.sdk.close();await sender.sdk.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const notices: string[]=[];
  claude.sdk.setNotificationHandler(z.object({method:z.literal("notifications/claude/channel"),params:z.object({content:z.string()})}),n=>{notices.push(n.params.content);});
  assert.ok(claude.sdk.getServerCapabilities()?.experimental?.["claude/channel"]);
  store.pause(session,"manual");
  const sent=(await sender.call("send",{to:"claude",text:"DO-NOT-INJECT-THIS",importance:"high",idempotency_key:"channel"})).value;
  await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(notices.length,0);
  store.pause(session,null);
  for(let i=0;i<30&&!notices.length;i++)await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(notices.length,1);assert.ok(!notices[0].includes("DO-NOT-INJECT-THIS"));
  await eventually(()=>store.status(store.agent("codex")!,sent.message.id).state==="notified","Wait for the notification receipt after the channel frame arrives");
  assert.equal((await sender.call("status",{message_id:sent.message.id})).value.state,"notified");
  assert.equal((await claude.call("receive")).value.messages.length,1);
});

test("SIGKILL presence cleanup, durable unread mail and clean EOF shutdown",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-crash-"));const project=path.join(root,"project");fs.mkdirSync(project);
  const state=path.join(root,"state");
  const a=await client("a","codex",project,state),b=await client("b","claude",project,state);
  const store=new Store(resolveProject(project,state));
  let replacement: Awaited<ReturnType<typeof client>> | undefined;
  t.after(async()=>{await a.sdk.close();await b.sdk.close();await replacement?.sdk.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const sent=(await a.call("send",{to:"b",text:"survive crash",idempotency_key:"durable"})).value;
  const pid=store.agent("b")!.pid!;process.kill(pid,"SIGKILL");
  for(let i=0;i<20&&store.peers().find(p=>p.name==="b")?.online;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(store.peers().find(p=>p.name==="b")?.online,false);
  replacement=await client("b","claude",project,state);
  assert.equal((await replacement.call("receive")).value.messages[0].id,sent.message.id);
  await replacement.sdk.close();
  for(let i=0;i<20&&store.peers().find(p=>p.name==="b")?.online;i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(store.peers().find(p=>p.name==="b")?.online,false);
});
