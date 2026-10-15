import {problemKey, validProblem} from './core.mjs';

export function emptyConversation() {
  return {version:1, messages:[], history:[], draft:'', manualCode:'', useManual:false, mode:'explain', title:'', updatedAt:0};
}
export function conversationKey(url) {
  if (!validProblem(url)) throw new Error('Invalid problem identity');
  return 'conversation.v1:' + problemKey(url);
}
export function restoreConversation(value) {
  const result={...emptyConversation(), ...(value || {})};
  result.messages=(Array.isArray(result.messages)?result.messages:[]).filter(m=>['user','assistant'].includes(m.role) && typeof m.text==='string').map(m=>({...m}));
  result.history=(Array.isArray(result.history)?result.history:[]).filter(m=>['user','assistant'].includes(m.role) && typeof m.content==='string').slice(-8);
  for (const field of ['draft','manualCode','title']) if(typeof result[field]!=='string') result[field]='';
  result.useManual=result.useManual===true;
  if(!['explain','hint','debug','complexity'].includes(result.mode))result.mode='explain';
  for (const message of result.messages) {
    if(message.pending) {message.pending=false;message.note='上次生成已中断，已保留收到的内容；可以继续提问。';}
  }
  return result;
}

// Every write captures an immutable snapshot and is ordered per problem.
// Reads wait for pending writes so switching A → B → A cannot restore stale A.
export class ConversationStore {
  constructor(storage) {this.storage=storage;this.pending=new Map();}
  async load(url) {
    const key=conversationKey(url);
    await this.pending.get(key)?.catch(()=>{});
    return restoreConversation((await this.storage.get(key))[key]);
  }
  save(url,value) {
    const key=conversationKey(url), copy=structuredClone(value);
    copy.version=1;copy.updatedAt=Date.now();
    const prior=this.pending.get(key)||Promise.resolve();
    const write=prior.catch(()=>{}).then(()=>this.storage.set({[key]:copy}));
    this.pending.set(key,write);
    write.finally(()=>{if(this.pending.get(key)===write)this.pending.delete(key);}).catch(()=>{});
    return write;
  }
}
