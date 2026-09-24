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

const { intralineDiff, lineParts } = require('../src/viewer.js');
const changedText = parts => parts.filter(p => p.changed).map(p => p.text).join('');
const fullText = parts => parts.map(p => p.text).join('');

test('highlights separated edits and preserves unchanged code between them', () => {
  const [old, next] = intralineDiff('let count = 10; return count;', 'let total = 20; return count;');
  assert.equal(fullText(old), 'let count = 10; return count;');
  assert.equal(fullText(next), 'let total = 20; return count;');
  assert.ok(old.some(p => !p.changed && p.text.includes(' = ')));
  assert.ok(next.some(p => !p.changed && p.text.includes('; return count;')));
  assert.ok(changedText(old).includes('1'));
  assert.ok(changedText(next).includes('2'));
});

test('insertion, deletion, identical and empty lines', () => {
  let parts = intralineDiff('call(x)', 'call(x, y)');
  assert.equal(changedText(parts[0]), ''); assert.equal(changedText(parts[1]), ', y');
  parts = intralineDiff('call(x, y)', 'call(x)');
  assert.equal(changedText(parts[0]), ', y'); assert.equal(changedText(parts[1]), '');
  assert.deepEqual(intralineDiff('', ''), [[], []]);
  assert.equal(changedText(intralineDiff('', 'new')[1]), 'new');
  assert.equal(changedText(intralineDiff('same', 'same')[0]), '');
});

test('graphemes, whitespace and hostile markup remain exact text', () => {
  for (const [a, b] of [
    ['x👩‍💻y', 'x👨‍💻y'], ['cafe\u0301', 'cafe'],
    ['\tfoo  bar', ' foo bar'],
    ['<img src=x onerror=alert(1)>', '</script><script>alert(2)</script>'],
  ]) {
    const parts = intralineDiff(a, b);
    assert.equal(fullText(parts[0]), a); assert.equal(fullText(parts[1]), b);
  }
  assert.equal(changedText(intralineDiff('x👩‍💻y', 'x👨‍💻y')[0]), '👩‍💻');
  assert.equal(changedText(intralineDiff('cafe\u0301', 'cafe')[0]), 'cafe\u0301');
});

test('split and unified use the same lazy paired highlighting', () => {
  const patch = '@@ -1,2 +1,3 @@\n-value = 1\n keep\n+extra\n';
  assert.equal(lineParts(parseRows(patch, true)[1].left), null);
  const replacement = '@@ -1 +1 @@\n-value = 1\n+value = 2\n+extra\n';
  const split = parseRows(replacement, true);
  const unified = parseRows(replacement, false);
  assert.equal(Object.hasOwn(split[1].left.pair, 'parts'), false);
  assert.deepEqual(lineParts(split[1].left), lineParts(unified[1].single));
  assert.deepEqual(lineParts(split[1].right), lineParts(unified[2].single));
  assert.equal(changedText(lineParts(split[1].left)), '1');
  assert.equal(changedText(lineParts(split[1].right)), '2');
  assert.equal(lineParts(split[2].right), null);
});

test('newline annotations stay outside character highlights', () => {
  const rows = parseRows('@@ -1 +1 @@\n-value = old\n\\ No newline at end of file\n+value = new\n', true);
  const parts = lineParts(rows[1].left);
  assert.equal(fullText(parts), 'value = old\n\\ No newline at end of file');
  assert.equal(parts.at(-1).changed, false);
});

test('long lines and expensive comparisons fall back to whole-line coloring', () => {
  assert.equal(intralineDiff('a'.repeat(4097), 'b'), null);
  assert.equal(intralineDiff('a,'.repeat(300), 'b;'.repeat(300)), null);
  const prefix = 'unchanged '.repeat(300);
  assert.equal(changedText(intralineDiff(prefix + 'x', prefix + 'y')[1]), 'y');
});


