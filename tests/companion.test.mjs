import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {createCompanion,planBody} from '../companion/server.mjs';
const origin='chrome-extension://'+'a'.repeat(32),key='local-test-pairing';
async function fixture(t){
  const calls=[];
  const auth={notice:'',requestController:new AbortController(),
    async status(){return {activeProfileId:'account',pending:false,profiles:[{id:'account',clientId:'private-client',email:'test@example.invalid',planEnabled:true,models:[{slug:'test-model'}]}]};},
    async current(id){if(id!=='account')throw new Error('无此账号');return {models:[{slug:'test-model'}]};},
    async refreshModels(){return [{slug:'test-model',visibility:'list'}];},
    async fetchInference(id,url,init){calls.push({id,url,body:JSON.parse(init.body)});return new Response('data: {"type":"response.output_text.delta","delta":"你好"}\n\ndata: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream'}});},
    async begin(options){calls.push(options);return 'https://auth.openai.com/api/accounts/authorize?state=test';},
    async callback(url){if(url.searchParams.get('state')!=='test')throw new Error('state 不匹配');},
    cancel(){calls.push('cancel');},async select(id){calls.push(id);},async signOut(id){calls.push(id);return {revoked:true};}
  };
  const server=createCompanion({auth,pairKey:key,port:0});server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const root='http://127.0.0.1:'+server.address().port;
  const request=(path,options={})=>fetch(root+path,{...options,headers:{Origin:origin,Authorization:`Bearer ${key}`,...options.headers}});
  return {request,root,calls};
}
test('companion rejects wrong pairing, webpage Origin and malicious Host',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/auth/status',{headers:{Authorization:'Bearer wrong'}})).status,401);
  assert.equal((await f.request('/auth/status',{headers:{Origin:'https://leetcode.cn'}})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{const req=httpRequest(f.root+'/auth/status',{headers:{Host:'evil.example',Authorization:`Bearer ${key}`}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(hostStatus,403);
  const preflight=await f.request('/v1/responses',{method:'OPTIONS'});assert.equal(preflight.status,204);assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
});
test('companion status exposes account metadata only and model catalog can be read',async t=>{
  const f=await fixture(t),res=await f.request('/auth/status');assert.equal(res.status,200);
  const body=await res.text();assert(!body.includes('private-client'));assert(!body.includes(key));
  assert.equal((await (await f.request('/v1/models')).json()).models[0].slug,'test-model');
});
test('login uses loopback callback; invalid callback cannot complete',async t=>{
  const f=await fixture(t);
  const login=await f.request('/auth/login',{method:'POST',body:JSON.stringify({newProfile:true})});assert.equal(login.status,200);
  assert.equal(f.calls[0].redirectUri,f.root+'/auth/callback');assert.equal(f.calls[0].newProfile,true);
  assert.equal((await fetch(f.root+'/auth/callback?state=wrong')).status,400);
  assert.equal((await fetch(f.root+'/auth/callback?state=test')).status,200);
});
test('subscription request is pinned to chosen account, strips unsupported fields and streams text',async t=>{
  const f=await fixture(t),payload={model:'test-model',input:[{role:'user',content:'code question'}],instructions:'teach',tools:[{type:'shell'}],store:true,max_output_tokens:10};
  const res=await f.request('/v1/responses',{method:'POST',headers:{'X-Plan-Account':'account'},body:JSON.stringify(payload)});
  assert.equal(res.status,200);assert.match(await res.text(),/你好/);
  assert.equal(f.calls[0].id,'account');assert.equal(f.calls[0].url,'https://api.openai.com/v1/responses');
  assert.equal(f.calls[0].body.store,false);assert.equal(f.calls[0].body.tools,undefined);assert.equal(f.calls[0].body.max_output_tokens,undefined);
  assert.equal((await f.request('/v1/responses',{method:'POST',body:JSON.stringify(payload)})).status,400);
  assert.equal((await f.request('/v1/responses',{method:'POST',headers:{'X-Plan-Account':'account'},body:JSON.stringify({...payload,model:'hidden'})})).status,400);
});
test('subscription route accepts text only and cannot proxy arbitrary endpoints',async t=>{
  assert.throws(()=>planBody({model:'test',input:[{role:'tool',content:'execute'}]}));
  const f=await fixture(t);assert.equal((await f.request('/v1/chat/completions',{method:'POST',body:'{}'})).status,404);
});
