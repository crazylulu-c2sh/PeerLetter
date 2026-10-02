import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { readJson, mergeHooks, mergeToml, quoteShell, writeWithBackup } from "./install.ts";
import { MailError, errorResult } from "../src/errors.ts";

const repo=fileURLToPath(new URL("../",import.meta.url));
const json=(value:unknown)=>JSON.stringify(value,null,2)+"\n";
const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
type Client="codex"|"claude"|"pi";
type Write={file:string;data:string};
type Link={file:string;target:string};
type Command={command:string;args:string[]};
export interface GlobalOptions {client?:string;home?:string;checkout?:string;node?:string;codexHome?:string;claudeHome?:string;piHome?:string;stateHome?:string}
interface RecordEntry {
  checkout:string;node:string;writes:Write[];links:Link[];commands:Command[];
  config:string;hookfile?:string;extension?:string;skill?:string;root?:string;pluginId?:string;catalog?:string;
  addedExtension?:boolean;addedSkill?:boolean;
}
function roots(o:GlobalOptions) {
  const home=o.home || process.env.HOME;
  if (!home || !path.isAbsolute(home)) throw new MailError("INVALID_CONFIG","HOME must be an absolute directory.");
  return {home,codex:o.codexHome || (!o.home && process.env.CODEX_HOME) || path.join(home,".codex"),
    claude:o.claudeHome || (!o.home && process.env.CLAUDE_CONFIG_DIR) || path.join(home,".claude"),
    pi:o.piHome || (!o.home && process.env.PI_CODING_AGENT_DIR) || path.join(home,".pi/agent"),
    state:o.stateHome || (!o.home && process.env.XDG_STATE_HOME) || path.join(home,".local/state")};
}
function clients(client="all"):Client[] {
  if (client === "all") return ["codex","claude","pi"];
  if (!["codex","claude","pi"].includes(client)) throw new MailError("INVALID_ARGUMENT","Choose claude, codex, pi or all.");
  return [client as Client];
}
function checkLink(link:Link) {
  try {
    const stat=fs.lstatSync(link.file);
    if (!stat.isSymbolicLink() || path.resolve(path.dirname(link.file),fs.readlinkSync(link.file)) !== link.target)
      throw new MailError("CONFIG_EXISTS",`${link.file} is not this checkout's skill link.`);
  } catch(error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;}
}
function list(config:Record<string,any>,key:string):string[] {
  const value=config[key] ?? [];
  if (!Array.isArray(value) || value.some(v=>typeof v !== "string")) throw new MailError("INVALID_CONFIG",`${key} must be a string array.`);
  return value;
}
function removeHook(config:Record<string,any>,command:string) {
  const copy=structuredClone(config);
  for (const [event,groups] of Object.entries(copy.hooks || {})) {
    if (!Array.isArray(groups)) throw new MailError("INVALID_CONFIG",`Invalid ${event} hooks.`);
    copy.hooks[event]=groups.map(g=>({...g,hooks:g.hooks?.filter((h:any)=>h.command !== command)})).filter(g=>g.hooks?.length);
    if (!copy.hooks[event].length) delete copy.hooks[event];
  }
  return copy;
}

