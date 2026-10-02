import * as fs from "node:fs";
import { watchMail } from "../src/watch.ts";

// exit 2 is reserved for an actual new-mail signal. Errors/timeouts never wake.
const stopped=new AbortController();
process.on("SIGINT",()=>stopped.abort());process.on("SIGTERM",()=>stopped.abort());
let noticed=false;
try {
  const raw=fs.readFileSync(0,"utf8");
  if (raw.length>1048576) throw new Error("Hook input too large");
  const input=JSON.parse(raw);
  if (input.hook_event_name === "Stop" && typeof input.cwd === "string" && typeof input.session_id === "string") {
    noticed=await watchMail({project:input.cwd,session:input.session_id,sink:"claude-async-rewake",once:true,
      // Finish before the host's 600-second timeout to release ownership cleanly.
      timeoutMs:595000,signal:stopped.signal,
      emit:line=>new Promise((resolve,reject)=>process.stderr.write(line+"\n",error=>error ? reject(error) : resolve())),
      // Host delivers stderr on exit 2; never mix diagnostics with the notice.
      diagnostic:()=>{}});
  }
} catch { /* No technical error is interpreted as a mail signal. */ }
process.exitCode=noticed ? 2 : 0;
