import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installation, mergeHooks, mergeToml, quoteShell, writeWithBackup } from "../scripts/install.ts";
import { Store } from "../src/store.ts";
import { locateProject, resolveProject } from "../src/project.ts";
import piExtension from "../pi/peerletter.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo=fileURLToPath(new URL("../",import.meta.url));
function temp(t:test.TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-integration-"));
  const project=path.join(root,"project");fs.mkdirSync(project);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,project};
}

test("project installer preserves other settings, is repeatable and creates private backups",t=>{
  const {project}=temp(t);
  fs.mkdirSync(path.join(project,".codex"));fs.mkdirSync(path.join(project,".claude"));
  const toml="# user's comment\nmodel = 'custom'\n[mcp_servers.other]\ncommand = 'other'\n";
  fs.writeFileSync(path.join(project,".codex/config.toml"),toml);
  fs.writeFileSync(path.join(project,".mcp.json"),JSON.stringify({mcpServers:{other:{command:"other"}}}));
  fs.writeFileSync(path.join(project,".claude/settings.local.json"),JSON.stringify({permissions:{allow:["Bash(ls:*)"]},hooks:{Stop:[{hooks:[{type:"command",command:"original"}]}]}}));
  const first=installation(project);
  assert.ok(first.writes.find(w=>w.file.endsWith("config.toml"))!.data.startsWith(toml));
  assert.equal(JSON.parse(first.writes.find(w=>w.file.endsWith(".mcp.json"))!.data).mcpServers.other.command,"other");
  for(const w of first.writes) {
    const backup=writeWithBackup(w.file,w.data);
    if(w.file.endsWith("config.toml")) {assert.ok(backup);assert.equal(fs.readFileSync(backup!,"utf8"),toml);assert.equal(fs.statSync(backup!).mode & 0o777,0o600);}
  }
  const settings=JSON.parse(fs.readFileSync(path.join(project,".claude/settings.local.json"),"utf8"));
  assert.deepEqual(settings.permissions.allow,["Bash(ls:*)"]);assert.equal(settings.hooks.Stop[0].hooks[0].command,"original");
  assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.endsWith("claude"));
  const again=installation(project);
  assert.ok(again.writes.every(w=>fs.readFileSync(w.file,"utf8")===w.data));
  assert.throws(()=>mergeToml("[mcp_servers.peerletter]\ncommand='custom'\n",""));
  assert.equal(mergeHooks(settings,"claude",process.execPath,repo).hooks.Stop.length,2);
  const extension=installation(project,{client:"pi",piMode:"extension"});
  const mcp=extension.writes.find(w=>w.file.endsWith("mcp.json"))!;
  assert.equal(JSON.parse(mcp.data).mcpServers.peerletter,undefined);
  assert.ok(extension.writes.find(w=>w.file.endsWith("settings.json"))!.data.includes("pi/peerletter.ts"));
  assert.throws(()=>installation(project,{client:"pi",piMode:"extension",name:"pi-role"}),/PEERLETTER_NAME/);
});

test("Claude PostToolUse injects a single body-free notice while work continues",t=>{
  const {root,project}=temp(t);const state=path.join(root,"state"),session=randomUUID();
  const store=new Store(resolveProject(project,state));t.after(()=>store.close());
  const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
  const receiver=store.register({name:"receiver",kind:"claude",session_id:session});
  const mail=store.send(sender,{to:"receiver",text:"PRIVATE-BODY",idempotency_key:"mid-turn"}).message;
  const hook=(event:string)=>execFileSync(process.execPath,[path.join(repo,"hooks/hook.ts"),"claude"],
    {env:{...process.env,PEERLETTER_STATE_DIR:state},input:JSON.stringify({session_id:session,cwd:project,hook_event_name:event}),encoding:"utf8"});
  const output=hook("PostToolUse"),notice=JSON.parse(output).hookSpecificOutput;
  assert.equal(notice.hookEventName,"PostToolUse");assert.match(notice.additionalContext,/peerletter_receive/);assert.ok(!output.includes("PRIVATE-BODY"));
  assert.equal(hook("PostToolUse"),"");assert.equal(hook("Stop"),"");
  assert.equal(store.status(sender,mail.id).state,"notified");assert.equal(store.peek(receiver).messages.length,1);
});

