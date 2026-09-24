'use strict';

// Linear parsing and positional pairing: no quadratic line matching on large patches.
function parseRows(patch, split) {
  const rows = [];
  let old = 0, next = 0, inHunk = false, deleted = [], added = [];
  function flush() {
    for (let i = 0; i < Math.min(deleted.length, added.length); i++) {
      const pair = { left: deleted[i].text, right: added[i].text };
      deleted[i].pair = pair; deleted[i].pairSide = 0;
      added[i].pair = pair; added[i].pairSide = 1;
    }
    if (split) {
      for (let i = 0; i < Math.max(deleted.length, added.length); i++)
        rows.push({ left: deleted[i], right: added[i] });
    } else {
      for (const item of deleted) rows.push({ single: item });
      for (const item of added) rows.push({ single: item });
    }
    deleted = []; added = [];
  }
  const lines = patch.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush(); old = Number(hunk[1]); next = Number(hunk[2]); inHunk = true;
      rows.push({ kind: 'hunk', text: line });
    } else if (inHunk && line.startsWith('-')) {
      deleted.push({ kind: 'del', old: old++, text: line.slice(1) });
    } else if (inHunk && line.startsWith('+')) {
      added.push({ kind: 'add', next: next++, text: line.slice(1) });
    } else if (inHunk && line.startsWith(' ')) {
      flush(); const item = { kind: 'context', old: old++, next: next++, text: line.slice(1) };
      rows.push(split ? { left: item, right: item } : { single: item });
    } else if (inHunk && line.startsWith('\\')) {
      // Attach the marker to its source line without interrupting replacement pairing.
      const item = added.at(-1) || deleted.at(-1);
      if (item) item.text += '\n' + line;
      else { flush(); rows.push({ kind: 'meta', text: line }); }
    } else {
      flush();
      if (!line.startsWith('diff --git ') && !line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ '))
        rows.push({ kind: 'meta', text: line });
    }
  }
  flush(); return rows;
}

// Bounded token LCS, computed only when a replacement line is displayed.
// Graphemes keep emoji and combining marks intact. Large comparisons fall back
// to the existing line backgrounds instead of doing unbounded work.
const graphemes = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
function intralineDiff(left, right) {
  if (left.length > 4096 || right.length > 4096) return null;
  const split = text => graphemes
    ? Array.from(graphemes.segment(text), part => part.segment) : Array.from(text);
  function tokens(text) {
    const result = [];
    let previousKind;
    for (const character of split(text)) {
      const kind = /^[\p{L}\p{N}\p{M}_]+$/u.test(character) ? 'word'
        : /^[ \t]+$/.test(character) ? 'space' : 'punctuation';
      if (kind !== 'punctuation' && kind === previousKind) result[result.length - 1] += character;
      else result.push(character);
      previousKind = kind;
    }
    return result;
  }
  const a = tokens(left), b = tokens(right);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n * m > 65536) return null;
  const width = m + 1;
  const scores = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      scores[i * width + j] = a[start + i] === b[start + j]
        ? 1 + scores[(i + 1) * width + j + 1]
        : Math.max(scores[(i + 1) * width + j], scores[i * width + j + 1]);
    }
  }
  const parts = [[], []];
  function push(side, text, changed) {
    if (!text) return;
    const last = parts[side].at(-1);
    if (last && last.changed === changed) last.text += text;
    else parts[side].push({ text, changed });
  }
  push(0, a.slice(0, start).join(''), false);
  push(1, b.slice(0, start).join(''), false);
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      push(0, a[start + i++], false); push(1, b[start + j++], false);
    } else if (i < n && (j === m || scores[(i + 1) * width + j] >= scores[i * width + j + 1])) {
      push(0, a[start + i++], true);
    } else {
      push(1, b[start + j++], true);
    }
  }
  push(0, a.slice(endA).join(''), false); push(1, b.slice(endB).join(''), false);
  return parts;
}

