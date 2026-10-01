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
async function client(name: string, kind: string, project: string, state: string, extra: string[] = []) {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [script,"--project",project,"--name",name,"--state",state,...extra], stderr: "pipe" });
  const sdk = new Client({ name: kind, version: "test" });
  let errors = ""; transport.stderr?.on("data",chunk=>{errors+=String(chunk);});
  await sdk.connect(transport);
  async function call(tool: string, args: Record<string,unknown> = {}) {
    const response = await sdk.callTool({ name: `peerletter_${tool}`, arguments: args });
    const blocks = response.content as {type:string;text?:string}[];
    const value = JSON.parse(blocks.find(b=>b.type==="text")!.text!);
    return { value, error: !!response.isError };
  }
  const ready = await call("whoami");
  assert.equal(ready.error,false,JSON.stringify(ready.value));
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
  assert.equal((await codex.sdk.listTools()).tools.length,10);
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
