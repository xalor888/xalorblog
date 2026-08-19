const { sanitizeRssHtml, mdToHtml } = require('../src/routes/feed');

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, cond) {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(name);
  }
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
}

const out = sanitizeRssHtml(`
<script>alert(1)</script>
<img src="https://example.com/a.png" onerror="alert(1)">
<a href="javascript:alert(1)">bad</a>
<a href="https://example.com">good</a>
<iframe src="https://evil.example"></iframe>
`);

assert('script 被移除', !/script/i.test(out));
assert('事件属性被移除', !/onerror/i.test(out));
assert('javascript 链接被移除', !/javascript:/i.test(out));
assert('iframe 被移除', !/iframe/i.test(out));
assert('正常链接保留', /href="https:\/\/example\.com"/.test(out));

const protoRelative = sanitizeRssHtml(mdToHtml('[bad](//evil.example)', 'https://site.example'));
assert('协议相对链接被移除', !/evil\.example/.test(protoRelative));

console.log(`feed 套件结果: ${passed} 通过, ${failed} 失败`);
if (failed) {
  console.error(failures.join('\n'));
  process.exit(1);
}