test("prepared wrapper executes even with shell punctuation in project/output paths",t=>{
  const {root,project}=temp(t);const odd=path.join(project,"x ' $(touch bad) `name`");fs.mkdirSync(odd);
  const output=path.join(odd,"output");
  const env={...process.env,PEERLETTER_STATE_DIR:path.join(root,"state")};
  execFileSync(process.execPath,[path.join(repo,"scripts/prepare.ts"),"--project",odd,"--output",output],{env});
  const result=JSON.parse(execFileSync(path.join(output,"peerletter"),["--name","test","register"],{env,encoding:"utf8"}));
  assert.equal(result.project,odd);assert.equal(result.name,"test");
  assert.equal(fs.existsSync(path.join(project,"bad")),false);
  assert.ok(quoteShell(odd).startsWith("'"));
});

test("hook Stop signals once without body or ACK and suppresses loops and pause",t=>{
  const {root,project}=temp(t);const state=path.join(root,"state"),session=randomUUID();
  const store=new Store(resolveProject(project,state));t.after(()=>store.close());
  const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
  const receiver=store.register({name:"receiver",kind:"claude",session_id:session});
  const mail=store.send(sender,{to:"receiver",text:"BODY-MUST-STAY-OUT",idempotency_key:"hook"}).message;
  const hook=(event:string,extra:Record<string,unknown>={})=>execFileSync(process.execPath,[path.join(repo,"hooks/hook.ts"),"claude"],
    {env:{...process.env,PEERLETTER_STATE_DIR:state},input:JSON.stringify({session_id:session,cwd:project,hook_event_name:event,...extra}),encoding:"utf8"});
  assert.equal(hook("Stop",{stop_hook_active:true}),"");
  store.pause(session,"manual");assert.equal(hook("Stop"),"");store.pause(session,null);
  const signal=hook("Stop");assert.equal(JSON.parse(signal).decision,"block");assert.ok(!signal.includes("BODY-MUST-STAY-OUT"));
  assert.equal(hook("Stop"),"");assert.equal(hook("PostToolUse"),"");
  assert.equal(store.status(sender,mail.id).state,"notified");assert.equal(store.peek(receiver).messages.length,1);
  hook("StopFailure");assert.equal(store.gate(session).pause_reason,"provider_error");
  hook("UserPromptSubmit");assert.equal(store.gate(session).state,"ready");
});

