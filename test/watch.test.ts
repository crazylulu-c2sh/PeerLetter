import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/store.ts";
import { locateProject, resolveProject } from "../src/project.ts";
import { watchMail } from "../src/watch.ts";
import { claudeWakeFile } from "../src/claude.ts";
import { installation,writeWithBackup } from "../scripts/install.ts";

const repo=fileURLToPath(new URL("../",import.meta.url));
function fixture(t:test.TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-watch-"));
  const project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  const store=new Store(resolveProject(project,state));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,project,state,store,session:randomUUID()};
}
async function until(fn:()=>boolean,ms=5000) {
  const deadline=Date.now()+ms;
  while(!fn()) {if(Date.now()>=deadline)throw new Error("Timed out waiting for fixture");await delay(10);}
}
async function mcp(project:string,state:string,session:string,wake="claude-monitor") {
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,"src/stdio.ts"),"--project",project,"--state",state,"--kind","claude","--wake",wake],
    env:{CLAUDE_CODE_SESSION_ID:session},stderr:"pipe"});
  const sdk=new Client({name:"claude-code",version:"test"});
  await sdk.connect(transport);return sdk;
}

test("monitor waits for actual MCP startup, emits once without body or ACK, and survives reconnect",{timeout:15000},async t=>{
  const {project,state,store,session}=fixture(t),stopped=new AbortController(),lines:string[]=[];
  const watching=watchMail({project,state,session,signal:stopped.signal,pollMs:10,emit:async line=>{lines.push(line);},diagnostic:()=>{}});
  let sdk:Client|undefined;
  store.recordUse("claude",session);
  try {
    assert.equal(store.peers().length,0,"watch must not create an offline or online actor");
    sdk=await mcp(project,state,session);
    await until(()=>!!store.agentForSession(session,"claude"));
    const actor=store.agentForSession(session,"claude")!;
    const lease=store.leaseClaim(actor,["keep/**"]);
    const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
    const first=store.send(sender,{to:actor.name,text:"PRIVATE-MONITOR-BODY",idempotency_key:"first"}).message;
    await until(()=>store.status(sender,first.id).state === "notified");
    assert.equal(lines.length,1);assert.match(lines[0],/peerletter_receive/);assert.ok(!lines[0].includes("PRIVATE-MONITOR-BODY"));
    assert.equal(store.peek(actor).messages[0].state,"notified");assert.equal(store.status(sender,first.id).acknowledged_at,null);
    const identity=await sdk.callTool({name:"peerletter_whoami",arguments:{}});
    const who=JSON.parse((identity.content as {text:string}[])[0].text);
    assert.equal(who.registration.mode,"startup");assert.equal(who.wake_runner.online,true);assert.equal(who.wake_error,null);
    assert.equal(await watchMail({project,state,session,timeoutMs:100,pollMs:10,diagnostic:()=>{}}),false,"duplicate must not steal a live watch");
    assert.ok(store.leaseList().some(x=>x.id === lease.id));
    await sdk.close();sdk=undefined;
    await until(()=>!store.agent(actor.name)?.online);
    const other=await mcp(project,state,randomUUID());await other.close();
    sdk=await mcp(project,state,session);
    await until(()=>!!store.agentForSession(session,"claude"));
    assert.equal(store.agentForSession(session,"claude")!.name,actor.name);
    const second=store.send(sender,{to:actor.name,text:"SECOND-PRIVATE",idempotency_key:"second"}).message;
    await until(()=>store.status(sender,second.id).state === "notified");
    assert.equal(lines.length,2);assert.equal(store.peek(store.agent(actor.name)!).messages.length,2);
  } finally {stopped.abort();await watching;await sdk?.close();}
  assert.equal(store.watchStatus(session).online,false);
});

