import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeApiUrl,permissionOrigin,normalizeConnection,parseModels,buildRequest,consumeResponses,ConnectionStore,generate} from '../providers.mjs';
import {planFetch,PLAN_ROOT} from '../model-settings.mjs';
const profile={id:'a',name:'Test',apiUrl:'https://api.example.com/v1',model:'test-model',protocol:'chat',rememberKey:false};
const messages=[{role:'system',content:'teach'},{role:'user',content:'question'},{role:'assistant',content:'answer'}];
const storage=(data={})=>({data,async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(data[k])]));},async set(values){Object.assign(data,structuredClone(values));},async remove(key){delete data[key];}});
const stream=events=>new ReadableStream({start(c){const text=events.map(e=>'data: '+JSON.stringify(e)+'\r\n\r\n').join('');for(const byte of new TextEncoder().encode(text))c.enqueue(new Uint8Array([byte]));c.close();}});
test('API URL preserves base path, normalizes full endpoints and rejects credentials/remote HTTP',()=>{
  assert.equal(normalizeApiUrl('https://example.com/gateway/v1/chat/completions/'),'https://example.com/gateway/v1');
  assert.equal(normalizeApiUrl('http://127.0.0.1:1234/v1'),'http://127.0.0.1:1234/v1');
  assert.equal(permissionOrigin('https://example.com:8443/v1'),'https://example.com/*');
  for(const url of ['http://example.com','https://key@example.com','https://example.com?key=secret','javascript:alert(1)','https://example.com/#a'])assert.throws(()=>normalizeApiUrl(url));
});
test('generic chat requests omit DeepSeek-only parameters; Responses converts system instructions',()=>{
  const generic=buildRequest(profile,messages);assert.deepEqual(Object.keys(generic.body).sort(),['messages','model','stream']);
  const deepseek=buildRequest({...profile,apiUrl:'https://api.deepseek.com',thinking:true},messages);assert.equal(deepseek.body.thinking.type,'enabled');
  const responses=buildRequest({...profile,protocol:'responses'},messages);assert.equal(responses.url,profile.apiUrl+'/responses');assert.equal(responses.body.instructions,'teach');assert.equal(responses.body.input.length,2);assert.equal(responses.body.store,false);
});
test('model menus accept both API and ChatGPT plan catalogs and hide non-list models',()=>{
  assert.deepEqual(parseModels({data:[{id:'org/model:free'},{id:'org/model:free'},{id:'bad id'}]}).map(m=>m.id),['org/model:free']);
  assert.deepEqual(parseModels({models:[{slug:'gpt-test',display_name:'Test',visibility:'list'},{slug:'hidden',visibility:'hidden'}]}),[{id:'gpt-test',name:'Test'}]);
  assert.throws(()=>normalizeConnection({...profile,model:''}));
});
test('v0.4 migration preserves model, key and independent conversation storage',async()=>{
  const local=storage({apiKey:'test-key',rememberKey:true,settings:{model:'legacy-model',thinking:true},'conversation.v1:a':{draft:'keep'}}),session=storage();
  const store=new ConnectionStore(local,session),state=await store.load();
  assert.equal(state.profiles[0].model,'legacy-model');assert.equal(await store.key(state.profiles[0]),'test-key');assert.equal(local.data.apiKey,undefined);assert.equal(local.data['conversation.v1:a'].draft,'keep');
});
test('keys stay scoped to profile and canonical URL, and session keys do not persist locally',async()=>{
  const local=storage(),session=storage(),store=new ConnectionStore(local,session);
  await store.save({profiles:[profile],activeId:'a'},profile,'test-a');
  assert.equal(await store.key(profile),'test-a');assert.equal(local.data['key:a'],undefined);
  assert.equal(await store.key({...profile,apiUrl:'https://different.example/v1'}),'');
  assert.equal(await store.key({...profile,id:'b'}),'');
  const remembered={...profile,rememberKey:true};await store.save({profiles:[remembered]},remembered,'test-b');
  assert.equal(session.data['key:a'],undefined);assert.equal(await store.key(remembered),'test-b');
  await store.forget('a');assert.equal(await store.key(remembered),'');
});
test('failed migration keeps legacy credentials recoverable',async()=>{
  const local=storage({apiKey:'legacy',rememberKey:true}),session=storage();local.set=async()=>{throw new Error('quota');};
  await assert.rejects(new ConnectionStore(local,session).load());assert.equal(local.data.apiKey,'legacy');
});
test('Responses decodes split UTF-8 and requires terminal completion',async()=>{
  let shown='';const result=await consumeResponses(stream([{type:'response.output_text.delta',delta:'中文'},{type:'response.completed'}]),d=>shown+=d);
  assert.equal(result.text,'中文');assert.equal(shown,'中文');
  await assert.rejects(consumeResponses(stream([{type:'response.output_text.delta',delta:'partial'}]),()=>{}),/提前结束/);
});
test('Responses rejects errors after output and reports subscription limits',async()=>{
  await assert.rejects(consumeResponses(stream([{type:'response.output_text.delta',delta:'partial'},{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}}]),()=>{}),/额度/);
  await assert.rejects(consumeResponses(stream([{type:'response.incomplete'}]),()=>{}),/未完成/);
});
test('requests use the chosen endpoint and key, block redirects, omit cookies and local auth stays local',async()=>{
  const fetcher=async(url,options)=>{assert.equal(url,profile.apiUrl+'/chat/completions');assert.equal(options.headers.Authorization,'Bearer test-key');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});};
  assert.equal((await generate(profile,'test-key',messages,()=>{},undefined,fetcher)).text,'ok');
  await assert.rejects(planFetch('pairing','account',fetcher)('https://example.com/v1/responses'),/地址/);
  await planFetch('pairing','account',async(url,options)=>{assert.equal(url,PLAN_ROOT+'/v1/models');assert.equal(options.headers['X-Plan-Account'],'account');return Response.json({});})(PLAN_ROOT+'/v1/models');
});
