import {DEFAULT_PROMPT, validProblem, problemKey, effectiveSnapshot, contextText, makeMessages} from './core.mjs';
import {renderMessage as renderText, enableCodeCopy} from './render.mjs';
import {ConversationStore, emptyConversation} from './conversations.mjs';
import {initializeAppearance} from './appearance.mjs';
import {initializeModelSettings} from './model-settings.mjs';
const $ = id => document.getElementById(id);
let settings = {prompt: DEFAULT_PROMPT}, modelUI;
let snapshot = null, activeIdentity = '', history = [], controller = null, refreshPromise = null, busy = false;
let windowId, operation = 0, contextError = '';
let current = emptyConversation(), attached = false, pendingAnswer = null, lastProgressSave = 0, loadFailed = false;
const store = new ConversationStore(chrome.storage.local);
const memory = new Map();
const welcome = $('welcome').cloneNode(true);
function selectSettingsTab(name) {
  document.querySelectorAll('[data-settings-tab]').forEach(tab=>{
    const active=tab.dataset.settingsTab===name;
    tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
    $(tab.getAttribute('aria-controls')).hidden=!active;
  });
  $('save-settings').hidden=!['model','teaching'].includes(name);
  $('settings-status').hidden=!['model','teaching'].includes(name);
}
function openSettings(name='appearance') {
  selectSettingsTab(name);
  if(!$('settings').open)$('settings').showModal();
  $(`tab-${name}`).focus();
}
function status(text, error = false) { $('status').textContent = text; $('status').classList.toggle('error', error); }
function addMessage(role, text, reference = '', record = null) {
  $('welcome')?.remove();
  const article = document.createElement('article'); article.className = `message ${role}`;
  const who = document.createElement('div'); who.className = 'who'; who.textContent = role === 'user' ? '你' : record?.modelLabel || 'AI · 伴读';
  if (reference) {const ref = document.createElement('span'); ref.textContent = '· ' + reference; who.append(ref);}
  const body = document.createElement('div'); body.className = 'body'; renderText(body, text);
  article.append(who, body); $('messages').append(article);
  if(!record) {record={role,text,reference};current.messages.push(record);}
  if(record.note) note(article,record.note);
  return {article, body, record};
}
function captureCurrent() {
  current.history=history; current.draft=$('question').value;
  current.manualCode=$('manual-code').value;current.useManual=$('use-manual').checked;
  current.mode=$('mode').value;if(snapshot?.title)current.title=snapshot.title;
}
function persistCurrent() {
  if(!activeIdentity || loadFailed)return Promise.resolve();
  captureCurrent(); const identity=activeIdentity;
  memory.set(identity,structuredClone(current));
  $('save-state').textContent='保存中…';
  return store.save(identity,current).then(()=>{
    if(identity===activeIdentity){$('save-state').textContent='已保存到本机';$('save-state').classList.remove('save-error');}
  }).catch(()=>{
    if(identity===activeIdentity){$('save-state').textContent='本机保存失败，请勿关闭侧栏';$('save-state').classList.add('save-error');}
  });
}
function interruptCurrent(reason) {
  operation++; controller?.abort();controller=null;
  if(pendingAnswer){pendingAnswer.pending=false;pendingAnswer.note=reason;pendingAnswer=null;}
  setBusy(false);
}
function clearConversation() {
  interruptCurrent('');history=[];current.messages=[];
  $('messages').replaceChildren(welcome.cloneNode(true));
  persistCurrent();
}
function setBusy(value) {
  busy = value; $('send').disabled = value || !attached; $('stop').hidden = !value;
}
async function setIdentity(id) {
  if (id === activeIdentity) return;
  interruptCurrent('已切换到另一道题，生成已停止；已收到的内容保留在原题对话中。');
  await persistCurrent();
  activeIdentity=id;snapshot=null;attached=false;loadFailed=false;
  $('question').disabled=true;$('manual-code').disabled=true;
  try {current=memory.has(id)?structuredClone(memory.get(id)):await store.load(id);}
  catch {current=emptyConversation();loadFailed=true;status('无法读取本机对话记录，请重新打开侧栏。',true);}
  history=current.history;
  $('question').value=current.draft;$('manual-code').value=current.manualCode;
  $('use-manual').checked=current.useManual;$('mode').value=current.mode;
  $('messages').replaceChildren(welcome.cloneNode(true));
  for(const record of current.messages)addMessage(record.role,record.text,record.reference,record);
  $('question').disabled=loadFailed;$('manual-code').disabled=loadFailed;
  $('save-state').textContent=current.messages.length?'已恢复本题对话':'按题目保存对话';
  chrome.storage.session.set({[`lastProblem:${windowId}`]:id}).catch(()=>{});
  if(loadFailed){$('save-state').textContent='读取记录失败，请重新打开侧栏';return;}
  status(current.messages.length?'已恢复本题对话，可继续提问。':'这道题的对话会自动保存到本机。');
}
function currentSnapshot() { return effectiveSnapshot(snapshot, $('manual-code').value, $('use-manual').checked); }
function positionLabel(s) {
  if (s.selection?.startLine) return s.selection.endLine !== s.selection.startLine ? `第 ${s.selection.startLine}–${s.selection.endLine} 行` : `第 ${s.selection.startLine} 行`;
  return s.cursor?.line ? `第 ${s.cursor.line} 行` : '未定位';
}
function renderContext() {
  if (!snapshot) {
    $('problem-title').textContent = current.title || '打开一道力扣题目'; $('source-tag').textContent = activeIdentity?'对话已保留':'等待连接'; $('position-tag').textContent = '未定位';
    $('status-dot').classList.remove('ready'); $('reference').textContent = contextError || '在代码中选中一段内容，再来问我。';
    $('context-preview').textContent = '尚无页面内容。'; $('context-warning').hidden = true; return;
  }
  let s;
  try { s = currentSnapshot(); } catch (e) { $('context-warning').textContent = e.message; $('context-warning').hidden = false; return; }
  $('status-dot').classList.add('ready'); $('problem-title').textContent = s.title || '当前题目';
  $('source-tag').textContent = s.source; $('position-tag').textContent = positionLabel(s);
  const line = s.complete && s.cursor?.line ? s.code.split('\n')[s.cursor.line - 1] : '';
  $('reference').textContent = (s.selection?.text || line || s.pageSelection || '可在问题中直接提到变量、表达式或行号。').trimStart();
  const warnings = [...(s.warnings || [])].filter(w => !($('use-manual').checked && w.includes('完整代码')));
  if ($('use-manual').checked) warnings.unshift('当前使用手动代码，请在修改网页代码后重新粘贴。');
  $('context-warning').hidden = !warnings.length; $('context-warning').textContent = warnings.join('\n');
  $('context-preview').textContent = contextText(s);
  $('status-dot').classList.toggle('ready',attached);
}
function setAttached(value) {
  value=value && !loadFailed;
  attached=value;$('away-banner').hidden=value || !activeIdentity;
  $('send').disabled=busy || !value;
}
async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const tabs = await chrome.tabs.query({active:true, windowId}); const tab = tabs[0];
      if (!tab || !validProblem(tab.url)) {
        setAttached(false);contextError=activeIdentity?'当前不在力扣题目页，对话已保留；切回原题即可继续。':'请在当前 Edge 窗口打开力扣题目页面。';
        renderContext();return false;
      }
      const identity = problemKey(tab.url); await setIdentity(identity);
      let response;
      try { response = await chrome.tabs.sendMessage(tab.id, {type:'LC_READ_CONTEXT'}); }
      catch { throw new Error('请刷新力扣网页一次，让刚安装的插件开始读取页面。'); }
      // Check the active tab again: never attach a response from a tab just left.
      const now = (await chrome.tabs.query({active:true, windowId}))[0];
      if (!now || now.id !== tab.id || problemKey(now.url) !== identity) {setAttached(false);renderContext();return false;}
      if (!response?.ok || problemKey(response.data?.url) !== problemKey(tab.url)) throw new Error(response?.error || '题目正在切换，请稍后再试。');
      snapshot = response.data;contextError='';setAttached(true);renderContext();return true;
    } catch (e) {setAttached(false);contextError=e.message || '读取页面失败，请刷新力扣网页。';renderContext();return false;}
    finally { refreshPromise = null; }
  })();
  return refreshPromise;
}
async function saveSettings() {
  if(busy){$('settings-status').textContent='请等待当前回答结束，或先停止生成，再切换连接。';return;}
  $('save-settings').disabled=true;
  try {
    await modelUI.save();
    settings={prompt:$('system-prompt').value.trim() || DEFAULT_PROMPT};
    await chrome.storage.local.set({settings});
    $('settings-status').textContent='已保存并启用所选连接。';status('模型连接已更新，可以提问。');
  }catch(e){$('settings-status').textContent=e.message || '保存失败，请重试。';}
  finally{$('save-settings').disabled=false;}
}
async function ask(event) {
  event.preventDefault();
  if (busy) return;
  const question = $('question').value.trim(); if (!question) return;
  const originIdentity=activeIdentity;
  setBusy(true);
  let connection;
  try{connection=await modelUI.snapshot();}catch(e){setBusy(false);openSettings('model');status(e.message,true);return;}
  // setIdentity may clear a previous conversation during refresh; lock again afterward.
  const okay = await refresh();
  if (!okay || !attached) {setBusy(false); status(loadFailed?'读取记录失败，请重新打开侧栏。':contextError || '页面已切换，请重试。', true); return;}
  if(originIdentity!==activeIdentity){setBusy(false);status('已切换题目，请确认本题输入框中的问题后再发送。');return;}
  let s;
  try { s = currentSnapshot(); } catch (e) {setBusy(false); status(e.message, true); return;}
  if (!s.code && !s.problem) {setBusy(false); status('没有读取到代码或题目，请刷新页面或使用手动代码。', true); return;}
  const myOperation = ++operation, identity = activeIdentity;
  const messages = makeMessages(s, question, history, settings.prompt, $('mode').value);
  setBusy(true); addMessage('user', question, positionLabel(s)); $('question').value = '';
  const answer = addMessage('assistant', '正在阅读代码…');
  answer.record.modelLabel=connection.label;answer.article.querySelector('.who').textContent=connection.label;
  answer.record.text='';answer.record.pending=true;pendingAnswer=answer.record;
  await persistCurrent();
  answer.article.scrollIntoView({block:'nearest', behavior:'smooth'});
  if(myOperation!==operation)return;
  const aborter = new AbortController(); controller = aborter;
  let text = '', timedOut = false, renderTimer = null;
  const timeout = setTimeout(() => {timedOut = true; aborter.abort();}, 240000);
  status('正在连接 '+connection.label+'…');
  try {
    const result = await connection.generate(messages, (delta, meta) => {
      if (myOperation !== operation) return;
      text += delta;
      answer.record.text=text;
      if(Date.now()-lastProgressSave>1000){lastProgressSave=Date.now();persistCurrent();}
      status(meta.reasoning && !text ? '模型正在思考…' : '正在回答…');
      if (!renderTimer) {
        renderTimer = setTimeout(() => {renderTimer = null; if (myOperation === operation) renderText(answer.body, text || '模型正在思考…');},100);
      }
    }, aborter.signal);
    if (myOperation !== operation || identity !== activeIdentity) return;
    renderText(answer.body, result.text);
    answer.record.text=result.text;answer.record.pending=false;pendingAnswer=null;
    const oldReference = s.selection?.text || (s.complete && s.cursor?.line ? s.code.split('\n')[s.cursor.line-1] : '');
    history.push({role:'user', content:`${question}\n（上轮引用 ${positionLabel(s)}，内容：${oldReference || '未指定'}；后续以最新快照为准。）`}, {role:'assistant', content:result.text});
    history = history.slice(-8);
    if (result.finishReason === 'length') {answer.record.note='达到本次输出长度上限，回答可能未结束。可以继续追问。';note(answer.article,answer.record.note); status('已达到输出上限。');}
    else status('回答完成。修改代码后，可以直接继续提问。');
  } catch (e) {
    if (myOperation !== operation) return;
    const message = e.name === 'AbortError' ? timedOut ? '等待超过 4 分钟，已停止。请稍后重试。' : '已停止生成。' : e instanceof TypeError ? '无法连接所选服务，请检查 API 地址、网络或本地连接程序。' : e.message;
    renderText(answer.body, text || message);
    answer.record.text=text || message;answer.record.pending=false;pendingAnswer=null;
    if (text) {answer.record.note=message + ' 当前回答不完整，未加入后续对话上下文。';note(answer.article,answer.record.note);}
    if (!text) $('question').value ||= question;
    status(message, e.name !== 'AbortError' || timedOut);
  } finally {
    clearTimeout(renderTimer);
    clearTimeout(timeout);
    if (myOperation === operation) {controller = null;setBusy(false);persistCurrent();}
  }
}
function note(article, text) {const p = document.createElement('p'); p.className = 'answer-note'; p.textContent = text; article.append(p);}
async function initialize() {
  await initializeAppearance({storage:chrome.storage.local,changes:chrome.storage.onChanged});
  enableCodeCopy($('messages'));
  windowId = (await chrome.windows.getCurrent()).id;
  await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
  const [local, session] = await Promise.all([chrome.storage.local.get('settings'), chrome.storage.session.get(`lastProblem:${windowId}`)]);
  settings.prompt=local.settings?.prompt || DEFAULT_PROMPT;
  $('system-prompt').value=settings.prompt;
  modelUI=await initializeModelSettings();
  $('settings-toggle').addEventListener('click',()=>openSettings());
  $('settings-close').addEventListener('click',()=>$('settings').close());
  $('settings-done').addEventListener('click',()=>$('settings').close());
  $('settings').addEventListener('close',()=>$('settings-toggle').focus());
  const tabs=[...document.querySelectorAll('[data-settings-tab]')];
  tabs.forEach((tab,index)=>{
    tab.addEventListener('click',()=>selectSettingsTab(tab.dataset.settingsTab));
    tab.addEventListener('keydown',event=>{
      let next;
      if(event.key==='ArrowRight')next=(index+1)%tabs.length;
      else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=tabs.length-1;
      else return;
      event.preventDefault();selectSettingsTab(tabs[next].dataset.settingsTab);tabs[next].focus();
    });
  });
  if(!modelUI.configured)openSettings('model');
  $('save-settings').addEventListener('click', saveSettings);
  $('reset-prompt').addEventListener('click', () => {$('system-prompt').value = DEFAULT_PROMPT; $('settings-status').textContent = '已恢复默认规则，点击保存后生效。';});
  $('refresh').addEventListener('click', async () => {const ok = await refresh(); status(ok ? '已获取最新页面内容。' : contextError, !ok);});
  $('manual-code').addEventListener('input',()=>{renderContext();persistCurrent();});$('use-manual').addEventListener('change',()=>{renderContext();persistCurrent();});
  $('question').addEventListener('input',()=>persistCurrent());$('mode').addEventListener('change',()=>persistCurrent());
  $('clear-chat').addEventListener('click', () => {clearConversation(); status('对话已清空。');});
  $('stop').addEventListener('click', () => controller?.abort());
  $('ask-form').addEventListener('submit', ask);
  $('question').addEventListener('keydown', e => {if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {e.preventDefault(); $('ask-form').requestSubmit();}});
  document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => {$('question').value = button.dataset.question; $('mode').value = button.dataset.mode || 'explain'; $('question').focus();persistCurrent();}));
  const last=session[`lastProblem:${windowId}`];
  if(validProblem(last))await setIdentity(problemKey(last));
  window.addEventListener('pagehide',()=>{interruptCurrent('侧栏已关闭，生成中断；已收到的内容已保留。');persistCurrent();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)persistCurrent();else refresh();});
  chrome.tabs.onActivated?.addListener(()=>refresh());
  await refresh();
  if (modelUI.configured) status(snapshot ? '已连接页面读取功能，可以提问。' : contextError, !snapshot);
  setInterval(refresh, 1800);
}
initialize().catch(() => status('扩展初始化失败，请关闭侧栏再重新打开。', true));
