import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/store.ts";
import { resolveProject } from "../src/project.ts";
const fixture=fileURLToPath(new URL("./claude-host-fixture.ts",import.meta.url));
async function until(fn:()=>boolean) {const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw new Error("Fixture timed out");await delay(20);}}
async function host(t:test.TestContext,pin=false) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-transition-")),project=path.join(root,"project"),home=path.join(root,"home"),state=path.join(root,"state");
  fs.mkdirSync(project);fs.mkdirSync(home);const session=randomUUID(),store=new Store(resolveProject(project,state));
  const child=spawn(process.execPath,[fixture,project,state,home,session,...(pin?["pin"]:[])],{stdio:["ignore","pipe","pipe","ipc"]});
  const replies:any[]=[],notices:string[]=[];let errors="";
  child.stderr!.on("data",x=>errors+=x);child.stdout!.on("data",()=>{});
  child.on("message",(m:any)=>{if(m.notice)notices.push(m.notice);else replies.push(m);});
  t.after(async()=>{
    if (child.exitCode === null) {child.send({close:true});await Promise.race([new Promise(r=>child.once("exit",r)),delay(3000)]);if(child.exitCode === null)child.kill("SIGKILL");}
    store.close();fs.rmSync(root,{recursive:true,force:true});
  });
  await until(()=>replies.some(r=>r.ready) || child.exitCode !== null);assert.equal(child.exitCode,null,errors);
  const ready=replies.find(r=>r.ready);
  async function command(m:any) {const id=randomUUID();child.send({...m,id});await until(()=>replies.some(r=>r.id === id));const result=replies.find(r=>r.id === id);assert.equal(result.error,undefined);return result;}
  return {store,session,ready,command,notices};
}

test("same Claude process follows /clear and /resume without tool calls; monitor, names, pause and leases stay isolated",{timeout:25000},async t=>{
  const {store,session,ready,command,notices}=await host(t);
  const first=store.agent(ready.ready.name)!;
  const sender=store.register({name:"sender",kind:"pi",session_id:randomUUID()});
  const lease=store.leaseClaim(first,["old/**"]);store.pause(session,"manual");
  const old=store.send(sender,{to:first.name,text:"OLD-PRIVATE",idempotency_key:"old"}).message;
  await until(()=>store.watchStatus(session).online);
  const next=randomUUID();await command({transition:next,registry:false}); // Hook beats stale registry/environment.
  await until(()=>!!store.agentForSession(next,"claude") && store.watchStatus(next).online);
  const second=store.agentForSession(next,"claude")!;
  assert.notEqual(second.name,first.name);assert.equal(store.agent(first.name)!.online,0);
  assert.equal(store.peek(second).messages.length,0);assert.equal(store.gate(session).pause_reason,"manual");
  assert.ok(!store.leaseList().some(l=>l.id === lease.id));assert.equal(store.watchStatus(session).online,false);
  const fresh=store.send(sender,{to:second.name,text:"NEW-PRIVATE",idempotency_key:"new"}).message;
  await until(()=>store.status(sender,fresh.id).state === "notified");assert.equal(notices.length,1);assert.ok(!notices[0].includes("PRIVATE"));
  await command({transition:session});await until(()=>store.agentForSession(session,"claude")?.name === first.name && store.watchStatus(session).online);
  assert.equal(store.gate(session).pause_reason,"manual");assert.equal(store.status(sender,old.id).state,"accepted");
  store.pause(session,null);await until(()=>store.status(sender,old.id).state === "notified");
  assert.equal(store.status(sender,old.id).acknowledged_at,null);assert.equal(notices.length,2);
  const third=randomUUID();await command({transition:third,hook:false,end:false}); // New registry beats a stale hook mapping too.
  await until(()=>!!store.agentForSession(third,"claude") && store.watchStatus(third).online);
  assert.notEqual(store.agentForSession(third,"claude")!.name,first.name);
  assert.equal((await command({who:true})).who.session_id,third);
});

test("explicit Claude --session stays pinned across the host's transition",{timeout:15000},async t=>{
  const {store,session,command}=await host(t,true);
  await command({transition:randomUUID()});await delay(900);
  assert.equal((await command({who:true})).who.session_id,session);
  assert.equal(store.peers().filter(p=>p.online).length,1);
});

test("failed Claude replacement rolls back old participant and leases without taking another host's name/session",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"peerletter-replacement-")),store=new Store(resolveProject(root,path.join(root,"state")));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  const old=store.register({kind:"claude",session_id:randomUUID(),host_pid:process.pid});
  const other=store.register({kind:"claude",session_id:randomUUID(),host_pid:process.pid});
  const lease=store.leaseClaim(old,["keep/**"]);
  assert.throws(()=>store.register({kind:"claude",session_id:other.session_id,host_pid:process.pid,replace:old}),/already owned/);
  assert.equal(store.agent(old.name)!.runtime_id,old.runtime_id);assert.equal(store.agent(old.name)!.online,1);
  assert.ok(store.leaseList().some(l=>l.id === lease.id));assert.equal(store.agent(other.name)!.runtime_id,other.runtime_id);
});
