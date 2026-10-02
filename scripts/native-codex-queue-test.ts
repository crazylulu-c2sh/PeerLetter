import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { CodexConnection } from "../src/codex.ts";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { applyGlobal } from "./global-install.ts";
import type { Agent } from "../src/store.ts";

// Installed interactive TUI + app-server; every model response comes from loopback.
// Only this temporary project's mailbox, control socket and child processes are used.
const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-native-queue-"));
const project=path.join(root,"project"),testHome=path.join(root,"codex"),state=path.join(root,"state"),socket=path.join(root,"daemon.sock");
fs.mkdirSync(project);fs.mkdirSync(testHome);
const globalSetup=process.argv.includes("--global");
const checkout=fileURLToPath(new URL("../",import.meta.url)),binary=process.env.PEERLETTER_CODEX_BIN || "codex";
const store=new Store(resolveProject(project,state)),sender=store.register({name:"fixture-sender",kind:"cli",session_id:`cli:${randomUUID()}`});
let requests=0,backgroundRequests=0,providerError:Error|undefined,tuiOutput="",serverErrors="",trustAccepted=false;
let hooksAccepted=false;
let releaseRead=()=>{},releaseUnread=()=>{};
const waitRead=new Promise<void>(resolve=>{releaseRead=resolve;}),waitUnread=new Promise<void>(resolve=>{releaseUnread=resolve;});
let ackIds:string[]=[],sawUnreadNotice=false,sawIdleNotice=false;
function tool(tools:any[],suffix:string):{name:string;namespace?:string}|undefined {
  for(const t of tools || []) {if(t.name?.endsWith(`peerletter_${suffix}`))return {name:t.name};if(t.tools){const child=tool(t.tools,suffix);if(child)return {...child,namespace:t.name};}}
}
function lastUser(input:any[]):string {
  const users=(input || []).filter(i=>i.role === "user");return JSON.stringify(users.at(-1));
}
const provider=http.createServer(async(req,res)=>{
  try {
    if(req.method !== "POST" || !req.url?.endsWith("/responses")){res.writeHead(404);res.end();return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));let bytes=Buffer.concat(chunks);
    if(req.headers["content-encoding"] === "gzip")bytes=gunzipSync(bytes);
    if(req.headers["content-encoding"] === "zstd")bytes=zstdDecompressSync(bytes);
    const input=JSON.parse(bytes.toString("utf8")),identity=tool(input.tools,"whoami");
    const index=identity ? ++requests : 0;if(!identity)backgroundRequests++;
    let item:any;
    const call=(suffix:string,args:unknown)=>{const named=tool(input.tools,suffix);assert.ok(named,`Missing ${suffix}`);return {type:"function_call",call_id:randomUUID(),...named,arguments:JSON.stringify(args)};};
    if(index === 1)item=call("whoami",{});
    else if(index === 2){await waitRead;item=call("receive",{});}
    else if(index === 3)item=call("ack",{message_ids:ackIds});
    else {
      if(index === 5)await waitUnread;
      if(index === 6){sawUnreadNotice=lastUser(input.input).includes("PeerLetter:");assert.ok(sawUnreadNotice);assert.ok(!JSON.stringify(input.input).includes("SECRET-UNREAD-BODY"));}
      if(index === 7){sawIdleNotice=lastUser(input.input).includes("PeerLetter:");assert.ok(sawIdleNotice);assert.ok(!JSON.stringify(input.input).includes("SECRET-IDLE-BODY"));}
      if(index > 7)throw new Error("Unexpected additional model turn");
      item={type:"message",id:randomUUID(),role:"assistant",content:[{type:"output_text",text:identity ? "PeerLetter native queue fixture done." : "Fixture title"}]};
    }
    const id=randomUUID(),events=[{type:"response.created",response:{id}}, {type:"response.output_item.done",item},
      {type:"response.completed",response:{id,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}];
    res.writeHead(200,{"content-type":"text/event-stream"});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  }catch(error){providerError=error as Error;res.writeHead(500);res.end("Local fixture failure");}
});
await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
const port=(provider.address() as {port:number}).port;
fs.writeFileSync(path.join(testHome,"config.toml"),`model = "peerletter-fixture"\nmodel_provider = "peerletter_fixture"\napproval_policy = "never"\n[analytics]\nenabled = false\n[features]\ncode_mode = false\ncode_mode_only = false\n[model_providers.peerletter_fixture]\nname = "Local PeerLetter fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[mcp_servers.peerletter]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([path.join(checkout,"src/stdio.ts"),"--project",project,"--state",state,"--kind","codex","--name","codex-fixture","--wake","codex-queue"])}\n[mcp_servers.peerletter.env]\nPEERLETTER_CODEX_SOCKET = ${JSON.stringify(socket)}\n`);
const env:NodeJS.ProcessEnv={...process.env,CODEX_HOME:testHome,TERM:"xterm-256color"};
if (globalSetup) {
  const config=path.join(testHome,"config.toml");
  fs.writeFileSync(config,fs.readFileSync(config,"utf8").split("[mcp_servers.peerletter]")[0]);
  applyGlobal({client:"codex",home:path.join(root,"user"),codexHome:testHome});
  Object.assign(env,{HOME:path.join(root,"user"),PEERLETTER_STATE_DIR:state,PEERLETTER_CODEX_SOCKET:socket});
}
for(const name of ["CODEX_THREAD_ID","PEERLETTER_SESSION_ID","PEERLETTER_NAME","PEERLETTER_WAKE","OPENAI_API_KEY","CODEX_API_KEY"])delete env[name];
const server=spawn(binary,["app-server","--listen",`unix://${socket}`],{env,stdio:["ignore","ignore","pipe"]});
server.stderr.on("data",b=>{serverErrors=(serverErrors+String(b)).slice(-5000);});
let tui:ReturnType<typeof spawn>|undefined;
const rpc=new CodexConnection(socket,3000);
async function eventually(check:()=>boolean|Promise<boolean>,label:string,timeout=15000) {
  const until=Date.now()+timeout;
  while(Date.now()<until){if(providerError)throw providerError;if(await check())return;await new Promise(resolve=>setTimeout(resolve,50));}
  throw new Error(`${label} timed out. TUI: ${tuiOutput.slice(-2000)} Server: ${serverErrors.slice(-1000)}`);
}
async function stop(child:ReturnType<typeof spawn>|undefined) {
  if(!child || child.exitCode !== null)return;
  child.kill("SIGTERM");await Promise.race([new Promise(resolve=>child.once("exit",resolve)),new Promise(resolve=>setTimeout(resolve,2000))]);
  if(child.exitCode === null){child.kill("SIGKILL");await new Promise(resolve=>child.once("exit",resolve));}
}
try {
  await eventually(()=>fs.existsSync(socket),"Daemon socket");
  const bridge=String.raw`import fcntl, os, pty, select, signal, struct, subprocess, sys, termios
master, slave = pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
running=True
def end(sig,frame):
 global running
 running=False
signal.signal(signal.SIGTERM,end)
try:
 while running and p.poll() is None:
  ready,_,_=select.select([master,0],[],[],0.1)
  for fd in ready:
   try: data=os.read(fd,65536)
   except OSError: running=False;break
   if not data: running=False;break
   if fd==master: os.write(1,data)
   else: os.write(master,data)
finally:
 if p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=1)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 os.close(master)
`;
  tui=spawn("python3",["-c",bridge,binary,"--remote",`unix://${socket}`,"-C",project,"Run the PeerLetter fixture identity."],{env,stdio:["pipe","pipe","pipe"]});
  tui.stdout!.on("data",b=>{
    tuiOutput=(tuiOutput+String(b)).slice(-64000);
    const plain=tuiOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"");
    if(!trustAccepted && /trust|Yes, continue/.test(plain)) {trustAccepted=true;setTimeout(()=>tui?.stdin?.write("1\r"),1000);}
    // This fixture created these four hooks under its temporary CODEX_HOME.
    // Use the host's normal review UI; no production hook approval is changed.
    if(globalSetup && !hooksAccepted && /hooks are new or changed/.test(plain)) {
      hooksAccepted=true;setTimeout(()=>tui?.stdin?.write("2\r"),1000);
    }
  });
  tui.stderr!.on("data",b=>{tuiOutput=(tuiOutput+String(b)).slice(-64000);});
  await eventually(()=>requests === 2,"Interactive identity and held busy turn",30000);
  const actor=globalSetup ? store.get<Agent>("SELECT * FROM agents WHERE kind='codex' AND online=1")! : store.agent("codex-fixture")!;assert.ok(actor);const threadId=actor.session_id;
  const status=()=>rpc.call("thread/read",{threadId,includeTurns:false});
  const queued=()=>rpc.call("thread/queue/list",{threadId,limit:100});
  const mail=(key:string,body:string)=>store.send(sender,{to:actor.name,text:body,idempotency_key:key}).message;
  ackIds=Array.from({length:3},(_,i)=>mail(`busy-read-${i}`,"BUSY-READ-BODY").id);
  await new Promise(resolve=>setTimeout(resolve,1600));
  assert.equal((await status()).thread.status.type,"active");assert.equal((await queued()).data.length,0);
  assert.equal(store.all("SELECT * FROM notices").length,0);releaseRead();
  await eventually(async()=>requests === 4 && (await status()).thread.status.type === "idle","Busy mail handled");
  assert.ok(ackIds.every(id=>store.status(sender,id).state === "acknowledged"));
  await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(requests,4);assert.equal((await queued()).data.length,0);
  await rpc.call("turn/start",{threadId,input:[{type:"text",text:"Hold a second fixture turn.",text_elements:[]}]});
  await eventually(()=>requests === 5,"Second active turn");
  const unread=Array.from({length:3},(_,i)=>mail(`busy-unread-${i}`,"SECRET-UNREAD-BODY"));
  await new Promise(resolve=>setTimeout(resolve,1600));assert.equal((await queued()).data.length,0);releaseUnread();
  await eventually(async()=>requests === 6 && sawUnreadNotice && (await status()).thread.status.type === "idle","One native wake after busy turn");
  assert.ok(unread.every(m=>store.status(sender,m.id).state === "notified"));assert.equal((await queued()).data.length,0);
  await store.receive(actor);store.ack(actor,unread.map(m=>m.id));
  const idle=mail("idle-wake","SECRET-IDLE-BODY");
  await eventually(async()=>requests === 7 && sawIdleNotice && (await status()).thread.status.type === "idle","Native idle wake");
  assert.equal(store.status(sender,idle.id).state,"notified");await new Promise(resolve=>setTimeout(resolve,1000));assert.equal(requests,7);
  console.log(JSON.stringify({passed:true,client:"installed interactive Codex TUI and app-server",global_setup:globalSetup,busy_read_extra_turns:0,
    busy_unread_native_wakes:1,idle_native_wakes:1,binding:"mcp-metadata",provider:"loopback fixture",provider_requests:requests,background_requests:backgroundRequests,external_model_requests:0}));
}finally {
  releaseRead();releaseUnread();rpc.close();await stop(tui);await stop(server);
  provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));store.close();fs.rmSync(root,{recursive:true,force:true});
}
