import * as http from "node:http";
import * as path from "node:path";
import { WebSocketServer } from "ws";
import type { TestContext } from "node:test";

export async function codexDaemon(t: TestContext, root: string, thread: string) {
  const socket = path.join(root,"daemon.sock"), server = http.createServer();
  const ws = new WebSocketServer({server});
  const calls: {method:string;params:any}[] = [], queued: any[] = [];
  const state = { status:"idle", deletes:0, additions:0, cwd:root };
  ws.on("connection",connection=>connection.on("message",data=>{
    const request = JSON.parse(String(data));
    if (!request.id) return;
    const {method,params,id} = request; calls.push({method,params});
    let result: any;
    if (method === "initialize") result = {};
    else if (method === "thread/read") result = {thread:{id:thread,cwd:state.cwd,status:{type:state.status}}};
    else if (method === "thread/queue/list") result = {data:queued,nextCursor:null};
    else if (method === "thread/queue/add") {
      const row = {id:`queue-${++state.additions}`,clientUserMessageId:params.clientUserMessageId,input:params.input};
      queued.push(row); result = {queuedSubmission:row};
    } else if (method === "thread/queue/delete") {
      const index = queued.findIndex(q=>q.id === params.queuedSubmissionId);
      if (index >= 0) {queued.splice(index,1);state.deletes++;} result = {deleted:index >= 0};
    } else return connection.send(JSON.stringify({id,error:{code:-32601,message:"Unsupported fixture method"}}));
    connection.send(JSON.stringify({id,result}));
  }));
  await new Promise<void>(resolve=>server.listen(socket,resolve));
  t.after(async()=>{for(const c of ws.clients)c.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {socket,calls,queued,state,ws};
}
