(() => {
  if (window.__LC_READING_CONTENT_V1__) return;
  window.__LC_READING_CONTENT_V1__ = true;
  const trim = (s, n = 20000) => typeof s === 'string' ? s.slice(0, n) : '';
  const visible = el => el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  let savedSelection = '', savedSelectionAt = '', lastPath = location.pathname;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel?.toString();
    if (text) { savedSelection = trim(text, 10000); savedSelectionAt = location.pathname; }
    else if (document.hasFocus()) savedSelection = '';
  });
  function firstText(selectors, max = 22000) {
    for (const selector of selectors) {
      const nodes = [...document.querySelectorAll(selector)].filter(visible);
      const text = nodes.map(n => n.innerText).filter(Boolean).join('\n');
      if (text.trim()) return trim(text, max);
    }
    return '';
  }
  function testText() {
    const roots = new Set(document.querySelectorAll('[data-e2e-locator="console-test-result"], [data-e2e-locator="console-test-case"], [data-e2e-locator="console-testcase-input"], [data-cy="testcase-content"], [data-cy="submission-result"]'));
    for (const tab of document.querySelectorAll('[role="tab"][aria-controls]')) {
      if (/^(测试用例|测试结果|Testcase|Test Result)$/i.test(tab.textContent.trim())) {
        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        if (panel) roots.add(panel);
      }
    }
    return trim([...roots].filter(visible).filter(el => ![...roots].some(parent => parent !== el && parent.contains(el))).map(root => {
      const fields = [...root.querySelectorAll('textarea, input:not([type=password]):not([type=hidden])')].filter(visible).map(el => el.value).filter(Boolean);
      return [root.innerText, ...fields].join('\n');
    }).join('\n'), 10000);
  }
  function readDomEditor() {
    const editor = [...document.querySelectorAll('.monaco-editor, .cm-editor, .CodeMirror')].find(visible);
    if (!editor) return {code: '', complete: false, source: '未找到编辑器'};
    const lines = [...editor.querySelectorAll('.view-line, .cm-line, .CodeMirror-line')];
    const nums = [...editor.querySelectorAll('.line-numbers')];
    return {
      code: trim(lines.map((line, i) => `${nums[i]?.textContent?.trim() || '?'} | ${line.textContent.replace(/\u00a0/g, ' ')}`).join('\n'), 60000),
      complete: false, source: '仅屏幕可见代码（不完整）', cursor: null, selection: null
    };
  }
  function bridge() {
    return new Promise(resolve => {
      const id = crypto.randomUUID();
      const listener = event => {
        if (event.source === window && event.origin === location.origin && event.data?.type === 'LC_READING_SNAPSHOT_RESPONSE_V1' && event.data.id === id) {
          window.removeEventListener('message', listener); clearTimeout(timer); resolve(event.data.data);
        }
      };
      const timer = setTimeout(() => {window.removeEventListener('message', listener); resolve(null);}, 850);
      window.addEventListener('message', listener);
      window.postMessage({type:'LC_READING_SNAPSHOT_REQUEST_V1', id}, location.origin);
    });
  }
  const integer = n => Number.isInteger(n) && n > 0 && n < 1000000 ? n : null;
  function sanitize(data) {
    if (!data || typeof data.code !== 'string') return null;
    const selection = data.selection;
    return {
      code: trim(data.code, 60000), complete: data.complete === true && data.code.length <= 60000,
      source: trim(data.source, 100), language: trim(data.language, 80), version: integer(data.version),
      cursor: integer(data.cursor?.line) ? {line: integer(data.cursor.line), column: integer(data.cursor.column)} : null,
      selection: typeof selection?.text === 'string' && selection.text ? {text: trim(selection.text, 12000), startLine: integer(selection.startLine), endLine: integer(selection.endLine)} : null
    };
  }
  async function snapshot() {
    if (lastPath !== location.pathname) {savedSelection = ''; lastPath = location.pathname;}
    const pathBefore = location.pathname;
    const captured = sanitize(await bridge()) || readDomEditor();
    if (location.pathname !== pathBefore) throw new Error('题目正在切换，请稍后刷新。');
    const problem = firstText(['[data-track-load="description_content"]', '[data-cy="question-content"]', '.elfjS', '.question-content', '[class*="description__"]']);
    const tests = testText();
    const title = firstText(['[data-cy="question-title"]', '.text-title-large a', '.text-title-large', 'h1'], 250) || document.title;
    const warnings = [];
    if (!captured.complete) warnings.push('未读取到完整代码。建议开启手动代码模式并粘贴完整代码。');
    if (!problem) warnings.push('未读取到题目正文，请切换到“题目描述”标签后刷新。');
    if (problem.length >= 22000) warnings.push('题目正文达到长度上限，可能被截断。');
    if (!tests) warnings.push('未读取到测试区域；讨论报错时请在问题中粘贴用例或报错。');
    return {...captured, title: trim(title, 250), url: location.origin + location.pathname, problem, tests,
      pageSelection: savedSelectionAt === location.pathname ? savedSelection : '', capturedAt: new Date().toISOString(), warnings};
  }
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (sender.id !== chrome.runtime.id || msg?.type !== 'LC_READ_CONTEXT') return;
    snapshot().then(data => respond({ok:true, data})).catch(() => respond({ok:false, error:'页面正在变化，请刷新后重试。'}));
    return true;
  });
})();
