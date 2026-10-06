import * as fs from "node:fs";
import type { applyGlobal, globalInstallation, uninstallPlan } from "./global-install.ts";

// Human-readable setup output. `setup ... --json` prints the full result instead.
type Applied = ReturnType<typeof applyGlobal>;
type Installed = Extract<Applied, { doctor: unknown[] }>;
type Plan = ReturnType<typeof globalInstallation> | ReturnType<typeof uninstallPlan>;
const order = ["claude","codex","pi"] as const;
const labels: Record<string,string> = { claude:"Claude", codex:"Codex", pi:"Pi" };

function short(file: string): string {
  const home = process.env.HOME;
  return home && (file === home || file.startsWith(home + "/")) ? "~" + file.slice(home.length) : file;
}
function sorted(list: string[]): string[] { return order.filter(kind => list.includes(kind)); }
function names(list: string[]): string { return sorted(list).map(kind => labels[kind]).join(", "); }
// A label column followed by text wrapped under it.
function item(label: string, text: string, width = 100): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && 12 + line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  lines.push(line);
  return lines.map((l,i) => (i ? " ".repeat(12) : `  ${label.padEnd(10)}`) + l);
}
function backups(list: unknown[]): string[] {
  const made = list.map(b => (b as { backup?: string }).backup).filter((b): b is string => !!b);
  return ["", "Backups (private copies of files that changed)",
    ...(made.length ? made.map(b => `  ${short(b)}`) : ["  none needed"])];
}

export function appliedReport(applied: Applied, refresh = false): string {
  if ("uninstalled" in applied && applied.uninstalled) {
    const result = applied;
    if (!result.uninstalled.length) return "Nothing to remove: no user installation is recorded for the selected agents.";
    return [`PeerLetter removed: ${names(result.uninstalled)}`,
      ...(result.retained_edited_files.length ? ["", "Kept edited files (review or delete them yourself)",
        ...result.retained_edited_files.map(f => `  ${short(f)}`)] : []),
      ...backups(result.backups),
      "", "Next", ...item("Hosts","Restart or reload each host to disconnect a PeerLetter MCP server that is still running. Mail and leases in workspace databases are kept.")].join("\n");
  }
  if (typeof applied.next === "string") return applied.next;
  const result = applied as Installed, next = result.next;
  const workspace = result.workspace_doctor;
  const healthy = workspace.integrity?.quick_check === "ok";
  const out = [`PeerLetter ${refresh ? "refreshed" : "installed"}: ${names(result.installed)}`,
    `  Node ${result.doctor[0]?.node ?? "unknown"}`, "", "Checks"];
  for (const kind of sorted(result.installed)) {
    const check = result.doctor.find(d => d.client === kind)!;
    out.push(...item(check.files && check.skills ? "ok" : "PROBLEM", `${labels[kind]}: ${check.files && check.skills
      ? "settings, generated files and skill are in place." : !check.files ? "a generated file differs from the plan; rerun setup." : "the skill link is missing; rerun setup."}`));
  }
  out.push(...item(healthy ? "ok" : "PROBLEM", `Workspace database integrity: ${healthy ? "ok" : JSON.stringify(workspace.integrity)}`),
    `${" ".repeat(12)}project   ${short(workspace.project)}`, `${" ".repeat(12)}database  ${short(workspace.database)}`);
  out.push(...backups(result.backups));
  if (result.project_conflicts.length) out.push("", "Old project-local PeerLetter entries in this directory",
    ...result.project_conflicts.map(f => `  ${short(f)}`), ...item("Fix", next.duplicates));
  out.push("", "Next", ...sorted(result.installed).flatMap(kind => item(labels[kind], next[kind as keyof typeof next])));
  return out.join("\n");
}

export function planReport(plan: Plan, client = "all"): string {
  const note = "(preview: nothing has been changed)";
  if ("entries" in plan) {
    const kinds = sorted(Object.keys(plan.entries));
    if (!kinds.length) return "Nothing is installed for your user. Run setup claude|codex|pi|all.";
    const out = [`setup ${client === "installed" ? "update would refresh" : "would install"}: ${names(kinds)} ${note}`];
    for (const kind of kinds) {
      const entry = plan.entries[kind as keyof typeof plan.entries]!;
      out.push("", labels[kind]);
      for (const w of entry.writes) {
        const state = !fs.existsSync(w.file) ? "create" : fs.readFileSync(w.file,"utf8") === w.data ? "unchanged" : "update";
        out.push(`  ${state.padEnd(10)}${short(w.file)}`);
      }
      for (const link of entry.links) out.push(`  ${"link".padEnd(10)}${short(link.file)} -> ${short(link.target)}`);
      for (const c of entry.commands) out.push(`  ${"run".padEnd(10)}${[c.command,...c.args].map(short).join(" ")}`);
    }
    return out.join("\n");
  }
  if (!plan.removed.length) return "Nothing to remove: no user installation is recorded for the selected agents.";
  return [`setup --uninstall would remove: ${names(plan.removed)} ${note}`, "",
    ...plan.writes.map(w => `  ${"update".padEnd(10)}${short(w.file)}`),
    ...plan.remove.map(f => `  ${"remove".padEnd(10)}${short(f)}`),
    ...plan.retained.map(f => `  ${"keep".padEnd(10)}${short(f)} (edited after setup)`),
    ...plan.commands.map(c => `  ${"run".padEnd(10)}${[c.command,...c.args].map(short).join(" ")}`)].join("\n");
}
