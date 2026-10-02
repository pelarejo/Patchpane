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

function treeWidthLimits(viewportWidth) {
  return { min: 180, max: Math.max(180, Math.min(600, viewportWidth - 360)) };
}

async function copyFileName(name) {
  try {
    await navigator.clipboard.writeText(name);
    return;
  } catch {} // Some browsers restrict the clipboard API for local HTML files.
  const input = document.createElement('textarea');
  input.value = name;
  input.readOnly = true;
  input.style.cssText = 'position:fixed;left:-9999px;top:0';
  const focused = document.activeElement;
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    input.remove();
    focused?.focus({ preventScroll: true });
  }
}

function setupTreeResizer(handle, pane, workspace, initialWidth, saveWidth) {
  let chosenWidth = null, drag = null;
  function update(width) {
    const { min, max } = treeWidthLimits(workspace.clientWidth);
    if (width !== null) {
      chosenWidth = Math.round(Math.max(min, Math.min(max, width)));
      workspace.style.setProperty('--tree-width', `${chosenWidth}px`);
    } else {
      chosenWidth = null;
      workspace.style.removeProperty('--tree-width');
    }

  }
  function stop() {
    if (drag) saveWidth(chosenWidth);
    drag = null;
    document.body.classList.remove('resizing-tree');
  }
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    drag = { x: event.clientX, width: pane.getBoundingClientRect().width };
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-tree');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (drag) update(drag.width + event.clientX - drag.x);
  });
  handle.addEventListener('pointerup', event => {
    stop();
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  });
  handle.addEventListener('pointercancel', stop);
  handle.addEventListener('lostpointercapture', stop);
  handle.addEventListener('dblclick', () => { update(null); saveWidth(null); });
  window.addEventListener('resize', () => { stop(); update(chosenWidth); });
  update(initialWidth);
}

function readReviewState(raw, generatedAt) {
  try {
    const saved = JSON.parse(raw);
    if (saved?.generatedAt !== generatedAt || !Array.isArray(saved.files)) return new Map();
    return new Map(saved.files.filter(file => file && typeof file.path === 'string'
      && typeof file.viewed === 'boolean' && typeof file.open === 'boolean')
      .map(file => [file.path, file]));
  } catch { return new Map(); }
}

function showerConfetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelector('.confetti')?.remove();
  const shower = document.createElement('div');
  shower.className = 'confetti';
  shower.setAttribute('aria-hidden', 'true');
  const colors = ['#ff7096', '#ffd166', '#70d6a6', '#73b8ff', '#c79aff'];
  for (let index = 0; index < 36; index++) {
    const piece = document.createElement('i');
    piece.style.cssText = `left:${Math.random() * 100}%;background:${colors[index % colors.length]};`
      + `--drift:${Math.random() * 160 - 80}px;--spin:${Math.random() * 720 - 360}deg;`
      + `animation-delay:${Math.random() * .5}s;animation-duration:${2.2 + Math.random()}s`;
    shower.append(piece);
  }
  document.body.append(shower);
  setTimeout(() => shower.remove(), 4000);
}