// Build the entire plan before writing anything. Reuse the project installer's
// merge and private-backup operations; global entries never pin a project/name.
export function globalInstallation(o:GlobalOptions={}) {
  const r=roots(o),checkout=fs.realpathSync(o.checkout || repo),node=fs.realpathSync(o.node || process.execPath);
  const manifest=path.join(r.state,"peerletter/installation.json"),previous=readJson(manifest);
  if (previous.version !== undefined && previous.version !== 1) throw new MailError("INVALID_CONFIG","Unknown installation manifest version.");
  const entries:Partial<Record<Client,RecordEntry>>={};
  for (const kind of clients(o.client)) {
    const old=previous.clients?.[kind] as RecordEntry|undefined;
    if (old && old.checkout !== checkout) throw new MailError("CONFIG_EXISTS",`Uninstall ${kind} from ${old.checkout} before switching checkouts.`);
    const expectedConfig=kind === "codex" ? path.join(r.codex,"config.toml") : kind === "pi" ? path.join(r.pi,"settings.json") : path.join(r.claude,"peerletter.json");
    if (old && old.config !== expectedConfig) throw new MailError("CONFIG_EXISTS",`Uninstall ${kind} from ${old.config} before changing its user configuration directory.`);
    const args=[path.join(checkout,"src/stdio.ts"),"--kind",kind,"--wake",kind === "codex" ? "codex-queue" : "claude-monitor"];
    const writes:Write[]=[],links:Link[]=[],commands:Command[]=[];
    let entry:RecordEntry;
    if (kind === "codex") {
      const config=path.join(r.codex,"config.toml"),hookfile=path.join(r.codex,"hooks.json");
      const snippet=`# BEGIN PeerLetter\n[mcp_servers.peerletter]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify(args)}\nenv_vars = ["PEERLETTER_NAME", "CODEX_THREAD_ID", "CODEX_HOME", "PEERLETTER_CODEX_SOCKET", "PEERLETTER_STATE_DIR"]\nstartup_timeout_sec = 10\ntool_timeout_sec = 45\n# END PeerLetter\n`;
      const hooks=old ? removeHook(readJson(hookfile),`${quoteShell(old.node)} ${quoteShell(path.join(old.checkout,"hooks/hook.ts"))} codex`) : readJson(hookfile);
      writes.push({file:config,data:mergeToml(fs.existsSync(config)?fs.readFileSync(config,"utf8"):"",snippet)},
        {file:hookfile,data:json(mergeHooks(hooks,kind,node,checkout))});
      links.push({file:path.join(r.home,".agents/skills/peerletter"),target:path.join(checkout,"skills/peerletter")});
      entry={checkout,node,writes,links,commands,config,hookfile};
    } else if (kind === "pi") {
      const config=path.join(r.pi,"settings.json"),settings=readJson(config);
      const extension=path.join(r.pi,"peerletter-extension.ts"),skill=path.join(checkout,"skills/peerletter");
      const addedExtension=old?.addedExtension ?? !list(settings,"extensions").includes(extension);
      const addedSkill=old?.addedSkill ?? !list(settings,"skills").includes(skill);
      settings.extensions=[...new Set([...list(settings,"extensions"),extension])];
      settings.skills=[...new Set([...list(settings,"skills"),skill])];
      // The MCP child uses the validated absolute Node executable even when Pi
      // was started through a different PATH. Pi itself also needs Node 24.18+.
      const wrapper=`import peerletter from ${JSON.stringify(path.join(checkout,"pi/peerletter.ts"))};\nexport default (pi: any) => peerletter(pi, {node:${JSON.stringify(node)}});\n`;
      if (fs.existsSync(extension) && !old) throw new MailError("CONFIG_EXISTS",`${extension} already exists without installer ownership.`);
      writes.push({file:config,data:json(settings)},{file:extension,data:wrapper});
      const manual=readJson(path.join(r.pi,"mcp.json")).mcpServers?.peerletter;
      if (manual) throw new MailError("CONFIG_EXISTS",`Remove the competing PeerLetter entry in ${path.join(r.pi,"mcp.json")} before installing the session-bound extension.`);
      entry={checkout,node,writes,links,commands,config,extension,skill,addedExtension,addedSkill};
    } else {
      const root=path.join(r.claude,"peerletter-plugin"),config=path.join(r.claude,"peerletter.json");
      const catalog=`peerletter-user-${digest(checkout).slice(0,16)}`,pluginId=`peerletter@${catalog}`;
      if (fs.existsSync(path.join(root,".claude-plugin/plugin.json")) && !old) throw new MailError("CONFIG_EXISTS",`${root} already exists without installer ownership.`);
      const plugin={name:"peerletter",version:"0.1.0",description:"Local agent mail and Claude wake",author:{name:"PeerLetter"},
        mcpServers:{peerletter:{type:"stdio",command:node,args}},hooks:mergeHooks({},kind,node,checkout,"claude-monitor").hooks,
        experimental:{monitors:[{name:"peerletter-inbox",description:"PeerLetter inbox",when:"always",
          command:`${quoteShell(node)} ${quoteShell(path.join(checkout,"src/cli.ts"))} --kind claude watch`}]}};
      writes.push({file:config,data:json({wake:"claude-monitor"})},
        {file:path.join(root,".claude-plugin/plugin.json"),data:json(plugin)},
        {file:path.join(root,".claude-plugin/marketplace.json"),data:json({name:catalog,owner:{name:"PeerLetter"},plugins:[{name:"peerletter",source:"./",description:"Private local PeerLetter installation"}]})},
        {file:path.join(root,"skills/peerletter/SKILL.md"),data:fs.readFileSync(path.join(checkout,"skills/peerletter/SKILL.md"),"utf8")});
      commands.push({command:"claude",args:["plugin","marketplace","add",root]},
        {command:"claude",args:["plugin","install",pluginId,"--scope","user"]});
      entry={checkout,node,writes,links,commands,config,root,pluginId,catalog};
    }
    links.forEach(checkLink);
    entries[kind]=entry;
  }
  return {manifest,previous,entries};
}

