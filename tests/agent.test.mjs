import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consumeAgentSSE,agentTurn,runAgent,replaceUnique,parseToolArguments,supportsAgent,agentMessages} from '../agent.mjs';
const profile={apiUrl:'https://api.deepseek.com',protocol:'chat',model:'deepseek-flash',thinking:true};
function stream(packets,ending=true){
  const raw=packets.map(p=>'data: '+JSON.stringify(p)+'\r\n\r\n').join('')+(ending?'data: [DONE]\r\n\r\n':'');
  const bytes=new TextEncoder().encode(raw);let at=0;
  return new ReadableStream({pull(c){if(at===bytes.length)c.close();else c.enqueue(bytes.slice(at,++at));}});
}
const delta=(delta,finish_reason=null)=>({choices:[{delta,finish_reason}]});
const call=(name,args={},id='call-1')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const response=(calls=[],text='')=>({text,finishReason:calls.length?'tool_calls':'stop',message:{role:'assistant',content:text || null,reasoning_content:'opaque reasoning',...(calls.length?{tool_calls:calls}:{})}});

test('Agent SSE joins split UTF-8, reasoning and interleaved tool argument fragments',async()=>{
  let shown='';const result=await consumeAgentSSE(stream([
    delta({reasoning_content:'内部推理'}),delta({content:'先读取。'}),
    delta({tool_calls:[{index:0,id:'call-0',type:'function',function:{name:'read_',arguments:'{'}}]}),
    delta({tool_calls:[{index:0,function:{name:'editor',arguments:'}'}}]}),delta({},'tool_calls')]),d=>shown+=d);
  assert.equal(shown,'先读取。');assert.equal(result.message.reasoning_content,'内部推理');assert.deepEqual(result.message.tool_calls,[call('read_editor',{},'call-0')]);
});
test('partial and output-limited tools never become executable',async()=>{
  for(const finish of [null,'length','stop'])await assert.rejects(consumeAgentSSE(stream([delta({tool_calls:[{index:0,...call('apply_code_edit')}]},finish)])),/未完整|提前结束/);
  await assert.rejects(consumeAgentSSE(stream([delta({},'tool_calls')])),/未提供/);
});
test('Agent permits only bounded named tools and unique literal replacements',()=>{
  assert.deepEqual(parseToolArguments(call('read_editor')),{});
  for(const c of [call('eval',{code:'evil()'}),call('read_editor',{unexpected:true}),call('apply_code_edit',{revision:1}),call('run_tests',[]),{function:{name:'read_editor',arguments:'invalid'}}])assert.throws(()=>parseToolArguments(c));
  assert.equal(replaceUnique('a\nb','b','c'),'a\nc');assert.equal(replaceUnique('','','a'),'a');
  assert.throws(()=>replaceUnique('aaaa','aa','x'),/多次/);assert.throws(()=>replaceUnique('abc','','x'),/不能为空/);assert.throws(()=>replaceUnique('abc','z','x'),/找不到/);assert.throws(()=>replaceUnique('a','a','a'),/相同/);
});
test('Agent is scoped to official DeepSeek Chat Completions and quotes old history',()=>{
  assert(supportsAgent(profile));assert(!supportsAgent({...profile,protocol:'responses'}));assert(!supportsAgent({...profile,apiUrl:'https://api.deepseek.com.evil.invalid'}));
  const messages=agentMessages({code:'x',complete:true},'fix',[{role:'assistant',content:'old'}],'teach');
  assert.deepEqual(messages.map(m=>m.role),['system','user']);assert.match(messages[1].content,/历史对话摘要/);
});
test('DeepSeek request carries tools, preserves reasoning verbatim and has no cookies or redirects',async()=>{
  const messages=[{role:'system',content:'rules'},response([call('read_editor')]).message,{role:'tool',tool_call_id:'call-1',content:'ok'}];
  const fetcher=async(url,options)=>{
    assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(options.headers.Authorization,'Bearer test-only');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.deepEqual(body.messages,messages);assert.equal(body.tools.length,8);assert.equal(body.tool_choice,'none');assert.equal(body.thinking.type,'enabled');
    return new Response(stream([delta({content:'完成'},'stop')]),{headers:{'content-type':'text/event-stream'}});
  };
  assert.equal((await agentTurn(profile,'test-only',messages,()=>{},undefined,{final:true,fetcher})).text,'完成');
});
test('Agent loops read → edit → run → final and never sends undo snapshots to model',async()=>{
  let round=0;const executed=[],events=[];
  const results=[response([call('read_editor',{},'r')]),response([call('apply_code_edit',{revision:'v1',old_text:'a',new_text:'b'},'e')]),response([call('run_tests',{revision:'v2'},'t')]),response([],'已经修复。')];
  const result=await runAgent({messages:[{role:'user',content:'修复并运行'}],turn:async(messages,onDelta)=>{
    if(round){assert.equal(messages.at(-2).reasoning_content,'opaque reasoning');assert.equal(messages.at(-1).role,'tool');assert(!messages.at(-1).content.includes('PRIVATE_UNDO'));}
    const r=results[round++];if(r.text)onDelta(r.text,{});return r;
  },execute:async(name)=>{executed.push(name);return {ok:true,revision:'v2',change:{before:'PRIVATE_UNDO'}};},onTool:e=>events.push(e)});
  assert.equal(result.text,'已经修复。');assert.deepEqual(executed,['read_editor','apply_code_edit','run_tests']);assert.equal(events.length,6);
});
test('tool failure is reported to model; invalid tools cannot execute',async()=>{
  let calls=0;
  await runAgent({messages:[],turn:async transcript=>{
    if(!calls++)return response([call('eval',{},'x')]);
    assert.match(transcript.at(-1).content,/不支持/);return response([],'无法操作');
  },execute:()=>assert.fail('must not execute')});
});
test('tool and round budgets force a final answer without additional mutations',async()=>{
  let rounds=0,executions=0;
  await runAgent({messages:[],limits:{rounds:3,tools:1,testRuns:1},turn:async(_,onDelta,signal,options)=>{
    rounds++;if(rounds===1)return response([call('read_editor')]);assert.equal(options.final,true);return response([],'达到上限');
  },execute:async()=>{executions++;return {ok:true};}});
  assert.equal(executions,1);assert.equal(rounds,2);
  let runs=0,turns=0;
  await runAgent({messages:[],limits:{rounds:4,tools:8,testRuns:1},turn:async transcript=>{
    if(turns++<2)return response([call('run_tests',{revision:'v'},'t'+turns)]);
    assert.match(transcript.at(-1).content,/运行.*次数上限/);return response([],'停止测试');
  },execute:async()=>{runs++;return {ok:true};}});assert.equal(runs,1);
});
test('stop after a completed edit preserves its log and prevents the next tool',async()=>{
  const aborter=new AbortController();let count=0,ended=false;
  await assert.rejects(runAgent({messages:[],signal:aborter.signal,turn:async()=>response([call('read_editor',{},'a'),call('read_test_result',{},'b')]),execute:async()=>{count++;aborter.abort();return {ok:true};},onTool:e=>{if(e.phase==='end')ended=true;}}),{name:'AbortError'});
  assert.equal(count,1);assert(ended);
});
test('stop cancels a pending SSE read without waiting for more packets',async()=>{
  const aborter=new AbortController(),pending=consumeAgentSSE(new ReadableStream({start(){}}),()=>{},aborter.signal);aborter.abort();
  await assert.rejects(pending,{name:'AbortError'});
});
test('tools expose bounded numeric timeouts, waits and selector diagnostics',()=>{
  assert.equal(parseToolArguments(call('submit_solution',{revision:'v1',timeout_ms:10000})).timeout_ms,10000);
  assert.equal(parseToolArguments(call('get_test_run',{wait_ms:10000,timeout_ms:10000})).wait_ms,10000);
  assert.deepEqual(parseToolArguments(call('inspect_page',{selector:'[role=tab]',max_nodes:10,max_chars:1000})),{selector:'[role=tab]',max_nodes:10,max_chars:1000});
  for(const args of [{wait_ms:10001},{wait_ms:-1},{wait_ms:'10000'},{timeout_ms:Infinity},{timeout_ms:999}])assert.throws(()=>parseToolArguments(call('get_test_run',args)));
});
test('new user instructions arriving during inference skip stale tool calls',async()=>{
  let round=0,pending=[];const executed=[];
  await runAgent({messages:[],takeInstructions:()=>pending.splice(0),turn:async transcript=>{
    if(!round++){pending.push('不要提交，先检查页面');return response([call('submit_solution',{revision:'v1'})]);}
    assert.equal(transcript.at(-1).role,'user');assert.match(transcript.at(-1).content,/不要提交/);assert.match(transcript.at(-2).content,/跳过/);return response([],'已改为检查');
  },execute:async name=>{executed.push(name);return {ok:true};}});assert.deepEqual(executed,[]);
});
test('instructions received during one tool skip later tools and preserve protocol pairs',async()=>{
  let round=0,pending=[],count=0;
  await runAgent({messages:[],takeInstructions:()=>pending.splice(0),turn:async transcript=>{
    if(!round++)return response([call('inspect_page',{},'inspect'),call('submit_solution',{revision:'v1'},'submit')]);
    assert.equal(transcript.filter(m=>m.role==='tool').length,2);assert.match(transcript.at(-1).content,/十秒/);return response([],'收到');
  },execute:async()=>{count++;pending.push('十秒早停，不要再提交');return {ok:true};}});assert.equal(count,1);
});
