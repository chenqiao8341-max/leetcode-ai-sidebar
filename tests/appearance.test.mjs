import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {THEME_IDS,normalizeTheme,resolveTheme,initializeAppearance} from '../appearance.mjs';

test('four palettes and system preference resolve safely',()=>{
  for(const id of ['light','dark','warm','lavender'])assert.equal(resolveTheme(id),id);
  assert.equal(resolveTheme('system',true),'dark');assert.equal(resolveTheme('system',false),'light');assert.equal(normalizeTheme('unexpected'),'light');
});
function fixture(theme='light') {
  const data={appearance:{theme},settings:{model:'existing-model'},apiKey:'test-only',conversation:{messages:['keep']}};
  const status={textContent:''},radios=THEME_IDS.map(value=>({value,checked:false,addEventListener(){}}));
  globalThis.document={querySelectorAll:()=>radios,getElementById:()=>status};
  const root={dataset:{}},media={matches:false,addEventListener(_,fn){this.notify=fn;}};
  const cache={value:null,setItem(_,value){this.value=value;},getItem(){return this.value;}};
  const changes={addListener(fn){this.notify=fn;}};
  const storage={async get(key){return {[key]:data[key]};},async set(value){await new Promise(r=>setTimeout(r,2));Object.assign(data,structuredClone(value));}};
  return {data,status,root,media,cache,radios,storage,changes};
}
test('saved theme restores without changing model, credentials or conversations',async()=>{
  const f=fixture('warm');const app=await initializeAppearance(f);
  assert.equal(f.root.dataset.theme,'warm');assert(f.radios.find(r=>r.value==='warm').checked);
  await app.choose('dark');assert.equal(f.data.appearance.theme,'dark');
  assert.equal(f.data.settings.model,'existing-model');assert.equal(f.data.apiKey,'test-only');assert.deepEqual(f.data.conversation.messages,['keep']);
});
test('rapid theme choices are saved in order and reopening restores final choice',async()=>{
  const f=fixture();const app=await initializeAppearance(f);
  const first=app.choose('dark');const second=app.choose('lavender');await Promise.all([first,second]);
  assert.equal(f.root.dataset.theme,'lavender');assert.equal(f.data.appearance.theme,'lavender');
  f.root.dataset.theme='light';await initializeAppearance(f);assert.equal(f.root.dataset.theme,'lavender');
});
test('system changes update appearance only in follow-system mode',async()=>{
  const f=fixture('system'),app=await initializeAppearance(f);f.media.matches=true;f.media.notify();assert.equal(f.root.dataset.theme,'dark');
  await app.choose('warm');f.media.matches=false;f.media.notify();assert.equal(f.root.dataset.theme,'warm');
});
test('preferences from another side panel synchronize',async()=>{
  const f=fixture();await initializeAppearance(f);f.changes.notify({appearance:{newValue:{theme:'dark'}}},'local');
  assert.equal(f.root.dataset.theme,'dark');assert.equal(f.cache.value,'dark');
});
test('failed save leaves preview active and explicitly reports failure',async()=>{
  const f=fixture();f.storage.set=async()=>{throw new Error('quota');};const app=await initializeAppearance(f);
  await assert.rejects(app.choose('dark'));assert.equal(f.root.dataset.theme,'dark');assert.match(f.status.textContent,/保存失败/);
});
test('prepaint cache validates values and resolves system without accessing credentials',async()=>{
  const script=await readFile(new URL('../theme-boot.js',import.meta.url),'utf8');
  for(const [value,expected] of [['dark','dark'],['system','dark'],['bad','light']]){
    const document={documentElement:{dataset:{}}};vm.runInNewContext(script,{document,localStorage:{getItem:()=>value},matchMedia:()=>({matches:true})});
    assert.equal(document.documentElement.dataset.theme,expected);
  }
});
test('core palette text has readable contrast on every background',async()=>{
  const css=await readFile(new URL('../themes.css',import.meta.url),'utf8');
  function l(hex){const rgb=hex.match(/[a-f\d]{2}/gi).map(x=>parseInt(x,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];}
  for(const block of css.matchAll(/\{([^}]+)\}/g)){
    const tokens=Object.fromEntries([...block[1].matchAll(/--([\w-]+):#([a-f\d]{6});/g)].map(m=>[m[1],m[2]]));
    const ratio=(a,b)=>(Math.max(l(a),l(b))+.05)/(Math.min(l(a),l(b))+.05);
    assert(ratio(tokens.text,tokens.bg)>=7,'main text contrast');assert(ratio(tokens['on-accent'],tokens.accent)>=4.5,'button contrast');
  }
});
