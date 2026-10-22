import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const code=await readFile(new URL('../test-tools.js',import.meta.url),'utf8');
const context=vm.createContext({console,DOMException,setTimeout,clearTimeout,crypto});vm.runInContext(code,context);
const {create,verdictOf}=context.LCTestTools;
const expected={url:'https://leetcode.cn/problems/a/',before:'print(1)',editorId:'editor-a',version:1};
function fixture({instant=false}={}){
  let time=0,serial=0,notify=()=>{},editor={code:expected.before,editorId:expected.editorId,version:1},active=true,hangEditor=false;
  const timers=new Map(),state={text:'Accepted',root:'old',disabled:false,blocking:[],submissionId:''},clicked=[],oldButton={disabled:false};
  const setTimer=(fn,ms)=>{const id=++serial;timers.set(id,{at:time+ms,fn});return id;},clearTimer=id=>timers.delete(id);
  const scan=(_,hidden,kind='run')=>({parts:[{id:state.root,text:state.text,visible:true,source:'fixture result pane'}],text:state.text,signature:state.root+':'+state.text,verdict:verdictOf(state.text),busy:state.disabled,blocking:state.blocking,submission_id:state.submissionId,page_url:'https://leetcode.cn/problems/a/submissions/'+state.submissionId+'/',controls:[{id:'run-current',kind:'run',disabled:state.disabled},{id:'submit-current',kind:'submit',disabled:state.disabled}]});
  const adapter={scan,click(id,kind){clicked.push({id,kind});state.disabled=!instant;oldButton.disabled=true;return {id:kind+'-current',kind};},observe(fn){notify=fn;state.notify=fn;return ()=>{notify=()=>{};};},inspect:()=>({controls:scan().controls,result_regions:scan().parts})};
  const tools=create({adapter,now:()=>time,setTimer,clearTimer,makeId:()=> 'job-'+(++serial),assertPage(){if(!active)throw new Error('page left');},readEditor:()=>hangEditor?new Promise(()=>{}):Promise.resolve(editor)});
  async function flush(){for(let n=0;n<8;n++)await Promise.resolve();}
  return {tools,state,clicked,oldButton,timers,async advance(ms){const target=time+ms;let count=0;while(true){const due=[...timers].filter(([,t])=>t.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;if(count++>10000)throw new Error('timer loop');time=due[1].at;timers.delete(due[0]);due[1].fn();await flush();}time=target;await flush();},result(text='Wrong Answer'){state.disabled=false;state.root='new';state.text=text;notify();},edit(){editor={...editor,code:'print(2)',version:2};},hang(){hangEditor=true;},leave(){active=false;},get now(){return time;}};
}
test('run starts immediately and remains unverified while diagnostics are available',async()=>{
  const f=fixture(),start=await f.tools.start(expected,{timeout_ms:10000});assert.equal(start.status,'running');assert.equal(start.fresh,false);assert.equal(start.elapsed_ms,0);
  const diagnostic=f.tools.inspect();assert.equal(diagnostic.test_runs[0].run_id,start.run_id);assert.equal(diagnostic.test_runs[0].status,'running');assert.equal(f.clicked[0].kind,'run');
});
test('fresh results complete after the old disabled run button has been replaced',async()=>{
  const f=fixture(),start=await f.tools.start(expected);f.result('Accepted\nRuntime: 0 ms');await f.advance(600);
  const status=await f.tools.status(start.run_id);assert.equal(status.status,'completed');assert.equal(status.verdict.passed,true);assert.equal(f.oldButton.disabled,true);assert.equal(status.diagnostics.controls[0].disabled,false);
});
test('a ten-second deadline stops monitoring even when editor probing never returns',async()=>{
  const f=fixture(),start=await f.tools.start(expected,{timeout_ms:10000});f.hang();await f.advance(9999);assert.equal((await f.tools.status(start.run_id)).status,'running');await f.advance(1);
  const ended=await f.tools.status(start.run_id);assert.equal(ended.status,'timed_out');assert.equal(ended.elapsed_ms,10000);assert.equal(ended.fresh,false);assert.equal(ended.verified,false);
  const checks=ended.diagnostics.checks;await f.advance(20000);assert.equal((await f.tools.status(start.run_id)).diagnostics.checks,checks);
});
test('bounded query waiting returns running; cancel releases all waiters without canceling the server',async()=>{
  const f=fixture(),start=await f.tools.start(expected);let done=false;
  const query=f.tools.status(start.run_id,{wait_ms:1000}).then(result=>{done=true;return result;});await f.advance(999);assert.equal(done,false);await f.advance(1);assert.equal((await query).status,'running');
  const waiting=f.tools.status(start.run_id,{wait_ms:10000});const canceled=f.tools.cancel(start.run_id);assert.equal(canceled.status,'canceled');assert.match(canceled.note,/未声称取消力扣服务器/);assert.equal((await waiting).status,'canceled');
});
test('aborting a status wait leaves the backend task queryable',async()=>{
  const f=fixture(),start=await f.tools.start(expected),aborter=new AbortController();const waiting=f.tools.status(start.run_id,{wait_ms:10000},aborter.signal);aborter.abort();
  await assert.rejects(waiting,{name:'AbortError'});assert.equal((await f.tools.status(start.run_id)).status,'running');assert.equal(f.tools.inspect().test_runs.length,1);
});
test('user can shorten an existing deadline from its original start time',async()=>{
  const f=fixture(),start=await f.tools.start(expected,{timeout_ms:30000});await f.advance(11000);
  const result=await f.tools.status(start.run_id,{timeout_ms:10000});assert.equal(result.status,'timed_out');assert.match(result.note,/立即停止/);
});
test('submission uses its own control, default timeout and full-judge task kind',async()=>{
  const f=fixture(),start=await f.tools.start(expected,{},'submit');assert.equal(start.task_kind,'submit');assert.equal(start.timeout_ms,60000);assert.equal(f.clicked[0].kind,'submit');
  f.edit();f.result('Accepted\nRuntime: 0 ms');await f.advance(600);const result=await f.tools.status(start.run_id);assert.equal(result.status,'completed');assert.equal(result.current_code_matches,false);assert.equal(result.verdict.passed,true);
});
test('changed editor invalidates current-case verification and navigation stops monitoring',async()=>{
  const f=fixture(),start=await f.tools.start(expected);f.edit();f.result();await f.advance(600);assert.equal((await f.tools.status(start.run_id)).status,'invalidated');
  const g=fixture(),second=await g.tools.start(expected);g.leave();await g.advance(200);assert.equal((await g.tools.status(second.run_id)).status,'failed');
});
test('a fresh wrong answer is completed verification, not an accepted solution',async()=>{
  const f=fixture(),start=await f.tools.start(expected);f.result('Wrong Answer\nOutput: 1\nExpected: 2');await f.advance(600);const result=await f.tools.status(start.run_id);assert.equal(result.status,'completed');assert.equal(result.verdict.passed,false);
});
test('old accepted output never becomes fresh merely because time passes',async()=>{
  const f=fixture(),start=await f.tools.start(expected,{timeout_ms:1000});f.state.disabled=false;await f.advance(1000);assert.equal((await f.tools.status(start.run_id)).status,'timed_out');
});
test('a transient busy state plus result mutation verifies an identical final result',async()=>{
  const f=fixture({instant:true}),start=await f.tools.start(expected);f.state.disabled=false;
  f.state.notify({resultMutated:true,observedBusy:true});await f.advance(600);
  const result=await f.tools.status(start.run_id);assert.equal(result.status,'completed');assert.equal(result.diagnostics.observed_busy,true);assert.equal(result.diagnostics.observed_result_mutation,true);
});
test('rerendering identical old Accepted without execution evidence stays unverified',async()=>{
  const f=fixture({instant:true}),start=await f.tools.start(expected,{timeout_ms:1000});f.state.disabled=false;
  f.state.notify({resultMutated:true,observedBusy:false});await f.advance(1000);
  const result=await f.tools.status(start.run_id);assert.equal(result.status,'timed_out');assert.equal(result.verified,false);
});
test('busy evidence without a result change cannot verify untouched old Accepted',async()=>{
  const f=fixture({instant:true}),start=await f.tools.start(expected,{timeout_ms:1000});f.state.disabled=false;
  f.state.notify({resultMutated:false,observedBusy:true});await f.advance(1000);
  assert.equal((await f.tools.status(start.run_id)).status,'timed_out');
});
test('login requirements fail explicitly instead of waiting for a verdict forever',async()=>{
  const f=fixture(),start=await f.tools.start(expected,{},'submit');f.state.blocking=['请先登录力扣'];await f.advance(200);const result=await f.tools.status(start.run_id);assert.equal(result.status,'failed');assert.match(result.note,/登录/);assert.equal(result.verified,false);
});
test('changing result selector cannot label the currently visible old verdict as fresh',async()=>{
  const f=fixture(),start=await f.tools.start(expected);f.state.disabled=false;await f.tools.status(start.run_id,{result_selector:'.custom-result'});await f.advance(600);assert.equal((await f.tools.status(start.run_id)).status,'running');
});
test('a previous submission id cannot be reused as the new full-judge result',async()=>{
  const f=fixture();f.state.submissionId='100';const start=await f.tools.start(expected,{},'submit');f.result('Accepted\nnew-looking content');await f.advance(600);
  assert.equal((await f.tools.status(start.run_id)).status,'running');
  f.state.submissionId='101';await f.advance(200);const result=await f.tools.status(start.run_id);assert.equal(result.status,'completed');assert.equal(result.submission_id,'101');assert.match(result.submission_url,/submissions\/101/);
});
