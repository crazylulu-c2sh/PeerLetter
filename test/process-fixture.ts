import type test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { processInfo } from "../src/process.ts";

export async function stoppableChild(t: test.TestContext) {
  const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
  t.after(async ()=>{
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited=once(child,"exit"); child.kill("SIGKILL"); await exited;
  });
  await once(child,"spawn");
  const signal=async (value:"SIGSTOP" | "SIGCONT")=>{
    child.kill(value);
    for (let i=0; ["T","t"].includes(processInfo(child.pid!)?.state || "") !== (value === "SIGSTOP"); i++) {
      assert.ok(i<200,`child should respond to ${value}`); await delay(10);
    }
  };
  return {pid:child.pid!,signal};
}