test("watch creates no database in an unused workspace and starts once PeerLetter is used",{timeout:10000},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-watch-unused-")),project=path.join(root,"project"),state=path.join(root,"state");fs.mkdirSync(project);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const session=randomUUID(),workspace=locateProject(project,state),lines:string[]=[];
  assert.equal(await watchMail({project,state,session,sink:"claude-async-rewake",once:true,timeoutMs:5000,pollMs:10,diagnostic:()=>{}}),false);
  assert.equal(fs.existsSync(workspace.directory),false,"A one-shot waiter returns without creating state");
  const stopped=new AbortController(),waits:string[]=[];
  const watching=watchMail({project,state,session,signal:stopped.signal,pollMs:10,emit:async line=>{lines.push(line);},diagnostic:m=>{waits.push(m);}});
  try {
    await delay(100);assert.equal(fs.existsSync(workspace.directory),false,"The monitor waits without creating state");
    assert.ok(waits.some(m=>/use PeerLetter/.test(m)));
    const store=new Store(resolveProject(project,state));t.after(()=>store.close());
    const actor=store.register({name:"claude-test",kind:"claude",session_id:session,wake:"claude-monitor"});
    const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
    const mail=store.send(sender,{to:actor.name,text:"PRIVATE",idempotency_key:"unused-then-used"}).message;
    await until(()=>store.status(sender,mail.id).state === "notified");assert.equal(lines.length,1);
  } finally {stopped.abort();await watching;}
});

test("monitor preserves pause/UI/compact, retries failed output and does not take another session",{timeout:10000},async t=>{
  const {project,state,store,session}=fixture(t),stopped=new AbortController(),lines:string[]=[];
  const actor=store.register({name:"claude-test",kind:"claude",session_id:session,wake:"claude-monitor"});
  const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
  store.pause(session,"manual");store.block(session,"ui",true);store.block(session,"compact",true);
  const mail=store.send(sender,{to:actor.name,text:"PRIVATE",idempotency_key:"gates",importance:"high"}).message;
  let fail=true;
  const watching=watchMail({project,state,session,signal:stopped.signal,pollMs:10,diagnostic:()=>{},emit:async line=>{
    if(fail){fail=false;throw new Error("output failure");}lines.push(line);
  }});
  try {
    await delay(50);assert.equal(lines.length,0);
    store.pause(session,null);store.block(session,"ui",false);await delay(50);assert.equal(lines.length,0);
    store.block(session,"compact",false);
    await until(()=>store.agent(actor.name)?.wake_error === "output failure");
    assert.equal(store.status(sender,mail.id).state,"accepted");
    await until(()=>store.status(sender,mail.id).state === "notified");assert.equal(lines.length,1);
    await delay(50);assert.equal(lines.length,1);
    assert.equal(await watchMail({project,state,session:randomUUID(),name:actor.name,timeoutMs:30,pollMs:10,diagnostic:()=>{}}),false);
    assert.equal(store.peers().length,2);
    fs.mkdirSync(path.dirname(claudeWakeFile(project)),{recursive:true});fs.writeFileSync(claudeWakeFile(project),JSON.stringify({wake:"none"}));
    await watching;
    assert.equal(store.agent(actor.name)?.online,1,"watch teardown must not disconnect MCP");
  } finally {stopped.abort();await watching;}
});

test("watch skips old role backlog, enforces exact name and recovers dead ownership",async t=>{
  const {project,state,store,session}=fixture(t);
  const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
  const role=store.cliActor("role");store.send(sender,{to:role.name,text:"OLD",idempotency_key:"old"});
  const actor=store.register({name:role.name,kind:"claude",session_id:session,wake:"claude-monitor"});
  const lines:string[]=[];
  assert.equal(await watchMail({project,state,session,timeoutMs:30,pollMs:10,emit:async line=>{lines.push(line);}}),false);
  assert.equal(lines.length,0);assert.equal(store.peek(actor).messages.length,1);
  assert.equal(await watchMail({project,state,session,name:"wrong",timeoutMs:100,diagnostic:()=>{}}),false);
  store.run("INSERT INTO watch_owners VALUES(?,?,?,?,?,?)",session,"dead","claude-monitor",2147483000,"stale",0);
  assert.equal(await watchMail({project,state,session,backlog:true,timeoutMs:30,pollMs:10,emit:async line=>{lines.push(line);}}),true);
  assert.equal(lines.length,1);assert.equal(store.watchStatus(session).online,false);
  assert.equal(store.claimWatch(session,"claude-monitor","new"),true);
  store.releaseWatch(session,"dead");assert.equal(store.ownsWatch(session,"new"),true);store.releaseWatch(session,"new");
});

