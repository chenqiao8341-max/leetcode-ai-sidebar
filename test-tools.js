// Isolated content world. No model JavaScript is evaluated and no HTTP endpoint
// is called here: execution uses LeetCode's own Run control.
(() => {
  const normalize = value => String(value || '').replace(/\s+/g,' ').trim();
  const verdictOf = text => {
    const match = String(text || '').match(/(?:^|\n)\s*(Wrong Answer|Runtime Error|Compile Error|Compilation Error|Time Limit Exceeded|Memory Limit Exceeded|Output Limit Exceeded|Internal Error|Unknown Error|解答错误|答案错误|执行出错|运行错误|编译出错|编译错误|超出时间限制|超出内存限制|超出输出限制|系统错误|未知错误|Accepted|通过|解答正确)(?=\s|[·:：|]|$)/i);
    return match ? {label:match[1],passed:/^(Accepted|通过|解答正确)$/i.test(match[1])} : null;
  };
  const visible = el => !!el && el.isConnected !== false && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const busyText = value => /(?:^|\n)\s*(运行中|执行中|判题中|排队中|Pending|Judging|Running|Queueing)(?:[…\.\s]|$)/im.test(value);
  function createDOMAdapter(doc = document) {
    const ids = new WeakMap(), handles = new Map();let serial = 0;
    function id(el) {if(!ids.has(el))ids.set(el,'node-'+(++serial));const key=ids.get(el);handles.set(key,el);return key;}
    const text = el => (el.innerText || el.textContent || '').trim();
    function describe(el) {
      return {id:id(el),tag:el.tagName?.toLowerCase(),role:el.getAttribute('role'),label:normalize(el.getAttribute('aria-label') || el.getAttribute('title') || text(el)).slice(0,300),
        locator:el.getAttribute('data-e2e-locator') || el.getAttribute('data-cy') || '',disabled:!!el.disabled || el.getAttribute('aria-disabled')==='true'};
    }
    function controlKind(item) {
      if(/^(console-run-button|run-code-btn)$/.test(item.locator))return 'run';
      if(/^(console-submit-button|submit-code-btn)$/.test(item.locator))return 'submit';
      if(/调试|debug|单步|^(继续|重置|Continue|Reset)$/i.test(item.label))return 'debug';
      if(/提交|\bSubmit\b/i.test(item.label) || /submit/i.test(item.locator))return 'submit';
      return /^(运行|运行代码|执行代码|Run|Run Code)(?:\s|[（(]|$)/i.test(item.label)?'run':'other';
    }
    function buttons() {
      // Run is a div in some LeetCode layouts, not always a native button.
      const nodes=[...doc.querySelectorAll('button,[role="button"],[data-e2e-locator="console-run-button"],[data-cy="run-code-btn"],[data-e2e-locator="console-submit-button"],[data-cy="submit-code-btn"]')].filter(visible);
      return [...new Set(nodes)].map(el=>{
        const item=describe(el);return {...item,kind:controlKind(item)};
      });
    }
    function roots(selector,includeHidden=false,kind='run') {
      const selected=[];const add=(el,source)=>{
        if(!el || (!includeHidden && !visible(el)))return;
        const existing=selected.find(x=>x.el===el);
        if(!existing)selected.push({el,source});else if(source.startsWith('result: '))existing.source=source;
      };
      if(selector){
        if(typeof selector!=='string' || selector.length>500)throw new Error('结果选择器过长。');
        let nodes;try{nodes=[...doc.querySelectorAll(selector)];}catch{throw new Error('结果 CSS 选择器无效。');}
        for(const el of nodes.slice(0,20)){
          if(el===doc.body || el===doc.documentElement || el.matches('script,style,input,textarea') || el.querySelector('.monaco-editor,.cm-editor'))continue;
          add(el,'custom: '+selector);
        }
      }else{
        const candidates=doc.querySelectorAll(kind==='submit'?'[data-e2e-locator="submission-result"],[data-e2e-locator="submission-detail"],[data-cy="submission-result"],[id*="submission-result"]':'[data-e2e-locator="console-result"],#result_tab,[data-e2e-locator="console-test-result"],[data-e2e-locator="console-result-panel"],[data-cy="test-result"],[id*="test-result"],[id*="testResult"],[id*="console-result"]');
        for(const el of candidates){
          if(!el.matches('button,[role="tab"]') && !el.querySelector('.monaco-editor,.cm-editor'))add(el,'result: '+(el.getAttribute('data-e2e-locator') || el.getAttribute('data-cy') || '#'+el.id));
          const controlled=el.getAttribute('aria-controls');if(controlled)add(doc.getElementById(controlled),'aria-controls');
        }
        const labels=[...doc.querySelectorAll('[role="tab"],button,h2,h3,h4,span')].slice(0,1800).filter(el=> (kind==='submit'? /^(提交结果|提交详情|Submission Results?|Submission Details?|Accepted|通过|解答正确|解答错误|Wrong Answer|Runtime Error|Time Limit Exceeded)$/i : /^(测试结果|运行结果|Test Results?|Result)$/i).test(normalize(el.textContent)) && (includeHidden || visible(el)) && !(kind==='submit' && el.closest('a[href*="/submissions/"],tr,[role="row"]')));
        // result_tabbar_outer is an anchor, not necessarily the result body.
        // Never accept a tab header alone or climb into the code editor.
        const anchors=kind==='run'?[...labels,...doc.querySelectorAll('#result_tabbar_outer')]:labels;
        for(const label of anchors.slice(0,16)){
          const controlled=label.getAttribute('aria-controls');if(controlled)add(doc.getElementById(controlled),'result tab');
          // Floating dock layouts often have neither tabpanel nor aria-controls.
          // Find a bounded result pane near the visible result heading.
          for(let el=label.parentElement,depth=0;el && depth<7;el=el.parentElement,depth++){
            if(el===doc.body || el===doc.documentElement || el.querySelector('.monaco-editor,.cm-editor'))break;
            const value=text(el);
            if(value.length>20000)break;
            if(verdictOf(value) || /执行用时|运行时间|Runtime|输出|Output|判题中|Judging/i.test(value)){add(el,'near result heading');break;}
          }
        }
      }
      // Nested duplicate panes cause both stale and new verdicts to be read.
      return selected.filter(x=>!selected.some(y=>x!==y && x.el.contains(y.el))).slice(0,20);
    }
    function scan(selector='',includeHidden=false,kind='run') {
      const controls=buttons(),areas=roots(selector,includeHidden,kind);let remaining=20000;
      const parts=areas.map(({el,source})=>{const value=text(el).slice(0,remaining);remaining-=value.length;return {id:id(el),text:value,source,visible:visible(el)};});
      const value=parts.map(p=>p.text).join('\n').slice(0,20000);
      let verdict=verdictOf(value);
      if(!verdict)for(const {el} of areas){
        for(const leaf of [...el.querySelectorAll('span,h1,h2,h3,h4,p,[role="status"]')].slice(0,300)){
          if(!includeHidden && !visible(leaf))continue;
          const found=verdictOf(text(leaf));if(found){verdict=found;break;}
        }
        if(verdict)break;
      }
      const run=controls.filter(c=>c.kind===kind);
      const blocking=[...doc.querySelectorAll('[role="dialog"],[role="alert"]')].filter(visible).map(el=>text(el).slice(0,1000)).filter(value=>/登录|Sign in|Log in|验证码|captcha|验证身份/i.test(value)).slice(0,3);
      return {controls,parts,text:value,verdict,blocking,page_url:doc.location?.href || '',submission_id:doc.location?.pathname?.match(/\/submissions\/(?:detail\/)?(\d+)/)?.[1] || '',busy:run.some(c=>c.disabled) || busyText(value),
        signature:parts.map(p=>p.id+':'+p.text).join('\n')};
    }
    function click(buttonId,kind='run') {
      const current=buttons().filter(c=>c.kind===kind),chosen=buttonId?current.find(c=>c.id===buttonId):current.length===1?current[0]:null;
      if(!chosen)throw new Error('未能唯一定位'+(kind==='submit'?'提交':'运行')+'控件；先用 inspect_page 检查并指定 button_id。');
      if(chosen.disabled)throw new Error('执行控件不可用，可能已有运行或提交正在进行。');
      const el=handles.get(chosen.id);if(!visible(el))throw new Error('运行控件已被页面替换，请重新检查。');
      el.click();return chosen;
    }
    function inspect({selector='',max_nodes=20,max_chars=12000}={}) {
      const current=scan();let nodes=[];
      if(selector){
        if(selector.length>500)throw new Error('CSS 选择器超过 500 字符。');
        let matches;try{matches=[...doc.querySelectorAll(selector)];}catch{throw new Error('CSS 选择器无效。');}
        let remaining=max_chars;
        for(const el of matches.filter(visible).slice(0,max_nodes)){
          if(el.matches('script,style,input[type="password"],input[type="hidden"]'))continue;
          const value=text(el).slice(0,remaining);remaining-=value.length;
          nodes.push({...describe(el),text:value,element_id:el.id || '',classes:String(el.className || '').slice(0,300)});if(remaining<=0)break;
        }
      }
      return {controls:current.controls.filter(c=>c.kind!=='debug').slice(0,60),debug_controls:current.controls.filter(c=>c.kind==='debug').slice(0,20),result_regions:current.parts,visible_status_label:current.verdict?.label || null,fresh:false,verified:false,run_busy:current.busy,nodes,
        submission_regions:scan('',false,'submit').parts,blocking_dialogs:current.blocking,
        note:'只读 DOM 诊断；visible result 可能来自旧记录。run_tests 只选择 kind=run 控件；submit_solution 只选择 kind=submit 控件。'};
    }
    function observe(notify,{selector='',kind='run'}={}) {
      let previous=roots(selector,false,kind).map(p=>p.el);
      const initialControls=new Set(buttons().filter(c=>c.kind===kind).map(c=>handles.get(c.id)));
      const observer=new MutationObserver(records=>{
        const current=roots(selector,false,kind).map(p=>p.el),areas=[...new Set([...previous.filter(el=>!el.isConnected),...current])];
        let resultMutated=false,observedBusy=false;
        for(const record of records){
          if(record.type==='attributes' && /^(disabled|aria-disabled)$/.test(record.attributeName) && (initialControls.has(record.target) || visible(record.target)) && controlKind(describe(record.target))===kind){
            observedBusy ||= record.attributeName==='disabled'?record.oldValue!==null || record.target.hasAttribute('disabled'):record.oldValue==='true' || record.target.getAttribute('aria-disabled')==='true';
          }
          if(!['childList','characterData'].includes(record.type))continue;
          const changed=[...(record.addedNodes || []),...(record.removedNodes || [])];
          if(!areas.some(el=>el===record.target || el.contains(record.target) || changed.some(node=>node===el || node.contains?.(el))))continue;
          resultMutated=true;
          observedBusy ||= busyText(record.oldValue || '') || changed.some(node=>busyText(node.textContent || ''));
        }
        previous=current;notify({resultMutated,observedBusy});
      });
      observer.observe(doc.body,{subtree:true,childList:true,characterData:true,characterDataOldValue:true,attributes:true,attributeOldValue:true,attributeFilter:['disabled','aria-disabled','aria-selected','class']});
      return ()=>observer.disconnect();
    }
    return {scan,click,inspect,observe};
  }
  function create({readEditor,assertPage,assertStart=assertPage,adapter=createDOMAdapter(),now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,makeId=()=>crypto.randomUUID()}) {
    const jobs=new Map();let latest='';
    const terminal=job=>job.status!=='running';
    function view(job) {
      return {run_id:job.id,task_kind:job.kind,status:job.status,clicked:job.clicked,elapsed_ms:Math.max(0,(job.finishedAt ?? now())-job.startedAt),timeout_ms:job.timeoutMs,current_code_matches:job.editorMatches,
        remaining_ms:Math.max(0,job.deadline-now()),fresh:job.status==='completed',verified:job.status==='completed',verdict:job.status==='completed'?job.sample?.verdict:null,
        tests:job.status==='completed'?job.sample?.text || '':'',submission_id:job.kind==='submit'?job.sample?.submission_id || '':undefined,submission_url:job.kind==='submit' && job.sample?.submission_id?job.sample.page_url:undefined,
        diagnostics:{checks:job.checks,observed_busy:job.sawBusy,observed_result_mutation:job.resultMutated,result_changed:job.changed,result_region_missing:!job.sample?.parts?.length,result_regions:(job.sample?.parts || []).slice(0,6).map(p=>({...p,text:p.text.slice(0,3000)})),
          controls:job.sample?.controls?.filter(c=>c.kind===job.kind) || [],blocking_dialogs:job.sample?.blocking || [],editor_probe_pending:!!job.editorCheck || !!job.completing,last_error:job.error || '',result_selector:job.selector || '(自动定位)'},note:job.note || ''};
    }
    function finish(job,status,note) {
      if(terminal(job))return;
      job.status=status;job.note=note;job.finishedAt=now();clearTimer(job.timer);clearTimer(job.deadlineTimer);job.disconnect?.();
      for(const notify of job.waiters)notify();job.waiters.clear();
    }
    function lookup(id) {const job=jobs.get(id || latest);if(!job)throw new Error('没有找到测试任务；可以用 inspect_page 检查页面，或重新启动测试。');return job;}
    function validateEditor(job,editor){
      job.editorMatches=editor?editor.code===job.expected.before:null;
      if(job.kind==='run' && (!editor || editor.editorId!==job.expected.editorId || editor.version!==job.expected.version || !job.editorMatches)){
        finish(job,'invalidated','代码或编辑器已变化，本次结果不能验证当前代码。');return false;
      }
      return true;
    }
    function check(job,evidence={}) {
      if(terminal(job))return;
      try{
        assertPage(job.expected);job.checks++;
        if(job.clicked && evidence.resultMutated){job.resultMutated=true;job.stableAt=now();}
        job.sample=adapter.scan(job.selector,false,job.kind);job.sawBusy ||= job.sample.busy || (job.clicked && evidence.observedBusy);
        if(job.sample.blocking?.length){finish(job,'failed','页面要求登录或身份验证，未确认执行已启动：'+job.sample.blocking.join(' '));return;}
        const newRoot=job.sample.parts.some(p=>!job.baseline.parts.some(b=>b.id===p.id));
        // A hidden historical region disappearing from the visible sample is
        // not a new result. Compare content within each baseline region.
        const newText=job.sample.parts.some(p=>job.baseline.parts.some(b=>b.id===p.id && b.text!==p.text));
        job.changed ||= newRoot || newText || (job.sawBusy && job.resultMutated);
        const fresh=job.changed && (job.sawBusy || newRoot || newText);
        if(job.sample.signature!==job.stable){job.stable=job.sample.signature;job.stableAt=now();}
        // Completion is based on fresh result evidence, not a captured old button.
        const oldSubmission=job.kind==='submit' && job.sample.submission_id && job.sample.submission_id===job.baseline.submission_id;
        if(fresh && !oldSubmission && job.sample.verdict && !job.sample.busy && now()-job.stableAt>=400 && !job.completing){
          job.completing=true;const signature=job.sample.signature;
          Promise.resolve(readEditor()).then(editor=>{
            if(terminal(job))return;assertPage(job.expected);
            if(!validateEditor(job,editor))return;
            const confirmed=adapter.scan(job.selector,false,job.kind);
            if(confirmed.signature===signature && confirmed.verdict && !confirmed.busy){job.sample=confirmed;finish(job,'completed','已确认本次新结果。');}
          }).catch(e=>{job.error=e.message;finish(job,'failed','最终结果核验失败：'+e.message);}).finally(()=>{job.completing=false;});return;
        }
        if(!job.editorCheck && now()-job.lastEditorCheck>=750){
          job.lastEditorCheck=now();job.editorCheck=true;job.editorVerified=false;
          Promise.resolve(readEditor()).then(editor=>{
            if(terminal(job))return;
            if(!validateEditor(job,editor))return;
            job.editorVerified=true;
          }).catch(e=>{job.error=e.message;finish(job,'failed','编辑器检查失败：'+e.message);}).finally(()=>{job.editorCheck=false;});
        }
      }catch(e){job.error=e.message;finish(job,'failed',e.message);}
    }
    async function start(expected,{timeout_ms,result_selector='',button_id=''}={},kind='run') {
      timeout_ms ??= kind==='submit'?60000:30000;
      if([...jobs.values()].some(j=>!terminal(j)))throw new Error('已有测试监控任务；先查询或取消它，避免重复运行。');
      assertStart(expected);
      const baseline=adapter.scan(result_selector,true,kind),startedAt=now();
      const job={id:makeId(),kind,expected:{...expected,task_kind:kind},selector:result_selector,timeoutMs:timeout_ms,startedAt,deadline:startedAt+timeout_ms,baseline,sample:baseline,status:'running',clicked:false,
        checks:0,sawBusy:false,resultMutated:false,changed:false,stable:baseline.signature,stableAt:startedAt,lastEditorCheck:startedAt,editorVerified:true,editorMatches:true,waiters:new Set()};
      jobs.set(job.id,job);latest=job.id;
      for(const [id,old] of jobs)if(jobs.size>6 && terminal(old))jobs.delete(id);
      try{
        job.disconnect=adapter.observe(evidence=>check(job,evidence),{selector:job.selector,kind});assertStart(expected);job.button=adapter.click(button_id,kind);job.clicked=true;
        const tick=()=>{check(job);if(!terminal(job))job.timer=setTimer(tick,200);};
        job.deadlineTimer=setTimer(()=>finish(job,'timed_out',`测试监控已达到 ${timeout_ms/1000} 秒上限；尚未确认新结果。监控已停止，力扣服务器上的运行可能继续。请检查 diagnostics 或使用 inspect_page 排查。`),timeout_ms);
        tick();
      }catch(e){job.error=e.message;finish(job,'failed',e.message);}
      return view(job);
    }
    async function status(id,{wait_ms=0,result_selector,timeout_ms}={},signal) {
      const job=lookup(id);
      if(timeout_ms!==undefined && !terminal(job)){
        job.timeoutMs=timeout_ms;job.deadline=job.startedAt+timeout_ms;clearTimer(job.deadlineTimer);
        if(now()>=job.deadline)finish(job,'timed_out','已超过用户指定的 '+timeout_ms/1000+' 秒期限，监控立即停止。');
        else job.deadlineTimer=setTimer(()=>finish(job,'timed_out','已达到 '+timeout_ms/1000+' 秒期限，监控停止；力扣服务器可能继续执行。'),job.deadline-now());
      }
      if(result_selector!==undefined && result_selector!==job.selector){
        // Validate before changing the live task's selector. New roots must still
        // be compared against a before-click baseline, not blindly marked fresh.
        const baseline=adapter.scan(result_selector,true,job.kind);
        job.disconnect?.();job.selector=result_selector;job.baseline=baseline;job.changed=false;job.resultMutated=false;job.sawBusy=false;job.stable=baseline.signature;job.stableAt=now();
        if(!terminal(job))job.disconnect=adapter.observe(evidence=>check(job,evidence),{selector:job.selector,kind:job.kind});
      }
      if(wait_ms && !terminal(job))await new Promise((resolve,reject)=>{
        let timer;
        const clear=()=>{clearTimer(timer);job.waiters.delete(done);signal?.removeEventListener('abort',abort);};
        const done=()=>{clear();resolve();},abort=()=>{clear();reject(new DOMException('Aborted','AbortError'));};
        job.waiters.add(done);timer=setTimer(done,wait_ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      });
      signal?.throwIfAborted();return view(job);
    }
    function cancel(id) {const job=lookup(id);finish(job,'canceled','已停止插件的测试监控与等待；未声称取消力扣服务器上的执行。');return view(job);}
    function inspect(args={}) {return {...adapter.inspect(args),test_runs:[...jobs.values()].slice(-3).map(view)};}
    return {start,status,cancel,inspect};
  }
  globalThis.LCTestTools={create,createDOMAdapter,verdictOf};
})();
