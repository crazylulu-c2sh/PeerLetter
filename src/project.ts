import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { MailError } from "./errors.ts";

export interface Project {
  key: string;
  cwd: string;
  directory: string;
  database: string;
}

export function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new MailError("UNSAFE_PATH", "State directory must be a real directory.");
  if (process.getuid && stat.uid !== process.getuid()) throw new MailError("UNSAFE_PATH", "State directory must belong to the current user.");
  fs.chmodSync(directory, 0o700);
}

// Workspace paths without writing anything. A workspace that never used PeerLetter has no database.
export function locateProject(cwd = process.env.PEERLETTER_PROJECT || process.cwd(), stateRoot?: string): Project {
  let canonical = fs.realpathSync(cwd);
  if (!fs.statSync(canonical).isDirectory()) throw new MailError("INVALID_PROJECT", "Project path must be a directory.");
  try {
    canonical = fs.realpathSync(execFileSync("git", ["-C", canonical, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim());
  } catch { /* A directory without a Git repository is its own workspace. */ }
  const key = createHash("sha256").update(canonical).digest("hex");
  const root = stateRoot || process.env.PEERLETTER_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "peerletter");
  const directory = path.join(root, key);
  return { key, cwd: canonical, directory, database: path.join(directory, "peerletter.db") };
}

// Create or validate the private state directories before opening the database.
export function prepareProject(project: Project): Project {
  privateDirectory(path.dirname(project.directory));
  privateDirectory(project.directory);
  return project;
}

export function resolveProject(cwd = process.env.PEERLETTER_PROJECT || process.cwd(), stateRoot?: string): Project {
  return prepareProject(locateProject(cwd, stateRoot));
}
