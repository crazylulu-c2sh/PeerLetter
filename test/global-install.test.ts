import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { globalInstallation, applyGlobal, uninstallPlan } from "../scripts/global-install.ts";
import { codexDaemon } from "./codex-fixture.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
const repo=fileURLToPath(new URL("../",import.meta.url));
function fixture(t:test.TestContext) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-global-")),home=path.join(root,"home");fs.mkdirSync(home);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,home};
}
const stub=(c:{command:string;args:string[]})=>c.args[0] === "--version" ? "2.1.287" : "";
const read=(file:string)=>JSON.parse(fs.readFileSync(file,"utf8"));
test("fresh HOME all-client global plan pins Node, installs wake/skills and uninstall preserves unrelated/later settings",t=>{
  const {home}=fixture(t),options={home};
  fs.mkdirSync(path.join(home,".codex"),{recursive:true});
  fs.writeFileSync(path.join(home,".codex/config.toml"),"# user\nmodel='custom'\n");
  fs.writeFileSync(path.join(home,".codex/hooks.json"),JSON.stringify({hooks:{Stop:[{hooks:[{type:"command",command:"unrelated"}]}]}}));
  fs.mkdirSync(path.join(home,".pi/agent"),{recursive:true});
  fs.writeFileSync(path.join(home,".pi/agent/settings.json"),JSON.stringify({extensions:["other.ts"],skills:["other-skill"],theme:"mine"}));
  const plan=globalInstallation(options);assert.equal(Object.keys(plan.entries).length,3);
  const codex=plan.entries.codex!,claude=plan.entries.claude!;
  assert.ok(codex.writes[0].data.includes("codex-queue"));assert.ok(!codex.writes[0].data.includes("--project"));
  const manifest=JSON.parse(claude.writes.find(w=>w.file.endsWith("plugin.json"))!.data);
  assert.equal(manifest.mcpServers.peerletter.command,fs.realpathSync(process.execPath));
  assert.ok(!manifest.mcpServers.peerletter.args.includes("--project"));assert.equal(manifest.experimental.monitors[0].when,"always");
  assert.equal(claude.commands[1].args.at(-1),"user");
  applyGlobal(options,false,stub);
  const again=globalInstallation(options);assert.ok(Object.values(again.entries).every(e=>e!.writes.every(w=>fs.readFileSync(w.file,"utf8") === w.data)));
  assert.equal(fs.statSync(path.join(home,".codex/config.toml")).mode & 0o777,0o600);
  assert.ok(fs.readdirSync(path.join(home,".codex")).some(f=>f.includes("backup")));
  const pi=path.join(home,".pi/agent/settings.json"),settings=read(pi);settings.later=true;fs.writeFileSync(pi,JSON.stringify(settings));
  fs.appendFileSync(path.join(home,".codex/config.toml"),"\n# later\n");
  applyGlobal(options,true,stub);
  assert.equal(fs.readFileSync(path.join(home,".codex/config.toml"),"utf8"),"# user\nmodel='custom'\n\n\n# later\n");
  assert.deepEqual(read(path.join(home,".codex/hooks.json")),{hooks:{Stop:[{hooks:[{type:"command",command:"unrelated"}]}]}});
  assert.deepEqual(read(pi),{extensions:["other.ts"],skills:["other-skill"],theme:"mine",later:true});
  assert.equal(read(path.join(home,".claude/peerletter.json")).wake,"none");
  assert.ok(!fs.existsSync(path.join(home,".agents/skills/peerletter")));
  assert.equal(uninstallPlan(options).removed.length,0);
});

test("global installer rejects foreign config and modified owned Codex blocks before mutation",t=>{
  const {home}=fixture(t),config=path.join(home,".codex/config.toml");fs.mkdirSync(path.dirname(config));
  fs.writeFileSync(config,"[mcp_servers.peerletter]\ncommand='foreign'\n");
  assert.throws(()=>globalInstallation({home,client:"codex"}),/not managed/);
  assert.equal(fs.readFileSync(config,"utf8"),"[mcp_servers.peerletter]\ncommand='foreign'\n");
  fs.unlinkSync(config);applyGlobal({home,client:"codex"},false,stub);
  fs.writeFileSync(config,fs.readFileSync(config,"utf8").replace("codex-queue","none"));
  assert.throws(()=>uninstallPlan({home,client:"codex"}),/block changed/);
});

test("global Pi extension and skill load while project resources stay untrusted",{timeout:15000},async t=>{
  const {root,home}=fixture(t);applyGlobal({home,client:"pi"},false,stub);
  const project=path.join(root,"untrusted");fs.mkdirSync(path.join(project,".pi"),{recursive:true});
  const forbidden=path.join(project,".pi/forbidden.ts");fs.writeFileSync(forbidden,"throw new Error('project extension must not load');");
  fs.writeFileSync(path.join(project,".pi/settings.json"),JSON.stringify({extensions:[forbidden]}));
  const agentDir=path.join(home,".pi/agent"),settingsManager=SettingsManager.create(project,agentDir);settingsManager.setProjectTrusted(false);
  const loader=new DefaultResourceLoader({cwd:project,agentDir,settingsManager,noContextFiles:true});
  const bootstrap=await loader.loadProjectTrustExtensions();
  assert.equal(bootstrap.errors.length,0,JSON.stringify(bootstrap.errors));
  assert.ok(bootstrap.extensions.some(e=>e.path === path.join(agentDir,"peerletter-extension.ts")));
  assert.ok(!bootstrap.extensions.some(e=>e.path === forbidden));
  await loader.reload();assert.ok(loader.getSkills().skills.some(s=>s.name === "peerletter"));
});

test("global Codex uses native calling thread cwd rather than the MCP daemon cwd",{timeout:10000},async t=>{
  const {root,home}=fixture(t),thread=randomUUID(),project=path.join(root,"actual-project"),nested=path.join(project,"nested");fs.mkdirSync(nested,{recursive:true});
  execFileSync("git",["init","-q",project]);
  const daemon=await codexDaemon(t,root,thread);daemon.state.cwd=nested;
  const sdk=new Client({name:"codex",version:"test"}),transport=new StdioClientTransport({command:process.execPath,
    args:[path.join(repo,"src/stdio.ts"),"--kind","codex","--wake","codex-queue"],cwd:home,
    env:{HOME:home,PEERLETTER_STATE_DIR:path.join(root,"state"),PEERLETTER_CODEX_SOCKET:daemon.socket},stderr:"pipe"});
  transport.stderr?.on("data",()=>{});await sdk.connect(transport);t.after(()=>sdk.close());
  const unbound=await sdk.callTool({name:"peerletter_whoami",arguments:{}});
  assert.equal(JSON.parse((unbound.content as {text:string}[])[0].text).error.code,"UNBOUND_SESSION");
  const result=await sdk.callTool({name:"peerletter_whoami",arguments:{},_meta:{threadId:thread}});
  const who=JSON.parse((result.content as {text:string}[])[0].text);assert.equal(result.isError,undefined,JSON.stringify(who));
  assert.equal(who.project,project);assert.equal(who.session_id,thread);assert.equal(who.session_binding.state,"bound");
  assert.ok(daemon.calls.every(c=>c.method !== "thread/read" || c.params.threadId === thread));
});