test("Claude foreground hooks defer to each automatic adapter and report gate events",t=>{
  const {project,state,store,session}=fixture(t);
  const actor=store.register({name:"claude-test",kind:"claude",session_id:session,wake:"claude-monitor"});
  const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
  const mail=store.send(sender,{to:actor.name,text:"PRIVATE",idempotency_key:"hook"}).message;
  const hook=(event:string,extra:Record<string,unknown>={})=>execFileSync(process.execPath,[path.join(repo,"hooks/hook.ts"),"claude"],
    {env:{...process.env,PEERLETTER_STATE_DIR:state},input:JSON.stringify({session_id:session,cwd:project,hook_event_name:event,...extra}),encoding:"utf8"});
  for(const wake of ["claude-monitor","claude-async-rewake","claude-channel"]) {
    store.setWake(actor,wake);assert.equal(hook("Stop"),"");assert.equal(hook("PostToolUse"),"");
  }
  assert.equal(store.status(sender,mail.id).state,"accepted");
  hook("PermissionRequest",{tool_use_id:"a"});hook("PermissionRequest",{tool_use_id:"b"});
  assert.equal(store.gate(session).blocked_reasons.length,2);
  hook("PostToolUse",{tool_use_id:"a"});assert.deepEqual(store.gate(session).blocked_reasons,["permission:b"]);
  hook("PostToolUseFailure",{tool_use_id:"b",is_interrupt:true});assert.equal(store.gate(session).pause_reason,"user_abort");
  hook("UserPromptSubmit");assert.equal(store.gate(session).state,"ready");
  hook("PreCompact");assert.equal(store.gate(session).state,"blocked");hook("PostCompact");assert.equal(store.gate(session).state,"ready");
  hook("Elicitation");assert.equal(store.gate(session).state,"blocked");hook("ElicitationResult");assert.equal(store.gate(session).state,"ready");
  hook("Elicitation",{elicitation_id:"a"});hook("Elicitation",{elicitation_id:"b"});
  hook("ElicitationResult",{elicitation_id:"a"});assert.equal(store.gate(session).state,"blocked");
  hook("ElicitationResult",{elicitation_id:"b"});assert.equal(store.gate(session).state,"ready");
  hook("SessionEnd");assert.ok(store.gate(session).blocked_reasons.includes("session_end"));hook("SessionStart");assert.equal(store.gate(session).state,"ready");
});

