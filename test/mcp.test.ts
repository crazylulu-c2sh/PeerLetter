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

const script = fileURLToPath(new URL("../src/stdio.ts",import.meta.url));
async function client(name: string, kind: string, project: string, state: string, extra: string[] = [], expectedReadyError?: string) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [script,"--project",project,"--name",name,"--state",state,...extra], stderr: "pipe" });
  const sdk = new Client({ name: kind, version: "test" });
  let errors = ""; transport.stderr?.on("data",chunk=>{errors+=String(chunk);});
  await sdk.connect(transport);
  async function call(tool: string, args: Record<string,unknown> = {}, meta?: Record<string,unknown>) {
    const response = await sdk.callTool({ name: `peerletter_${tool}`, arguments: args, ...(meta ? {_meta:meta} : {}) });
    const blocks = response.content as {type:string;text?:string}[];
    const value = JSON.parse(blocks.find(b=>b.type==="text")!.text!);
    return { value, error: !!response.isError };
  }
  const ready = await call("whoami");
  if(expectedReadyError) assert.equal(ready.value.error?.code,expectedReadyError);
  else assert.equal(ready.error,false,JSON.stringify(ready.value));
  return { sdk,transport,call,errors:()=>errors };
}

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