test("Pi extension binds one MCP identity, respects manual/UI/abort gates and closes on reload",async t=>{
  const {root,project}=temp(t);const state=path.join(root,"state"),session=randomUUID();
  const oldState=process.env.PEERLETTER_STATE_DIR;process.env.PEERLETTER_STATE_DIR=state;
  t.after(()=>{if(oldState===undefined)delete process.env.PEERLETTER_STATE_DIR;else process.env.PEERLETTER_STATE_DIR=oldState;});
  const handlers=new Map<string,Function>(),commands=new Map<string,any>(),registrations:any[]=[],notices:any[]=[];
  let unregistered=0;
  const pi={on:(event:string,handler:Function)=>{handlers.set(event,handler);},registerCommand:(name:string,command:any)=>commands.set(name,command),
    registerMcpServer:(name:string,config:any)=>{registrations.push({name,config});},unregisterMcpServer:()=>{unregistered++;},
    sendMessage:(message:any,options:any)=>{notices.push({message,options});}};
  const ctx={cwd:project,mode:"print",sessionManager:{getSessionId:()=>session},isIdle:()=>true,
    ui:{setStatus:()=>{},notify:()=>{}}} as unknown as ExtensionContext;
  piExtension(pi as unknown as ExtensionAPI);
  await handlers.get("session_start")!({},ctx);
  const store=new Store(resolveProject(project,state));t.after(()=>store.close());
  assert.equal(registrations.length,1);assert.ok(registrations[0].config.args.includes(session));
  assert.equal(store.peers().length,0,"The extension does not register a second participant");
  const receiver=store.register({name:"pi",kind:"pi",session_id:session,host_pid:process.pid});
  const sender=store.register({name:"codex",kind:"codex",session_id:randomUUID()});
  await commands.get("peerletter").handler("pause",ctx);
  const mail=store.send(sender,{to:"pi",text:"HIDDEN",importance:"high",idempotency_key:"pi"}).message;
  await new Promise(resolve=>setTimeout(resolve,850));assert.equal(notices.length,0);
  await handlers.get("ui_prompt_start")!({});
  await commands.get("peerletter").handler("resume",ctx);assert.equal(notices.length,0);
  await handlers.get("ui_prompt_end")!({});assert.equal(notices.length,1);
  assert.equal(notices[0].options.triggerTurn,true);assert.ok(!notices[0].message.content.includes("HIDDEN"));
  assert.equal(store.status(sender,mail.id).state,"notified");assert.equal(store.peek(receiver).messages.length,1);
  await handlers.get("agent_before_settle")!({outcome:"aborted"});assert.equal(store.gate(session).pause_reason,"user_abort");
  await handlers.get("input")!({source:"extension"});assert.equal(store.gate(session).pause_reason,"user_abort");
  await handlers.get("input")!({source:"interactive"});assert.equal(store.gate(session).state,"ready");
  await handlers.get("session_shutdown")!({reason:"reload"});assert.ok(unregistered >= 2);
  assert.equal(store.agent(receiver.name)?.online,0);
});

test("Pi extension reads no terminal input and injects nothing while the current run is aborting",{timeout:10000},async t=>{
  const {root,project}=temp(t);const state=path.join(root,"state"),session=randomUUID();
  const oldState=process.env.PEERLETTER_STATE_DIR;process.env.PEERLETTER_STATE_DIR=state;
  t.after(()=>{if(oldState===undefined)delete process.env.PEERLETTER_STATE_DIR;else process.env.PEERLETTER_STATE_DIR=oldState;});
  const store=new Store(resolveProject(project,state));t.after(()=>store.close());
  const handlers=new Map<string,Function>(),notices:any[]=[];let inputListeners=0,signal:AbortSignal|undefined;
  const pi={on:(event:string,handler:Function)=>{handlers.set(event,handler);},registerCommand:()=>{},registerMcpServer:()=>{},
    unregisterMcpServer:()=>{},sendMessage:(message:any)=>{notices.push(message);}};
  const ctx={cwd:project,mode:"tui",sessionManager:{getSessionId:()=>session},isIdle:()=>false,get signal(){return signal;},
    ui:{setStatus:()=>{},notify:()=>{},onTerminalInput:()=>{inputListeners++;return ()=>{};}}} as unknown as ExtensionContext;
  piExtension(pi as unknown as ExtensionAPI);
  await handlers.get("session_start")!({},ctx);
  assert.equal(inputListeners,0,"The extension must not observe terminal input");
  store.register({name:"pi",kind:"pi",session_id:session,host_pid:process.pid});
  const sender=store.register({name:"codex",kind:"codex",session_id:randomUUID()});
  const run=new AbortController();signal=run.signal;run.abort();
  store.send(sender,{to:"pi",text:"HIDDEN",idempotency_key:"aborting"});
  await new Promise(resolve=>setTimeout(resolve,850));assert.equal(notices.length,0,"No notice while the user's abort settles");
  await handlers.get("agent_before_settle")!({outcome:"aborted"});assert.equal(store.gate(session).pause_reason,"user_abort");
  signal=undefined;await handlers.get("input")!({source:"interactive"});await handlers.get("ui_prompt_end")!({});
  assert.equal(notices.length,1);assert.ok(!notices[0].content.includes("HIDDEN"));
  await handlers.get("session_shutdown")!({reason:"quit"});
});

