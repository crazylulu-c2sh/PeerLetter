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
import { resolveProject } from "../src/project.ts";
import piExtension from "../pi/peerletter.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
  const again=installation(project);
  assert.ok(again.writes.every(w=>fs.readFileSync(w.file,"utf8")===w.data));
  assert.throws(()=>mergeToml("[mcp_servers.peerletter]\ncommand='custom'\n",""));
  assert.equal(mergeHooks(settings,"claude",process.execPath,repo).hooks.Stop.length,2);
  const extension=installation(project,{client:"pi",piMode:"extension"});
  const mcp=extension.writes.find(w=>w.file.endsWith("mcp.json"))!;
  assert.equal(JSON.parse(mcp.data).mcpServers.peerletter,undefined);
  assert.ok(extension.writes.find(w=>w.file.endsWith("settings.json"))!.data.includes("pi/peerletter.ts"));
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
  const receiver=store.register({name:"pi",kind:"pi",session_id:session});
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
});
