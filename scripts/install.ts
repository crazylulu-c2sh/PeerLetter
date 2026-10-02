import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { MailError, errorResult, validName } from "../src/errors.ts";

const repo = fileURLToPath(new URL("../",import.meta.url));
export const quoteShell = (s: string) => "'" + s.replaceAll("'","'\"'\"'") + "'";
const json = (data: unknown) => JSON.stringify(data,null,2)+"\n";
export function readJson(file: string): Record<string,any> {
  if (!fs.existsSync(file)) return {};
  const result = JSON.parse(fs.readFileSync(file,"utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new MailError("INVALID_CONFIG",`${file} must contain a JSON object.`);
  return result;
}
export function mergeHooks(config: Record<string,any>, kind: string, node: string, checkout: string) {
  const copy = structuredClone(config);
  copy.hooks ||= {};
  const events = kind === "codex" ? ["SessionStart","Stop","UserPromptSubmit","Interrupt"]
    : ["SessionStart","Stop","PostToolUse","UserPromptSubmit","StopFailure"];
  const command = `${quoteShell(node)} ${quoteShell(path.join(checkout,"hooks/hook.ts"))} ${kind}`;
  for (const event of events) {
    const existing = copy.hooks[event] || [];
    if (!Array.isArray(existing)) throw new MailError("INVALID_CONFIG",`${event} hooks must be an array.`);
    const groups = existing.map((group:any)=> ({...group,hooks:group.hooks?.filter((hook:any)=>hook.command !== command)}))
      .filter((group:any)=>group.hooks?.length);
    copy.hooks[event] = [...groups,{ hooks: [{type:"command",command,timeout:event === "Interrupt" ? 3 : 5}] }];
  }
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
  if(options.wake && options.wake !== "none" && (clients.length !== 1 || ![
    "claude:claude-channel","codex:codex-queue"].includes(`${clients[0]}:${options.wake}`))) {
    throw new MailError("INVALID_WAKE","Use --client claude --wake claude-channel or --client codex --wake codex-queue.");
  }
  const writes: {file:string;data:string}[]=[],links: {file:string;target:string}[]=[];
  const args=[path.join(checkout,"src/stdio.ts"),"--project",project,...(options.name?["--name",options.name]:[]),
    ...(options.wake?["--wake",options.wake]:[])];
  for(const kind of clients) {
    if(kind === "codex") {
      const file=path.join(project,".codex/config.toml");
      const snippet=`# BEGIN PeerLetter\n[mcp_servers.peerletter]\ncommand = ${JSON.stringify(node)}\nargs = ${JSON.stringify([...args,"--kind","codex"])}\nenv_vars = ["PEERLETTER_NAME", "CODEX_THREAD_ID"]\nstartup_timeout_sec = 10\ntool_timeout_sec = 45\n# END PeerLetter\n`;
      writes.push({file,data:mergeToml(fs.existsSync(file)?fs.readFileSync(file,"utf8"):"",snippet)});
      const hookfile=path.join(project,".codex/hooks.json");
      writes.push({file:hookfile,data:json(mergeHooks(readJson(hookfile),kind,node,checkout))});
      links.push({file:path.join(project,".agents/skills/peerletter"),target:path.join(checkout,"skills/peerletter")});
    } else if(kind === "claude") {
      const file=path.join(project,".mcp.json"),config=readJson(file);config.mcpServers ||= {};
      const current=config.mcpServers.peerletter;
      if(current && !current.args?.includes(path.join(checkout,"src/stdio.ts"))) throw new MailError("CONFIG_EXISTS","Existing Claude PeerLetter configuration uses a different checkout.");
      config.mcpServers.peerletter={type:"stdio",command:node,args:[...args,"--kind","claude"]};
      writes.push({file,data:json(config)});
      const hookfile=path.join(project,".claude/settings.local.json");
      writes.push({file:hookfile,data:json(mergeHooks(readJson(hookfile),kind,node,checkout))});
      links.push({file:path.join(project,".claude/skills/peerletter"),target:path.join(checkout,"skills/peerletter")});
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
  for(const link of links) {
    try {
      const stat=fs.lstatSync(link.file);
      if(!stat.isSymbolicLink() || path.resolve(path.dirname(link.file),fs.readlinkSync(link.file)) !== link.target) {
        throw new MailError("CONFIG_EXISTS",`${link.file} already exists; this installer will not replace another skill.`);
      }
    } catch(error) {if((error as NodeJS.ErrnoException).code !== "ENOENT")throw error;}
  }
  return {writes,links};
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {values:v}=parseArgs({options:{project:{type:"string"},client:{type:"string"},name:{type:"string"},
      "pi-mode":{type:"string"},wake:{type:"string"},apply:{type:"boolean"},help:{type:"boolean"}}});
    if(v.help) {console.log("node scripts/install.ts --project DIR [--client all|codex|claude|pi] [--name AGENT] [--pi-mode mcp|extension] [--wake none|claude-channel|codex-queue] [--apply]\nDefault: preview project-local configuration, manual receive. Existing files are backed up before apply.");process.exit(0);}
    const project=fs.realpathSync(v.project || process.cwd());
    const plan=installation(project,{client:v.client,name:v.name,piMode:v["pi-mode"],wake:v.wake});
    if(!v.apply) console.log(json({project,apply:false,...plan}));
    else {
      const backups=plan.writes.map(w=>({file:w.file,backup:writeWithBackup(w.file,w.data)}));
      for(const link of plan.links) {
        fs.mkdirSync(path.dirname(link.file),{recursive:true,mode:0o700});
        if(!fs.existsSync(link.file))fs.symlinkSync(link.target,link.file,"dir");
      }
      console.log(json({project,applied:true,files:backups,skills:plan.links.map(l=>l.file),
        next:"Codex: review /hooks, start a new session, then call peerletter_whoami to bind native thread metadata. Claude: approve project MCP and start a new session. Pi: /trust this project, then /reload (pi -a is one-run trust only)."}));
    }
  } catch(error) {console.error(json(errorResult(error)));process.exitCode=1;}
}
