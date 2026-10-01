import { parseArgs } from "node:util";
import { MailError } from "./errors.ts";
import type { RuntimeOptions } from "./runtime.ts";

type StringKey = "project" | "name" | "kind" | "session" | "state" | "wake" | "to" | "text" | "text-file"
  | "idempotency-key" | "reply-to" | "thread-id" | "to-session" | "importance" | "wait-ms" | "after-id"
  | "limit" | "ttl" | "reason" | "days";
type BooleanKey = "wake-backlog" | "help" | "shared" | "apply" | "checkpoint";
type Values = Partial<Record<StringKey,string> & Record<BooleanKey,boolean>>;

export function parseOptions(args = process.argv.slice(2), cli = false) {
  const string = { type: "string" as const };
  const boolean = { type: "boolean" as const };
  const parsed = parseArgs({ args, allowPositionals: cli,
    options: { project: string, name: string, kind: string, session: string, state: string, wake: string,
      "wake-backlog": boolean, help: boolean,
      ...(cli ? { to: string, text: string, "text-file": string, "idempotency-key": string,
        "reply-to": string, "thread-id": string, "to-session": string, importance: string,
        "wait-ms": string, "after-id": string, limit: string, ttl: string, shared: boolean,
        reason: string, days: string, apply: boolean, checkpoint: boolean } : {}) } });
  const values = parsed.values as Values;
  const runtime: RuntimeOptions = { project: values.project, name: values.name, kind: values.kind,
    session: values.session, state: values.state, wake: values.wake, wakeBacklog: values["wake-backlog"] };
  return { values, positionals: parsed.positionals, runtime };
}

export function required(value: string | undefined, name: string): string {
  if (!value) throw new MailError("INVALID_ARGUMENT", `${name} is required.`);
  return value;
}
