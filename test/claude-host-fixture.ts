// A real ancestor process and stdio MCP transport, with only Claude's documented
// registry and hook inputs simulated. No provider or production settings used.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
process.title="claude-fixture";
const [project,state,home,initial,pin]=process.argv.slice(2),repo=fileURLToPath(new URL("../",import.meta.url));
Object.assign(process.env,{HOME:home,CLAUDE_CONFIG_DIR:path.join(home,".claude"),PEERLETTER_STATE_DIR:state,CLAUDE_CODE_SESSION_ID:initial});
let session=initial;
const registry=path.join(home,".claude/sessions",`${process.pid}.json`);
fs.mkdirSync(path.dirname(registry),{recursive:true});
function writeRegistry(id:string) {fs.writeFileSync(registry,JSON.stringify({sessionId:id,cwd:project}));}
function hook(event:string,id:string) {
  execFileSync(process.execPath,[path.join(repo,"hooks/hook.ts"),"claude"],{env:process.env,
    input:JSON.stringify({hook_event_name:event,session_id:id,cwd:project}),stdio:["pipe","pipe","pipe"]});
}
writeRegistry(initial);hook("SessionStart",initial);
const sdk=new Client({name:"claude-code",version:"fixture"});
const transport=new StdioClientTransport({command:process.execPath,
  args:[path.join(repo,"src/stdio.ts"),"--kind","claude","--wake","claude-monitor",...(pin?["--session",initial]:[])],env:process.env as Record<string,string>,stderr:"pipe"});
transport.stderr?.on("data",()=>{});
await sdk.connect(transport);
const watch=spawn(process.execPath,[path.join(repo,"src/cli.ts"),"--kind","claude","watch"],{env:process.env,stdio:["ignore","pipe","pipe"]});
watch.stdout.on("data",chunk=>process.send?.({notice:String(chunk)}));watch.stderr.on("data",()=>{});
async function who() {const r=await sdk.callTool({name:"peerletter_whoami",arguments:{}});return JSON.parse((r.content as {text:string}[])[0].text);}
process.send?.({ready:await who(),pid:process.pid});
let chain=Promise.resolve();
process.on("message",(m:any)=>{chain=chain.then(async()=>{
  try {
    if (m.transition) {
      if (m.end !== false) hook("SessionEnd",session);
      if (m.registry !== false) writeRegistry(m.transition);
      if (m.hook !== false) hook("SessionStart",m.transition);
      session=m.transition;process.send?.({id:m.id,transitioned:true});
    } else if (m.who) process.send?.({id:m.id,who:await who()});
    else if (m.close) {watch.kill("SIGTERM");await new Promise(r=>watch.once("exit",r));await sdk.close();process.exit(0);}
  } catch(error) {process.send?.({id:m.id,error:String(error)});}
});});
process.on("disconnect",()=>{watch.kill("SIGTERM");void sdk.close().finally(()=>process.exit(0));});