if (typeof module !== 'undefined') module.exports = { parseRows, intralineDiff, lineParts, buildFileTree, compactDirectory, readReviewState };
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
  const generated = new Date(data.generatedAt);
  const date = generated.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = generated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const subtitle = `${date} · ${time}`;
  $('comparison').textContent = `${data.title} · ${subtitle}`;
  $('comparison').title = `${generated.toLocaleString()}\n${data.comparison}`;
  document.title = `Patchpane · ${data.title} · ${subtitle}`;
  $('file-count').textContent = data.files.length;
  const additions = data.files.reduce((n, f) => n + f.added, 0);
  const deletions = data.files.reduce((n, f) => n + f.removed, 0);
  $('stats').append(`${data.files.length} changed files`, '  ·  ', element('span', 'plus', `+${additions}`), '  ', element('span', 'minus', `−${deletions}`));
  const preferenceKey = 'patchpane:viewer-preferences';
  const preferences = { split: true, wrap: true, treeHidden: false, treeWidth: null };
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey));
    for (const key of ['split', 'wrap', 'treeHidden']) {
      if (typeof saved?.[key] === 'boolean') preferences[key] = saved[key];
    }
    if (Number.isFinite(saved?.treeWidth) && saved.treeWidth > 0) preferences.treeWidth = saved.treeWidth;
  } catch {} // Keep defaults when browser storage is unavailable or invalid.
  function savePreferences() {
    try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch {}
  }
  setupTreeResizer($('tree-resizer'), $('file-tree'), document.querySelector('.workspace'), preferences.treeWidth, width => {
    preferences.treeWidth = width;
    savePreferences();
  });
  function showTree(hidden) {
    $('file-tree').hidden = hidden;
    document.querySelector('.workspace').classList.toggle('tree-hidden', hidden);
    $('toggle-tree').setAttribute('aria-expanded', String(!hidden));
    $('toggle-tree').textContent = hidden ? 'Show file tree' : 'Hide file tree';
  }
  let split = preferences.split;
  $('split').setAttribute('aria-pressed', String(split));
  $('unified').setAttribute('aria-pressed', String(!split));
  document.body.classList.toggle('wrap', preferences.wrap);
  $('wrap').setAttribute('aria-pressed', String(preferences.wrap));
  showTree(preferences.treeHidden);
  function expandControls(expanded) {
    document.querySelector('.controls').classList.toggle('expanded', expanded);
    $('toggle-controls').setAttribute('aria-expanded', String(expanded));
    const label = expanded ? 'Hide view controls' : 'Show view controls';
    $('toggle-controls').setAttribute('aria-label', label);
    $('toggle-controls').title = label;
  }
  let viewClicks = [];
  $('toggle-controls').addEventListener('click', () => {
    expandControls($('toggle-controls').getAttribute('aria-expanded') !== 'true');
    const now = performance.now();
    viewClicks = viewClicks.filter(time => now - time <= 2000);
    viewClicks.push(now);
    if (viewClicks.length === 5) { viewClicks = []; showerConfetti(); }
  });
  document.querySelector('.controls').addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('toggle-controls').getAttribute('aria-expanded') === 'true') {
      expandControls(false);
      $('toggle-controls').focus();
    }
  });
  const entries = [];
  const reviewKey = `patchpane:review:${location.pathname}`;
  let reviewState = new Map(), reviewFrame = null;
  try { reviewState = readReviewState(sessionStorage.getItem(reviewKey), data.generatedAt); } catch {}
  function saveReviewState() {
    $('collapse').textContent = entries.length && entries.every(entry => !entry.details.open) ? 'Expand all' : 'Collapse all';
    try {
      sessionStorage.setItem(reviewKey, JSON.stringify({ generatedAt: data.generatedAt,
        files: entries.map(entry => ({ path: entry.file.path, viewed: entry.check.checked, open: entry.details.open })) }));
    } catch {}
  }
  function scheduleReviewSave() {
    if (reviewFrame !== null) return;
    reviewFrame = requestAnimationFrame(() => { reviewFrame = null; saveReviewState(); });
  }
  window.addEventListener('pagehide', saveReviewState);
  const updateProgress = () => $('progress').textContent = `${entries.filter(e => e.check.checked).length} of ${entries.length} files viewed`;
  const observer = new IntersectionObserver(changes => {
    for (const change of changes) if (change.isIntersecting) {
      const entry = entries[Number(change.target.dataset.index)];
      if (entry && entry.details.open) render(entry);
    }
  }, { rootMargin: '400px' });

  function codeCell(className, item, prefix = '', side = 'next') {
    const td = element('td', className);
    const viewport = element('div', 'line');
    const line = element('span', 'line-content');
    viewport.append(line);
    if (prefix) line.append(prefix);
    const parts = PatchpaneSyntax.segments(item, side, lineParts(item));
    for (const part of parts) {
      const className = [part.className, part.changed ? 'intraline' : ''].filter(Boolean).join(' ');
      if (className) line.append(element('span', className, part.text));
      else line.append(part.text);
    }
    td.append(viewport);
    return td;
  }

  function render(entry) {
    if (entry.rendered) return;
    entry.rendered = true;
    const rows = parseRows(entry.file.patch, split);
    PatchpaneSyntax.prepare(rows, split, entry.file.oldPath || entry.file.path, entry.file.path);
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
      row.append(codeCell(`code ${item?.kind || 'gap'} ${side === 'next' ? 'split-edge' : ''}`, item, '', side));
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
          row.append(element('td', `number ${line.kind}`, String(line.old ?? '')), element('td', `number ${line.kind}`, String(line.next ?? '')), codeCell(`code ${line.kind}`, line, `${line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '} `, line.kind === 'del' ? 'old' : 'next'));
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
    link.title = file.path.split('/').at(-1); link.setAttribute('aria-label', file.path);
    const article = element('article'); article.id = id; article.dataset.index = index;
    const savedFile = reviewState.get(file.path);
    const details = document.createElement('details'); details.open = savedFile?.open ?? true;
    const summary = document.createElement('summary');
    const heading = element('span', 'file-heading');
    const copy = element('button', 'copy-filename');
    copy.type = 'button';
    const copyIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) copyIcon.setAttribute(key, value);
    const copyPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    copyIcon.append(copyPath); copy.append(copyIcon);
    function copyFeedback(state) {
      copyPath.setAttribute('d', state === 'Copied' ? 'M5 12l4 4L19 6' : state === 'Copy failed' ? 'M12 5v9m0 4v1' : 'M8 8h12v12H8z M16 8V4H4v12h4');
      const label = state || `Copy filename ${file.path}`;
      copy.title = label;
      copy.setAttribute('aria-label', label);
    }
    copyFeedback();
    copy.setAttribute('aria-live', 'polite');
    let copyTimer;
    copy.addEventListener('click', async event => {
      event.preventDefault(); event.stopPropagation();
      clearTimeout(copyTimer);
      try {
        await copyFileName(file.path);
        copyFeedback('Copied');
      } catch {
        copyFeedback('Copy failed');
      }
      copyTimer = setTimeout(() => copyFeedback(), 2000);
    });
    heading.append(element('span', 'file-title', file.oldPath ? `${file.oldPath} → ${file.path}` : file.path), copy);
    summary.append(heading);
    const counts = element('span', 'file-counts');
    counts.append(element('span', 'plus', `+${file.added}`), '  ', element('span', 'minus', `−${file.removed}`));
    const label = element('label', 'viewed');
    const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', `Mark ${file.path} viewed`);
    check.checked = savedFile?.viewed ?? false;
    link.classList.toggle('done', check.checked);
    label.append(check, 'Viewed'); label.addEventListener('click', e => e.stopPropagation());
    summary.append(counts, label);
    const body = element('div', 'file-body'); details.append(summary, body); article.append(details);
    const entry = { file, article, details, body, check, link, rendered: false }; entries.push(entry);
    check.addEventListener('change', () => { link.classList.toggle('done', check.checked); updateProgress(); scheduleReviewSave(); });
    details.addEventListener('toggle', () => { scheduleReviewSave(); if (details.open && article.getBoundingClientRect().top < innerHeight + 400 && article.getBoundingClientRect().bottom > -400) render(entry); });
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
      // Use this same directory-first traversal for the diff panels and navigation.
      $('review').append(entries[file.index].article);
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
  const endings = [
    ['☕', 'That’s a wrap!', 'Every diff has had its moment.'],
    ['🎉', 'You made it!', 'No more lines ahead.'],
    ['✨', 'All diffed out.', 'Time for a well-earned break.'],
    ['🚀', 'End of the diffiverse.', 'Nothing but whitespace beyond here.'],
    ['🎬', 'Fin.', 'The code will return in the next commit.'],
  ];
  const [emoji, headline, message] = endings[Math.floor(Math.random() * endings.length)];
  $('review-end').querySelector('.finish-emoji').textContent = emoji;
  $('review-end').querySelector('p').textContent = headline;
  $('review-end').querySelector('.finish-message').textContent = message;
  $('review-end').hidden = entries.length === 0;
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
    $('review-end').hidden = visible === 0;
    for (const entry of entries) {
      const rect = entry.article.getBoundingClientRect();
      if (!entry.article.hidden && entry.details.open && rect.top < innerHeight + 400 && rect.bottom > -400) render(entry);
    }
  });
  function layout(value) {
    split = value; $('split').setAttribute('aria-pressed', String(split)); $('unified').setAttribute('aria-pressed', String(!split));
    preferences.split = split; savePreferences();
    for (const entry of entries) {
      entry.resizeObserver?.disconnect();
      entry.updateScroll = null;
      entry.body.replaceChildren(); entry.rendered = false;
      const rect = entry.article.getBoundingClientRect();
      if (!entry.article.hidden && entry.details.open && rect.top < innerHeight + 400 && rect.bottom > -400) render(entry);
    }
  }
  $('toggle-tree').addEventListener('click', () => {
    preferences.treeHidden = !$('file-tree').hidden;
    showTree(preferences.treeHidden); savePreferences();
  });
  $('split').addEventListener('click', () => layout(true));
  $('unified').addEventListener('click', () => layout(false));
  $('wrap').addEventListener('click', () => {
    preferences.wrap = document.body.classList.toggle('wrap');
    $('wrap').setAttribute('aria-pressed', String(preferences.wrap));
    savePreferences();
    for (const entry of entries) entry.updateScroll?.();
  });
  $('collapse').textContent = entries.length && entries.every(entry => !entry.details.open) ? 'Expand all' : 'Collapse all';
  $('collapse').addEventListener('click', () => {
    const expand = entries.every(e => !e.details.open);
    for (const entry of entries) entry.details.open = expand;
    $('collapse').textContent = expand ? 'Collapse all' : 'Expand all';
  });
  const positionKey = `patchpane:position:${location.pathname}`;
  let savedPosition = null;
  try { savedPosition = JSON.parse(sessionStorage.getItem(positionKey)); } catch {}
  const sameReport = savedPosition?.generatedAt === data.generatedAt;
  const reloading = performance.getEntriesByType('navigation')[0]?.type === 'reload';
  const orderedEntries = [...$('review').children].map(article => entries[Number(article.dataset.index)]).filter(Boolean);
  let restoringPosition = true, positionFrame = null;
  function savePosition() {
    if (restoringPosition) return;
    // Follow the file at the top of the review, including manual scrolling.
    const reviewTop = document.querySelector('header').getBoundingClientRect().bottom;
    const entry = orderedEntries.find(entry => !entry.article.hidden && entry.article.getBoundingClientRect().bottom > reviewTop);
    try {
      sessionStorage.setItem(positionKey, JSON.stringify({ generatedAt: data.generatedAt, file: entry?.file.path }));
    } catch {} // Local-file storage may be unavailable in some browsers.
  }
  window.addEventListener('scroll', () => {
    if (positionFrame !== null) return;
    positionFrame = requestAnimationFrame(() => { positionFrame = null; savePosition(); });
  }, { passive: true });
  window.addEventListener('pagehide', savePosition);
  let target = reloading && sameReport ? entries.find(entry => entry.file.path === savedPosition.file) : null;
  // An old hash refers to a different file after regeneration; discard it on reload.
  const regenerated = reloading && savedPosition && !sameReport;
  if (!target && !regenerated && /^#file-\d+$/.test(location.hash)) target = entries[Number(location.hash.slice(6))];
  if (regenerated || target) history.scrollRestoration = 'manual';
  if (target) {
    const previous = orderedEntries[orderedEntries.indexOf(target) - 1];
    if (previous) render(previous);
    render(target);
  }
  requestAnimationFrame(() => {
    if (target) target.article.scrollIntoView();
    else if (regenerated) window.scrollTo(0, 0);
    requestAnimationFrame(() => { restoringPosition = false; savePosition(); });
  });
}
