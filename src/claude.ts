import * as fs from "node:fs";
import * as path from "node:path";
import { MailError } from "./errors.ts";

export const claudeWakes = ["none", "claude-monitor", "claude-async-rewake", "claude-channel"] as const;
export function claudeWakeFile(project: string): string { return path.join(project,".claude/peerletter.json"); }

// Read by running adapters: selecting none silences an old monitor before reload.
export function configuredClaudeWake(project: string): string | undefined {
  let raw: string;
  try { raw = fs.readFileSync(claudeWakeFile(project),"utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const home=process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || "", ".claude");
    try {raw=fs.readFileSync(path.join(home,"peerletter.json"),"utf8");}
    catch(globalError) {if ((globalError as NodeJS.ErrnoException).code === "ENOENT") return;throw globalError;}
  }
  const value = JSON.parse(raw).wake;
  if (!claudeWakes.includes(value)) throw new MailError("INVALID_WAKE","Invalid Claude wake setting; inspect .claude/peerletter.json.");
  return value;
}

export function externalClaudeWake(wake: string): boolean {
  return wake === "claude-monitor" || wake === "claude-async-rewake";
}
