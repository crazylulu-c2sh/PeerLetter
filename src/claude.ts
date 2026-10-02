import * as fs from "node:fs";
import * as path from "node:path";
import { MailError } from "./errors.ts";

export const claudeWakes = ["none", "claude-monitor", "claude-async-rewake", "claude-channel"] as const;
export function claudeWakeFile(project: string): string { return path.join(project,".claude/peerletter.json"); }

// Read by running adapters: selecting none silences an old monitor before reload.
export function configuredClaudeWake(project: string): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(claudeWakeFile(project),"utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const value = JSON.parse(raw).wake;
  if (!claudeWakes.includes(value)) throw new MailError("INVALID_WAKE","Invalid Claude wake setting; inspect .claude/peerletter.json.");
  return value;
}

export function externalClaudeWake(wake: string): boolean {
  return wake === "claude-monitor" || wake === "claude-async-rewake";
}
