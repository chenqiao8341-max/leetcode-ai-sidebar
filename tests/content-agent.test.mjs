import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../content.js',import.meta.url),'utf8');
function harness(){
  let handler,windowListener,statusSignal;const calls=[];
  const location={origin:'https://leetcode.cn',pathname:'/problems/a/'};
  const window={addEventListener:(_,fn)=>windowListener=fn,removeEventListener(){},postMessage(msg){
    queueMicrotask(()=>windowListener({source:window,origin:location.origin,data:{type:'LC_READING_SNAPSHOT_RESPONSE_V1',id:msg.id,data:{code:'a',version:1,editorId:'m',editable:true,complete:true}}}));
  }};
  const tools={async start(msg,options,kind){calls.push({msg,options,kind});return {run_id:'job-1',status:'running',task_kind:kind,fresh:false};},status(_,options,signal){
    if(!options?.wait_ms)return Promise.resolve({run_id:'job-1',status:'running'});
    statusSignal=signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  },inspect:()=>({controls:[{kind:'submit'}],test_runs:[{status:'running'}]}),cancel:()=>({status:'canceled'})};
  const document={hidden:false,addEventListener(){},querySelectorAll:()=>[]};
  const chrome={runtime:{id:'ext',getURL:name=>'chrome-extension://ext/'+name,onMessage:{addListener:fn=>handler=fn}}};
  const context=vm.createContext({window,document,location,chrome,crypto,AbortController,DOMException,Date,setTimeout,clearTimeout,LCTestTools:{create:()=>tools}});
  vm.runInContext(source,context);
  let serial=0;
  return {calls,location,get statusSignal(){return statusSignal;},send(overrides={},sender={id:'ext',url:'chrome-extension://ext/panel.html'}){
    const msg={type:'LC_AGENT_ACTION',requestId:'request-'+(++serial),url:location.origin+location.pathname,action:'run_start',editorId:'m',version:1,before:'a',options:{timeout_ms:10000},...overrides};
    return new Promise(resolve=>{const accepted=handler(msg,sender,resolve);if(!accepted)resolve(null);});
  }};
}
test('content runtime accepts only the sidebar caller',async()=>{
  const h=harness();assert.equal(await h.send({}, {id:'ext',url:'https://leetcode.cn'}),null);assert.equal(h.calls.length,0);
});
test('start routes current-case execution and full submission to different actions',async()=>{
  for(const [action,kind] of [['run_start','run'],['submit_start','submit']]){
    const h=harness(),result=await h.send({action});assert.equal(result.data.status,'running');assert.equal(result.data.fresh,false);assert.equal(h.calls[0].kind,kind);assert.equal(h.calls[0].options.timeout_ms,10000);
  }
});
test('diagnostics and cancellation are available while a status query is waiting',async()=>{
  const h=harness(),waiting=h.send({action:'run_status',requestId:'wait',options:{wait_ms:10000}});
  while(!h.statusSignal)await new Promise(r=>setImmediate(r));
  const diagnostic=await h.send({action:'inspect',options:{}});assert.equal(diagnostic.data.controls[0].kind,'submit');
  const canceled=await h.send({action:'run_cancel'});assert.equal(canceled.data.status,'canceled');
  await h.send({type:'LC_AGENT_CANCEL',requestId:'wait'});assert.equal((await waiting).ok,false);
});
test('submission start still validates the exact live editor before clicking',async()=>{
  const h=harness(),result=await h.send({action:'submit_start',version:999});assert.equal(result.ok,false);assert.match(result.error,/代码已变化/);assert.equal(h.calls.length,0);
});
test('an expired execution request cannot later click submit',async()=>{
  const h=harness(),result=await h.send({action:'submit_start',expires_at:Date.now()-1});assert.equal(result.ok,false);assert.match(result.error,/已过期/);assert.equal(h.calls.length,0);
});