function lineParts(item) {
  if (!item?.pair) return null;
  const pair = item.pair;
  if (!Object.hasOwn(pair, 'parts')) {
    // The parser appends Git's missing-newline annotation after a newline.
    // Keep that annotation visible, but outside character matching.
    const content = [pair.left, pair.right].map(text => text.split('\n', 1)[0]);
    pair.parts = intralineDiff(...content);
    // Shared indentation/spacing alone doesn't make a replacement partial.
    // Whole-line replacements already have the red/green line background.
    if (pair.parts && !pair.parts[0].some(part => !part.changed && part.text.trim())) {
      pair.parts = null;
    }
    if (pair.parts) {
      [pair.left, pair.right].forEach((text, side) => {
        const annotation = text.slice(content[side].length);
        if (annotation) pair.parts[side].push({ text: annotation, changed: false });
      });
    }
  }
  return pair.parts?.[item.pairSide] ?? null;
}

// Keep paths as data: directory names can contain markup or object property names.
function buildFileTree(files) {
  const root = { directories: new Map(), files: [] };
  files.forEach((file, index) => {
    const parts = file.path.split('/');
    const name = parts.pop();
    let node = root;
    for (const directory of parts) {
      if (!node.directories.has(directory)) {
        node.directories.set(directory, { directories: new Map(), files: [] });
      }
      node = node.directories.get(directory);
    }
    node.files.push({ name, index });
  });
  return root;
}

function compactDirectory(name, node) {
  while (node.files.length === 0 && node.directories.size === 1) {
    const [childName, child] = node.directories.entries().next().value;
    name += '/' + childName;
    node = child;
  }
  return { name, node };
}

if (typeof module !== 'undefined') module.exports = { parseRows, intralineDiff, lineParts, buildFileTree, compactDirectory };
if (typeof document !== 'undefined') startViewer();

