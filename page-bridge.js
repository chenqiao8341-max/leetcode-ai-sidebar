// Runs in the page world. Only bounded editor reads and version-checked edits;
// no API keys, storage access, network requests or executable model output.
(() => {
  if (window.__LC_READING_BRIDGE_V1__) return;
  window.__LC_READING_BRIDGE_V1__ = true;
  const MAX = 60000;
  let lastUrl = '', cachedEditor = null, lastSelection = null, lastCursor = null, lastModel = null;
  let disposables = [], lastDiscovery = 0;
  const modelIds = new WeakMap();
  function modelId(model) {if (!modelIds.has(model)) modelIds.set(model, crypto.randomUUID());return modelIds.get(model);}
  const isEditor = x => x && typeof x.getModel === 'function' && typeof x.getSelection === 'function' && typeof x.getValue === 'function';
  const visible = el => el instanceof Element && el.isConnected && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  function reset() {
    for (const d of disposables) try { d?.dispose(); } catch {}
    disposables = []; cachedEditor = null; lastModel = null; lastSelection = null; lastCursor = null; lastDiscovery = 0;
  }
  function editorVisible(e) { try { return visible(e.getDomNode()); } catch { return false; } }
  function remember() {
    try {
      const model = cachedEditor?.getModel();
      if (!model) return;
      if (lastModel !== model) { lastModel = model; lastSelection = null; lastCursor = null; }
      const p = cachedEditor.getPosition?.();
      if (p) lastCursor = {line: p.lineNumber, column: p.column};
      const s = cachedEditor.getSelection();
      if (s) {
        const text = model.getValueInRange(s);
        lastSelection = text ? {startLine: s.startLineNumber, endLine: s.endLineNumber, startColumn: s.startColumn, endColumn: s.endColumn, text: text.slice(0, MAX)} : null;
      }
    } catch {}
  }
  function bind(editor) {
    if (cachedEditor === editor) return;
    reset(); cachedEditor = editor; remember();
    for (const name of ['onDidChangeCursorSelection', 'onDidChangeModelContent', 'onDidChangeModel']) {
      try { if (typeof editor[name] === 'function') disposables.push(editor[name](remember)); } catch {}
    }
  }
  // A site may keep its editor in a React ref instead of exposing window.monaco.
  // Only walk props/refs near the actual editor DOM, with strict bounds.
  function findReactEditor(root) {
    const queue = [], seen = new Set();
    for (let el = root, level = 0; el && level < 8; el = el.parentElement, level++) {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      let fiber = key && el[key];
      for (let n = 0; fiber && n < 10; n++, fiber = fiber.return) {
        queue.push([fiber.memoizedProps, 0], [fiber.ref, 0]);
        let hook = fiber.memoizedState;
        for (let h = 0; hook && h < 40; h++, hook = hook.next) queue.push([hook.memoizedState || hook, 0]);
      }
    }
    let count = 0;
    while (queue.length && count++ < 1200) {
      const [obj, depth] = queue.shift();
      if (!obj || typeof obj !== 'object' || seen.has(obj) || obj instanceof Node) continue;
      seen.add(obj);
      if (isEditor(obj) && editorVisible(obj)) return obj;
      if (depth >= 5) continue;
      // Do not evaluate getters or recursively inspect arbitrary application state.
      for (const [key, desc] of Object.entries(Object.getOwnPropertyDescriptors(obj))) {
        if (!('value' in desc) || !/^(current|value|memoizedState|next|ref|stateNode)$|editor|monaco/i.test(key)) continue;
        queue.push([desc.value, depth + 1]);
      }
    }
    return null;
  }
  function monacoApi() {
    if (window.monaco?.editor) return window.monaco.editor;
    try {
      // Only resolve already-loaded AMD modules; never trigger a download.
      for (const name of ['vs/editor/editor.api', 'vs/editor/editor.main']) {
        if (typeof window.require === 'function' && window.require.defined?.(name)) {
          const module = window.require(name);
          if (module?.editor) return module.editor;
        }
      }
    } catch {}
    return null;
  }
  function discover() {
    if (location.pathname !== lastUrl) { reset(); lastUrl = location.pathname; }
    if (cachedEditor && editorVisible(cachedEditor)) return;
    if (Date.now() - lastDiscovery < 1500) return;
    lastDiscovery = Date.now();
    try {
      const editors = monacoApi()?.getEditors?.() || [];
      const editor = editors.find(e => editorVisible(e) && e.hasTextFocus?.()) || editors.find(editorVisible);
      if (editor) { bind(editor); return; }
    } catch {}
    const root = [...document.querySelectorAll('.monaco-editor')].find(visible);
    if (root) { const editor = findReactEditor(root); if (editor) bind(editor); }
  }
  function snapshot() {
    discover();
    try {
      if (cachedEditor && editorVisible(cachedEditor)) {
        remember();
        const m = cachedEditor.getModel(), code = m.getValue();
        return {code: code.slice(0, MAX), complete: code.length <= MAX, source: 'Monaco 编辑器', language: m.getLanguageId?.() || '', version: m.getVersionId?.(), editorId: modelId(m), editable: typeof cachedEditor.executeEdits === 'function', selection: lastSelection, cursor: lastCursor};
      }
      // A single attached model is unambiguous; never choose among multiple models arbitrarily.
      const models = (monacoApi()?.getModels?.() || []).filter(m => !m.isDisposed?.() && m.isAttachedToEditor?.());
      if (models.length === 1 && document.querySelector('.monaco-editor')) {
        const m = models[0], code = m.getValue();
        return {code: code.slice(0, MAX), complete: code.length <= MAX, source: 'Monaco 文本模型（光标未知）', language: m.getLanguageId?.() || '', version: m.getVersionId?.(), selection: null, cursor: null};
      }
      // CodeMirror 6 exposes its view on the editor DOM in common integrations.
      for (const root of document.querySelectorAll('.cm-editor')) {
        if (!visible(root)) continue;
        const view = root.cmView?.view || root.querySelector('.cm-content')?.cmView?.view;
        if (!view?.state?.doc) continue;
        const doc = view.state.doc, range = view.state.selection.main, code = doc.toString();
        const line = doc.lineAt(range.head);
        return {code: code.slice(0, MAX), complete: code.length <= MAX, source: 'CodeMirror 编辑器', language: '', cursor: {line: line.number, column: range.head - line.from + 1}, selection: range.empty ? null : {text: doc.sliceString(range.from, range.to).slice(0, MAX), startLine: doc.lineAt(range.from).number, endLine: doc.lineAt(range.to).number}};
      }
    } catch {}
    return null;
  }
  function edit(data) {
    const before = snapshot();
    if(Number.isFinite(data?.expires_at) && Date.now()>data.expires_at)throw new Error('修改请求已过期，未应用。');
    if (document.hidden || !data || data.url !== location.origin + location.pathname) throw new Error('题目页面已变化，请重新读取。');
    if (!before?.complete || !before.editable || !cachedEditor) throw new Error('未找到可写的 Monaco 编辑器，请刷新页面；当前只能分析代码。');
    if (data.editorId !== before.editorId || data.version !== before.version || data.before !== before.code) throw new Error('代码版本已变化，请重新读取后再修改。');
    if (typeof data.after !== 'string' || data.after.length > MAX || data.after === data.before) throw new Error('修改内容无效或超过长度限制。');
    const model = cachedEditor.getModel();
    // Preserve native Ctrl+Z by creating an undo group rather than setValue().
    cachedEditor.pushUndoStop();
    const accepted = cachedEditor.executeEdits('leetcode-ai-agent', [{range:model.getFullModelRange(),text:data.after,forceMoveMarkers:true}]);
    cachedEditor.pushUndoStop();
    if (accepted === false || model.getValue() !== data.after) throw new Error('编辑器未应用预期修改，请重新读取代码确认。');
    remember();return snapshot();
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || !['LC_READING_SNAPSHOT_REQUEST_V1','LC_AGENT_EDIT_REQUEST_V1'].includes(event.data?.type)) return;
    const id = event.data.id;
    if (typeof id !== 'string' || id.length > 80) return;
    if (event.data.type === 'LC_READING_SNAPSHOT_REQUEST_V1') window.postMessage({type:'LC_READING_SNAPSHOT_RESPONSE_V1',id,data:snapshot()},location.origin);
    else {
      try {window.postMessage({type:'LC_AGENT_EDIT_RESPONSE_V1',id,ok:true,data:edit(event.data.data)},location.origin);}
      catch(e) {window.postMessage({type:'LC_AGENT_EDIT_RESPONSE_V1',id,ok:false,error:e.message},location.origin);}
    }
  });
  setInterval(() => { if (!document.hidden) discover(); }, 1500);
})();
