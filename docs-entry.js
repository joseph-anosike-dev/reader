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
  return pagesToText(pages);
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

function pagesToText(pages) {
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
  const r = await mammoth.extractRawText({ arrayBuffer: buf });
  return r.value.replace(/\n{2,}/g, '\n').trim();
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
