import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn } from "node:child_process";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";

// Optional installed-client regression. All provider responses come from this loopback
// fixture. No external model, user configuration, production mailbox or queue is used.
const checkout=fileURLToPath(new URL("../",import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-native-codex-"));
const project=path.join(root,"project"),testHome=path.join(root,"codex"),state=path.join(root,"state");
fs.mkdirSync(project);fs.mkdirSync(testHome);
let requests=0,providerError: Error | undefined,observedBinding=false;
function findIdentityTool(tools: any[]): {name:string;namespace?:string} | undefined {
  for(const tool of tools || []) {
    if(tool.name?.includes("peerletter_whoami"))return {name:tool.name};
    if(tool.tools) {
      const child=findIdentityTool(tool.tools);
      if(child)return {name:child.name,namespace:tool.name};
    }
  }
  return undefined;
}
const provider=http.createServer(async (req,res)=>{
  try {
    if(req.method !== "POST" || !req.url?.endsWith("/responses")) {res.writeHead(404);res.end();return;}
    const chunks: Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    let bytes=Buffer.concat(chunks);
    if(req.headers["content-encoding"] === "gzip")bytes=gunzipSync(bytes);
    if(req.headers["content-encoding"] === "zstd")bytes=zstdDecompressSync(bytes);
    const input=JSON.parse(bytes.toString("utf8"));requests++;
    observedBinding ||= JSON.stringify(input.input).includes("mcp-metadata");
    const responseId=`peerletter_fixture_${requests}`;
    let item: Record<string,unknown>;
    if(requests === 1) {
      const tool=findIdentityTool(input.tools);
      if(!tool)throw new Error("PeerLetter identity tool is not directly exposed to Codex");
      item={type:"function_call",call_id:"peerletter_identity",...tool,arguments:"{}"};
    } else item={type:"message",id:"fixture_done",role:"assistant",content:[{type:"output_text",text:"PeerLetter native test finished."}]};
    const events=[{type:"response.created",response:{id:responseId}},
      {type:"response.output_item.done",item},
      {type:"response.completed",response:{id:responseId,usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}];
    res.writeHead(200,{"content-type":"text/event-stream"});
    res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  } catch(error) {providerError=error as Error;res.writeHead(500);res.end("Local fixture error");}
});
await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
const address=provider.address() as {port:number};
// Force the reported failure condition: CODEX_THREAD_ID does not reach the MCP core.
const wrapper=path.join(root,"stdio-wrapper.mjs");
fs.writeFileSync(wrapper,`delete process.env.CODEX_THREAD_ID; delete process.env.PEERLETTER_SESSION_ID;\nawait import(${JSON.stringify(pathToFileURL(path.join(checkout,"src/stdio.ts")).href)});\n`);
fs.mkdirSync(path.join(project,".codex"));
fs.writeFileSync(path.join(project,".codex/hooks.json"),JSON.stringify({hooks:{SessionStart:[{hooks:[{
  type:"command",command:`'${process.execPath}' '${path.join(checkout,"hooks/hook.ts")}' codex`,timeout:5,
}]}]}}));
fs.writeFileSync(path.join(testHome,"config.toml"),`model = "peerletter-fixture"\nmodel_provider = "peerletter_fixture"\napproval_policy = "never"\n[analytics]\nenabled = false\n[features]\ncode_mode = false\ncode_mode_only = false\n[model_providers.peerletter_fixture]\nname = "Local PeerLetter test fixture"\nbase_url = "http://127.0.0.1:${address.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[mcp_servers.peerletter]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([wrapper,"--project",project,"--state",state,"--kind","codex","--name","codex-fixture"])}\n`);
let output="",errors="";
const env: NodeJS.ProcessEnv={...process.env,CODEX_HOME:testHome,PEERLETTER_STATE_DIR:state};
delete env.CODEX_THREAD_ID;delete env.PEERLETTER_SESSION_ID;delete env.PEERLETTER_NAME;delete env.PEERLETTER_WAKE;
const child=spawn(process.env.PEERLETTER_CODEX_BIN || "codex",["exec","--skip-git-repo-check","--json","--cd",project,"Run the local PeerLetter identity fixture."],
  {env,stdio:["ignore","pipe","pipe"],detached:process.platform !== "win32"});
child.stdout.on("data",chunk=>{output+=String(chunk);});child.stderr.on("data",chunk=>{errors+=String(chunk);});
const timeout=setTimeout(()=>{
  if(process.platform !== "win32" && child.pid)try{process.kill(-child.pid,"SIGTERM");}catch{}
  else child.kill("SIGTERM");
},30000);
try {
  const exit=await new Promise<number|null>((resolve,reject)=>{child.on("exit",resolve);child.on("error",reject);});
  assert.equal(exit,0,providerError?.message || errors.slice(-2000));
  assert.equal(providerError,undefined);assert.equal(requests,2);assert.equal(observedBinding,true);
  const events=output.trim().split("\n").map(line=>JSON.parse(line));
  const thread=events.find(e=>e.type === "thread.started")?.thread_id;
  assert.ok(thread,"Codex did not emit its real thread ID");
  const store=new Store(resolveProject(project,state));
  try {
    assert.equal(store.agent("codex-fixture")?.session_id,thread);
    assert.equal(store.all("SELECT * FROM sessions").length,0,"No hook or inherited session mapping was used");
  } finally {store.close();}
  console.log(JSON.stringify({passed:true,client:"installed codex exec",thread_id:thread,binding:"native MCP tools/call _meta.threadId",provider:"loopback fixture",provider_requests:requests,external_model_requests:0}));
} finally {
  clearTimeout(timeout);provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));
  fs.rmSync(root,{recursive:true,force:true});
}