test("asyncRewake exits 2 only for real mail; malformed input and timeout do not notify or ACK",{timeout:10000},async t=>{
  const {project,state,store,session}=fixture(t);
  const actor=store.register({name:"claude-test",kind:"claude",session_id:session,wake:"claude-async-rewake"});
  const sender=store.register({name:"sender",kind:"codex",session_id:randomUUID()});
  assert.equal(await watchMail({project,state,session,sink:"claude-async-rewake",once:true,timeoutMs:30,pollMs:10,diagnostic:()=>{}}),false);
  assert.equal(store.watchStatus(session).online,false);
  const mail=store.send(sender,{to:actor.name,text:"ASYNC-PRIVATE",idempotency_key:"rewake"}).message;
  const child=spawn(process.execPath,[path.join(repo,"hooks/rewake.ts")],{env:{...process.env,PEERLETTER_STATE_DIR:state}});
  let output="",errors="";child.stdout.on("data",x=>{output+=x;});child.stderr.on("data",x=>{errors+=x;});
  child.stdin.end(JSON.stringify({hook_event_name:"Stop",session_id:session,cwd:project}));
  const code=await new Promise(resolve=>child.on("exit",resolve));
  assert.equal(code,2);assert.equal(output,"");assert.match(errors,/peerletter_receive/);assert.ok(!errors.includes("ASYNC-PRIVATE"));
  assert.equal(store.status(sender,mail.id).state,"notified");assert.equal(store.status(sender,mail.id).acknowledged_at,null);
  const malformed=execFileSync(process.execPath,[path.join(repo,"hooks/rewake.ts")],{input:"bad-json",encoding:"utf8"});assert.equal(malformed,"");
  await assert.rejects(watchMail({project,state,session:"runtime:fake",timeoutMs:10}),/UUID/);
});

test("local plugin installer switches modes, removes owned manual entries and preserves unrelated config",t=>{
  const {project}=fixture(t);
  const manual=installation(project,{client:"claude"});for(const w of manual.writes)writeWithBackup(w.file,w.data);
  const settingsFile=path.join(project,".claude/settings.local.json");
  const settings=JSON.parse(fs.readFileSync(settingsFile,"utf8"));settings.permissions={allow:["Read(*)"]};
  settings.hooks.Stop.push({hooks:[{type:"command",command:"unrelated"}]});settings.enabledMcpjsonServers=["peerletter","other"];fs.writeFileSync(settingsFile,JSON.stringify(settings));
  const monitor=installation(project,{client:"claude",wake:"monitor"});
  const manifest=JSON.parse(monitor.writes.find(w=>w.file.endsWith("plugin.json"))!.data);
  assert.equal(manifest.experimental.monitors[0].when,"always");assert.equal(manifest.mcpServers.peerletter.args.includes("claude-monitor"),true);
  assert.equal(JSON.parse(monitor.writes.find(w=>w.file.endsWith(".mcp.json"))!.data).mcpServers.peerletter,undefined);
  const preserved=JSON.parse(monitor.writes.find(w=>w.file === settingsFile)!.data);
  assert.deepEqual(preserved.permissions,{allow:["Read(*)"]});assert.deepEqual(preserved.hooks.Stop,[{hooks:[{type:"command",command:"unrelated"}]}]);
  assert.deepEqual(preserved.enabledMcpjsonServers,["other"]);
  assert.equal(monitor.commands.length,2);assert.ok(monitor.commands[1].args.includes("local"));
  for(const w of monitor.writes)writeWithBackup(w.file,w.data);
  const async=installation(project,{client:"claude",wake:"async-rewake"});
  const alternative=JSON.parse(async.writes.find(w=>w.file.endsWith("plugin.json"))!.data);
  assert.equal(alternative.experimental,undefined);assert.ok(alternative.hooks.Stop.some((g:any)=>g.hooks.some((h:any)=>h.asyncRewake && h.timeout === 600)));
  const installed=JSON.parse(fs.readFileSync(settingsFile,"utf8"));const id=monitor.commands[1].args[2];installed.enabledPlugins={[id]:true,other:true};fs.writeFileSync(settingsFile,JSON.stringify(installed));
  const none=installation(project,{client:"claude",wake:"none"});
  const disabled=JSON.parse(none.writes.find(w=>w.file === settingsFile)!.data);
  assert.equal(disabled.enabledPlugins[id],false);assert.equal(disabled.enabledPlugins.other,true);
  assert.equal(none.commands.length,0);assert.equal(JSON.parse(none.writes.find(w=>w.file === claudeWakeFile(project))!.data).wake,"none");
  assert.throws(()=>installation(project,{client:"codex",wake:"monitor"}),/INVALID_WAKE|--client/);
});