function startViewer() {
  const data = JSON.parse(document.getElementById('diff-data').textContent);
  const $ = id => document.getElementById(id);
  const element = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  $('comparison').textContent = data.title;
  document.title = `Patchpane · ${data.title}`;
  $('file-count').textContent = data.files.length;
  const additions = data.files.reduce((n, f) => n + f.added, 0);
  const deletions = data.files.reduce((n, f) => n + f.removed, 0);
  $('stats').append(`${data.files.length} changed files`, '  ·  ', element('span', 'plus', `+${additions}`), '  ', element('span', 'minus', `−${deletions}`));
  let split = true;
  const entries = [];
  const updateProgress = () => $('progress').textContent = `${entries.filter(e => e.check.checked).length} of ${entries.length} files viewed`;
  const observer = new IntersectionObserver(changes => {
    for (const change of changes) if (change.isIntersecting) {
      const entry = entries[Number(change.target.dataset.index)];
      if (entry && entry.details.open) render(entry);
    }
  }, { rootMargin: '400px' });

  function codeCell(className, item, prefix = '') {
    const td = element('td', className);
    const viewport = element('div', 'line');
    const line = element('span', 'line-content');
    viewport.append(line);
    if (prefix) line.append(prefix);
    const parts = lineParts(item);
    if (parts) {
      for (const part of parts) {
        if (part.changed) line.append(element('span', 'intraline', part.text));
        else line.append(part.text);
      }
    } else line.append(item?.text ?? '');
    td.append(viewport);
    return td;
  }

  function render(entry) {
    if (entry.rendered) return;
    entry.rendered = true;
    const rows = parseRows(entry.file.patch, split);
    const scroll = element('div', 'diff-scroll');
    const table = element('table', 'diff');
    table.setAttribute('aria-label', `Diff for ${entry.file.path}`);
    const cols = document.createElement('colgroup');
    for (const name of split ? ['number', 'code', 'number', 'code'] : ['number', 'number', 'code']) cols.append(element('col', name));
    const tbody = document.createElement('tbody');
    table.append(cols, tbody); scroll.append(table); entry.body.append(scroll);
    const horizontal = element('div', 'file-horizontal-scroll');
    horizontal.tabIndex = 0;
    horizontal.setAttribute('role', 'region');
    horizontal.setAttribute('aria-label', `Horizontal scroll for ${entry.file.path}; both sides scroll together`);
    const extent = element('div'); horizontal.append(extent);
    entry.body.append(horizontal);
    function pan() {
      table.style.setProperty('--file-pan', `${-horizontal.scrollLeft}px`);
    }
    entry.updateScroll = () => {
      if (!table.clientWidth) return;
      let overflow = 0;
      if (!document.body.classList.contains('wrap')) {
        for (const content of table.querySelectorAll('.line-content')) {
          overflow = Math.max(overflow, content.scrollWidth - content.parentElement.clientWidth + 20);
        }
      }
      horizontal.hidden = overflow <= 0;
      extent.style.width = `${table.clientWidth + overflow}px`;
      horizontal.scrollLeft = Math.min(horizontal.scrollLeft, overflow);
      pan();
    };
    horizontal.addEventListener('scroll', pan);
    scroll.addEventListener('wheel', event => {
      const delta = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      if (!delta || horizontal.hidden) return;
      const scale = event.deltaMode === 1 ? 21 : event.deltaMode === 2 ? table.clientWidth : 1;
      horizontal.scrollLeft += delta * scale;
      pan(); event.preventDefault();
    }, { passive: false });
    horizontal.addEventListener('keydown', event => {
      const changes = { ArrowLeft: -40, ArrowRight: 40, Home: -Infinity, End: Infinity };
      if (!(event.key in changes)) return;
      const max = horizontal.scrollWidth - horizontal.clientWidth;
      horizontal.scrollLeft = Math.max(0, Math.min(max, horizontal.scrollLeft + changes[event.key]));
      pan(); event.preventDefault();
    });
    entry.resizeObserver = new ResizeObserver(entry.updateScroll);
    entry.resizeObserver.observe(table);
    let cursor = 0;
    const more = element('button', 'load-more');
    function cell(row, item, side) {
      row.append(element('td', `number ${item?.kind || 'gap'}`, item ? String((side === 'old' ? item.old : item.next) ?? '') : ''));
      row.append(codeCell(`code ${item?.kind || 'gap'} ${side === 'next' ? 'split-edge' : ''}`, item));
    }
    function batch() {
      const fragment = document.createDocumentFragment();
      const end = Math.min(cursor + 400, rows.length);
      for (; cursor < end; cursor++) {
        const item = rows[cursor];
        const row = element('tr', item.kind);
        if (item.kind) {
          const td = element('td', '', item.text); td.colSpan = split ? 4 : 3; row.append(td);
        } else if (split) {
          cell(row, item.left, 'old'); cell(row, item.right, 'next');
        } else {
          const line = item.single;
          row.append(element('td', `number ${line.kind}`, String(line.old ?? '')), element('td', `number ${line.kind}`, String(line.next ?? '')), codeCell(`code ${line.kind}`, line, `${line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '} `));
        }
        fragment.append(row);
      }
      tbody.append(fragment);
      entry.updateScroll();
      more.textContent = `Show next ${Math.min(400, rows.length - cursor)} rows (${rows.length - cursor} remaining)`;
      more.hidden = cursor >= rows.length;
    }
    more.addEventListener('click', batch); entry.body.append(more); batch();
    if (!rows.length) entry.body.append(element('p', 'notice', entry.file.binary ? 'Binary file changed. Content is not displayed.' : 'File metadata changed; no text hunks.'));
  }

  for (const [index, file] of data.files.entries()) {
    const id = `file-${index}`;
    const link = element('a'); link.href = `#${id}`;
    link.append(element('span', 'filename', file.path.split('/').at(-1)), element('span', 'delta plus', `+${file.added}`), element('span', 'delta minus', `−${file.removed}`));
    link.title = file.path; link.setAttribute('aria-label', file.path);
    const article = element('article'); article.id = id; article.dataset.index = index;
    const details = document.createElement('details'); details.open = true;
    const summary = document.createElement('summary');
    summary.append(element('span', 'file-title', file.oldPath ? `${file.oldPath} → ${file.path}` : file.path));
    const counts = element('span', 'file-counts');
    counts.append(element('span', 'plus', `+${file.added}`), '  ', element('span', 'minus', `−${file.removed}`));
    const label = element('label', 'viewed');
    const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', `Mark ${file.path} viewed`);
    label.append(check, 'Viewed'); label.addEventListener('click', e => e.stopPropagation());
    summary.append(counts, label);
    const body = element('div', 'file-body'); details.append(summary, body); article.append(details); $('review').append(article);
    const entry = { file, article, details, body, check, link, rendered: false }; entries.push(entry);
    check.addEventListener('change', () => { link.classList.toggle('done', check.checked); updateProgress(); });
    details.addEventListener('toggle', () => { if (details.open && article.getBoundingClientRect().top < innerHeight + 400 && article.getBoundingClientRect().bottom > -400) render(entry); });
    link.addEventListener('click', () => { details.open = true; render(entry); for (const e of entries) e.link.classList.toggle('active', e === entry); });
    observer.observe(article);
  }
  const folders = [];
  function renderTree(node, parent, prefix = '') {
    const groups = [];
    for (const [directoryName, directory] of [...node.directories].sort(([a], [b]) => a.localeCompare(b))) {
      const { name, node: child } = compactDirectory(directoryName, directory);
      const folder = element('details', 'directory'); folder.open = true;
      const heading = element('summary', 'directory-heading');
      heading.append(element('span', 'directory-name', name));
      heading.title = prefix + name;
      heading.setAttribute('aria-label', `Directory ${prefix}${name}`);
      const contents = element('div', 'directory-contents');
      folder.append(heading, contents); parent.append(folder); folders.push(folder);
      groups.push({ folder, tree: renderTree(child, contents, prefix + name + '/') });
    }
    const links = [];
    for (const file of [...node.files].sort((a, b) => a.name.localeCompare(b.name))) {
      const link = entries[file.index].link;
      parent.append(link); links.push(link);
    }
    return { groups, links };
  }
  const navigation = renderTree(buildFileTree(data.files), $('files'));
  let savedFolderState = null;
  function filterTree(tree, searching) {
    let visible = tree.links.some(link => !link.hidden);
    for (const group of tree.groups) {
      const childVisible = filterTree(group.tree, searching);
      group.folder.hidden = !childVisible;
      if (searching && childVisible) group.folder.open = true;
      visible = visible || childVisible;
    }
    return visible;
  }
  updateProgress();
  if (!entries.length) {
    const empty = element('div', 'empty-state');
    empty.append(element('h2', '', 'No changes to review'), element('p', '', 'The selected comparison contains no changes.'));
    $('review').append(empty);
  }
  $('filter').addEventListener('input', () => {
    const query = $('filter').value.toLowerCase(); let visible = 0;
    for (const entry of entries) {
      const match = `${entry.file.path}\n${entry.file.oldPath || ''}`.toLowerCase().includes(query);
      entry.article.hidden = !match; entry.link.hidden = !match; if (match) visible++;
    }
    if (query && savedFolderState === null) savedFolderState = folders.map(folder => folder.open);
    filterTree(navigation, Boolean(query));
    if (!query && savedFolderState !== null) {
      folders.forEach((folder, index) => { folder.open = savedFolderState[index]; });
      savedFolderState = null;
    }
    $('empty').hidden = visible !== 0 || entries.length === 0;
    for (const entry of entries) {
      const rect = entry.article.getBoundingClientRect();
      if (!entry.article.hidden && entry.details.open && rect.top < innerHeight + 400 && rect.bottom > -400) render(entry);
    }
  });
  function layout(value) {
    split = value; $('split').setAttribute('aria-pressed', String(split)); $('unified').setAttribute('aria-pressed', String(!split));
    for (const entry of entries) {
      entry.resizeObserver?.disconnect();
      entry.updateScroll = null;
      entry.body.replaceChildren(); entry.rendered = false;
      const rect = entry.article.getBoundingClientRect();
      if (!entry.article.hidden && entry.details.open && rect.top < innerHeight + 400 && rect.bottom > -400) render(entry);
    }
  }
  $('split').addEventListener('click', () => layout(true));
  $('unified').addEventListener('click', () => layout(false));
  $('wrap').addEventListener('click', () => {
    $('wrap').setAttribute('aria-pressed', String(document.body.classList.toggle('wrap')));
    for (const entry of entries) entry.updateScroll?.();
  });
  $('collapse').addEventListener('click', () => {
    const expand = entries.every(e => !e.details.open);
    for (const entry of entries) entry.details.open = expand;
    $('collapse').textContent = expand ? 'Collapse all' : 'Expand all';
  });
  if (/^#file-\d+$/.test(location.hash)) {
    const entry = entries[Number(location.hash.slice(6))];
    if (entry) { render(entry); requestAnimationFrame(() => entry.article.scrollIntoView()); }
  }
}
