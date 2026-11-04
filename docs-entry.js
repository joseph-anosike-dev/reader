// Reads PDF, Word (.docx) and PowerPoint (.pptx) files fully offline.
// Bundled into the APK by the build workflow; exposes window.__DOCS for Reader.html.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import mammoth from 'mammoth/mammoth.browser.js';
import JSZip from 'jszip';

// Run pdf.js's worker code on the main thread, so no separate worker file is needed.
globalThis.pdfjsWorker = pdfWorker;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const clean = (s) => s.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/[ \t]+/g, ' ').trim();

function readBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsArrayBuffer(file);
  });
}

/* ---------------- PDF ---------------- */
const ENDS_SENTENCE = /[.!?]["'”’)\]]*$/;
const BULLET = /^([•●▪◦‣–—-]|\d{1,3}[.)])\s+/;
const PAGE_NUMBER = /^\s*(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?\s*$/i;

async function extractPdf(buf, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const pages = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const lines = [];
    let cur = null;

    for (const it of content.items) {
      if (!('str' in it) || it.str === '') continue;
      const x = it.transform[4];
      const y = it.transform[5];
      const h = Math.abs(it.transform[3]) || it.height || 10;
      if (cur && Math.abs(y - cur.y) <= h * 0.5) {
        const gap = x - cur.endX;
        const needSpace = gap > h * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
        cur.text += (needSpace ? ' ' : '') + it.str;
        cur.endX = x + it.width;
        cur.h = Math.max(cur.h, h);
      } else {
        if (cur) lines.push(cur);
        cur = { text: it.str, x, y, h, endX: x + it.width };
      }
    }
    if (cur) lines.push(cur);

    pages.push(
      lines
        .map((l) => ({ text: clean(l.text), y: l.y, h: l.h, width: l.endX - l.x }))
        .filter((l) => l.text)
    );
    page.cleanup();
    if (onProgress) onProgress(p, pdf.numPages);
    if (p % 3 === 0) await tick();   // let the screen update on long files
  }
  const outline = await readOutline(pdf);
  return pagesToText(pages, outline);
}

// The PDF's own table of contents (bookmarks), flattened to { title, level, page }.
async function readOutline(pdf) {
  let tree = null;
  try { tree = await pdf.getOutline(); } catch (e) { /* no outline */ }
  if (!tree || !tree.length) return [];
  const items = [];
  const walk = async (nodes, depth) => {
    for (const n of nodes) {
      const title = (n.title || '').replace(/\s+/g, ' ').trim();
      let page = -1;
      try {
        let dest = n.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null) {
          page = typeof dest[0] === 'object' ? await pdf.getPageIndex(dest[0]) : dest[0];
        }
      } catch (e) { /* unresolved bookmark: skip it */ }
      if (title && page >= 0 && page < pdf.numPages) items.push({ title, level: Math.min(depth, 6), page });
      if (n.items && n.items.length) await walk(n.items, depth + 1);
    }
  };
  try { await walk(tree, 1); } catch (e) { return []; }
  return items;
}

const normTitle = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// Marks the page line that matches each bookmark as a heading (a title wrapped over up to
// three lines is merged). A bookmark with no matching line gets its title added at the top
// of its page, so every entry in the table of contents still has a place to jump to.
function applyOutline(pages, outline) {
  const synth = pages.map(() => []);
  outline.forEach((it) => {
    const lines = pages[it.page];
    const target = normTitle(it.title);
    if (!lines || !target) return;
    let hit = false;
    for (let s = 0; s < lines.length && !hit; s++) {
      if (lines[s].level) continue;
      let acc = '';
      for (let e = s; e < Math.min(lines.length, s + 3); e++) {
        if (lines[e].level) break;
        acc += lines[e].text;
        const a = normTitle(acc);
        if (a === target) {
          if (e > s) {
            lines[s].text = lines.slice(s, e + 1).map((l) => l.text).join(' ');
            lines.splice(s + 1, e - s);
          }
          lines[s].level = it.level;
          hit = true;
          break;
        }
        if (a.length >= target.length) break;
      }
    }
    if (!hit) synth[it.page].push({ text: it.title, y: 0, h: 0, width: 0, level: it.level });
  });
  return pages.map((lines, i) => (synth[i].length ? [...synth[i], ...lines] : lines));
}

