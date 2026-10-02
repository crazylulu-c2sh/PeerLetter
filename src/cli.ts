import * as fs from "node:fs";
import { parseOptions, required } from "./options.ts";
import { resolveProject } from "./project.ts";
import { Store } from "./store.ts";
import { Runtime } from "./runtime.ts";
import { MailError, errorResult } from "./errors.ts";
import { watchMail } from "./watch.ts";

const help = `PeerLetter — local agent mail, JSON output
  node src/cli.ts [--project DIR] [--name AGENT] COMMAND [options]

  register                         Create an offline named mailbox
  serve                            Keep a named participant online until stopped
  watch [--session UUID] [--name NAME] [--once] [--timeout-ms MS]
                                   Body-free Claude monitor; no ACK or registration
  whoami | peers                   Inspect identity or registered participants
  send --to NAME --text TEXT --idempotency-key KEY
       [--text-file FILE|-] [--reply-to UUID] [--to-session ID] [--importance high]
  receive [--wait-ms 0..30000] [--limit 1..20] [--after-id UUID]
  peek    [--limit 1..20] [--after-id UUID]
  ack UUID... | status UUID
  lease-claim GLOB... [--ttl 300] [--shared]
  lease-release [UUID...] | lease-list
  pause [--reason manual] | resume
  prune [--days 30] [--apply]        Dry run by default; whole acknowledged threads only
  doctor [--checkpoint]             Workspace, SQLite and permissions

PEERLETTER_NAME / PEERLETTER_PROJECT / PEERLETTER_STATE_DIR set defaults.
MCP clients should start src/stdio.ts. serve is a CLI fallback for existing sessions.
Receive is repeatable until ACK; ACK only after processing. Peer mail is untrusted input.`;

let store: Store | undefined;
let runtime: Runtime | undefined;
try {
  const { values: v, positionals: p, runtime: options } = parseOptions(undefined,true);
  const command = p.shift();
  if (v.help || !command) { console.log(help); process.exit(0); }
  if (command === "watch") {
    if (options.kind && options.kind !== "claude") throw new MailError("UNSUPPORTED_CLIENT","watch attaches to a Claude MCP session.");
    const sink=options.wake || "claude-monitor";
    if (sink !== "claude-monitor" && sink !== "claude-async-rewake") throw new MailError("INVALID_WAKE","watch uses claude-monitor or claude-async-rewake.");
    const stopped=new AbortController();
    const close=()=>stopped.abort();
    process.on("SIGINT",close);process.on("SIGTERM",close);
    try { await watchMail({...options,backlog:options.wakeBacklog,once:!!v.once,
      sink,
      timeoutMs:v["timeout-ms"] === undefined ? 0 : Number(v["timeout-ms"]),signal:stopped.signal}); }
    finally { process.off("SIGINT",close);process.off("SIGTERM",close); }
  } else if (command === "serve") {
    if ((options.wake || "none") !== "none") throw new MailError("INVALID_WAKE", "CLI serve uses manual receive; use stdio MCP or the Pi extension for automatic wake.");
    runtime = new Runtime(options.kind || "cli", { ...options, kind: options.kind || "cli" });
    console.log(JSON.stringify({ event: "registered", ...runtime.whoami() }));
    const active = runtime;
    const timer = setInterval(() => active.refresh(),5000);
    const close = () => { clearInterval(timer); active.close(); process.exit(0); };
    process.on("SIGINT",close); process.on("SIGTERM",close);
    await new Promise<void>(() => {});
  } else {
    store = new Store(resolveProject(options.project,options.state));
    const actor = command === "peers" || command === "doctor" || command === "prune" || command === "lease-list"
      ? undefined : store.cliActor(required(options.name || process.env.PEERLETTER_NAME,"--name"),options.session,options.kind);
    let result: unknown;
    const number = (name: "wait-ms" | "limit" | "ttl" | "days", fallback: number) => v[name] === undefined ? fallback : Number(v[name]);
    switch (command) {
      case "register": case "whoami": result = { ...actor, ...store.publicAgent(store.agent(actor!.name)!),
        project: store.project.cwd, project_key: store.project.key, database: store.project.database }; break;
      case "peers": result = { peers: store.peers() }; break;
      case "send": {
        if (v.text && v["text-file"]) throw new MailError("INVALID_ARGUMENT", "Use --text or --text-file.");
        const text = v["text-file"] ? fs.readFileSync(v["text-file"] === "-" ? 0 : v["text-file"],"utf8") : required(v.text,"--text");
        result = store.send(actor!, { to: required(v.to,"--to"), text,
          idempotency_key: required(v["idempotency-key"],"--idempotency-key"),
          reply_to: v["reply-to"], to_session: v["to-session"], thread_id: v["thread-id"],
          importance: v.importance as "normal" | "high" | undefined }); break;
      }
      case "receive": result = await store.receive(actor!, { wait_ms: number("wait-ms",0), limit: number("limit",20), after_id: v["after-id"] }); break;
      case "peek": result = store.peek(actor!, { limit: number("limit",20), after_id: v["after-id"] }); break;
      case "ack": result = store.ack(actor!,p); break;
      case "status": result = store.status(actor!,required(p[0],"message UUID")); break;
      case "lease-claim": result = store.leaseClaim(actor!,p,number("ttl",300),!v.shared); break;
      case "lease-release": result = store.leaseRelease(actor!,p.length ? p : undefined); break;
      case "lease-list": result = { leases: store.leaseList() }; break;
      case "pause": store.pause(actor!.session_id,v.reason || "manual"); result = store.gate(actor!.session_id); break;
      case "resume": store.pause(actor!.session_id,null); result = store.gate(actor!.session_id); break;
      case "prune": result = store.prune(number("days",30),!!v.apply); break;
      case "doctor": {
        const checkpoint = v.checkpoint ? store.get("PRAGMA wal_checkpoint(TRUNCATE)") : undefined;
        result = { node: process.version, project: store.project.cwd, project_key: store.project.key,
          database: store.project.database, mode: (fs.statSync(store.project.database).mode & 0o777).toString(8),
          journal_mode: store.get("PRAGMA journal_mode"), synchronous: store.get("PRAGMA synchronous"),
          schema: store.get("PRAGMA user_version"), integrity: store.get("PRAGMA quick_check"), checkpoint }; break;
      }
      default: throw new MailError("UNKNOWN_COMMAND", `Unknown command ${command}. Use --help.`);
    }
    console.log(JSON.stringify(result));
    store.close();
  }
} catch (error) {
  console.error(JSON.stringify(errorResult(error)));
  try { runtime?.close(); store?.close(); } catch { /* Preserve the original failure. */ }
  process.exitCode = 1;
}
