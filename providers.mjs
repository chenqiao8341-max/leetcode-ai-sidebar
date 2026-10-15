import {API_ROOT, DEFAULT_MODEL, consumeSSE, errorMessage} from './core.mjs';

export function normalizeApiUrl(value) {
  let url;
  try {url = new URL(value.trim());} catch {throw new Error('请填写完整的 API URL，例如 https://api.example.com/v1。');}
  if (url.username || url.password || url.search || url.hash) throw new Error('API URL 不能包含账号、密码、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('远程 API 必须使用 HTTPS；本机服务可以使用 HTTP。');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|models)$/, '');
  return url.href.replace(/\/+$/, '');
}
export function permissionOrigin(apiUrl) {
  const u = new URL(normalizeApiUrl(apiUrl));
  return `${u.protocol}//${u.hostname}/*`;
}
export function validModel(value) {return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\s\x00-\x1f]/.test(value);}
export function normalizeConnection(value) {
  const apiUrl = normalizeApiUrl(value.apiUrl);
  if (!validModel(value.model)) throw new Error('请从列表选择模型，或填写服务商提供的模型 ID。');
  return {id:value.id || crypto.randomUUID(), name:(value.name || new URL(apiUrl).hostname).trim().slice(0,80),
    apiUrl, model:value.model, protocol:value.protocol === 'responses' ? 'responses' : 'chat',
    thinking:!!value.thinking, rememberKey:!!value.rememberKey};
}
export function parseModels(data) {
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models.filter(m=>!m.visibility || m.visibility==='list') : [];
  return [...new Map(list.map(m=>({id:m.id || m.slug, name:m.display_name || m.id || m.slug})).filter(m=>validModel(m.id)).map(m=>[m.id,m])).values()];
}
export function buildRequest(connection,messages) {
  const root = normalizeApiUrl(connection.apiUrl);
  if (connection.protocol === 'responses') {
    return {url:root+'/responses', body:{model:connection.model, instructions:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),
      input:messages.filter(m=>m.role!=='system').map(m=>({role:m.role,content:m.content})), stream:true,store:false}};
  }
  const body = {model:connection.model,messages,stream:true};
  // Provider-specific parameters must never leak into another provider's schema.
  if (new URL(root).hostname === 'api.deepseek.com') Object.assign(body,{max_tokens:connection.thinking?16000:4096,thinking:{type:connection.thinking?'enabled':'disabled'}});
  return {url:root+'/chat/completions',body};
}
export async function consumeResponses(stream,onDelta,signal) {
  const reader=stream.getReader(), decoder=new TextDecoder();
  let buffer='',text='',completed=false;
  function event(block) {
    const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!raw || raw==='[DONE]')return;
    let data;try{data=JSON.parse(raw);}catch{throw new Error('Responses 返回了无法解析的数据。');}
    if(data.type==='response.output_text.delta' && typeof data.delta==='string'){text+=data.delta;onDelta(data.delta,{reasoning:false});}
    if(data.type==='response.refusal.delta' && typeof data.delta==='string'){text+=data.delta;onDelta(data.delta,{reasoning:false});}
    if(data.type==='response.completed')completed=true;
    if(['error','response.failed','response.incomplete'].includes(data.type)) {
      const code=data.code || data.error?.code || data.response?.error?.code;
      if(code==='subscription_sharing_usage_limit_exceeded')throw new Error('ChatGPT 套餐授权额度已用完，请到 ChatGPT 用量设置查看。');
      if(code==='subscription_sharing_usage_unavailable')throw new Error('当前账号暂不能使用套餐授权，请检查 ChatGPT 账号权限。');
      throw new Error(data.type==='response.incomplete'?'回答未完成，可能达到输出限制。':'模型返回错误，请检查账号权限、模型和额度。');
    }
  }
  try {
    while(!completed){
      if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});buffer=buffer.replace(/\r\n/g,'\n');
      let i;while((i=buffer.indexOf('\n\n'))!==-1){event(buffer.slice(0,i));buffer=buffer.slice(i+2);if(completed)break;}
      if(done){if(buffer.trim()&&!completed)event(buffer);break;}
    }
    if(!completed)throw new Error('连接提前结束，回答未收到完成确认。');
    if(!text)throw new Error('模型没有返回文本回答。');
    return {text,finishReason:'stop'};
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function generate(connection,key,messages,onDelta,signal,fetcher=fetch) {
  const request=buildRequest(connection,messages);
  const response=await fetcher(request.url,{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{})},
    body:JSON.stringify(request.body),signal,credentials:'omit',redirect:'error'});
  if(!response.ok)throw new Error(errorMessage(response.status));
  if(!response.body || !response.headers.get('content-type')?.includes('text/event-stream'))throw new Error('接口未返回 SSE 数据流，请检查 API URL 和接口格式。');
  return (connection.protocol==='responses'?consumeResponses:consumeSSE)(response.body,onDelta,signal);
}
export async function fetchModels(connection,key,signal,fetcher=fetch) {
  const response=await fetcher(normalizeApiUrl(connection.apiUrl)+'/models',{headers:key?{Authorization:`Bearer ${key}`}:{},signal,credentials:'omit',redirect:'error'});
  if(!response.ok)throw new Error(errorMessage(response.status));
  const models=parseModels(await response.json());
  if(!models.length)throw new Error('接口未返回模型列表，可以手动填写模型 ID。');
  return models;
}

// Credentials are bound to a profile AND its canonical URL, never shared between providers.
export class ConnectionStore {
  constructor(local,session){this.local=local;this.session=session;}
  async load(){
    const local=await this.local.get(['connections','settings','rememberKey','apiKey']);
    if(local.connections?.profiles?.length)return structuredClone(local.connections);
    const profile={id:'deepseek-legacy',name:'DeepSeek',apiUrl:API_ROOT,model:local.settings?.model || DEFAULT_MODEL,protocol:'chat',thinking:!!local.settings?.thinking,rememberKey:!!local.rememberKey};
    const key=local.rememberKey?local.apiKey:(await this.session.get('apiKey')).apiKey;
    const state={activeId:profile.id,profiles:[profile]};
    await this.save(state,profile,key || '');
    return state;
  }
  async key(profile){
    const entry=(await (profile.rememberKey?this.local:this.session).get('key:'+profile.id))['key:'+profile.id];
    return entry?.apiUrl===profile.apiUrl?entry.value:'';
  }
  async save(state,profile,key){
    if(/\s/.test(key))throw new Error('密钥中不能含有空白字符。');
    const field='key:'+profile.id, target=profile.rememberKey?this.local:this.session, other=profile.rememberKey?this.session:this.local;
    await target.set({[field]:{apiUrl:profile.apiUrl,value:key}});
    await this.local.set({connections:state});
    await other.remove(field);
    // Remove the v0.4 unscoped key only after migration is durably saved.
    await this.local.remove('apiKey');await this.session.remove('apiKey');
  }
  async forget(id){await this.local.remove('key:'+id);await this.session.remove('key:'+id);}
}