// No bookmarks: fall back to lines set in clearly larger type than the body text.
function guessHeadings(pages, medH) {
  const total = pages.reduce((n, l) => n + l.length, 0);
  const isBig = (l) => l.h > medH * 1.2 && l.text.length < 100 && /[\p{L}]/u.test(l.text) && !/[.,;:]$/.test(l.text);
  const sizes = [...new Set(pages.flat().filter(isBig).map((l) => Math.round(l.h * 2) / 2))].sort((a, b) => b - a).slice(0, 3);
  const marked = pages.flat().filter(isBig).length;
  if (!sizes.length || marked > total * 0.25) return;   // looks like noise, not headings
  pages.forEach((lines) => lines.forEach((l) => {
    if (isBig(l)) l.level = sizes.indexOf(Math.round(l.h * 2) / 2) + 1 || 3;
  }));
}

// Lines that sit clearly apart from the body (a big vertical gap) at the very top or
// bottom of a page: the only lines we ever treat as running headers/footers.
function edgeBlocks(lines) {
  const out = new Set();
  const n = lines.length;
  if (n < 3) return out;
  const big = (a, b) => lines[a].y - lines[b].y > Math.max(lines[a].h, lines[b].h) * 1.6;
  for (const k of [1, 2]) {
    if (big(k - 1, k) && (k === 1 || !big(0, 1))) { for (let i = 0; i < k; i++) out.add(i); break; }
  }
  for (const k of [1, 2]) {
    if (big(n - k - 1, n - k) && (k === 1 || !big(n - 2, n - 1))) { for (let i = n - k; i < n; i++) out.add(i); break; }
  }
  return out;
}

function pagesToText(pages, outline) {
  // 1. Drop running headers/footers: an isolated line at the top or bottom of a page
  //    that repeats (digits ignored) on at least half the pages, and bare page numbers.
  //    Body text is never removed, even if a line happens to repeat.
  const key = (t) => t.toLowerCase().replace(/\d+/g, '#');
  const edge = (lines, i) => i < 2 || i >= lines.length - 2;
  if (pages.length >= 3) {
    const blocks = pages.map(edgeBlocks);
    const seen = new Map();
    pages.forEach((lines, pi) => {
      const keys = new Set();
      lines.forEach((l, i) => { if (blocks[pi].has(i)) keys.add(key(l.text)); });
      keys.forEach((k) => seen.set(k, (seen.get(k) || 0) + 1));
    });
    const need = Math.max(3, Math.ceil(pages.length * 0.5));
    pages = pages.map((lines, pi) =>
      lines.filter((l, i) => !(blocks[pi].has(i) && seen.get(key(l.text)) >= need))
    );
  }
  pages = pages.map((lines) =>
    lines.filter((l, i) => !(edge(lines, i) && PAGE_NUMBER.test(l.text)))
  );

  // 2. Work out what "normal" text looks like, to spot headings.
  const all = pages.flat();
  if (!all.length) return '';
  const hs = all.map((l) => l.h).sort((a, b) => a - b);
  const medH = hs[Math.floor(hs.length / 2)];
  const ws = all.map((l) => l.width).sort((a, b) => a - b);
  const fullW = ws[Math.floor(ws.length * 0.9)];

  if (outline && outline.length) pages = applyOutline(pages, outline);
  else guessHeadings(pages, medH);

  const isHeading = (l) =>
    l.text.length < 120 &&
    ((l.h > medH * 1.15) || (!ENDS_SENTENCE.test(l.text) && l.width < fullW * 0.6 && l.text.length < 80));

  // 3. Join lines into paragraphs (one paragraph per output line).
  const paras = [];
  let buf = '';
  let prev = null;
  const flush = () => { if (buf.trim()) paras.push(buf.trim()); buf = ''; };

  pages.forEach((lines) => {
    lines.forEach((l, i) => {
      if (l.level) {   // a bookmarked / detected section title: its own paragraph, marked as a heading
        flush();
        paras.push('#'.repeat(l.level) + ' ' + l.text);
        prev = { y: l.y, heading: true };
        return;
      }
      const heading = isHeading(l);
      const bullet = BULLET.test(l.text);
      const bigGap = prev && i > 0 && prev.y - l.y > l.h * 1.6;
      if (prev && (heading || prev.heading || bullet || bigGap)) flush();
      let text = bullet ? l.text.replace(BULLET, '') : l.text;
      if (buf) {
        if (/[a-z]-$/.test(buf) && /^[a-z]/.test(text)) buf = buf.slice(0, -1) + text;   // un-hyphenate
        else buf += ' ' + text;
      } else {
        buf = text;
      }
      prev = { y: l.y, heading };
    });
  });
  flush();
  return paras.join('\n');
}

