import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {ChatGPTAuth,equalSecret,RESOURCE} from './oauth.mjs';
import {Store,defaultDirectory,prepareDirectory,writePrivate} from './storage.mjs';

export const PORT=18765;
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function body(req){
  let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>2_000_000)throw new Error('请求过大。');}
  try{return JSON.parse(text || '{}');}catch{throw new Error('请求 JSON 无效。');}
}
export function planBody(value){
  if(typeof value.model!=='string' || value.model.length>200 || !Array.isArray(value.input) || value.input.length>20)throw new Error('模型或消息格式错误。');
  const input=value.input.map(m=>{
    if(!['user','assistant','developer'].includes(m.role) || typeof m.content!=='string')throw new Error('订阅连接仅接受文本对话。');
    return {role:m.role,content:m.content};
  });
  return {model:value.model,input,instructions:typeof value.instructions==='string'?value.instructions:'',store:false,stream:true};
}
export function createCompanion({auth,pairKey,port=PORT}){
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    const expected=`127.0.0.1:${server.address()?.port || port}`;
    if(req.headers.host!==expected)return json(res,403,{error:'Host 不受支持。'});
    let url;try{url=new URL(req.url,`http://${expected}`);}catch{return json(res,400,{error:'请求地址无效。'});}
    if(url.pathname==='/auth/callback' && req.method==='GET'){
      try{await auth.callback(url);res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('授权已处理，请回到力扣伴读，点击“刷新登录状态”。'+auth.notice);}
      catch(e){res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'});res.end(e.message);}
      return;
    }
    const origin=req.headers.origin;
    if(origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))return json(res,403,{error:'Origin 不受支持。'});
    if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
    if(req.method==='OPTIONS'){
      res.setHeader('Access-Control-Allow-Methods','GET, POST');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-Plan-Account');
      res.writeHead(204);res.end();return;
    }
    if(!equalSecret(req.headers.authorization,`Bearer ${pairKey}`))return json(res,401,{error:'本地连接码不正确，请复制启动窗口中的连接码。'});
    try{
      if(url.pathname==='/auth/status' && req.method==='GET'){
        const state=await auth.status();
        return json(res,200,{...state,profiles:state.profiles.map(({clientId,...p})=>p)});
      }
      if(url.pathname==='/auth/login' && req.method==='POST'){
        const data=await body(req);
        const authorizeUrl=await auth.begin({redirectUri:`http://${expected}/auth/callback`,profileId:data.profileId || undefined,newProfile:!!data.newProfile,enablePlan:!!data.enablePlan});
        return json(res,200,{authorizeUrl});
      }
      if(url.pathname==='/auth/cancel' && req.method==='POST'){auth.cancel();return json(res,200,{ok:true});}
      if(url.pathname==='/auth/select' && req.method==='POST'){await auth.select((await body(req)).profileId);return json(res,200,{ok:true});}
      if(url.pathname==='/auth/logout' && req.method==='POST'){return json(res,200,await auth.signOut((await body(req)).profileId));}
      if(url.pathname==='/v1/models' && req.method==='GET'){
        const models=await auth.refreshModels();return json(res,200,{models});
      }
      if(url.pathname==='/v1/responses' && req.method==='POST'){
        const request=planBody(await body(req));
        const profileId=req.headers['x-plan-account'];
        if(typeof profileId!=='string' || !profileId)throw new Error('请先选择并保存 ChatGPT 账号。');
        const profile=await auth.current(profileId);
        if(!profile.models?.some(m=>m.slug===request.model))throw new Error('模型不在该账号列表中，请刷新模型列表并重新选择。');
        const aborter=new AbortController();res.on('close',()=>aborter.abort());
        const signal=AbortSignal.any([aborter.signal,auth.requestController.signal,AbortSignal.timeout(240000)]);
        const upstream=await auth.fetchInference(profileId,RESOURCE+'/responses',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal});
        if(!upstream.ok){await upstream.body?.cancel();return json(res,upstream.status,{error:`OpenAI 请求失败（${upstream.status}），请检查登录、模型或套餐额度。`});}
        if(!upstream.headers.get('content-type')?.includes('text/event-stream')){await upstream.body?.cancel();throw new Error('OpenAI 未返回预期的数据流。');}
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8'});
        const reader=upstream.body.getReader();
        try{while(!signal.aborted){const {value,done}=await reader.read();if(done)break;if(!res.write(value))await Promise.race([once(res,'drain'),once(res,'close')]);}}
        finally{await reader.cancel().catch(()=>{});reader.releaseLock();res.end();}
        return;
      }
      json(res,404,{error:'未知接口。'});
    }catch(e){if(!res.headersSent)json(res,400,{error:e.message});else res.end();}
  });
  return server;
}
export async function start({directory=defaultDirectory(),port=PORT}={}){
  await prepareDirectory(directory);
  const pairingPath=join(directory,'pairing.json');let pairKey;
  try{pairKey=JSON.parse(await readFile(pairingPath,'utf8')).key;if(!/^[A-Za-z0-9_-]{43}$/.test(pairKey))throw new Error('连接码文件损坏。');}
  catch(e){if(e.code!=='ENOENT')throw e;pairKey=randomBytes(32).toString('base64url');await writePrivate(pairingPath,{key:pairKey});}
  const auth=new ChatGPTAuth({store:new Store(directory)});
  const server=createCompanion({auth,pairKey,port});
  server.listen(port,'127.0.0.1');await once(server,'listening');
  try{await auth.initialize();}catch(e){server.close();throw e;}
  return {server,auth,pairKey};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  start().then(({pairKey})=>{
    console.log(`力扣伴读 · ChatGPT 本地连接已启动（127.0.0.1:${PORT}）。\n请保持此窗口运行；关闭窗口即停止连接。\n在扩展“设置 → 模型 → ChatGPT 订阅”中粘贴以下本地连接码：\n\n${pairKey}\n\n此码只用于本机配对，请勿上传或发给别人。`);
  }).catch(e=>{console.error(e.code==='EADDRINUSE'?'连接端口已被占用，请检查是否已有连接程序运行。':e.message);process.exitCode=1;});
}
