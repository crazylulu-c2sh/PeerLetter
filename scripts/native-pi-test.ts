import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { applyGlobal } from "./global-install.ts";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
// Installed Pi 0.99.2 CLI, actual global resource discovery and MCP. Every model
// response is loopback; project settings are deliberately untrusted.
const checkout=fileURLToPath(new URL("../",import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-native-pi-"));
const home=path.join(root,"home"),project=path.join(root,"project"),agentDir=path.join(home,".pi/agent"),state=path.join(root,"state");
fs.mkdirSync(home);fs.mkdirSync(path.join(project,".pi"),{recursive:true});
fs.writeFileSync(path.join(project,".pi/forbidden.ts"),"throw new Error('UNTRUSTED-PROJECT-EXTENSION-LOADED');");
fs.writeFileSync(path.join(project,".pi/settings.json"),JSON.stringify({extensions:["./forbidden.ts"]}));
applyGlobal({client:"pi",home});
const settings=JSON.parse(fs.readFileSync(path.join(agentDir,"settings.json"),"utf8"));settings.defaultProjectTrust="never";
fs.writeFileSync(path.join(agentDir,"settings.json"),JSON.stringify(settings));
let requests=0,sawNotice=false,providerError:Error|undefined;
const provider=http.createServer(async(req,res)=>{
  try {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {res.writeHead(404);res.end();return;}
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const input=JSON.parse(Buffer.concat(chunks).toString("utf8")),index=++requests;
    let delta:any,finish="stop";
    if (index === 1) {
      const tool=input.tools?.find((t:any)=>t.function?.name.endsWith("peerletter_whoami"));assert.ok(tool,"Global PeerLetter tool missing");
      delta={role:"assistant",tool_calls:[{index:0,id:randomUUID(),type:"function",function:{name:tool.function.name,arguments:"{}"}}]};finish="tool_calls";
    } else {
      if (index === 3) {
        sawNotice=JSON.stringify(input.messages).includes("PeerLetter:");assert.ok(sawNotice,"Idle wake missing");
        assert.ok(!JSON.stringify(input.messages).includes("PRIVATE-PI-MAIL-BODY"));
      }
      assert.ok(index <= 3,"Extra Pi model turn");delta={role:"assistant",content:"Fixture done."};
    }
    const frame=(d:any,reason:string|null)=>({id:`fixture-${index}`,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"fixture",choices:[{index:0,delta:d,finish_reason:reason}]});
    res.writeHead(200,{"content-type":"text/event-stream"});
    res.end(`data: ${JSON.stringify(frame(delta,null))}\n\ndata: ${JSON.stringify(frame({},finish))}\n\ndata: [DONE]\n\n`);
  } catch(error) {providerError=error as Error;res.writeHead(500);res.end("Fixture failed");}
});
await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
fs.writeFileSync(path.join(agentDir,"models.json"),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}/v1`,
  api:"openai-completions",apiKey:"fixture-dummy",models:[{id:"fixture",contextWindow:32768,maxTokens:1024}]}}}));
const env:NodeJS.ProcessEnv={...process.env,HOME:home,PI_CODING_AGENT_DIR:agentDir,PEERLETTER_STATE_DIR:state,PI_OFFLINE:"1",PI_TELEMETRY:"0"};
for (const key of Object.keys(env)) if (/API_KEY|AUTH_TOKEN|OAUTH_TOKEN|PEERLETTER_(PROJECT|NAME|SESSION_ID|WAKE)$/.test(key)) delete env[key];
const binary=path.join(checkout,"node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const child=spawn(process.execPath,[binary,"--mode","rpc","--no-session","--no-approve","--no-context-files","--no-builtin-tools","--provider","fixture","--model","fixture","--thinking","off","--offline"],{cwd:project,env,stdio:["pipe","pipe","pipe"]});
let errors="",buffer="";const events:any[]=[];
child.stdout.on("data",bytes=>{
  buffer+=String(bytes);let end:number;
  while((end=buffer.indexOf("\n"))>=0) {const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line)try{events.push(JSON.parse(line));}catch{errors+="Bad Pi RPC frame\n";}}
});child.stderr.on("data",bytes=>errors+=String(bytes));
const store=new Store(resolveProject(project,state));
async function until(fn:()=>boolean,label:string) {
  const end=Date.now()+20000;
  while(!fn()) {if(providerError)throw providerError;if(child.exitCode !== null || Date.now()>end)throw new Error(`${label}: ${errors.slice(-3000)}`);await new Promise(r=>setTimeout(r,50));}
}
try {
  await until(()=>!!store.get<Agent>("SELECT * FROM agents WHERE kind='pi' AND online=1"),"Global Pi startup registration");
  const actor=store.get<Agent>("SELECT * FROM agents WHERE kind='pi' AND online=1")!;
  assert.equal(actor.wake,"pi-extension");assert.equal(store.publicAgent(actor).session_binding.state,"bound");
  child.stdin.write(JSON.stringify({id:"fixture-start",type:"prompt",message:"Run the PeerLetter identity fixture."})+"\n");
  await until(()=>requests === 2 && events.some(e=>e.type === "agent_settled"),"Initial Pi turn");
  const sender=store.cliActor("fixture-sender");
  const mail=store.send(sender,{to:actor.name,text:"PRIVATE-PI-MAIL-BODY",idempotency_key:"native-pi-idle"}).message;
  await until(()=>requests === 3 && sawNotice && store.status(sender,mail.id).state === "notified","Native Pi idle wake");
  await new Promise(r=>setTimeout(r,1000));assert.equal(requests,3);assert.equal(store.status(sender,mail.id).acknowledged_at,null);
  assert.ok(!errors.includes("UNTRUSTED-PROJECT-EXTENSION-LOADED"));
  console.log(JSON.stringify({passed:true,client:"installed Pi CLI 0.99.2 RPC",global_setup:true,project_trusted:false,startup_bound:true,
    idle_native_wakes:1,provider_requests:requests,external_model_requests:0}));
} finally {
  child.stdin.end();await Promise.race([new Promise(r=>child.once("exit",r)),new Promise(r=>setTimeout(r,2000))]);
  if(child.exitCode === null){child.kill("SIGTERM");await new Promise(r=>child.once("exit",r));}
  provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));store.close();fs.rmSync(root,{recursive:true,force:true});
}