function piRig(t:test.TestContext,project:string,state:string) {
  const oldState=process.env.PEERLETTER_STATE_DIR;process.env.PEERLETTER_STATE_DIR=state;
  t.after(()=>{if(oldState===undefined)delete process.env.PEERLETTER_STATE_DIR;else process.env.PEERLETTER_STATE_DIR=oldState;});
  const handlers=new Map<string,Function>(),notices:any[]=[],closing:Promise<void>[]=[];
  const connections:{sdk:Client;ready:Promise<void>}[]=[];
  let active:typeof connections[number] | undefined;
  const pi={on:(event:string,handler:Function)=>{handlers.set(event,handler);},registerCommand:()=>{},
    registerMcpServer:(_:string,config:any)=>{
      const sdk=new Client({name:"pi",version:"test"});
      const transport=new StdioClientTransport({...config,env:{PEERLETTER_STATE_DIR:state},stderr:"pipe"});
      const connection={sdk,ready:sdk.connect(transport)};active=connection;connections.push(connection);
    },
    unregisterMcpServer:()=>{const previous=active;active=undefined;if(previous)closing.push(previous.ready.then(()=>previous.sdk.close()));},
    sendMessage:(message:any)=>{notices.push(message);}};
  piExtension(pi as unknown as ExtensionAPI);
  const ctx=(session:string)=>({cwd:project,mode:"print",sessionManager:{getSessionId:()=>session},isIdle:()=>true,
    ui:{setStatus:()=>{},notify:()=>{}}}) as unknown as ExtensionContext;
  async function start(reason:string,session:string) {
    await handlers.get("session_start")!({reason},ctx(session));
    const connection=connections.at(-1)!;await connection.ready;
    assert.equal((await connection.sdk.listTools()).tools.length,12);
    return connection.sdk;
  }
  async function call(sdk:Client,tool:string,args:Record<string,unknown>={}) {
    const reply=await sdk.callTool({name:`peerletter_${tool}`,arguments:args});
    assert.notEqual(reply.isError,true,JSON.stringify(reply));
    return JSON.parse((reply.content as {text:string}[])[0].text);
  }
  async function shutdown(reason:string) {await handlers.get("session_shutdown")!({reason});}
  async function cleanup() {
    await shutdown("quit");await Promise.all(closing);
    await Promise.all(connections.map(async c=>{await c.ready;await c.sdk.close();}));
  }
  return {start,call,shutdown,cleanup,handlers,notices,closing};
}

test("Pi startup wakes without tools/call and keeps UI and compaction gates",{timeout:10000},async t=>{
  const {root,project}=temp(t),state=path.join(root,"state"),session=randomUUID();
  const rig=piRig(t,project,state),store=new Store(resolveProject(project,state));store.recordUse("pi",session);
  try {
    const sdk=await rig.start("startup",session),receiver=store.agentForSession(session,"pi")!;
    assert.ok(receiver);assert.equal(receiver.host_pid,process.pid);
    const sender=store.register({name:"sender",kind:"claude",session_id:randomUUID()});
    await rig.handlers.get("ui_prompt_start")!({});await rig.handlers.get("session_before_compact")!({});
    const mail=store.send(sender,{to:receiver.name,text:"SECRET-PI-STARTUP",importance:"high",idempotency_key:"startup-pi"}).message;
    await new Promise(resolve=>setTimeout(resolve,850));assert.equal(rig.notices.length,0);
    await rig.handlers.get("ui_prompt_end")!({});assert.equal(rig.notices.length,0);
    await rig.handlers.get("session_compact")!({});assert.equal(rig.notices.length,1);
    assert.ok(!rig.notices[0].content.includes("SECRET-PI-STARTUP"));assert.match(rig.notices[0].content,/peerletter_receive/);
    assert.equal(store.status(sender,mail.id).state,"notified");assert.equal(store.peek(receiver).messages.length,1);
    assert.equal((await rig.call(sdk,"whoami")).registration.mode,"startup");
    await rig.handlers.get("ui_prompt_end")!({});assert.equal(rig.notices.length,1);
  } finally {await rig.cleanup();store.close();}
});

