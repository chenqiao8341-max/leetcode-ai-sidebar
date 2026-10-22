import {test} from 'node:test';
import assert from 'node:assert/strict';
import {updateAction,toolLabel} from '../agent-ui.mjs';
test('task start and timeout are never displayed as passing verification',()=>{
  const actions=[];
  const start=updateAction(actions,{id:'a',name:'submit_solution',round:1,phase:'end',output:{ok:true,task_kind:'submit',status:'running',fresh:false,elapsed_ms:0,timeout_ms:10000}});
  assert.match(start.summary,/尚未验证/);assert.equal(start.result,'');assert.equal(toolLabel('submit_solution'),'提交力扣判题');
  const timeout=updateAction(actions,{id:'b',name:'get_test_run',round:2,phase:'end',output:{ok:true,status:'timed_out',note:'十秒超时，停止监控'}});assert.equal(timeout.state,'warning');assert.match(timeout.summary,/超时/);
});
test('wrong answer remains a failed verdict; repeated call ids in later rounds do not overwrite history',()=>{
  const actions=[];
  const first=updateAction(actions,{id:'same',name:'get_test_run',round:1,phase:'end',output:{ok:true,status:'completed',task_kind:'submit',verdict:{label:'Wrong Answer',passed:false},elapsed_ms:2000}});
  assert.match(first.summary,/提交判题：Wrong Answer/);
  updateAction(actions,{id:'same',name:'inspect_page',round:2,phase:'end',output:{ok:true,controls:[]}});assert.equal(actions.length,2);assert.match(actions[0].summary,/Wrong Answer/);
});
