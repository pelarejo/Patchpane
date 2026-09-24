'use strict';

const PatchpaneSyntax = (() => {
  const highlighter = typeof module !== 'undefined' ? require('./vendor/highlight.min.js') : hljs;
  function language(path) {
    const name = path.split('/').at(-1).toLowerCase();
    const special = { makefile: 'makefile', gnumakefile: 'makefile', '.bashrc': 'bash', '.zshrc': 'bash', '.patchpane': 'ini', '.gitconfig': 'ini' };
    const aliases = { rs: 'rust', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', sh: 'bash', zsh: 'bash', h: 'c', cc: 'cpp', hpp: 'cpp', cs: 'csharp', kt: 'kotlin', kts: 'kotlin', yml: 'yaml', toml: 'ini', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', md: 'markdown', m: 'objectivec' };
    const extension = name.includes('.') ? name.split('.').at(-1) : '';
    const candidate = special[name] || aliases[extension] || extension;
    return candidate && highlighter.getLanguage(candidate) ? candidate : null;
  }

  // Decode only the escaped text emitted by Highlight.js, never insert its HTML.
  function decode(text) {
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'", '&#39;': "'" };
    return text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, entity => entities[entity]);
  }
  function highlightLines(lines, path) {
    const lang = language(path);
    if (!lang || lines.length > 2000 || lines.reduce((n, line) => n + line.length + 1, 0) > 100000
        || lines.some(line => line.length > 10000)) return null;
    const source = lines.join('\n');
    try {
      const html = highlighter.highlight(source, { language: lang, ignoreIllegals: true }).value;
      const output = [[]], stack = [];
      for (const match of html.matchAll(/<span class="([^"]*)">|(<\/span>)|([^<]+)/g)) {
        if (match[1] !== undefined) {
          stack.push(match[1].split(/\s+/).filter(c => /^[a-zA-Z][\w-]*$/.test(c)).join(' '));
        } else if (match[2]) stack.pop();
        else {
          decode(match[3]).split('\n').forEach((text, index) => {
            if (index) output.push([]);
            if (text) output.at(-1).push({ text, className: stack.join(' ') });
          });
        }
      }
      // Fall back if the library ever emits unexpected markup or alters text.
      if (output.map(parts => parts.map(p => p.text).join('')).join('\n') !== source) return null;
      return output;
    } catch { return null; }
  }

  function prepare(rows, split, oldPath, newPath) {
    let group;
    for (const row of rows) {
      if (row.kind === 'hunk') group = { old: [], next: [], oldPath, newPath };
      if (row.kind || !group) continue;
      const old = split ? row.left : row.single.kind !== 'add' ? row.single : null;
      const next = split ? row.right : row.single.kind !== 'del' ? row.single : null;
      if (old) { group.old.push(old); old.syntaxGroup = group; }
      if (next) { group.next.push(next); next.syntaxGroup = group; }
    }
  }
  function tokens(item, side) {
    const group = item?.syntaxGroup;
    if (!group) return null;
    const key = side === 'old' ? 'syntaxOld' : 'syntaxNext';
    if (!Object.hasOwn(group, key)) {
      group[key] = true;
      const items = side === 'old' ? group.old : group.next;
      const lines = items.map(line => line.text.split('\n', 1)[0]);
      const highlighted = highlightLines(lines, side === 'old' ? group.oldPath : group.newPath);
      items.forEach((line, index) => {
        line[key] = highlighted?.[index] ?? null;
        const annotation = line.text.slice(lines[index].length);
        if (line[key] && annotation) line[key].push({ text: annotation, className: '' });
      });
    }
    return item[key];
  }

  // Intersect syntax runs with change runs so both use the same original text.
  function segments(item, side, changes) {
    const text = item?.text ?? '';
    const syntax = tokens(item, side) || [{ text, className: '' }];
    const diff = changes || [{ text, changed: false }];
    const result = [];
    let a = 0, b = 0, x = 0, y = 0;
    while (a < syntax.length && b < diff.length) {
      const length = Math.min(syntax[a].text.length - x, diff[b].text.length - y);
      if (length) result.push({ text: syntax[a].text.slice(x, x + length), className: syntax[a].className, changed: diff[b].changed });
      x += length; y += length;
      if (x === syntax[a].text.length) { a++; x = 0; }
      if (y === diff[b].text.length) { b++; y = 0; }
    }
    return result;
  }
  return { language, highlightLines, prepare, segments };
})();
if (typeof module !== 'undefined') module.exports = PatchpaneSyntax;
