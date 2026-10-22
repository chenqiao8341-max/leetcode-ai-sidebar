import {validProblem,problemKey} from './core.mjs';
import {replaceUnique} from './agent.mjs';

const pageUrl=value=>{const u=new URL(value);return u.origin+u.pathname;};
export function createPageTools({tabId,windowId,url,manual=false,chromeApi=chrome,onChange=()=>{}}){
  let last=null,waiting=null,lastRunId='',stopBound=false;
  async function active(signal,allowRoute=false,targetUrl=last?.url || url){
    signal?.throwIfAborted();const tab=(await chromeApi.tabs.query({active:true,windowId}))[0];signal?.throwIfAborted();
    if(!tab || tab.id!==tabId || !validProblem(tab.url) || problemKey(tab.url)!==problemKey(url) || (!allowRoute && pageUrl(tab.url)!==targetUrl))throw new Error('当前网页或题目已切换，操作已停止。');
    return pageUrl(tab.url);
  }
  async function send(message,signal,{waitSignal,timeoutMs=5000,targetUrl}={}){
    const requestId=crypto.randomUUID(),expiresAt=Date.now()+timeoutMs;
    const deadline=new AbortController(),signals=[signal,waitSignal,deadline.signal].filter(Boolean),combined=AbortSignal.any(signals);
    const cancel=()=>{chromeApi.tabs.sendMessage(tabId,{type:'LC_AGENT_CANCEL',requestId}).catch(()=>{});};
    let timeout,rejectAbort;
    const abort=()=>{cancel();if(!['edit','run_start','submit_start'].includes(message.action))rejectAbort?.(combined.reason);};
    combined.addEventListener('abort',abort,{once:true});
    try{
      combined.throwIfAborted();
      const result=await Promise.race([
        (async()=>{const actualUrl=await active(combined,message.type==='LC_READ_CONTEXT' || ['run_status','run_cancel','inspect','tests'].includes(message.action),targetUrl);combined.throwIfAborted();return chromeApi.tabs.sendMessage(tabId,{...message,requestId,url:actualUrl,expires_at:expiresAt});})(),
        new Promise((_,reject)=>{timeout=setTimeout(()=>{const error=new Error(`页面操作超过 ${timeoutMs/1000} 秒未响应，等待已切断；可调用 inspect_page 排查。`);reject(error);deadline.abort(error);},timeoutMs);}),
        new Promise((_,reject)=>{rejectAbort=reject;})
      ]);
      if(!result?.ok)throw new Error(result?.error || '页面操作失败，请刷新力扣页面。');
      return result.data;
    }finally{clearTimeout(timeout);combined.removeEventListener('abort',abort);}
  }
  function bindStop(signal){
    if(stopBound || !signal)return;stopBound=true;
    const cancel=()=>chromeApi.tabs.sendMessage(tabId,{type:'LC_AGENT_ACTION',action:'run_cancel',requestId:crypto.randomUUID(),url,run_id:lastRunId || undefined}).catch(()=>{});
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  }
  function remember(data){
    last={...data,revision:data.editorId && data.version?`${data.editorId}:${data.version}`:crypto.randomUUID()};
    return last;
  }
  function requireRevision(revision){
    if(manual)throw new Error('手动代码模式下只分析；关闭手动代码后才能修改、运行或提交网页代码。');
    if(!last?.complete || !last.editable || !last.editorId || !last.version)throw new Error('请先调用 read_editor；当前需要完整、可写的 Monaco 编辑器。');
    if(revision!==last.revision)throw new Error('revision 已过期或不正确，请重新读取代码。');
    return last;
  }
  const expected=s=>({editorId:s.editorId,version:s.version,before:s.code});
  async function execute(name,args,signal){
    if(name==='read_editor'){
      const data=await send({type:'LC_READ_CONTEXT'},signal);signal?.throwIfAborted();
      if(problemKey(data.url)!==problemKey(url))throw new Error('读取到其他题目，操作已停止。');
      remember(data);
      return {ok:true,code:data.code,complete:data.complete,language:data.language,cursor:data.cursor,selection:data.selection,revision:last.revision,editable:!manual && data.editable,manualMode:manual};
    }
    if(name==='read_test_result')return {ok:true,...await send({type:'LC_AGENT_ACTION',action:'tests'},signal)};
    if(name==='inspect_page')return {ok:true,...await send({type:'LC_AGENT_ACTION',action:'inspect',options:args},signal)};
    if(name==='get_test_run'){
      const waiter=new AbortController();waiting=waiter;bindStop(signal);
      try{return {ok:true,...await send({type:'LC_AGENT_ACTION',action:'run_status',run_id:args.run_id,options:args},signal,{waitSignal:waiter.signal,timeoutMs:Math.min(10000,(args.wait_ms || 0)+2000)})};}
      catch(e){
        if(waiter.signal.aborted && !signal?.aborted)return {ok:true,...await send({type:'LC_AGENT_ACTION',action:'run_status',run_id:args.run_id,options:{wait_ms:0}},signal),note:'用户补充了要求，单次等待已提前结束，请依据最新要求继续。'};
        throw e;
      }finally{if(waiting===waiter)waiting=null;}
    }
    if(name==='cancel_test_run')return {ok:true,...await send({type:'LC_AGENT_ACTION',action:'run_cancel',run_id:args.run_id},signal)};
    if(name==='apply_code_edit'){
      const before=requireRevision(args.revision),after=replaceUnique(before.code,args.old_text,args.new_text);
      const data=await send({type:'LC_AGENT_ACTION',action:'edit',...expected(before),after},signal);
      if(data.code!==after || data.editorId!==before.editorId)throw new Error('未能确认修改结果，请重新读取页面。');
      remember(data);onChange(data);
      return {ok:true,revision:last.revision,note:'修改已应用到力扣编辑器，可撤销。',change:{before:before.code,after,editorId:data.editorId,url,oldText:args.old_text,newText:args.new_text}};
    }
    if(['run_tests','submit_solution'].includes(name)){
      const before=requireRevision(args.revision);
      bindStop(signal);
      const data=await send({type:'LC_AGENT_ACTION',action:name==='submit_solution'?'submit_start':'run_start',...expected(before),options:args},signal);
      lastRunId=data.run_id;
      if(signal?.aborted){chromeApi.tabs.sendMessage(tabId,{type:'LC_AGENT_ACTION',action:'run_cancel',requestId:crypto.randomUUID(),url,run_id:lastRunId}).catch(()=>{});signal.throwIfAborted();}
      return {ok:true,...data};
    }
    throw new Error('不支持的工具。');
  }
  async function undo(change,signal){
    const data=await send({type:'LC_READ_CONTEXT'},signal);signal?.throwIfAborted();
    if(manual || problemKey(change.url)!==problemKey(url) || problemKey(data.url)!==problemKey(url) || !data.complete || !data.editable || data.editorId!==change.editorId || data.code!==change.after)throw new Error('代码已变化或编辑器已重建，无法直接撤销这次修改。可在力扣中使用 Ctrl+Z，或要求 AI 基于最新代码调整。');
    const updated=await send({type:'LC_AGENT_ACTION',action:'edit',...expected(data),after:change.before},signal,{targetUrl:data.url});
    if(updated.code!==change.before)throw new Error('未能确认撤销结果，请检查编辑器。');
    onChange(updated);return updated;
  }
  return {execute,undo,interruptWait:()=>waiting?.abort()};
}