/* ---------------- Word (.docx) ---------------- */
async function extractDocx(buf) {
  const r = await mammoth.convertToHtml({ arrayBuffer: buf });
  const doc = new DOMParser().parseFromString(r.value, 'text/html');
  const out = [];
  const isNote = (el) => /^(footnote|endnote)-/.test(el.id || '');
  const walk = (node) => {
    for (const el of node.children) {
      const tag = el.tagName.toLowerCase();
      if (isNote(el)) continue;
      if (/^h[1-6]$/.test(tag)) {
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (t) out.push('#'.repeat(Number(tag[1])) + ' ' + t);
      } else if (tag === 'ol' || tag === 'ul') {
        if (el.querySelector(':scope > li[id^="footnote-"], :scope > li[id^="endnote-"]')) continue;
        walk(el);
      } else if (['table', 'tbody', 'thead', 'tr', 'td', 'th', 'div', 'blockquote'].includes(tag)) {
        walk(el);
      } else {
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
      }
    }
  };
  walk(doc.body);
  return out.join('\n').trim();
}

/* ---------------- PowerPoint (.pptx) ---------------- */
async function extractPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = async (name) => {
    const f = zip.file(name);
    return f ? new DOMParser().parseFromString(await f.async('string'), 'application/xml') : null;
  };

  // Real slide order lives in presentation.xml; file numbers can be out of order.
  let slideFiles = [];
  const pres = await xml('ppt/presentation.xml');
  const rels = await xml('ppt/_rels/presentation.xml.rels');
  if (pres && rels) {
    const target = {};
    [...rels.getElementsByTagName('Relationship')].forEach((r) => {
      target[r.getAttribute('Id')] = r.getAttribute('Target');
    });
    slideFiles = [...pres.getElementsByTagName('p:sldId')]
      .map((s) => target[s.getAttribute('r:id')])
      .filter(Boolean)
      .map((t) => 'ppt/' + t.replace(/^\/?(ppt\/)?/, ''));
  }
  if (!slideFiles.length) {
    slideFiles = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1], 10) - parseInt(b.match(/(\d+)\.xml/)[1], 10));
  }

  const out = [];
  for (const name of slideFiles) {
    const doc = await xml(name);
    if (!doc) continue;
    const paras = [...doc.getElementsByTagName('a:p')]
      .map((p) => [...p.getElementsByTagName('a:t')].map((t) => t.textContent).join('').trim())
      .filter(Boolean);
    if (paras.length) out.push(paras.join('\n'));
  }
  return out.join('\n');
}

window.__DOCS = {
  async read(file, ext, onProgress) {
    const buf = await readBuffer(file);
    if (ext === 'pdf') return extractPdf(buf, onProgress);
    if (ext === 'docx') return extractDocx(buf);
    if (ext === 'pptx') return extractPptx(buf);
    throw new Error('Unsupported file type: .' + ext);
  },
};
