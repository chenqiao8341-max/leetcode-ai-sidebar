import MarkdownIt from './vendor/markdown-it.mjs';
import katex from './vendor/katex.mjs';

const md = new MarkdownIt({html:false, breaks:true, linkify:false, typographer:false});
const escape = md.utils.escapeHtml;
const formulaCache = new Map();

function formula(tex, display) {
  const key = `${display}:${tex}`;
  if (formulaCache.has(key)) return formulaCache.get(key);
  let html;
  try {
    if (tex.length > 6000) throw new Error('Formula too long');
    html = katex.renderToString(tex, {
      displayMode:display, throwOnError:false, errorColor:'#efc785',
      trust:false, strict:'ignore', maxExpand:300, maxSize:20,
      output:'htmlAndMathml', macros:{}
    });
  } catch { html = `<code class="math-fallback">${escape(tex)}</code>`; }
  if (formulaCache.size >= 128) formulaCache.delete(formulaCache.keys().next().value);
  formulaCache.set(key,html);
  return html;
}
function escaped(source, position) {
  let slashes = 0;
  while (position > 0 && source[--position] === '\\') slashes++;
  return slashes % 2 === 1;
}
function closeAt(source, close, from, dollar = false) {
  let pos = from;
  while ((pos = source.indexOf(close,pos)) !== -1) {
    if (!escaped(source,pos) && (!dollar || (!/\s/.test(source[pos-1] || '') && !/\d/.test(source[pos+1] || '') && source[pos+1] !== '$'))) return pos;
    pos += close.length;
  }
  return -1;
}

// Parse math BEFORE Markdown consumes backslashes. Code spans and fenced code
// are parsed by Markdown itself and never passed through a post-render regex.
md.inline.ruler.before('escape','lc_math',(state,silent) => {
  const start = state.pos, source = state.src;
  let open, close, display = false;
  if (source.startsWith('$$',start)) {open='$$';close='$$';display=true;}
  else if (source.startsWith('\\[',start)) {open='\\[';close='\\]';display=true;}
  else if (source.startsWith('\\(',start)) {open='\\(';close='\\)';}
  else if (source[start] === '$' && !/\s/.test(source[start+1] || ' ') && source[start+1] !== '$') {open='$';close='$';}
  else return false;
  const end = closeAt(source,close,start+open.length,open==='$');
  if (end === -1 || (open === '$' && source.slice(start,end).includes('\n'))) {
    // Incomplete streamed formula: retain its literal delimiters until closed.
    if (silent) return false;
    const lineEnd = source.indexOf('\n',start);
    const stop = lineEnd === -1 ? source.length : lineEnd;
    const token=state.push('text','',0); token.content=source.slice(start,stop);
    state.pos=stop;return true;
  }
  if (end === start + open.length) return false;
  if (!silent) {
    const token=state.push('lc_math','',0);
    token.content=source.slice(start+open.length,end);token.meta={display};
  }
  state.pos=end+close.length;return true;
});

md.block.ruler.before('fence','lc_math_block',(state,startLine,endLine,silent) => {
  if (state.sCount[startLine]-state.blkIndent>=4) return false;
  const begin=state.bMarks[startLine]+state.tShift[startLine];
  const first=state.src.slice(begin,state.eMarks[startLine]);
  const open=first.startsWith('$$')?'$$':first.startsWith('\\[')?'\\[':null;
  if (!open) return false;
  const close=open==='$$'?'$$':'\\]';
  let line=startLine, content=first.slice(open.length), end=closeAt(content,close,0);
  while (end===-1 && line+1<endLine) {
    if (state.sCount[line+1]<state.blkIndent && !state.isEmpty(line+1)) break;
    line++;
    content+='\n'+state.src.slice(state.bMarks[line]+state.tShift[line],state.eMarks[line]);
    end=closeAt(content,close,0);
  }
  if (end!==-1 && content.slice(end+close.length).trim()) return false;
  if (silent) return true;
  const token=state.push(end===-1?'lc_math_pending':'lc_math_block','',0);
  token.block=true;token.map=[startLine,line+1];
  token.content=end===-1?open+content:content.slice(0,end);
  state.line=line+1;return true;
},{alt:['paragraph','reference','blockquote','list']});

md.renderer.rules.lc_math=(tokens,i)=>`<span class="math-inline${tokens[i].meta.display?' math-inline-display':''}">${formula(tokens[i].content,tokens[i].meta.display)}</span>`;
md.renderer.rules.lc_math_block=(tokens,i)=>`<div class="math-block" tabindex="0" aria-label="数学公式">${formula(tokens[i].content,true)}</div>\n`;
md.renderer.rules.lc_math_pending=(tokens,i)=>`<pre class="math-pending">${escape(tokens[i].content)}</pre>\n`;

// No raw HTML, external images, executable URLs or model-controlled attributes.
md.validateLink = url => /^https?:\/\//i.test(url) && !/[\u0000-\u0020]/.test(url);
md.renderer.rules.link_open=(tokens,i,options,env,self)=>{
  tokens[i].attrSet('target','_blank'); tokens[i].attrSet('rel','noopener noreferrer');
  return self.renderToken(tokens,i,options);
};
md.renderer.rules.image=(tokens,i)=>`<span class="image-placeholder">[图片：${escape(tokens[i].content || '未加载')}]</span>`;
md.renderer.rules.fence=(tokens,i)=>{
  const token=tokens[i], language=(token.info.trim().split(/\s+/)[0] || '').slice(0,40);
  return `<div class="code-block"><div class="code-toolbar"><span>${escape(language || '代码')}</span><button type="button" class="copy-code" aria-label="复制代码">复制</button></div><pre tabindex="0"><code>${escape(token.content)}</code></pre></div>\n`;
};
md.renderer.rules.table_open=()=>'<div class="table-scroll" tabindex="0" aria-label="表格"><table>\n';
md.renderer.rules.table_close=()=>'</table></div>\n';

export function renderMarkdown(text) { return md.render(String(text)); }

const previous = new WeakMap();
export function renderMessage(element,text) {
  if (previous.get(element) === text) return;
  const offsets=[...element.querySelectorAll('pre,.table-scroll,.math-block')].map(el=>el.scrollLeft);
  // Only the configured Markdown parser and untrusted-mode KaTeX produce HTML.
  element.innerHTML=renderMarkdown(text);
  element.querySelectorAll('pre,.table-scroll,.math-block').forEach((el,i)=>{if(offsets[i])el.scrollLeft=offsets[i];});
  previous.set(element,text);
}

export function enableCodeCopy(container) {
  container.addEventListener('click',async event=>{
    const button=event.target.closest?.('.copy-code');
    if (!button || !container.contains(button)) return;
    const code=button.closest('.code-block')?.querySelector('pre code');
    if (!code) return;
    try {await navigator.clipboard.writeText(code.textContent);button.textContent='已复制';}
    catch {button.textContent='请选中复制';}
    setTimeout(()=>{if(button.isConnected)button.textContent='复制';},1800);
  });
}
