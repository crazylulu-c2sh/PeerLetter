import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { isProcessAlive, isProcessStopped, processInfo } from "../src/process.ts";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
import { stoppableChild } from "./process-fixture.ts";

test("a stopped PID without its recorded start time cannot revoke a live MCP",{skip:process.platform !== "linux"},async t=>{
  const child=await stoppableChild(t),start=processInfo(child.pid)!.start;
  await child.signal("SIGSTOP");
  assert.equal(isProcessAlive(child.pid,start),true);
  assert.equal(isProcessStopped(child.pid,start),true);
  assert.equal(isProcessStopped(child.pid,null),false);
  assert.equal(isProcessStopped(child.pid,"another-process"),false);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-process-"));
  const store=new Store(resolveProject(root,path.join(root,"state")));t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const old=store.register({kind:"claude",session_id:randomUUID(),host_pid:child.pid});
  store.run("UPDATE agents SET host_start=NULL WHERE name=?",old.name);
  assert.throws(()=>store.register({kind:"claude",session_id:old.session_id}),/already owned/);
  assert.equal(store.agent(old.name)?.runtime_id,old.runtime_id);
});

test("a transient tracing stop preserves ownership and reported presence",{skip:process.platform !== "linux"},async t=>{
  const child=await stoppableChild(t),start=processInfo(child.pid)!.start;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-tracing-"));
  const store=new Store(resolveProject(root,path.join(root,"state")));t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const old=store.register({kind:"claude",session_id:randomUUID(),host_pid:child.pid});
  const original=fs.readFileSync;
  // Model a single ptrace sample without depending on debugger/ptrace permissions in CI.
  const mocked=t.mock.method(fs,"readFileSync",((file:fs.PathOrFileDescriptor,...args:any[])=>{
    const result=(original as Function)(file,...args);
    return file === `/proc/${child.pid}/stat` ? (result as string).replace(/\) \S /,") t ") : result;
  }) as typeof fs.readFileSync);
  syncBuiltinESMExports();t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
  assert.equal(processInfo(child.pid)!.state,"t");
  assert.equal(isProcessAlive(child.pid,start),true);assert.equal(isProcessStopped(child.pid,start),false);
  assert.equal(store.peers().find(p=>p.name===old.name)?.online,true);
  assert.throws(()=>store.register({kind:"claude",session_id:old.session_id}),/already owned/);
  assert.equal(store.agent(old.name)?.runtime_id,old.runtime_id);store.touch(old);
});
