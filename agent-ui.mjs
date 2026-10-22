const LABELS={read_editor:'读取最新代码',apply_code_edit:'修改编辑器',run_tests:'运行当前用例',submit_solution:'提交力扣判题',get_test_run:'查询运行/判题状态',cancel_test_run:'停止任务监控',inspect_page:'检查页面与控件',read_test_result:'读取测试结果'};
const runSummary=out=>{
  const elapsed=`${((out.elapsed_ms || 0)/1000).toFixed(1)} 秒`;
  if(out.status==='completed')return `${out.task_kind==='submit'?'提交判题':'当前用例'}：${out.verdict?.label || '已收到新结果'} · ${elapsed}`;
  if(out.status==='running')return `后台运行中 · ${elapsed} · ${out.timeout_ms/1000} 秒超时；尚未验证`;
  return out.note || `${out.status} · ${elapsed}`;
};
export const toolLabel=name=>LABELS[name] || '未知工具';
export function updateAction(actions,event){
  let action=actions.find(a=>a.id===event.id && a.round===event.round);
  if(!action){action={id:event.id,name:event.name,round:event.round};actions.push(action);}
  if(event.phase==='start'){action.state='running';action.summary='进行中…';}
  else if(event.phase==='cancel'){action.state='interrupted';action.summary=event.error;}
  else {
    const out=event.output;
    action.state=out.ok?'done':'error';action.change=out.change;
    if(['timed_out','canceled','invalidated','failed'].includes(out.status))action.state='warning';
    action.summary=!out.ok?out.error:out.status?runSummary(out):out.change?'已应用，可撤销':event.name==='read_editor'?`已读取 ${out.code?.split('\n').length || 0} 行${out.editable?'':' · 只读'}`:
      event.name==='inspect_page'?`已读取 ${out.controls?.length || 0} 个控件、${out.result_regions?.length || 0} 个结果区`:'当前可见结果，可能来自历史运行';
    action.result=out.tests || '';
    if(out.status || event.name==='inspect_page')action.diagnostics=JSON.stringify(out,null,2).slice(0,25000);
  }
  return action;
}
export function renderActions(article,actions,onUndo){
  let trace=article.querySelector('.agent-trace');
  if(!actions?.length){trace?.remove();return;}
  const opened=trace?.open ?? true;
  if(!trace){trace=document.createElement('details');trace.className='agent-trace';article.append(trace);}
  trace.open=opened;trace.replaceChildren();
  const summary=document.createElement('summary');summary.textContent=`Agent 操作 · ${actions.length} 步`;trace.append(summary);
  for(const action of actions){
    const row=document.createElement('div');row.className='agent-step';row.dataset.state=action.state;
    const title=document.createElement('strong');title.textContent=toolLabel(action.name);
    const status=document.createElement('span');status.className='agent-step-status';status.textContent=action.summary || '已中断';row.append(title,status);
    if(action.result){const detail=document.createElement('details'),heading=document.createElement('summary'),pre=document.createElement('pre');heading.textContent='查看页面结果';pre.textContent=action.result;detail.append(heading,pre);row.append(detail);}
    if(action.diagnostics){const detail=document.createElement('details'),heading=document.createElement('summary'),pre=document.createElement('pre');heading.textContent='查看诊断与状态';pre.textContent=action.diagnostics;detail.append(heading,pre);row.append(detail);}
    if(action.change){
      const details=document.createElement('details'),heading=document.createElement('summary');heading.textContent='查看代码变更';details.append(heading);
      for(const [label,text] of [['修改前',action.change.oldText],['修改后',action.change.newText]]){const p=document.createElement('p'),pre=document.createElement('pre');p.textContent=label;pre.textContent=text || '（空）';details.append(p,pre);}
      const button=document.createElement('button');button.type='button';button.className='text-button undo-edit';button.textContent=action.undone?'已撤销':'撤销此修改';button.disabled=!!action.undone;
      button.addEventListener('click',()=>onUndo(action,button));row.append(details,button);
    }
    trace.append(row);
  }
}
