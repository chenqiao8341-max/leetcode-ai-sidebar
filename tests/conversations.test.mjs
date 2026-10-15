import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConversationStore,emptyConversation,conversationKey,restoreConversation} from '../conversations.mjs';
const A='https://leetcode.cn/problems/combination-sum/';
const B='https://leetcode.cn/problems/two-sum/';
function fakeStorage(){
 const data={};return {data,async get(k){return structuredClone({[k]:data[k]});},async set(values){await new Promise(r=>setTimeout(r,4));Object.assign(data,structuredClone(values));}};
}
test('same problem keeps identity across description pages, tracking params and tabs',()=>{
 assert.equal(conversationKey(A),conversationKey(A+'description/?foo=bar'));
 assert.throws(()=>conversationKey('https://example.com'));
});
test('A → B → A restores messages, model history, draft and manual code separately',async()=>{
 const storage=fakeStorage(),store=new ConversationStore(storage);
 const a={...emptyConversation(),messages:[{role:'user',text:'A问题'},{role:'assistant',text:'A回答'}],history:[{role:'user',content:'A问题'},{role:'assistant',content:'A回答'}],draft:'还没发出的问题',manualCode:'print(1)',useManual:true,mode:'hint'};
 await store.save(A,a);await store.save(B,{...emptyConversation(),draft:'B草稿'});
 const restored=await store.load(A);
 assert.equal(restored.messages[1].text,'A回答');assert.equal(restored.history[1].content,'A回答');assert.equal(restored.draft,'还没发出的问题');assert.equal(restored.manualCode,'print(1)');assert.equal(restored.useManual,true);assert.equal(restored.mode,'hint');
 assert.equal((await store.load(B)).draft,'B草稿');
});
test('closing and reopening side panel restores from storage with new store instance',async()=>{
 const storage=fakeStorage();await new ConversationStore(storage).save(A,{...emptyConversation(),messages:[{role:'assistant',text:'已保存的内容'}]});
 assert.equal((await new ConversationStore(storage).load(A)).messages[0].text,'已保存的内容');
});
test('read waits for queued writes and saving captures an immutable snapshot',async()=>{
 const store=new ConversationStore(fakeStorage()),a=emptyConversation();a.draft='first';store.save(A,a);a.draft='second';store.save(A,a);a.draft='unsaved';
 assert.equal((await store.load(A)).draft,'second');
});
test('clear affects current problem only and cannot be undone by an older pending write',async()=>{
 const store=new ConversationStore(fakeStorage());store.save(A,{...emptyConversation(),messages:[{role:'user',text:'旧记录'}]});store.save(A,emptyConversation());await store.save(B,{...emptyConversation(),draft:'保留'});
 assert.deepEqual((await store.load(A)).messages,[]);assert.equal((await store.load(B)).draft,'保留');
});
test('interrupted output remains visible, flagged incomplete, and not added to model history',()=>{
 const record=restoreConversation({...emptyConversation(),messages:[{role:'assistant',text:'部分回答',pending:true}]});
 assert.equal(record.messages[0].text,'部分回答');assert.equal(record.messages[0].pending,false);assert.match(record.messages[0].note,/中断/);assert.equal(record.history.length,0);
});
test('quota errors reject explicitly and a later retry can succeed',async()=>{
 const storage=fakeStorage();const set=storage.set;let fails=true;storage.set=async v=>{if(fails)throw new Error('QUOTA');await set(v);};
 const store=new ConversationStore(storage);await assert.rejects(store.save(A,emptyConversation()),/QUOTA/);fails=false;
 await store.save(A,{...emptyConversation(),draft:'重试'});assert.equal((await store.load(A)).draft,'重试');
});
