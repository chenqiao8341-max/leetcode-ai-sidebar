import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdown} from '../render.mjs';
test('Markdown headings, emphasis, nested lists, quotes, tables, links and fenced code',()=>{
 const html=renderMarkdown('# 标题\n\n**粗体** 和 *斜体* 与 ~~删除~~\n\n1. 一\n   - 子项\n\n> 引用\n\n|变量|意义|\n|---|---|\n|n|长度|\n\n[说明](https://example.com)\n\n```python\nprint("hello")\n```');
 for(const tag of ['h1','strong','em','s','ol','ul','blockquote','table','a','pre','code'])assert.match(html,new RegExp(`<${tag}[ >]`));
 assert.match(html,/复制代码/);assert.match(html,/noopener noreferrer/);
});
test('all four math delimiters render KaTeX',()=>{
 for(const input of [String.raw`复杂度 $O(n^2)$。`,String.raw`复杂度 \(O(n\log n)\)。`,String.raw`$$\sum_{i=1}^{n} i=\frac{n(n+1)}{2}$$`,String.raw`\[\frac{1}{2}\]`])assert.match(renderMarkdown(input),/class="katex"/);
});
test('multiline aligned formula and list formula preserve backslashes',()=>{
 const input=String.raw`## 递推

$$
\begin{aligned}
T(n)&=2T(n/2)+n\\
&=O(n\log n)
\end{aligned}
$$

- 空间：\(O(n)\)。
`;
 const html=renderMarkdown(input);assert.equal((html.match(/class="katex"/g)||[]).length,2);assert.doesNotMatch(html,/katex-error/);
});
test('math stays literal in code spans and fenced code',()=>{
 const html=renderMarkdown('`$x$` 和 `\\(x\\)`\n\n```latex\n$$x^2$$\n```');
 assert.doesNotMatch(html,/class="katex"/);assert.match(html,/\$\$x\^2\$\$/);assert.match(html,/<code>\$x\$<\/code>/);
});
test('streaming incomplete formulas preserve source and recover when completed',()=>{
 const source=String.raw`公式 \(\frac{n(n+1)}{2}\)`;
 for(let i=0;i<source.length;i++)assert.doesNotThrow(()=>renderMarkdown(source.slice(0,i)));
 assert.match(renderMarkdown(String.raw`公式 \(\frac{n`),/\\\(\\frac\{n/);
 assert.match(renderMarkdown(source),/class="katex"/);
 assert.match(renderMarkdown('$$\nx^2'),/math-pending/);
 assert.match(renderMarkdown('$$\nx^2\n$$'),/math-block/);
});
test('escaped dollars and currency are not formulas',()=>{
 assert.doesNotMatch(renderMarkdown(String.raw`价格 \$5，另一个 $10，比 $20 便宜。`),/class="katex"/);
});
test('raw HTML and dangerous links cannot produce active content',()=>{
 const html=renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert%281%29)\n\n![tracking](https://evil.test/a.png)\n\n[x](data:text/html,test)');
 assert.doesNotMatch(html,/<script|<img|href="(?:javascript|data):/i);assert.match(html,/&lt;script&gt;/);
});
test('KaTeX cannot load images or create trusted links',()=>{
 const html=renderMarkdown(String.raw`$\href{javascript:alert(1)}{x}$ $\includegraphics{https://evil.test/a.png}$`);
 assert.doesNotMatch(html,/<img|href="javascript|src="https/);
});
test('language attributes and malformed formulas are escaped safely',()=>{
 const html=renderMarkdown('```"><img/src=x>\n<script>x</script>\n```\n\n$\\notacommand{<img src=x>}$');
 assert.doesNotMatch(html,/<img|<script/);assert.match(html,/efc785/);
});
test('unclosed fences remain code, not math',()=>{
 assert.doesNotMatch(renderMarkdown('```python\nprint("$x$")'),/class="katex"/);
});
