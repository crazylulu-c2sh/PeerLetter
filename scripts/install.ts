import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { MailError, errorResult, validName } from "../src/errors.ts";
import { claudeWakeFile, externalClaudeWake } from "../src/claude.ts";

const repo = fileURLToPath(new URL("../",import.meta.url));
export const quoteShell = (s: string) => "'" + s.replaceAll("'","'\"'\"'") + "'";
const json = (data: unknown) => JSON.stringify(data,null,2)+"\n";
export function readJson(file: string): Record<string,any> {
  if (!fs.existsSync(file)) return {};
  const result = JSON.parse(fs.readFileSync(file,"utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new MailError("INVALID_CONFIG",`${file} must contain a JSON object.`);
  return result;
}
export function removeClaudeHooks(config: Record<string,any>, node: string, checkout: string) {
  const copy=structuredClone(config);
  const commands=[`${quoteShell(node)} ${quoteShell(path.join(checkout,"hooks/hook.ts"))} claude`,
    `${quoteShell(node)} ${quoteShell(path.join(checkout,"hooks/rewake.ts"))}`];
  for (const [event,groups] of Object.entries(copy.hooks || {})) {
    if (!Array.isArray(groups)) throw new MailError("INVALID_CONFIG",`${event} hooks must be an array.`);
    copy.hooks[event]=groups.map((group:any)=>({...group,hooks:group.hooks?.filter((hook:any)=>!commands.includes(hook.command))}))
      .filter((group:any)=>group.hooks?.length);
    if (!copy.hooks[event].length) delete copy.hooks[event];
  }
  return copy;
}
export function mergeHooks(config: Record<string,any>, kind: string, node: string, checkout: string, wake = "none") {
  const copy = kind === "claude" ? removeClaudeHooks(config,node,checkout) : structuredClone(config);
  copy.hooks ||= {};
  const events = kind === "codex" ? ["SessionStart","Stop","UserPromptSubmit","Interrupt"]
    : ["SessionStart","Stop","PostToolUse","UserPromptSubmit","StopFailure","PostToolUseFailure",
      "PermissionRequest","Elicitation","ElicitationResult","PreCompact","PostCompact","SessionEnd"];
  const command = `${quoteShell(node)} ${quoteShell(path.join(checkout,"hooks/hook.ts"))} ${kind}`;
  for (const event of events) {
    const existing = copy.hooks[event] || [];
    if (!Array.isArray(existing)) throw new MailError("INVALID_CONFIG",`${event} hooks must be an array.`);
    const groups = existing.map((group:any)=> ({...group,hooks:group.hooks?.filter((hook:any)=>hook.command !== command)}))
      .filter((group:any)=>group.hooks?.length);
    copy.hooks[event] = [...groups,{ hooks: [{type:"command",command,timeout:event === "Interrupt" ? 3 : 5}] }];
  }
  if (kind === "claude" && wake === "claude-async-rewake") copy.hooks.Stop.push({hooks:[{
    type:"command",command:`${quoteShell(node)} ${quoteShell(path.join(checkout,"hooks/rewake.ts"))}`,
    timeout:600,asyncRewake:true,
  }]});
  return copy;
}
export function mergeToml(existing: string, snippet: string): string {
  const start = "# BEGIN PeerLetter",end = "# END PeerLetter";
  if (existing.includes(start) || existing.includes(end)) {
    const begin = existing.indexOf(start),finish = existing.indexOf(end);
    if (begin < 0 || finish < begin || existing.indexOf(start,begin+1)>=0 || existing.indexOf(end,finish+1)>=0) {
      throw new MailError("INVALID_CONFIG","Invalid PeerLetter managed block; inspect config.toml.");
    }
    return existing.slice(0,begin)+snippet+existing.slice(finish+end.length).replace(/^\r?\n/,"");
  }
  if (/^\s*\[\s*mcp_servers\.(?:peerletter|"peerletter"|'peerletter')(?:\.|\s*\])/m.test(existing)) {
    throw new MailError("CONFIG_EXISTS","An existing PeerLetter MCP entry is not managed by this installer. Inspect it before replacing it.");
  }
  return existing+(existing.endsWith("\n") || !existing ? "" : "\n")+"\n"+snippet;
}
export function writeWithBackup(file: string, data: string, mode = 0o600) {
  if (fs.existsSync(file) && fs.readFileSync(file,"utf8") === data) return undefined;
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const backup = fs.existsSync(file) ? `${file}.backup-${Date.now()}-${randomUUID().slice(0,8)}` : undefined;
  if (backup) fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
  if (backup) fs.chmodSync(backup,0o600);
  const temp=`${file}.${randomUUID()}.tmp`;
  const fd=fs.openSync(temp,"wx",mode);
  try {fs.writeFileSync(fd,data);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(temp,file);
  return backup;
}

export function installation(project: string, options: { client?: string; name?: string; piMode?: string; wake?: string; checkout?: string; node?: string } = {}) {
  const checkout=options.checkout || repo,node=options.node || process.execPath;
  const clients=options.client && options.client !== "all" ? [options.client] : ["codex","claude","pi"];
  if (clients.some(c=>!["codex","claude","pi"].includes(c))) throw new MailError("INVALID_ARGUMENT","client must be codex, claude, pi or all.");
  if (options.name && clients.length !== 1) throw new MailError("INVALID_ARGUMENT","--name requires a single --client. Default names are assigned separately per live session.");
  if (options.name) validName(options.name);
  if (clients.includes("pi") && options.piMode === "extension" && options.name) {
    throw new MailError("INVALID_ARGUMENT","Pi extension role names use PEERLETTER_NAME when launching Pi; --name configures file MCP entries only.");
  }
  const aliases:Record<string,string>={monitor:"claude-monitor","async-rewake":"claude-async-rewake",channel:"claude-channel"};
  const wake=options.wake && (aliases[options.wake] || options.wake);
  if(wake && wake !== "none" && (clients.length !== 1 || ![
    "claude:claude-monitor","claude:claude-async-rewake","claude:claude-channel","codex:codex-queue"].includes(`${clients[0]}:${wake}`))) {
    throw new MailError("INVALID_WAKE","Use --client claude --wake monitor|async-rewake|channel|none or --client codex --wake codex-queue.");
  }
  const writes: {file:string;data:string}[]=[],links: {file:string;target:string}[]=[];
  const unlinks: {file:string;target:string}[]=[];
  const commands: {command:string;args:string[];cwd:string}[]=[];
  const args=[path.join(checkout,"src/stdio.ts"),"--project",project,...(options.name?["--name",options.name]:[]),
    ...(wake?["--wake",wake]:[])];
  for(const kind of clients) {
    if(kind === "codex") {
      const file=path.join(project,".codex/config.toml");
      const snippet=`# BEGIN PeerLetter\n[mcp_servers.peerletter]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([...args,"--kind","codex"])}\nenv_vars = ["PEERLETTER_NAME", "CODEX_THREAD_ID", "CODEX_HOME", "PEERLETTER_CODEX_SOCKET"]\nstartup_timeout_sec = 10\ntool_timeout_sec = 45\n# END PeerLetter\n`;
      writes.push({file,data:mergeToml(fs.existsSync(file)?fs.readFileSync(file,"utf8"):"",snippet)});
      const hookfile=path.join(project,".codex/hooks.json");
      writes.push({file:hookfile,data:json(mergeHooks(readJson(hookfile),kind,node,checkout))});
      links.push({file:path.join(project,".agents/skills/peerletter"),target:path.join(checkout,"skills/peerletter")});
    } else if(kind === "claude") {
      const file=path.join(project,".mcp.json"),config=readJson(file);config.mcpServers ||= {};
      const current=config.mcpServers.peerletter;
      if(current && !current.args?.includes(path.join(checkout,"src/stdio.ts"))) throw new MailError("CONFIG_EXISTS","Existing Claude PeerLetter configuration uses a different checkout.");
      const hookfile=path.join(project,".claude/settings.local.json");
      const selected=wake || "none";
      const catalog=`peerletter-local-${createHash("sha256").update(project).digest("hex").slice(0,16)}`;
      const pluginId=`peerletter@${catalog}`;
      const skillLink={file:path.join(project,".claude/skills/peerletter"),target:path.join(checkout,"skills/peerletter")};
      writes.push({file:claudeWakeFile(project),data:json({wake:selected})});
      if (externalClaudeWake(selected)) {
        // A private local catalog is installed through Claude's normal plugin path.
        // No project-skill auto-discovery, launch flag or registry publication.
        const root=path.join(project,".claude/peerletter-plugin");
        const manifest={name:"peerletter",version:"0.1.0",description:"Local agent mail and optional Claude wake",
          author:{name:"PeerLetter"},
          mcpServers:{peerletter:{type:"stdio",command:node,args:[...args,"--kind","claude"]}},
          hooks:mergeHooks({},kind,node,checkout,selected).hooks,
          ...(selected === "claude-monitor" ? {experimental:{monitors:[{name:"peerletter-inbox",description:"PeerLetter inbox",
            command:`${quoteShell(node)} ${quoteShell(path.join(checkout,"src/cli.ts"))} --project ${quoteShell(project)} --kind claude watch`,when:"always"}]}} : {}),
        };
        writes.push({file:path.join(root,".claude-plugin/plugin.json"),data:json(manifest)},
          {file:path.join(root,".claude-plugin/marketplace.json"),data:json({name:catalog,description:"Private local PeerLetter catalog",owner:{name:"PeerLetter"},plugins:[{
            name:"peerletter",source:"./",description:"Private local PeerLetter installation"}]})},
          {file:path.join(root,"skills/peerletter/SKILL.md"),data:fs.readFileSync(path.join(checkout,"skills/peerletter/SKILL.md"),"utf8")});
        if(current) {delete config.mcpServers.peerletter;writes.push({file,data:json(config)});}
        const settings=removeClaudeHooks(readJson(hookfile),node,checkout);
        if (current) for (const key of ["enabledMcpjsonServers","disabledMcpjsonServers"]) {
          if (Array.isArray(settings[key])) settings[key]=settings[key].filter((name:string)=>name !== "peerletter");
        }
        writes.push({file:hookfile,data:json(settings)});
        // lstat also detects a dangling link; never replace a different skill.
        try { fs.lstatSync(skillLink.file); unlinks.push(skillLink); }
        catch(error) { if((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        commands.push({command:"claude",args:["plugin","marketplace","add",root],cwd:project},
          {command:"claude",args:["plugin","install",pluginId,"--scope","local"],cwd:project});
      } else {
        config.mcpServers.peerletter={type:"stdio",command:node,args:[...args,"--kind","claude"]};
        writes.push({file,data:json(config)});
        const settings=mergeHooks(readJson(hookfile),kind,node,checkout);
        if (settings.enabledPlugins?.[pluginId] !== undefined) settings.enabledPlugins[pluginId]=false;
        writes.push({file:hookfile,data:json(settings)});
        links.push(skillLink);
      }
    } else {
      const file=path.join(project,".pi/mcp.json"),config=readJson(file);config.mcpServers ||= {};
      const current=config.mcpServers.peerletter;
      if(current && !current.args?.includes(path.join(checkout,"src/stdio.ts"))) throw new MailError("CONFIG_EXISTS","Existing Pi PeerLetter configuration uses a different checkout.");
      if(options.piMode === "extension") {
        // A file entry would override the extension's own session-bound registration.
        if(current) {delete config.mcpServers.peerletter;writes.push({file,data:json(config)});}
        const settingsFile=path.join(project,".pi/settings.json"),settings=readJson(settingsFile);
        const extension=path.join(checkout,"pi/peerletter.ts");
        settings.extensions=[...new Set([...(settings.extensions || []),extension])];
        writes.push({file:settingsFile,data:json(settings)});
      } else if(!options.piMode || options.piMode === "mcp") {
        config.mcpServers.peerletter={command:node,args:[...args,"--kind","pi"],cwd:project,exposure:"direct",timeout:45};
        writes.push({file,data:json(config)});
        const settingsFile=path.join(project,".pi/settings.json");
        if(fs.existsSync(settingsFile)) {
          const settings=readJson(settingsFile);
          if(settings.extensions?.includes(path.join(checkout,"pi/peerletter.ts"))) {
            settings.extensions=settings.extensions.filter((e:any)=>e!==path.join(checkout,"pi/peerletter.ts"));
            writes.push({file:settingsFile,data:json(settings)});
          }
        }
      } else throw new MailError("INVALID_ARGUMENT","pi-mode must be extension or mcp.");
      links.push({file:path.join(project,".pi/skills/peerletter"),target:path.join(checkout,"skills/peerletter")});
    }
  }
  for(const link of [...links,...unlinks]) {
    try {
      const stat=fs.lstatSync(link.file);
      if(!stat.isSymbolicLink() || path.resolve(path.dirname(link.file),fs.readlinkSync(link.file)) !== link.target) {
        throw new MailError("CONFIG_EXISTS",`${link.file} already exists; this installer will not replace another skill.`);
      }
    } catch(error) {if((error as NodeJS.ErrnoException).code !== "ENOENT")throw error;}
  }
  return {writes,links,unlinks,commands};
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values:v}=parseArgs({options:{project:{type:"string"},client:{type:"string"},name:{type:"string"},
      "pi-mode":{type:"string"},wake:{type:"string"},apply:{type:"boolean"},help:{type:"boolean"}}});
    if(v.help) {console.log("node scripts/install.ts --project DIR [--client all|codex|claude|pi] [--name AGENT] [--pi-mode mcp|extension] [--wake none|monitor|async-rewake|channel|codex-queue] [--apply]\nDefault: preview project-local configuration, manual receive. Claude monitor is recommended when opting into wake. Apply backs up settings and installs a private local plugin for monitor/async-rewake.");process.exit(0);}
    const project=fs.realpathSync(v.project || process.cwd());
    const plan=installation(project,{client:v.client,name:v.name,piMode:v["pi-mode"],wake:v.wake});
    if(!v.apply) console.log(json({project,apply:false,...plan}));
    else {
      if(plan.commands.length) {
        const version=execFileSync("claude",["--version"],{encoding:"utf8",timeout:10000});
        const match=version.match(/(\d+)\.(\d+)\.(\d+)/);
        if(!match || Number(match[1])<2 || (Number(match[1])===2 && Number(match[2])===1 && Number(match[3])<283)
          || (Number(match[1])===2 && Number(match[2])<1)) throw new MailError("UNSUPPORTED_CLIENT","Claude plugin wake requires Claude Code 2.1.283 or newer.");
      }
      const backups=plan.writes.map(w=>({file:w.file,backup:writeWithBackup(w.file,w.data)}));
      // Claude's CLI also edits user settings and plugin registries. Snapshot
      // these separately; a missing file is recorded so rollback can remove it.
      const pluginState=plan.commands.length ? ["settings.json","plugins/known_marketplaces.json","plugins/installed_plugins.json"].map(relative=>{
        const file=path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "",".claude"),relative);
        const backup=fs.existsSync(file) ? `${file}.backup-${Date.now()}-${randomUUID().slice(0,8)}` : undefined;
        if(backup) {fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);}
        return {file,backup:backup ?? null,existed:!!backup};
      }) : [];
      for (const link of plan.unlinks) fs.unlinkSync(link.file);
      for(const link of plan.links) {
        fs.mkdirSync(path.dirname(link.file),{recursive:true,mode:0o700});
        if(!fs.existsSync(link.file))fs.symlinkSync(link.target,link.file,"dir");
      }
      for (const command of plan.commands) execFileSync(command.command,command.args,{cwd:command.cwd,stdio:"inherit",timeout:30000});
      console.log(json({project,applied:true,files:backups,plugin_state_backups:pluginState,skills:plan.links.map(l=>l.file),
        next:"Codex: review /hooks, start a new session, then call peerletter_whoami. Claude: /reload-plugins or restart; approve host trust, close competing manual PeerLetter MCP connections and inspect whoami.wake_runner. Monitor/async-rewake need no channel launch flag. Pi: /trust, then /reload."}));
    }
  } catch(error) {console.error(json(errorResult(error)));process.exitCode=1;}
}
