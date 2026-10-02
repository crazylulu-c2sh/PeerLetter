#!/usr/bin/env python3
# Optional installed-client regression. All projects/settings/state and model
# requests are isolated. UI trust is accepted only for this generated fixture.
import os,json,tempfile,subprocess,threading,http.server,pty,select,time,sqlite3,shutil,re,signal,sys
repo=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
node=shutil.which('node')
if not node or not shutil.which('claude'):raise SystemExit('Requires Node 24.18+, installed Claude Code and a Unix PTY.')
root=tempfile.mkdtemp(prefix='peerletter-claude-interactive-')
requests=[]
class Provider(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=self.rfile.read(int(self.headers.get('Content-Length','0')))
  if '/messages' not in self.path:
   self.send_response(200);self.end_headers();self.wfile.write(b'{}');return
  try:data=json.loads(body)
  except:data={}
  if 'count_tokens' in self.path:
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":10}');return
  requests.append(data)
  events=[('message_start',{'type':'message_start','message':{'id':'msg_fixture_'+str(len(requests)),'type':'message','role':'assistant','content':[],'model':data.get('model','fixture'),'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':0}}}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':'Fixture ready.'}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':3}}),('message_stop',{'type':'message_stop'})]
  payload=''.join('event: '+event+'\ndata: '+json.dumps(value)+'\n\n' for event,value in events).encode()
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
threading.Thread(target=server.serve_forever,daemon=True).start()
def run(wake):
 project=os.path.join(root,wake);os.mkdir(project)
 config=os.path.join(root,'config-'+wake);state=os.path.join(root,'state-'+wake)
 env=dict(os.environ)
 for key in ['ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR','CLAUDECODE']:
  env.pop(key,None)
 env.update(CLAUDE_CONFIG_DIR=config,PEERLETTER_STATE_DIR=state,ANTHROPIC_API_KEY='sk-ant-peerletter-fixture',ANTHROPIC_BASE_URL='http://127.0.0.1:'+str(server.server_port),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1',DISABLE_TELEMETRY='1',TERM='xterm-256color')
 subprocess.run([node,repo+'/scripts/install.ts','--project',project,'--client','claude','--wake',wake,'--apply'],env=env,cwd=repo,check=True,stdout=subprocess.DEVNULL)
 pid,fd=pty.fork()
 if pid==0:
  os.chdir(project);os.execvpe('claude',['claude','--model','sonnet','Reply fixture ready.'],env)
 import fcntl,termios,struct
 fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',40,120,0,0))
 output='';handled=set();db=None;base=len(requests);sent=False;mail_base=0;prompted=False;trust_at=None;deadline=time.time()+75
 transition_test='--session-transitions' in sys.argv
 stage=0;original=None;clear_pid=None;resume_pid=None
 def command(text):
  os.write(fd,text.encode());time.sleep(0.3);os.write(fd,b'\r')
 try:
  while time.time()<deadline:
   if select.select([fd],[],[],0.2)[0]:
    try:output+=os.read(fd,65536).decode(errors='replace')
    except OSError:break
   clean=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',output)
   for key,pattern in [('theme','Choose the text style'),('trust','Yes, I trust this folder'),('apikey','Yes, I accept'),('apikey2','Yes, use this API key'),('custom-api','Detected a custom API key'),('continue','Press Enter to continue')]:
    if key not in handled and re.sub(r'\s+','',pattern.lower()) in re.sub(r'\s+','',clean.lower()):
     time.sleep(1);handled.add(key);trust_at=time.time() if key=='trust' else trust_at;os.write(fd,b'\x1b[A' if key=='custom-api' else (b'\x1b[B' if key=='trust' else b''));time.sleep(0.3);os.write(fd,b'\r');print(wake,'accepted fixture prompt',key,flush=True)
   if trust_at is not None and time.time()-trust_at>2 and not prompted and len(requests)==base:
    os.write(fd,b'\x1b[200~Reply fixture ready.\x1b[201~');time.sleep(0.3);os.write(fd,b'\r');prompted=True;print(wake,'entered initial fixture prompt',flush=True)
   if db is None:
    for directory,dirs,files in os.walk(state):
     if 'peerletter.db' in files:
      db=sqlite3.connect(os.path.join(directory,'peerletter.db'));db.row_factory=sqlite3.Row;break
   if db is not None and len(requests)>base and not sent:
    actors=db.execute("SELECT a.name,a.session_id,a.wake,a.pid FROM agents a WHERE kind='claude' AND online=1").fetchall()
    if actors:
     actor=actors[0]
     if transition_test:
      if stage==0:
       original=dict(actor);time.sleep(1);command('/clear');stage=1;print(wake,'requested real /clear',flush=True);continue
      if stage==1:
       if actor['session_id']==original['session_id']:continue
       clear_pid=actor['pid'];assert actor['name']!=original['name'];assert not db.execute('SELECT online FROM agents WHERE name=?',(original['name'],)).fetchone()['online']
       time.sleep(1);command('/resume '+original['session_id']);stage=2;print(wake,'requested real /resume',flush=True);continue
      if stage==2:
       if actor['session_id']!=original['session_id']:continue
       assert actor['name']==original['name'];resume_pid=actor['pid'];time.sleep(1);command('Reply fixture ready after resume.');stage=3
       print(wake,'resumed real session',actor['session_id'],'same MCP process',resume_pid==clear_pid,flush=True);continue
     owners=db.execute('SELECT * FROM watch_owners WHERE session_id=?',(actor['session_id'],)).fetchall()
     if owners:
      time.sleep(1)
      mail_base=len(requests)
      subprocess.run([node,repo+'/src/cli.ts','--project',project,'--state',state,'--name','fixture-sender','send','--to',actor['name'],'--text','BODY-MUST-NOT-BE-INJECTED','--idempotency-key','native-wake'],env=env,check=True,stdout=subprocess.DEVNULL)
      sent=True;print(wake,'registered',dict(actor),'watch process owns session',flush=True)
   candidates=[r for r in requests[mail_base:] if 'PeerLetter:' in json.dumps(r.get('messages',[]))] if sent else []
   if candidates:
    last=json.dumps(candidates[-1].get('messages',[]))
    assert 'BODY-MUST-NOT-BE-INJECTED' not in last
    time.sleep(1)
    notice=db.execute('SELECT state FROM deliveries').fetchone()['state']
    assert notice=='notified',notice
    print(json.dumps({'wake':wake,'native_interactive_idle_wake':True,'requests':len(requests)-base,'external_model_requests':0,'mail_state':notice,'monitor_session_env_verified':wake=='monitor','session_transitions':transition_test,'same_mcp_on_resume':resume_pid==clear_pid if transition_test else None}),flush=True)
    return True
  print(wake,'not completed; rendered screen tail:',clean[-4500:],flush=True)
  return False
 finally:
  try:os.kill(pid,signal.SIGTERM)
  except ProcessLookupError:pass
  time.sleep(0.4)
  try:os.kill(pid,signal.SIGKILL)
  except ProcessLookupError:pass
  os.close(fd)
  try:os.waitpid(pid,0)
  except:pass
  if db:db.close()
try:
 results=[run('async-rewake')]
 if not all(results):raise SystemExit('Native Claude fixture failed; inspect the isolated terminal output.')
finally:
 server.shutdown();shutil.rmtree(root,ignore_errors=True)
