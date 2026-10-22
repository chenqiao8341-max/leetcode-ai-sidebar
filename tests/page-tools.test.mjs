import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPageTools} from '../page-tools.mjs';
const url='https://leetcode.cn/problems/a/';
function fixture(){
  let tab={id:7,url},data={url,code:'a\nb',version:1,editorId:'model-a',editable:true,complete:true},calls=[];
  const chromeApi={tabs:{async query(){return [tab];},async sendMessage(id,msg){
    assert.equal(id,7);calls.push(msg);
    if(msg.type==='LC_READ_CONTEXT')return {ok:true,data:structuredClone(data)};
    if(msg.type==='LC_AGENT_CANCEL')return {ok:true};
    if(msg.action==='edit'){
      if(msg.version!==data.version || msg.before!==data.code || msg.editorId!==data.editorId)return {ok:false,error:'代码已变化'};
      data.code=msg.after;data.version++;return {ok:true,data:structuredClone(data)};
    }
    if(['run_start','submit_start'].includes(msg.action))return {ok:true,data:{run_id:'job-1',status:'running',task_kind:msg.action==='submit_start'?'submit':'run',fresh:false}};
    if(msg.action==='run_status')return {ok:true,data:{run_id:'job-1',status:'completed',fresh:true,verdict:{label:'Accepted',passed:true}}};
    return {ok:true,data:{tests:'Accepted',fresh:false}};
  }}};
  const options={url,tabId:7,windowId:1,chromeApi};
  return {options,api:createPageTools(options),data,calls,leave(){tab={id:8,url:'https://example.com/'};},route(path){tab.url='https://leetcode.cn'+path;data.url=tab.url;}};
}
test('page tools require a fresh read, apply one exact edit and undo it against current code',async()=>{
  const f=fixture();await assert.rejects(f.api.execute('apply_code_edit',{revision:'fake',old_text:'b',new_text:'c'}),/read_editor/);
  const read=await f.api.execute('read_editor',{}),result=await f.api.execute('apply_code_edit',{revision:read.revision,old_text:'b',new_text:'c'});
  assert.equal(f.data.code,'a\nc');assert.equal(result.change.before,'a\nb');
  assert.equal((await f.api.execute('run_tests',{revision:result.revision})).fresh,false);
  assert.equal((await f.api.execute('get_test_run',{run_id:'job-1'})).fresh,true);
  await f.api.undo(result.change);assert.equal(f.data.code,'a\nb');
});
test('editing after a manual change or switching tabs cannot overwrite code',async()=>{
  const f=fixture(),read=await f.api.execute('read_editor',{});f.data.code='user edits';f.data.version++;
  await assert.rejects(f.api.execute('apply_code_edit',{revision:read.revision,old_text:'b',new_text:'c'}),/代码已变化/);assert.equal(f.data.code,'user edits');
  f.leave();await assert.rejects(f.api.execute('read_editor',{}),/切换/);await assert.rejects(f.api.execute('read_test_result',{}),/切换/);
});
test('old revisions and manual code mode cannot modify or run the page',async()=>{
  const f=fixture(),read=await f.api.execute('read_editor',{});
  await assert.rejects(f.api.execute('run_tests',{revision:'old'}),/revision/);
  const manual=createPageTools({...f.options,manual:true});const snapshot=await manual.execute('read_editor',{});assert.equal(snapshot.editable,false);
  await assert.rejects(manual.execute('run_tests',{revision:snapshot.revision}),/手动代码/);
  await assert.rejects(manual.execute('apply_code_edit',{revision:read.revision,old_text:'b',new_text:'c'}),/手动代码/);
});
test('undo refuses changed code and a new editor instance',async()=>{
  for(const change of [data=>{data.code='typed';data.version++;},data=>{data.editorId='new-model';}]){
    const f=fixture(),read=await f.api.execute('read_editor',{}),edit=await f.api.execute('apply_code_edit',{revision:read.revision,old_text:'b',new_text:'c'});change(f.data);
    await assert.rejects(f.api.undo(edit.change),/无法直接撤销/);
  }
});
test('aborting a running page action sends a cancellation request',async()=>{
  const f=fixture(),read=await f.api.execute('read_editor',{}),aborter=new AbortController();
  let resolve;const original=f.options.chromeApi.tabs.sendMessage;
  f.options.chromeApi.tabs.sendMessage=async(id,msg)=>{if(msg.action==='run_start')return new Promise(r=>{resolve=r;});return original(id,msg);};
  const running=f.api.execute('run_tests',{revision:read.revision},aborter.signal);
  while(!resolve)await new Promise(r=>setImmediate(r));aborter.abort();
  assert(f.calls.some(m=>m.type==='LC_AGENT_CANCEL'));resolve({ok:false,error:'操作已停止'});await assert.rejects(running,/已停止/);
});
test('submission status follows a new submission route within the same problem',async()=>{
  const f=fixture(),read=await f.api.execute('read_editor',{}),start=await f.api.execute('submit_solution',{revision:read.revision,timeout_ms:10000});
  assert.equal(start.task_kind,'submit');assert.equal(f.calls.find(m=>m.action==='submit_start').options.timeout_ms,10000);
  f.route('/problems/a/submissions/1234/');assert.equal((await f.api.execute('get_test_run',{run_id:start.run_id})).fresh,true);
  const fresh=await f.api.execute('read_editor',{});await f.api.execute('apply_code_edit',{revision:fresh.revision,old_text:'b',new_text:'c'});assert.equal(f.data.code,'a\nc');
});
test('an unresponsive page operation is cut off and cancellation is dispatched',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),original=f.options.chromeApi.tabs.sendMessage;let started=false;
  f.options.chromeApi.tabs.sendMessage=async(id,msg)=>{if(msg.action==='inspect'){started=true;return new Promise(()=>{});}return original(id,msg);};
  const failure=assert.rejects(f.api.execute('inspect_page',{}),/5 秒未响应/);
  while(!started)await new Promise(r=>setImmediate(r));t.mock.timers.tick(5000);await failure;assert(f.calls.some(m=>m.type==='LC_AGENT_CANCEL'));
});
test('a follow-up releases one pending status wait without aborting the Agent',async()=>{
  const f=fixture(),original=f.options.chromeApi.tabs.sendMessage,aborter=new AbortController();let waiting=false;
  f.options.chromeApi.tabs.sendMessage=async(id,msg)=>{if(msg.action==='run_status' && msg.options.wait_ms){waiting=true;return new Promise(()=>{});}return original(id,msg);};
  const pending=f.api.execute('get_test_run',{run_id:'job-1',wait_ms:10000},aborter.signal);
  while(!waiting)await new Promise(r=>setImmediate(r));f.api.interruptWait();const result=await pending;assert.equal(result.ok,true);assert.match(result.note,/用户补充/);assert.equal(aborter.signal.aborted,false);
});
