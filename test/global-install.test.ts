import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { globalInstallation, applyGlobal, uninstallPlan } from "../scripts/global-install.ts";
import { appliedReport, planReport } from "../scripts/setup-report.ts";
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

test("installed selects only recorded agents and reports when nothing is installed",t=>{
  const {home}=fixture(t);
  assert.deepEqual(Object.keys(globalInstallation({home,client:"installed"}).entries),[]);
  const empty=applyGlobal({home,client:"installed"},false,stub);
  assert.deepEqual(empty.installed,[]);assert.match(String(empty.next),/setup claude\|codex\|pi\|all/);
  assert.equal(fs.existsSync(path.join(home,".local/state/peerletter/installation.json")),false);
  applyGlobal({home,client:"codex"},false,stub);
  assert.deepEqual(Object.keys(globalInstallation({home,client:"installed"}).entries),["codex"]);
  assert.deepEqual(applyGlobal({home,client:"installed"},false,stub).installed,["codex"]);
  assert.deepEqual(uninstallPlan({home,client:"installed"}).removed,["codex"]);
});

test("setup update fast-forwards, finishes with the updated setup and refuses unsafe checkouts unchanged",{timeout:30000},t=>{
  const {root,home}=fixture(t),remote=path.join(root,"remote.git"),checkout=path.join(root,"checkout"),other=path.join(root,"other");
  const git=(cwd:string,...args:string[])=>execFileSync("git",["-c","user.name=fixture","-c","user.email=fixture@example.invalid",...args],
    {cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
  const env:NodeJS.ProcessEnv={...process.env,HOME:home,CODEX_HOME:path.join(home,".codex"),CLAUDE_CONFIG_DIR:path.join(home,".claude"),
    PI_CODING_AGENT_DIR:path.join(home,".pi/agent"),XDG_STATE_HOME:path.join(home,".local/state"),PEERLETTER_NODE:process.execPath};
  delete env.PEERLETTER_SETUP_PULLED;
  const setup=(dir:string,...args:string[])=>spawnSync(path.join(dir,"setup"),args,{cwd:root,env,encoding:"utf8"});
  git(root,"init","-q","--bare","-b","main",remote);git(root,"clone","-q",remote,checkout);
  fs.copyFileSync(path.join(repo,"setup"),path.join(checkout,"setup"));
  for (const dir of ["scripts","src"]) fs.cpSync(path.join(repo,dir),path.join(checkout,dir),{recursive:true});
  git(checkout,"add","-A");git(checkout,"commit","-qm","initial");git(checkout,"push","-q","-u","origin","HEAD");
  const initial=git(checkout,"rev-parse","HEAD");

  const current=setup(checkout,"update","--preview","--json");assert.equal(current.status,0,current.stderr);
  assert.match(current.stderr,/up to date/);assert.deepEqual(JSON.parse(current.stdout).entries,{},"--json keeps stdout pure JSON");
  const readable=setup(checkout,"update","--preview");assert.equal(readable.status,0,readable.stderr);
  assert.match(readable.stdout,/up to date/);assert.match(readable.stdout,/Nothing is installed for your user/);

  // Upstream replaces setup with a stub, so the run after the merge proves which script finishes.
  git(root,"clone","-q",remote,other);
  fs.writeFileSync(path.join(other,"setup"),'#!/usr/bin/env bash\nprintf "updated setup: %s %s\\n" "$*" "${PEERLETTER_SETUP_PULLED:-}"\n');
  git(other,"commit","-qam","Upstream change");git(other,"push","-q");
  const upstream=git(other,"rev-parse","HEAD");

  fs.appendFileSync(path.join(checkout,"src/errors.ts"),"// local edit\n");
  const dirty=setup(checkout,"update");assert.equal(dirty.status,1);assert.match(dirty.stderr,/local changes/);
  git(checkout,"checkout","--","src/errors.ts");
  git(checkout,"switch","-q","-c","local");
  const unpublished=setup(checkout,"update");assert.equal(unpublished.status,1);assert.match(unpublished.stderr,/no upstream/);
  git(checkout,"switch","-q","main");
  fs.writeFileSync(path.join(checkout,"local.txt"),"local\n");git(checkout,"add","local.txt");git(checkout,"commit","-qm","Local change");
  const ahead=setup(checkout,"update");assert.equal(ahead.status,1);assert.match(ahead.stderr,/not on origin\/main/);
  git(checkout,"reset","-q","--hard",initial);
  assert.equal(git(checkout,"rev-parse","HEAD"),initial,"Refusals must not move the checkout");

  const preview=setup(checkout,"update","--preview");assert.equal(preview.status,0,preview.stderr);
  assert.match(preview.stdout,/would update/);assert.match(preview.stdout,/Upstream change/);
  assert.equal(git(checkout,"rev-parse","HEAD"),initial);

  const updated=setup(checkout,"update");assert.equal(updated.status,0,updated.stderr);
  assert.equal(git(checkout,"rev-parse","HEAD"),upstream);
  assert.match(updated.stdout,/updated [0-9a-f]+ -> [0-9a-f]+/);assert.match(updated.stdout,/updated setup: update 1/);

  const plain=path.join(root,"plain");fs.mkdirSync(plain);fs.copyFileSync(path.join(repo,"setup"),path.join(plain,"setup"));
  const notClone=setup(plain,"update");assert.equal(notClone.status,1);assert.match(notClone.stderr,/git clone/);
  assert.equal(setup(plain,"--uninstall","update").status,1);
});

test("setup prints readable install, preview, refresh and uninstall reports",t=>{
  const {home}=fixture(t),previous=process.env.HOME;process.env.HOME=home;
  t.after(()=>{process.env.HOME=previous;});
  const preview=planReport(globalInstallation({home}));
  assert.match(preview,/^setup would install: Claude, Codex, Pi \(preview: nothing has been changed\)$/m);
  assert.match(preview,/^  create {4}~\/\.codex\/config\.toml$/m);assert.match(preview,/^  run {7}claude plugin install peerletter@/m);
  const installed=appliedReport(applyGlobal({home},false,stub));
  assert.match(installed,/^PeerLetter installed: Claude, Codex, Pi$/m);
  assert.match(installed,/^  ok {8}Codex: settings, generated files and skill are in place\.$/m);
  assert.match(installed,/^  ok {8}Workspace database integrity: ok\n {12}project {3}.+\n {12}database {2}.+peerletter\.db$/m);
  assert.match(installed,/^Backups \(private copies of files that changed\)$/m);
  assert.match(installed,/^Next$/m);assert.match(installed,/^  Claude {4}Approve the local plugin/m);
  assert.match(planReport(globalInstallation({home})),/^  unchanged ~\/\.codex\/config\.toml$/m);
  assert.match(planReport(globalInstallation({home,client:"installed"}),"installed"),/^setup update would refresh: Claude, Codex, Pi/);
  assert.match(appliedReport(applyGlobal({home,client:"installed"},false,stub),true),/^PeerLetter refreshed: Claude, Codex, Pi$/m);
  assert.match(planReport(uninstallPlan({home})),/^setup --uninstall would remove: Claude, Codex, Pi/);
  assert.match(appliedReport(applyGlobal({home},true,stub)),/^PeerLetter removed: Claude, Codex, Pi$/m);
  assert.match(appliedReport(applyGlobal({home},true,stub)),/^Nothing to remove/);
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
