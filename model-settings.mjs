import {ConnectionStore,normalizeConnection,normalizeApiUrl,permissionOrigin,fetchModels,generate} from './providers.mjs';
const $=id=>document.getElementById(id);
export const PLAN_ROOT='http://127.0.0.1:18765';
export function planFetch(key,accountId,fetcher=fetch){
  return async (url,options={})=>{
    if(![PLAN_ROOT+'/v1/responses',PLAN_ROOT+'/v1/models'].includes(url))throw new Error('本地连接地址不正确。');
    const response=await fetcher(url,{...options,headers:{...options.headers,Authorization:`Bearer ${key}`,'X-Plan-Account':accountId}});
    if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(data?.error || `本地连接失败（${response.status}）。`);}
    return response;
  };
}
export async function initializeModelSettings(){
  const store=new ConnectionStore(chrome.storage.local,chrome.storage.session);
  let connections=await store.load(),active=connections.profiles.find(p=>p.id===connections.activeId) || connections.profiles[0];
  let activeKey=await store.key(active),editId=active.id,editUrl=active.apiUrl,revision=0;
  const local=await chrome.storage.local.get(['modelMode','planSettings','planKey']);
  const session=await chrome.storage.session.get('planKey');
  let mode=local.modelMode || 'api',planSettings=local.planSettings || {},planKey=planSettings.remember?local.planKey || '':session.planKey || '';
  let planState=null,poll=null,locked=false,statusFlight=null;
  function message(text){$('settings-status').textContent=text;}
  function profileOptions(){
    $('connection-profile').replaceChildren(...connections.profiles.map(p=>new Option(p.name,p.id)));
    $('connection-profile').value=editId;
  }
  function summary(){
    $('connection-summary').textContent=mode==='plan'?`ChatGPT 订阅 · ${planSettings.model || '未选模型'} · 发送时附带本题上下文与最近对话`:
      `${active.name} · ${active.model} · ${new URL(active.apiUrl).host} · 发送本题与最近对话，按服务商用量计费`;
  }
  function protocolHint(){
    let deepseek=false;try{deepseek=new URL($('api-url').value).hostname==='api.deepseek.com';}catch{}
    $('thinking-field').hidden=!deepseek || $('api-protocol').value!=='chat';
  }
  function switchFields(){const plan=$('connection-type').value==='plan';$('api-fields').hidden=plan;$('plan-fields').hidden=!plan;}
  async function fill(profile){
    const ticket=++revision;editId=profile.id;editUrl=profile.apiUrl;
    $('connection-name').value=profile.name;$('api-url').value=profile.apiUrl;$('model').value=profile.model;
    $('api-protocol').value=profile.protocol;$('thinking').checked=profile.thinking;$('remember-key').checked=profile.rememberKey;
    $('api-key').value='';$('model-list').replaceChildren(new Option(profile.model || '先获取模型列表',profile.model || ''));
    profileOptions();protocolHint();
    const key=await store.key(profile);if(ticket===revision)$('api-key').value=key || '';
  }
  function readProfile(){return normalizeConnection({id:editId,name:$('connection-name').value,apiUrl:$('api-url').value,model:$('model').value.trim(),protocol:$('api-protocol').value,thinking:$('thinking').checked,rememberKey:$('remember-key').checked});}
  // Called directly from a user click, before any asynchronous work, for optional host access.
  function allow(apiUrl){return chrome.permissions.request({origins:[permissionOrigin(apiUrl)]});}
  async function requirePermission(apiUrl){if(!await allow(apiUrl))throw new Error('未获得该地址的访问权限，配置和对话未切换。');}
  function invalidate(){revision++;let url='';try{url=normalizeApiUrl($('api-url').value);}catch{}
    if(url!==editUrl){$('api-key').value='';$('model-list').replaceChildren(new Option('地址已改变，请重新获取',''));editUrl=url;}
    protocolHint();
  }
  function planHeaders(){const key=$('plan-key').value.trim();if(!key)throw new Error('请先启动 companion/start.cmd，并填写它显示的本地连接码。');return {Authorization:`Bearer ${key}`,'Content-Type':'application/json'};}
  async function planCall(path,data){
    const res=await fetch(PLAN_ROOT+path,{method:data===undefined?'GET':'POST',headers:planHeaders(),...(data===undefined?{}:{body:JSON.stringify(data)}),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(35000)});
    const json=await res.json();if(!res.ok)throw new Error(json.error || `本地连接失败（${res.status}）。`);return json;
  }
  function modelsForAccount(){
    const p=planState?.profiles.find(p=>p.id===$('plan-account').value);
    const old=$('plan-model').value || planSettings.model;
    $('plan-model').replaceChildren(...(p?.models?.length?p.models.map(m=>new Option(m.display_name || m.slug,m.slug)):[new Option('请刷新模型列表','')]));
    if(p?.models?.some(m=>m.slug===old))$('plan-model').value=old;
  }
  function checkPlan(){
    if(!statusFlight)statusFlight=readPlanStatus().finally(()=>{statusFlight=null;});
    return statusFlight;
  }
  async function readPlanStatus(){
    const key=$('plan-key').value.trim(),old=$('plan-account').value;
    const next=await planCall('/auth/status');if(key!==$('plan-key').value.trim())return;
    const completedLogin=planState?.pending && !next.pending;planState=next;
    $('plan-account').replaceChildren(...(next.profiles.length?next.profiles.map(p=>new Option((p.email || p.label || '账号')+(p.planEnabled?'':' · 待授权'),p.id)):[new Option('登录后选择','')]));
    const preferred=completedLogin?next.activeProfileId:old || planSettings.accountId || next.activeProfileId;
    if(next.profiles.some(p=>p.id===preferred))$('plan-account').value=preferred;
    modelsForAccount();
    const p=next.profiles.find(p=>p.id===$('plan-account').value);
    $('plan-notice').textContent=next.pending?'等待你在 OpenAI 官方页面完成授权…':next.notice || (p?.planEnabled?'已连接 ChatGPT 套餐。请选择模型并保存。':'本地程序已连接，可以登录 ChatGPT。');
    if(!next.pending && poll){clearInterval(poll);poll=null;}
  }
  async function planAction(fn){
    if(locked)return;locked=true;
    try{await requirePermission(PLAN_ROOT);await fn();}
    catch(e){$('plan-notice').textContent=e instanceof TypeError?'无法连接本地程序，请运行 companion/start.cmd 并保持窗口打开。':e.message;}
    finally{locked=false;}
  }
  async function login(newProfile=false){
    const result=await planCall('/auth/login',{profileId:newProfile?undefined:$('plan-account').value || undefined,newProfile,enablePlan:true});
    const url=new URL(result.authorizeUrl);
    if(url.origin!=='https://auth.openai.com' || url.pathname!=='/api/accounts/authorize')throw new Error('登录地址不符合预期。');
    await chrome.tabs.create({url:url.href});
    await checkPlan();
    $('plan-notice').textContent='已打开 OpenAI 官方登录页面，请完成账号登录和套餐授权。';
    if(poll)clearInterval(poll);poll=setInterval(()=>{if(!locked)checkPlan().catch(()=>{clearInterval(poll);poll=null;$('plan-notice').textContent='登录状态刷新失败，请手动刷新。';});},3000);
  }
  async function loadModels(){
    const ticket=revision,key=$('api-key').value.trim();let profile;
    try{
      profile={apiUrl:normalizeApiUrl($('api-url').value)};
      $('load-models').disabled=true;await requirePermission(profile.apiUrl);message('正在读取模型列表…');
      const models=await fetchModels(profile,key,AbortSignal.timeout(20000));
      if(ticket!==revision || key!==$('api-key').value.trim())return;
      $('model-list').replaceChildren(...models.map(m=>new Option(m.name,m.id)));
      if(models.some(m=>m.id===$('model').value))$('model-list').value=$('model').value;else $('model').value=models[0].id;
      message(`已获取 ${models.length} 个模型，请选择并保存。`);
    }catch(e){if(ticket===revision)message(e instanceof TypeError?'无法连接 API，请检查地址、网络或接口兼容性。':e.message);}
    finally{$('load-models').disabled=false;}
  }
  async function save(){
    const nextMode=$('connection-type').value;
    if(nextMode==='plan'){
      const next={accountId:$('plan-account').value,model:$('plan-model').value,remember:$('remember-plan-key').checked};
      const key=$('plan-key').value.trim();
      if(!next.accountId || !next.model || !key)throw new Error('请完成 ChatGPT 登录并选择账号和模型。');
      await requirePermission(PLAN_ROOT);
      const state=await planCall('/auth/status');
      if(!state.profiles.some(p=>p.id===next.accountId && p.planEnabled && p.models.some(m=>m.slug===next.model)))throw new Error('账号或模型已改变，请刷新登录状态后重试。');
      await (next.remember?chrome.storage.local:chrome.storage.session).set({planKey:key});
      await chrome.storage.local.set({modelMode:'plan',planSettings:next});
      await (next.remember?chrome.storage.session:chrome.storage.local).remove('planKey');
      planSettings=next;planKey=key;mode='plan';
    }else{
      const profile=readProfile(),key=$('api-key').value.trim(),ticket=revision;
      await requirePermission(profile.apiUrl);
      if(ticket!==revision)throw new Error('配置已改变，请重新保存。');
      const next={activeId:profile.id,profiles:[...connections.profiles.filter(p=>p.id!==profile.id),profile]};
      await store.save(next,profile,key);
      await chrome.storage.local.set({modelMode:'api'});
      connections=next;active=profile;activeKey=key;mode='api';profileOptions();
    }
    summary();
  }
  async function snapshot(){
    const connection=mode==='plan'?{name:'ChatGPT 订阅',apiUrl:PLAN_ROOT+'/v1',model:planSettings.model,protocol:'responses'}:structuredClone(active);
    const key=mode==='plan'?planKey:activeKey,accountId=planSettings.accountId,type=mode;
    if(!connection.model || (type==='plan' && (!key || !accountId)))throw new Error('请先在设置中完成模型连接。');
    if(!await chrome.permissions.contains({origins:[permissionOrigin(connection.apiUrl)]}))throw new Error('该服务的访问权限未授予，请打开模型设置并保存。');
    return {label:`${connection.name} · ${connection.model}`,generate:(messages,onDelta,signal)=>generate(connection,key,messages,onDelta,signal,type==='plan'?planFetch(key,accountId):fetch)};
  }
  $('connection-type').value=mode;switchFields();
  $('plan-key').value=planKey;$('remember-plan-key').checked=!!planSettings.remember;
  $('connection-type').addEventListener('change',()=>{switchFields();message('连接方式已选择，保存后生效。');});
  for(const id of ['connection-name','api-url','api-key','api-protocol','model','model-list','thinking','remember-key','plan-key','remember-plan-key','plan-account','plan-model']){
    $(id).addEventListener('input',()=>message('配置已修改，保存后生效。'));
  }
  $('connection-profile').addEventListener('change',()=>fill(connections.profiles.find(p=>p.id===$('connection-profile').value)).catch(()=>message('无法读取连接。')));
  $('new-connection').addEventListener('click',()=>{fill({id:crypto.randomUUID(),name:'',apiUrl:'',model:'',protocol:'chat',rememberKey:false,thinking:false}).catch(()=>{});message('填写新 API 的地址和密钥，再获取模型；保存后启用。');});
  $('api-url').addEventListener('input',invalidate);$('api-protocol').addEventListener('change',protocolHint);
  $('model-list').addEventListener('change',()=>{$('model').value=$('model-list').value;});
  $('load-models').addEventListener('click',loadModels);
  $('forget-key').addEventListener('click',async()=>{const id=editId;try{await store.forget(id);if(id===editId)$('api-key').value='';if(id===active.id)activeKey='';message('所选 API 的密钥已清除。');}catch{message('清除失败，请重试。');}});
  $('plan-login').addEventListener('click',()=>planAction(()=>login(false)));
  $('plan-add').addEventListener('click',()=>planAction(()=>login(true)));
  $('plan-status').addEventListener('click',()=>planAction(checkPlan));
  $('plan-cancel').addEventListener('click',()=>planAction(async()=>{await planCall('/auth/cancel',{});await checkPlan();}));
  $('plan-account').addEventListener('change',()=>{modelsForAccount();});
  $('plan-models').addEventListener('click',()=>planAction(async()=>{const profileId=$('plan-account').value;if(!profileId)throw new Error('请先登录。');await planCall('/auth/select',{profileId});await planCall('/v1/models');await checkPlan();}));
  $('plan-logout').addEventListener('click',()=>planAction(async()=>{const profileId=$('plan-account').value;if(!profileId)throw new Error('请先选择账号。');await planCall('/auth/logout',{profileId});await checkPlan();}));
  await fill(active);summary();
  if(planKey && await chrome.permissions.contains({origins:[permissionOrigin(PLAN_ROOT)]}))checkPlan().catch(()=>{$('plan-notice').textContent='请启动本地连接程序后刷新登录状态。';});
  return {save,snapshot,configured:mode==='plan'?!!planKey:!!activeKey};
}
