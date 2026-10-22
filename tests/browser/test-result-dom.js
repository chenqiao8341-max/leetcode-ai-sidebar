/* Browser regression fixture: serve the repository over HTTP and open this
 * HTML page. No model/API credentials, LeetCode requests or browser privileges. */
(async()=>{
  const sandbox=document.getElementById('sandbox'),results=document.getElementById('results');
  const expected={before:'print(1)',editorId:'fixture-editor',version:1};let passed=0,failed=0;
  const assert=(value,message)=>{if(!value)throw new Error(message);};
  const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
  function fixture({layout='console',initial='Accepted',onClick=()=>{}}={}){
    const pane=layout==='console'?'<div id="result-content" data-e2e-locator="console-result">'+initial+'</div>':layout==='id'?'<div id="result_tab">'+initial+'</div>':'<div class="output">'+initial+'</div>';
    sandbox.innerHTML='<section><div class="monaco-editor">代码编辑器</div><button data-e2e-locator="console-run-button" aria-label="运行">运行</button><div data-e2e-locator="console-submit-button" aria-label="提交">提交</div></section>'+
      '<section><div id="result_tabbar_outer">'+(layout==='console'?'<button role="tab" id="result_tab" aria-controls="result-content">测试结果</button>':'结果面板')+'</div>'+pane+'</section>'+
      '<section id="debug-panel"><span>一遍不够，展开面板</span><button>停止调试</button><button disabled>继续</button><button disabled>单步跳过</button><button disabled>单步调试</button><button disabled>单步跳出</button><button disabled>重置</button><button>升级 Plus 会员使用调试功能</button><button>运行调试</button></section>';
    const button=sandbox.querySelector('[data-e2e-locator="console-run-button"]'),output=sandbox.querySelector('[data-e2e-locator="console-result"],#result_tab:not(button),.output');
    button.addEventListener('click',()=>onClick({button,output}));
    let time=0,serial=0;const timers=new Map(),adapter=LCTestTools.createDOMAdapter(document);
    const manager=LCTestTools.create({adapter,now:()=>time,setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:time+ms});return id;},clearTimer:id=>timers.delete(id),makeId:()=> 'browser-'+(++serial),assertPage(){},readEditor:async()=>({...expected,code:expected.before})});
    return {adapter,manager,button,output,async advance(ms){await settle();const end=time+ms;let count=0;while(true){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;assert(count++<1000,'timer loop');time=due[1].at;timers.delete(due[0]);due[1].fn();await settle();}time=end;await settle();}};
  }
  async function test(name,fn){
    const line=document.createElement('li');results.append(line);
    try{await fn();passed++;line.textContent='PASS · '+name;line.dataset.pass='true';}
    catch(error){failed++;line.textContent='FAIL · '+name+' · '+error.message;line.dataset.pass='false';}
    finally{sandbox.replaceChildren();await settle();}
  }
  await test('console-result 精确定位，tabbar 不重复读取',async()=>{
    const f=fixture(),scan=f.adapter.scan();assert(scan.parts.length===1,'expected one result region');assert(scan.parts[0].source==='result: console-result','wrong region: '+JSON.stringify(scan.parts));assert(scan.verdict?.passed,'short Accepted not found');
  });
  await test('result_tab 容器可直接定位短结果',async()=>{
    const f=fixture({layout:'id',initial:'通过'}),scan=f.adapter.scan();assert(scan.parts.length===1 && scan.parts[0].source==='result: #result_tab','id fallback missed');assert(scan.verdict?.passed,'short verdict missed');
  });
  await test('只有 result_tabbar_outer 时从锚点找到邻近结果',async()=>{
    const f=fixture({layout:'outer',initial:'<p>通过</p>'}),scan=f.adapter.scan();assert(scan.parts.length===1,'tabbar anchor missed result');assert(scan.verdict?.passed,'tabbar fallback missed verdict');
  });
  await test('调试残留独立分类，不影响运行按钮和 busy',async()=>{
    const f=fixture(),info=f.adapter.inspect();assert(info.controls.filter(c=>c.kind==='run').length===1,'debug run leaked');assert(info.debug_controls.length===8,'debug controls not separated');assert(!info.run_busy,'disabled debug control counted as busy');assert(f.adapter.scan('',false,'submit').controls.some(c=>c.kind==='submit' && c.tag==='div'),'div submit control missed');
  });
  await test('同步完成且没有 busy 采样，仍识别本次新文本',async()=>{
    const f=fixture({initial:'Wrong Answer',onClick:({output})=>output.textContent='通过'}),start=await f.manager.start(expected,{timeout_ms:1000});await f.advance(600);const result=await f.manager.status(start.run_id);assert(result.status==='completed',JSON.stringify(result));assert(result.verdict.passed && !result.diagnostics.observed_busy,'wrong fast-run verdict');
  });
  await test('瞬时 disabled 和判题中恢复成相同 Accepted，不丢失执行证据',async()=>{
    const f=fixture({onClick:({button,output})=>{button.disabled=true;output.innerHTML='<p>判题中...</p>';button.disabled=false;output.textContent='Accepted';}}),start=await f.manager.start(expected,{timeout_ms:1000});await f.advance(600);const result=await f.manager.status(start.run_id);assert(result.status==='completed',JSON.stringify(result));assert(result.diagnostics.observed_busy && result.diagnostics.observed_result_mutation,'mutation evidence lost');
  });
  await test('只有结果中的瞬时判题中，也能识别相同终态',async()=>{
    const f=fixture({onClick:({output})=>{output.innerHTML='<p>Judging...</p>';output.textContent='Accepted';}}),start=await f.manager.start(expected,{timeout_ms:1000});await f.advance(600);assert((await f.manager.status(start.run_id)).status==='completed','transient result text lost');
  });
  await test('调试控件变动与结果样式变化不把旧 Accepted 变新',async()=>{
    const f=fixture({onClick:({output})=>{document.querySelector('#debug-panel button').disabled=true;document.getElementById('debug-panel').append(document.createTextNode(' Running'));output.className='selected';}}),start=await f.manager.start(expected,{timeout_ms:1000});await f.advance(1000);const result=await f.manager.status(start.run_id);assert(result.status==='timed_out' && !result.verified,JSON.stringify(result));assert(!result.diagnostics.observed_result_mutation && !result.diagnostics.observed_busy,'unrelated mutation used as evidence');
  });
  await test('原样重绘旧 Accepted，没有运行证据时继续拒绝',async()=>{
    const f=fixture({onClick:({output})=>output.textContent='Accepted'}),start=await f.manager.start(expected,{timeout_ms:1000});await f.advance(1000);assert((await f.manager.status(start.run_id)).status==='timed_out','old accepted promoted');
  });
  await test('隐藏历史结果的显隐差异不能让可见旧 Accepted 变新',async()=>{
    const f=fixture(),hidden=document.createElement('div');hidden.hidden=true;hidden.dataset.e2eLocator='console-result';hidden.textContent='Wrong Answer';sandbox.append(hidden);
    const start=await f.manager.start(expected,{timeout_ms:1000});await f.advance(1000);assert((await f.manager.status(start.run_id)).status==='timed_out','hidden baseline region promoted visible old verdict');
  });
  await test('隐藏结果中的瞬时判题中不能验证另一个可见旧结果',async()=>{
    let hidden;const f=fixture({onClick:()=>{hidden.innerHTML='<p>Judging...</p>';hidden.textContent='Accepted';}});hidden=document.createElement('div');hidden.hidden=true;hidden.dataset.e2eLocator='console-result';hidden.textContent='Accepted';sandbox.append(hidden);
    const start=await f.manager.start(expected,{timeout_ms:1000});await f.advance(1000);const result=await f.manager.status(start.run_id);assert(result.status==='timed_out' && !result.diagnostics.observed_busy,JSON.stringify(result));
  });
  await test('展开原有隐藏 Accepted 面板也需要本次执行证据',async()=>{
    const f=fixture({onClick:({output})=>{output.hidden=false;}});f.output.hidden=true;
    const start=await f.manager.start(expected,{timeout_ms:1000});await f.advance(1000);assert((await f.manager.status(start.run_id)).status==='timed_out','old hidden verdict promoted');
  });
  await test('改选结果区域后，观察器随新 selector 更新',async()=>{
    const f=fixture(),start=await f.manager.start(expected,{timeout_ms:1500});const other=document.createElement('div');other.id='custom-output';other.textContent='Wrong Answer';sandbox.append(other);await settle();await f.manager.status(start.run_id,{result_selector:'#custom-output'});other.textContent='Accepted';await f.advance(600);assert((await f.manager.status(start.run_id)).status==='completed','new selector not observed');
  });
  const summary=document.getElementById('summary');summary.textContent=`完成：${passed} passed / ${failed} failed`;summary.dataset.failed=String(failed);
})().catch(error=>{document.getElementById('summary').textContent='Fixture error: '+error.stack;document.getElementById('summary').dataset.failed='1';});
