import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
// Optional installed-host setup regression. Empty HOME and checkout dependencies,
// real pnpm frozen install and Claude user-plugin CLI; no provider requests.
const repo=fileURLToPath(new URL("../",import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-native-setup-")),home=path.join(root,"home"),checkout=path.join(root,"checkout"),project=path.join(root,"project");
fs.mkdirSync(home);fs.mkdirSync(checkout);fs.mkdirSync(project);
for (const item of ["setup","package.json","pnpm-lock.yaml","src","scripts","hooks","skills","pi"])
  fs.cpSync(path.join(repo,item),path.join(checkout,item),{recursive:true});
execFileSync("git",["init","-q",project]);
const env={...process.env,HOME:home,CODEX_HOME:path.join(home,".codex"),CLAUDE_CONFIG_DIR:path.join(home,".claude"),
  PI_CODING_AGENT_DIR:path.join(home,".pi/agent"),XDG_STATE_HOME:path.join(home,".local/state"),
  PEERLETTER_STATE_DIR:path.join(home,".local/state/peerletter"),PEERLETTER_NODE:process.execPath,COREPACK_ENABLE_DOWNLOAD_PROMPT:"0"};
for (const key of ["PEERLETTER_PROJECT","PEERLETTER_NAME","PEERLETTER_SESSION_ID","CLAUDE_CODE_SESSION_ID","CODEX_THREAD_ID","PEERLETTER_CLAUDE_HOME"])
  delete (env as NodeJS.ProcessEnv)[key];
async function run(args:string[]) {
  const child=spawn(path.join(checkout,"setup"),args,{cwd:project,env,stdio:["ignore","pipe","pipe"]});
  let output="",errors="";child.stdout.on("data",x=>{output+=x;});child.stderr.on("data",x=>{errors+=x;});
  const timeout=setTimeout(()=>child.kill("SIGTERM"),180000);
  try {
    const code=await new Promise((resolve,reject)=>{child.on("exit",resolve);child.on("error",reject);});
    assert.equal(code,0,errors+output.slice(-4000));
    const start=output.indexOf('{\n  "');assert.ok(start>=0,output);
    return JSON.parse(output.slice(start));
  } finally {clearTimeout(timeout);}
}
try {
  const installed=await run(["all"]);assert.deepEqual(installed.installed,["codex","claude","pi"]);
  assert.ok(installed.doctor.every((r:any)=>r.files && r.skills));assert.equal(installed.workspace_doctor.project,project);
  assert.equal(installed.workspace_doctor.integrity.quick_check,"ok");
  const plugins=JSON.parse(execFileSync("claude",["plugin","list","--json"],{env,encoding:"utf8",timeout:10000}));
  const text=JSON.stringify(plugins);assert.ok(text.includes("peerletter@peerletter-user-"));assert.ok(text.includes('"scope":"user"'));
  const reinstalled=await run(["all"]);assert.deepEqual(reinstalled.installed,["codex","claude","pi"]);
  assert.ok(!fs.existsSync(path.join(project,".codex")));assert.ok(!fs.existsSync(path.join(project,".pi")));assert.ok(!fs.existsSync(path.join(project,".claude")));
  const removed=await run(["--uninstall","all"]);assert.deepEqual(removed.uninstalled,["codex","claude","pi"]);
  assert.ok(!fs.readFileSync(path.join(home,".codex/config.toml"),"utf8").includes("mcp_servers.peerletter"));
  assert.ok(!fs.existsSync(path.join(home,".pi/agent/peerletter-extension.ts")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,".claude/peerletter.json"),"utf8")).wake,"none");
  console.log(JSON.stringify({passed:true,fresh_home:true,fresh_checkout_dependencies:true,pnpm:"frozen-lockfile",agents:["claude","codex","pi"],claude_plugin_scope:"user",reinstall:true,uninstall:true,external_model_requests:0}));
} finally {fs.rmSync(root,{recursive:true,force:true});}
