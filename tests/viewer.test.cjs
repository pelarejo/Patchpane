const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseRows } = require('../src/viewer.js');

test('split aligns replacements and preserves numbers across hunks', () => {
  const rows = parseRows('@@ -10,3 +20,4 @@ fn\n keep\n-old\n+new\n+extra\n tail\n@@ -50 +60 @@\n-end\n+done\n', true);
  assert.equal(rows[1].left.old, 10); assert.equal(rows[1].right.next, 20);
  assert.equal(rows[2].left.text, 'old'); assert.equal(rows[2].right.text, 'new');
  assert.equal(rows[3].left, undefined); assert.equal(rows[3].right.next, 22);
  assert.equal(rows[4].left.old, 12); assert.equal(rows[6].right.next, 60);
});
test('unified keeps blank lines, source CR, and diff-like source text', () => {
  const rows = parseRows('@@ -1,2 +1,3 @@\n-\n--- old\n+\n+++ new\n+hello\r\n', false);
  assert.equal(rows[1].single.text, ''); assert.equal(rows[2].single.text, '-- old');
  assert.equal(rows[4].single.text, '++ new'); assert.equal(rows[5].single.text, 'hello\r');
});
test('missing newline markers attach to both replacement sides', () => {
  const rows = parseRows('@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n', true);
  assert.equal(rows.length, 2); assert.match(rows[1].left.text, /No newline/); assert.match(rows[1].right.text, /No newline/);
});
test('binary and mode-only metadata remains visible', () => {
  assert.equal(parseRows('old mode 100644\nnew mode 100755\n', true).length, 2);
  assert.match(parseRows('Binary files a/a and b/a differ\n', true)[0].text, /Binary files/);
});
test('large replacements avoid combinatorial matching', () => {
  const patch = '@@ -1,20000 +1,20000 @@\n' + '-old\n'.repeat(20000) + '+new\n'.repeat(20000);
  const rows = parseRows(patch, true); assert.equal(rows.length, 20001); assert.equal(rows.at(-1).right.next, 20000);
});