test("Pi extension /new isolates mail and leases and waits for use; resume reuses the real session's name",{timeout:15000},async t=>{
  const {root,project}=temp(t),state=path.join(root,"state"),session=randomUUID();
  const rig=piRig(t,project,state),store=new Store(resolveProject(project,state));store.recordUse("pi",session);
  try {
    const first=await rig.start("startup",session);
    assert.equal(store.peers().length,1,"A used session-bound wake MCP must join at startup without tools/call");
    const original=await rig.call(first,"whoami");
    assert.equal(original.session_id,session);assert.equal(original.session_binding.state,"bound");
    const actor=store.agent(original.name)!;assert.equal(actor.host_pid,process.pid);
    const lease=await rig.call(first,"lease_claim",{globs:["src/**"]});
    const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
    const mail=store.send(sender,{to:original.name,text:"belongs to original session",idempotency_key:"pi-original"}).message;
    store.pause(session,"manual");
    await rig.shutdown("new");
    assert.equal(store.agent(original.name)?.online,0);assert.equal(store.leaseList().some(l=>l.id===lease.id),false);
    assert.equal(store.sessionFor("pi",[process.pid]),undefined,"A closed adapter must not leave a stale host mapping");
    const nextSession=randomUUID(),next=await rig.start("new",nextSession);
    assert.equal(store.peers().filter(p=>p.kind === "pi" && p.online).length,0,"A new session that never used PeerLetter waits for its first tool call");
    const nextIdentity=await rig.call(next,"whoami");
    assert.notEqual(nextIdentity.name,original.name);assert.equal(nextIdentity.session_id,nextSession);
    assert.equal(nextIdentity.registration.mode,"tool-call");
    assert.equal((await rig.call(next,"receive")).messages.length,0);
    await rig.handlers.get("ui_prompt_end")!({});assert.equal(rig.notices.length,0);
    assert.equal(store.status(sender,mail.id).state,"accepted");
    await rig.shutdown("resume");const resumed=await rig.start("resume",session);
    const resumedIdentity=await rig.call(resumed,"whoami");
    assert.equal(resumedIdentity.name,original.name);assert.equal(resumedIdentity.registration.mode,"startup");assert.equal(resumedIdentity.delivery_gate.pause_reason,"manual");
    assert.equal((await rig.call(resumed,"receive")).messages[0].id,mail.id);
    await Promise.all(rig.closing);
    assert.equal(store.agent(original.name)?.online,1,"Late shutdown of the old MCP must not close the resumed owner");
  } finally {await rig.cleanup();store.close();}
});

test("Pi extension cannot inject or close another process's session owner",{timeout:10000},async t=>{
  const {root,project}=temp(t),state=path.join(root,"state"),session=randomUUID();
  const rig=piRig(t,project,state),store=new Store(resolveProject(project,state));
  try {
    const owner=store.register({name:"other-pi",kind:"pi",session_id:session,host_pid:2147483000});
    const lease=store.leaseClaim(owner,["other/**"]);
    const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
    store.send(sender,{to:owner.name,text:"private",idempotency_key:"other-owner"});
    store.pause(session,"manual");store.block(session,"ui",true);
    await rig.start("startup",session);await rig.handlers.get("input")!({source:"interactive"});await rig.handlers.get("ui_prompt_end")!({});
    assert.equal(rig.notices.length,0);
    assert.equal(store.gate(session).pause_reason,"manual");assert.ok(store.gate(session).blocked_reasons.includes("ui"));
    await rig.shutdown("new");assert.equal(store.agent(owner.name)?.online,1);
    assert.ok(store.leaseList().some(l=>l.id===lease.id));
  } finally {await rig.cleanup();store.close();}
});

