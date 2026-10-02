import * as fs from "node:fs";
import * as path from "node:path";

export interface ProcessInfo { pid: number; ppid: number; start: string | null; name: string; cwd?: string; state?: string }

export function processInfo(pid: number): ProcessInfo | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const fields = stat.slice(end + 2).split(" ");
    let cwd: string | undefined;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* Not always accessible. */ }
    return { pid, ppid: Number(fields[1]), start: fields[19], name: stat.slice(stat.indexOf("(") + 1, end), cwd, state: fields[0] };
  } catch {
    if (process.platform === "linux") return undefined;
    try { process.kill(pid, 0); return { pid, ppid: pid === process.pid ? process.ppid : 0, start: null, name: "" }; }
    catch { return undefined; }
  }
}

export function isProcessAlive(pid: number | null, start: string | null): boolean {
  if (!pid) return false;
  const info = processInfo(pid);
  return !!info && info.state !== "Z" && info.state !== "X" && (!start || info.start === start);
}

export function ancestors(pid = process.ppid): ProcessInfo[] {
  const list: ProcessInfo[] = [];
  const seen = new Set<number>();
  while (pid > 1 && list.length < 12 && !seen.has(pid)) {
    seen.add(pid);
    const info = processInfo(pid);
    if (!info) break;
    list.push(info);
    pid = info.ppid;
  }
  return list;
}

export function agentKind(value = ""): string {
  const lower = value.toLowerCase();
  if (lower.includes("claude")) return "claude";
  if (lower.includes("codex")) return "codex";
  if (lower === "pi" || lower.includes("pi-coding") || lower.includes("pi-agent")) return "pi";
  return "agent";
}

export function hostProcess(kind: string): ProcessInfo | undefined {
  const list = ancestors();
  return list.find(p => agentKind(p.name) === kind) || list[0];
}

export function claudeSession(): { session_id?: string; cwd?: string; host_pid?: number; updated_at?: number } | undefined {
  const home = process.env.PEERLETTER_CLAUDE_HOME || process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "", ".claude");
  // The inherited environment is a startup snapshot. /resume and /clear keep
  // subprocesses alive, while Claude updates the registry for its own host PID.
  for (const p of ancestors().filter(p => agentKind(p.name) === "claude")) {
    try {
      const file=path.join(home,"sessions",`${p.pid}.json`);
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof data.sessionId === "string") return { session_id: data.sessionId,
        cwd: typeof data.cwd === "string" ? data.cwd : undefined, host_pid: p.pid,updated_at:fs.statSync(file).mtimeMs };
    } catch { /* Registry is optional; no tokens or socket details are read. */ }
  }
  return process.env.CLAUDE_CODE_SESSION_ID ? {session_id:process.env.CLAUDE_CODE_SESSION_ID} : undefined;
}