export function uninstallPlan(o:GlobalOptions={}) {
  const r=roots(o),manifest=path.join(r.state,"peerletter/installation.json"),previous=readJson(manifest);
  if (previous.version !== undefined && previous.version !== 1) throw new MailError("INVALID_CONFIG","Unknown installation manifest version.");
  const writes:Write[]=[],remove:string[]=[],commands:Command[]=[],removed:Client[]=[],retained:string[]=[];
  for (const kind of clients(o.client)) {
    const entry=previous.clients?.[kind] as RecordEntry|undefined;
    if (!entry) continue;
    if (kind === "codex") {
      const existing=fs.existsSync(entry.config)?fs.readFileSync(entry.config,"utf8"):"";
      const managed=existing.match(/# BEGIN PeerLetter\n[\s\S]*?# END PeerLetter\n?/);
      const original=entry.writes.find(w=>w.file === entry.config)?.data.match(/# BEGIN PeerLetter\n[\s\S]*?# END PeerLetter\n?/);
      if (managed && managed[0] !== original?.[0]) throw new MailError("CONFIG_CHANGED",`Managed MCP block changed: ${entry.config}. Inspect it before uninstalling.`);
      if (managed) writes.push({file:entry.config,data:existing.replace(managed[0],"")});
      const hooks=removeHook(readJson(entry.hookfile!),`${quoteShell(entry.node)} ${quoteShell(path.join(entry.checkout,"hooks/hook.ts"))} codex`);
      if (fs.existsSync(entry.hookfile!)) writes.push({file:entry.hookfile!,data:json(hooks)});
    } else if (kind === "pi") {
      const settings=readJson(entry.config);
      if (entry.addedExtension) settings.extensions=list(settings,"extensions").filter(e=>e !== entry.extension);
      if (entry.addedSkill) settings.skills=list(settings,"skills").filter(e=>e !== entry.skill);
      if (fs.existsSync(entry.config)) writes.push({file:entry.config,data:json(settings)});
    } else {
      // Silence an already running monitor before plugin uninstall. New plugin
      // sessions stop loading it; backups remain available for inspection.
      writes.push({file:entry.config,data:json({wake:"none"})});
      commands.push({command:"claude",args:["plugin","uninstall",entry.pluginId!,"--scope","user"]},
        {command:"claude",args:["plugin","marketplace","remove",entry.catalog!]});
    }
    for (const link of entry.links) {checkLink(link);if (fs.existsSync(link.file)) remove.push(link.file);}
    for (const w of entry.writes) {
      if (w.file === entry.config || w.file === entry.hookfile || !fs.existsSync(w.file)) continue;
      if (fs.readFileSync(w.file,"utf8") === w.data) remove.push(w.file);else retained.push(w.file);
    }
    removed.push(kind);
  }
  return {manifest,previous,writes,remove,commands,removed,retained};
}

function snapshot(file:string) {
  if (!fs.existsSync(file)) return {file,existed:false};
  const backup=`${file}.backup-${Date.now()}-${digest(String(Math.random())).slice(0,8)}`;
  fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);
  return {file,existed:true,backup};
}
export function localConflicts(cwd:string) {
  return [".codex/config.toml",".codex/hooks.json",".mcp.json",".claude/settings.local.json",".claude/peerletter.json",".pi/mcp.json",".pi/settings.json"]
    .map(f=>path.join(cwd,f)).filter(f=>fs.existsSync(f) && /peerletter/i.test(fs.readFileSync(f,"utf8")));
}
export function applyGlobal(o:GlobalOptions={},uninstall=false,run:(c:Command)=>unknown=(c)=>execFileSync(c.command,c.args,{encoding:"utf8",stdio:c.args[0] === "--version" ? "pipe" : "inherit",timeout:30000})) {
  const plan=uninstall ? uninstallPlan(o) : globalInstallation(o);
  const commands=uninstall ? (plan as ReturnType<typeof uninstallPlan>).commands : Object.values((plan as ReturnType<typeof globalInstallation>).entries).flatMap(e=>e!.commands);
  if (commands.length) {
    const version=String(run({command:"claude",args:["--version"]}));
    const match=version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!uninstall && (!match || Number(match[1])<2 || Number(match[1])===2 && (Number(match[2])<1 || Number(match[2])===1 && Number(match[3])<283)))
      throw new MailError("UNSUPPORTED_CLIENT","Claude monitor plugin requires Claude Code 2.1.283+.");
  }
  const r=roots(o),backups:unknown[]=[];
  if (commands.length) for (const relative of ["settings.json","plugins/known_marketplaces.json","plugins/installed_plugins.json"])
    backups.push(snapshot(path.join(r.claude,relative)));
  const config=structuredClone(plan.previous);config.version=1;config.clients ||= {};
  if (uninstall) {
    const p=plan as ReturnType<typeof uninstallPlan>;
    for (const w of p.writes) backups.push({file:w.file,backup:writeWithBackup(w.file,w.data)});
    // Keep ownership until external uninstall succeeds, so a failure is retryable.
    commands.forEach(run);
    p.remove.forEach(file=>fs.unlinkSync(file));
    p.removed.forEach(kind=>delete config.clients[kind]);
    writeWithBackup(p.manifest,json(config));
    return {uninstalled:p.removed,retained_edited_files:p.retained,backups};
  }
  const p=plan as ReturnType<typeof globalInstallation>;
  // Record the recoverable plan before external CLI writes. A failed plugin
  // installation can be retried or removed using the same owned manifest.
  Object.assign(config.clients,p.entries);writeWithBackup(p.manifest,json(config));
  for (const e of Object.values(p.entries)) {
    for (const w of e!.writes) backups.push({file:w.file,backup:writeWithBackup(w.file,w.data)});
    for (const link of e!.links) {
      fs.mkdirSync(path.dirname(link.file),{recursive:true,mode:0o700});
      try {fs.lstatSync(link.file);} catch {fs.symlinkSync(link.target,link.file,"dir");}
    }
  }
  commands.forEach(run);
  const checkout=o.checkout || repo;
  const workspaceDoctor=JSON.parse(execFileSync(o.node || process.execPath,[path.join(checkout,"src/cli.ts"),"--project",process.cwd(),"doctor"],{
    encoding:"utf8",timeout:10000,env:{...process.env,HOME:r.home,PEERLETTER_STATE_DIR:path.join(r.state,"peerletter")}}));
  const doctor=Object.entries(p.entries).map(([client,e])=>({client,
    files:e!.writes.every(w=>fs.existsSync(w.file) && fs.readFileSync(w.file,"utf8") === w.data),
    skills:e!.links.every(l=>fs.existsSync(l.file)),node:e!.node}));
  return {installed:Object.keys(p.entries),manifest:p.manifest,backups,doctor,workspace_doctor:workspaceDoctor,project_conflicts:localConflicts(process.cwd()),
    next:{claude:"Approve the local plugin if prompted; /reload-plugins or restart for a first install. Restart Claude to load updates to an existing MCP runtime; plugin reload does not reliably respawn it. Ask Claude to use PeerLetter, then inspect whoami.wake_runner.online. Monitor requires an interactive supported provider. /resume and /clear follow the same live host session.",
      codex:"Review /hooks. Reconnect MCP or start a new session, then ask Codex to use PeerLetter: its first whoami binds the actual thread and enables queue wake. /mcp only shows status; restart a shared daemon only when you intend to disconnect its clients.",
      pi:"/reload or restart. Global extensions/skills load before project trust; no project trust bypass is installed. Pi itself needs Node 24.18+. Ask Pi to use PeerLetter.",
      duplicates:"If project_conflicts is nonempty, remove or disable only your old PeerLetter project entries with backups before joining. Keep other settings. Global setup deliberately does not edit project files."}};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values:v}=parseArgs({options:{client:{type:"string"},node:{type:"string"},preview:{type:"boolean"},uninstall:{type:"boolean"}}});
    const o={client:v.client,node:v.node};
    console.log(json(v.preview ? (v.uninstall?uninstallPlan(o):globalInstallation(o)) : applyGlobal(o,!!v.uninstall)));
  } catch(error) {console.error(json(errorResult(error)));process.exitCode=1;}
}