test("hooks and the Pi extension create no state in a workspace that never used PeerLetter",{timeout:10000},async t=>{
  const {root,project}=temp(t),state=path.join(root,"state"),session=randomUUID(),workspace=locateProject(project,state);
  for(const kind of ["claude","codex"]) for(const event of ["SessionStart","UserPromptSubmit","PermissionRequest","PostToolUse","Stop","Interrupt","SessionEnd"]) {
    const output=execFileSync(process.execPath,[path.join(repo,"hooks/hook.ts"),kind],
      {env:{...process.env,PEERLETTER_STATE_DIR:state},input:JSON.stringify({session_id:session,cwd:project,hook_event_name:event,tool_use_id:"x"}),encoding:"utf8"});
    assert.equal(output,"");
  }
  assert.equal(fs.existsSync(workspace.directory),false,"Hooks must not create a workspace database or directory");
  const rig=piRig(t,project,state);
  try {
    await rig.start("startup",session);await rig.handlers.get("ui_prompt_start")!({});
    assert.equal(fs.existsSync(workspace.directory),false,"The Pi extension and its MCP must not create state at session start");
    // The first PeerLetter use creates the database; the extension then attaches and reports its gates.
    const store=new Store(resolveProject(project,state));t.after(()=>store.close());
    for(let i=0;i<60 && store.sessionFor("pi",[process.pid]) !== session;i++) await new Promise(resolve=>setTimeout(resolve,50));
    assert.equal(store.sessionFor("pi",[process.pid]),session);assert.ok(store.gate(session).blocked_reasons.includes("ui"));
  } finally {await rig.cleanup();}
});

test("Stop and mid-turn hooks tolerate sessions that never joined PeerLetter",t=>{
  const {root,project}=temp(t),state=path.join(root,"state"),session=randomUUID();
  const store=new Store(resolveProject(project,state));t.after(()=>store.close());
  for(const kind of ["codex","claude"]) for(const event of ["Stop","PostToolUse"]) {
    const output=execFileSync(process.execPath,[path.join(repo,"hooks/hook.ts"),kind],
      {env:{...process.env,PEERLETTER_STATE_DIR:state},input:JSON.stringify({session_id:session,cwd:project,hook_event_name:event}),encoding:"utf8"});
    assert.equal(output,"");
  }
  assert.equal(store.peers().length,0);
});

test("prepared CLI wrapper renames offline mailboxes and intentionally reclaims old names",t=>{
  const {root,project}=temp(t),output=path.join(root,"prepared"),state=path.join(root,"state");
  const env={...process.env,PEERLETTER_STATE_DIR:state};
  execFileSync(process.execPath,[path.join(repo,"scripts/prepare.ts"),"--project",project,"--output",output],{env});
  const wrapper=path.join(output,"peerletter");
  const run=(...args:string[])=>JSON.parse(execFileSync(wrapper,args,{env,encoding:"utf8",stdio:["pipe","pipe","pipe"]}));
  run("--name","sender","register");run("--name","old","register");
  const mail=run("--name","sender","send","--to","old","--text","task","--idempotency-key","task").message;
  const renamed=run("--name","old","rename","--to","new");assert.equal(renamed.name,"new");assert.deepEqual(renamed.previous_names,["old"]);
  assert.ok(run("peers").peers.some((p:any)=>p.name==="new" && p.previous_names[0]==="old"));
  const failure=(...args:string[])=>{try {run(...args);assert.fail("Expected CLI error");} catch(e:any) {return JSON.parse(String(e.stderr)).error;}};
  assert.equal(failure("--name","old","peek").code,"NAME_RESERVED");
  const error=failure("--name","sender","send","--to","old","--text","new task","--idempotency-key","fresh");
  assert.equal(error.code,"PEER_RENAMED");assert.equal(error.details.renamed_to,"new");
  assert.equal(run("--name","new","receive").messages[0].id,mail.id);
  run("--name","new","ack",mail.id);assert.equal(run("--name","new","peek").messages.length,0);
  assert.equal(run("--name","old","register").name,"old");assert.equal(run("--name","old","peek").messages.length,0);
});
