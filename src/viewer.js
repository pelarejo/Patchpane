'use strict';

// Linear parsing and positional pairing: no quadratic line matching on large patches.
function parseRows(patch, split) {
  const rows = [];
  let old = 0, next = 0, inHunk = false, deleted = [], added = [];
  function flush() {
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

if (typeof module !== 'undefined') module.exports = { parseRows };
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

  function codeCell(className, text) {
    const td = element('td', className);
    td.append(element('div', 'line', text));
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
    let cursor = 0;
    const more = element('button', 'load-more');
    function cell(row, item, side) {
      row.append(element('td', `number ${item?.kind || 'gap'}`, item ? String((side === 'old' ? item.old : item.next) ?? '') : ''));
      row.append(codeCell(`code ${item?.kind || 'gap'} ${side === 'next' ? 'split-edge' : ''}`, item?.text ?? ''));
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
          row.append(element('td', `number ${line.kind}`, String(line.old ?? '')), element('td', `number ${line.kind}`, String(line.next ?? '')), codeCell(`code ${line.kind}`, `${line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '} ${line.text}`));
        }
        fragment.append(row);
      }
      tbody.append(fragment);
      more.textContent = `Show next ${Math.min(400, rows.length - cursor)} rows (${rows.length - cursor} remaining)`;
      more.hidden = cursor >= rows.length;
    }
    more.addEventListener('click', batch); entry.body.append(more); batch();
    if (!rows.length) entry.body.append(element('p', 'notice', entry.file.binary ? 'Binary file changed. Content is not displayed.' : 'File metadata changed; no text hunks.'));
  }

  for (const [index, file] of data.files.entries()) {
    const id = `file-${index}`;
    const link = element('a'); link.href = `#${id}`;
    link.append(element('span', 'filename', file.path), element('span', 'delta plus', `+${file.added}`), element('span', 'delta minus', `−${file.removed}`));
    link.title = file.path; $('files').append(link);
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
    $('empty').hidden = visible !== 0 || entries.length === 0;
    for (const entry of entries) {
      const rect = entry.article.getBoundingClientRect();
      if (!entry.article.hidden && entry.details.open && rect.top < innerHeight + 400 && rect.bottom > -400) render(entry);
    }
  });
  function layout(value) {
    split = value; $('split').setAttribute('aria-pressed', String(split)); $('unified').setAttribute('aria-pressed', String(!split));
    for (const entry of entries) {
      entry.body.replaceChildren(); entry.rendered = false;
      const rect = entry.article.getBoundingClientRect();
      if (!entry.article.hidden && entry.details.open && rect.top < innerHeight + 400 && rect.bottom > -400) render(entry);
    }
  }
  $('split').addEventListener('click', () => layout(true));
  $('unified').addEventListener('click', () => layout(false));
  $('wrap').addEventListener('click', () => $('wrap').setAttribute('aria-pressed', String(document.body.classList.toggle('wrap'))));
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