test('identifier replacements form one chunk rather than matching incidental characters', () => {
  const parts = intralineDiff('text', 'abctedefxf');
  assert.deepEqual(parts, [[{ text: 'text', changed: true }], [{ text: 'abctedefxf', changed: true }]]);
  const rename = intralineDiff('const userName = getUser();', 'const accountName = getAccount();');
  assert.equal(changedText(rename[0]), 'userNamegetUser');
  assert.equal(changedText(rename[1]), 'accountNamegetAccount');
  assert.ok(rename[0].some(p => p.text === ' = ' && !p.changed));
});

test('whole-line replacements have no word overlay in either layout', () => {
  for (const split of [true, false]) {
    for (const [old, next] of [['text', 'abctedefxf'], ['  old value', '  new content'], ['', 'added']]) {
      const rows = parseRows(`@@ -1 +1 @@\n-${old}\n\\ No newline at end of file\n+${next}\n`, split);
      const left = split ? rows[1].left : rows[1].single;
      const right = split ? rows[1].right : rows[2].single;
      assert.equal(lineParts(left), null);
      assert.equal(lineParts(right), null);
      assert.equal(left.text, old + '\n\\ No newline at end of file');
      assert.equal(right.text, next);
    }
  }
});

const { buildFileTree } = require('../src/viewer.js');
test('file tree groups nested directories without losing original navigation indices', () => {
  const tree = buildFileTree([
    { path: 'src/nested/a.rs' }, { path: 'README.md' },
    { path: 'tests/a.rs' }, { path: 'src/b.rs' }, { path: 'src/nested/c.rs' },
  ]);
  assert.deepEqual(tree.files, [{ name: 'README.md', index: 1 }]);
  assert.deepEqual(tree.directories.get('src').files, [{ name: 'b.rs', index: 3 }]);
  assert.deepEqual(tree.directories.get('src').directories.get('nested').files,
    [{ name: 'a.rs', index: 0 }, { name: 'c.rs', index: 4 }]);
  assert.deepEqual(tree.directories.get('tests').files, [{ name: 'a.rs', index: 2 }]);
});
test('file tree preserves unusual names, directory/file collisions, and empty comparisons', () => {
  const tree = buildFileTree([
    { path: '__proto__/<script>/odd\tname.txt' },
    { path: 'same' }, { path: 'same/child' }, { path: 'space dir/new\nname' },
  ]);
  assert.equal(tree.directories.get('__proto__').directories.get('<script>').files[0].name, 'odd\tname.txt');
  assert.equal(tree.files[0].name, 'same');
  assert.equal(tree.directories.get('same').files[0].name, 'child');
  assert.equal(tree.directories.get('space dir').files[0].name, 'new\nname');
  assert.equal(buildFileTree([]).directories.size, 0);
});

const { compactDirectory } = require('../src/viewer.js');
test('compacts single-child directory chains and preserves file navigation indices', () => {
  const tree = buildFileTree([{ path: 'src/components/forms/input.js' }]);
  const compact = compactDirectory('src', tree.directories.get('src'));
  assert.equal(compact.name, 'src/components/forms');
  assert.deepEqual(compact.node.files, [{ name: 'input.js', index: 0 }]);
  assert.ok(tree.directories.get('src').directories.has('components'));
});
test('directory compaction stops at files or multiple subdirectories', () => {
  const tree = buildFileTree([
    { path: 'src/components/index.js' },
    { path: 'src/components/forms/input.js' },
    { path: 'tests/unit/parser/test.js' },
    { path: 'tests/unit/viewer/test.js' },
  ]);
  const source = compactDirectory('src', tree.directories.get('src'));
  assert.equal(source.name, 'src/components');
  assert.equal(source.node.files[0].name, 'index.js');
  const tests = compactDirectory('tests', tree.directories.get('tests'));
  assert.equal(tests.name, 'tests/unit');
  assert.equal(tests.node.directories.size, 2);
});
