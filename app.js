const synth = window.speechSynthesis || null;
// Inside the Android app (Capacitor) the WebView has no usable speechSynthesis,
// so we talk to the phone's native text-to-speech plugin instead.
// (tts.js, bundled in only by the APK build, sets window.__TTS; it never throws here.)
const NativeTTS = (function () { try { return window.__TTS || null; } catch (e) { return null; } })();
// Background player (Android app only): a native service speaks the text, so reading keeps going
// with the screen off or the app minimized, with notification + lock screen controls.
// (Registered by the APK build as window.__BG; it is null in a normal browser.)
const BG = (function () { try { return window.__BG || null; } catch (e) { return null; } })();
const hasSpeech = !!(BG || NativeTTS || synth);
let nativeVoices = [];
let speakToken = 0;   // bumps on every cancel so stale 'finished' callbacks are ignored

let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 6000);
}

function cancelSpeech() {
  speakToken++;
  if (BG) { bgCmdAt = Date.now(); bgGen++; BG.pause().catch(() => {}); }
  else if (NativeTTS) { NativeTTS.stop().catch(() => {}); }
  else if (synth) { synth.cancel(); }
}

// ---- elements ----
const setupView = document.getElementById('setup');
const playerView = document.getElementById('player');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const pasteText = document.getElementById('pasteText');
const startBtn = document.getElementById('startBtn');
const setupNote = document.getElementById('setupNote');

const backBtn = document.getElementById('backBtn');
const docTitle = document.getElementById('docTitle');
const settingsBtn = document.getElementById('settingsBtn');
const sentencesEl = document.getElementById('sentences');

const progressFill = document.getElementById('progressFill');
const progressTrack = document.getElementById('progressTrack');
const progressWrap = document.getElementById('progressWrap');
const progressCount = document.getElementById('progressCount');
const progressEta = document.getElementById('progressEta');

const prevBtn = document.getElementById('prevBtn');
const playBtn = document.getElementById('playBtn');
const nextBtn = document.getElementById('nextBtn');
const repeatBtn = document.getElementById('repeatBtn');
const abBtn = document.getElementById('abBtn');
const abText = document.getElementById('abText');
let repeatAll = false;     // start over after the last sentence (not remembered between sessions)
let abA = -1, abB = -1;    // A-B loop, as sentence numbers (-1 = not set)

const scrim = document.getElementById('scrim');
const settingsSheet = document.getElementById('settingsSheet');
const voiceSel = document.getElementById('voiceSel');
const speedRange = document.getElementById('speedRange');
const speedLabel = document.getElementById('speedLabel');
const closeSettings = document.getElementById('closeSettings');
const sizeRange = document.getElementById('sizeRange');
const sizeLabel = document.getElementById('sizeLabel');
const lhRange = document.getElementById('lhRange');
const lhLabel = document.getElementById('lhLabel');
const diag = document.getElementById('diag');
const volumeRange = document.getElementById('volumeRange');
const volumeLabel = document.getElementById('volumeLabel');
const sectionsBtn = document.getElementById('sectionsBtn');
const sectionsSheet = document.getElementById('sectionsSheet');
const sectionsList = document.getElementById('sectionsList');
const recentSheet = document.getElementById('recentSheet');
const recentAllList = document.getElementById('recentAllList');

const ICON_PLAY = '<path d="M7 5v14l12-7z" fill="currentColor"/>';
const ICON_PAUSE = '<rect x="6" y="5" width="4" height="14" fill="currentColor"/><rect x="14" y="5" width="4" height="14" fill="currentColor"/>';

// ---- state ----
let sentences = [];   // { text, el }
let idx = 0;
let playing = false;  // true = we intend continuous playback / auto-advance

// ---- helpers ----
const HAS_WORD = /[\p{L}\p{N}]/u;
const HTML_TAGS = /<\/?(?:br|p|div|span|a|b|i|u|em|strong|sub|sup|small|mark|font|center|details|summary|table|thead|tbody|tr|td|th|ul|ol|li|img|hr)\b[^>]*>/gi;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm;
const SUPERSCRIPT_REF = /(?<=\p{L}{3,}|[.,;:!?)"”’])[⁰¹²³⁴⁵⁶⁷⁸⁹]+(?=\s|[.,;:!?)]|$)/gu;

// run fn on the parts of a string that are not inside `inline code`
function outsideCode(s, fn) {
  return s.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

// footnote markers, citations, rules and other things nobody wants read aloud
function stripNoise(s) {
  s = s
    .replace(/<sup>[^<\n]*<\/sup>/gi, '')                                          // <sup>4</sup>
    .replace(HTML_TAGS, '')
    .replace(/^[ \t]*\[\^[^\]\n]+\]:.*(?:\n(?:[ \t]{2,}|\t).*)*/gm, '')            // [^4]: footnote text
    .replace(/^[ \t]*\[[^\]\n]+\]:[ \t]*(?:https?:\/\/|www\.|<)\S*.*$/gm, '')       // [1]: http://link-definition
    .replace(/^[ \t]*(?:[-*_=][ \t]*){3,}$/gm, '')                                  // --- *** ___ rules
    .replace(TABLE_RULE, '');                                                       // |---|---| table rules
  return outsideCode(s, (p) => p
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')                                   // [text][ref] -> text
    .replace(/[ \t]*\[\^[^\]\n]+\]/g, '')                                           // [^4]
    .replace(/[ \t]*\[\s*(?:citation needed|clarification needed)\s*\]/gi, '')
    .replace(/[ \t]*\[\d{1,3}(?:[ \t]*[-–,][ \t]*\d{1,3})*\](?!\()/g, '')           // [4]  [1,2]  [3-5]
    .replace(SUPERSCRIPT_REF, ''));                                                 // word⁴
}

// Headings ("# Title") are kept as markers so the player can build its section list.
function stripMarkdown(s) {
  s = s.replace(/```[\s\S]*?```/g, '');
  s = stripNoise(s);
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/==(?=\S)([^=\n]*?\S)==/g, '$1')   // ==highlight== -> highlight
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')   // [[wiki|label]] -> label
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    .replace(/[*_~>]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Turns cleaned text into [{ text, level? }]: headings become their own entries.
function parseBlocks(text) {
  const out = [];
  let chunk = [];
  const flushChunk = () => {
    if (chunk.length) splitSentences(chunk.join('\n')).forEach((t) => out.push({ text: t }));
    chunk = [];
  };
  text.split('\n').forEach((line) => {
    const m = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
    if (m) {
      flushChunk();
      const title = m[2].trim();
      if (HAS_WORD.test(title)) out.push({ text: title, level: m[1].length });
    } else {
      chunk.push(line);
    }
  });
  flushChunk();
  return out.filter((b) => HAS_WORD.test(b.text));   // drop lines with nothing speakable
}

/**
 * splitSentences(text)
 *
 * Splits text into an array of sentences — built for feeding a
 * text-to-speech / "read aloud" pipeline one sentence at a time.
 *
 * KEY DESIGN CHANGE from a fragment-matching regex:
 * Instead of using String.match() to pull sentence-shaped fragments out
 * (which can silently SKIP a character position if no alternative matches
 * there — this is very likely what caused your "disappearing sentence"
 * bug), this version finds each sentence-boundary position with a regex,
 * then SLICES the original string between boundaries. Slicing guarantees
 * every character in the input ends up in the output somewhere — text
 * cannot vanish, it can only end up in the wrong place.
 *
 * Protected from being mistaken for a sentence end:
 *  - Common abbreviations (Mr., Dr., vs., etc., e.g., i.e., a.m./p.m., U.S., U.K., ...)
 *  - Initials (J.K. Rowling, A. Smith)
 *  - Decimals, version numbers, times, IPs (3.14, v2.0.1, 10.30, 192.168.0.1)
 *  - URLs and emails (including query strings / paths with . ? ! in them)
 *  - Bare domains (example.com, site.co.uk, mysite.ng)
 *  - Markdown links/images ([label](url "title")), inline code `like.this()`,
 *    and fenced ``` code blocks ```
 *  - Numbered-list markers at the start of a line ("1. Item")
 *
 * Also normalizes missing whitespace after real terminal punctuation
 * ("end.Next" -> "end. Next") so typo run-ons don't merge two sentences.
 *
 * Known limitations (inherent to any regex-based splitter, not just this one):
 *  - A single capital letter that legitimately ends a sentence right before
 *    another capitalized word ("Turn left at Point A. Then continue.") can
 *    be mistaken for an initial and left unsplit. True disambiguation needs
 *    an NLP sentence tokenizer, not regex.
 *  - Nested dialogue with multiple sentences inside one quote
 *    (`He said, "Wait. Stop. Now."`) will still split at each internal
 *    period — this mirrors the original behavior and is a design choice,
 *    not a bug; merge them yourself downstream if you want the whole quote
 *    read as one unit.
 */
function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];

  // Placeholders that contain none of . ! ? so they're invisible to the
  // boundary regex below. Restored to real punctuation at the very end.
  const maskPunct = (s) =>
    s.replace(/\./g, '\u0001').replace(/\?/g, '\u0002').replace(/!/g, '\u0003');
  const unmaskPunct = (s) =>
    s.replace(/\u0001/g, '.').replace(/\u0002/g, '?').replace(/\u0003/g, '!');

  // For URL-like matches: strip trailing punctuation FIRST so a real
  // sentence-ending character right after the URL still works, then mask
  // only the "core" of the match.
  const maskCoreKeepTrail = (match) => {
    const trailMatch = match.match(/[.,!?;:'"”’)\]]+$/);
    const trail = trailMatch ? trailMatch[0] : '';
    const core = trail ? match.slice(0, -trail.length) : match;
    return maskPunct(core) + trail;
  };

  let t = text;

  // --- Markdown-specific protection (safe to leave in even for plain text) ---
  t = t.replace(/```[\s\S]*?```/g, (m) => maskPunct(m));           // fenced code blocks
  t = t.replace(/`[^`\n]+`/g, (m) => maskPunct(m));                // inline code
  t = t.replace(/\]\(([^)]+)\)/g, (m, inner) => `](${maskPunct(inner)})`); // link/image target

  // --- URLs, emails, domains (handles query strings, so a "?" in a URL
  //     is no longer mistaken for a sentence end) ---
  t = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, maskCoreKeepTrail);
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, (m) => maskPunct(m));
  t = t.replace(
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|ng|gov|edu|info|biz|ai|dev|app|xyz|co\.uk|co\.ng|org\.ng|gov\.ng)(?:\/\S*)?\b/gi,
    maskCoreKeepTrail
  );

  // --- Decimals, version numbers, times, IPs ---
  t = t.replace(/\b\d+(?:\.\d+)+\b/g, (m) => maskPunct(m));

  // --- Abbreviations that already contain internal periods (longest first,
  //     so "U.S.A." isn't cut short by a "U.S." match) ---
  const dottedAbbrevs = [
    'U\\.S\\.A\\.', 'U\\.S\\.', 'U\\.K\\.', 'U\\.N\\.',
    'e\\.g\\.', 'i\\.e\\.', 'cf\\.', 'viz\\.',
    'a\\.m\\.', 'p\\.m\\.', 'A\\.M\\.', 'P\\.M\\.',
  ];
  t = t.replace(new RegExp('\\b(?:' + dottedAbbrevs.join('|') + ')', 'g'), (m) => maskPunct(m));

  // --- Abbreviations with a single trailing period ---
  const simpleAbbrevs = [
    'Mr','Mrs','Ms','Mx','Dr','Prof','Sr','Jr','St','Rev','Gen','Sgt','Col','Lt','Capt','Fr','Hon',
    'vs','etc','approx','dept','univ','al',
    'Jan','Feb','Mar','Apr','Jun','Jul','Aug','Sep','Sept','Oct','Nov','Dec',
    'Mon','Tue','Tues','Wed','Thu','Thur','Thurs','Fri','Sat','Sun',
    'Vol','pp','fig','Fig','ch','Ch','sec','Sec','para','Para',
  ];
  t = t.replace(new RegExp('\\b(' + simpleAbbrevs.join('|') + ')\\.', 'g'), (m) => maskPunct(m));

  // --- Initials: "J.K. Rowling", "A. Smith" ---
  t = t.replace(/\b([A-Z])\.(?=[A-Z]\.)/g, (m) => maskPunct(m));      // first of a run: "J."
  t = t.replace(/\b([A-Z])\.(?=\s[A-Z][a-z])/g, (m) => maskPunct(m)); // last before a name: "K." / "A."

  // --- Numbered-list markers at the start of a line: "1. Item" ---
  t = t.replace(/^(\s*\d+)\.(?=\s+\S)/gm, (m) => maskPunct(m));

  // --- Fix missing whitespace after a REAL terminal punctuation mark, so
  //     typo run-ons don't merge two sentences into one ("end.Next" -> "end. Next") ---
  t = t.replace(/([.!?])(["'”’»)\]]*)([A-Z])/g, (m, p1, quote, cap) => `${p1}${quote} ${cap}`);

  // --- Split into paragraphs, then slice each into sentences by boundary ---
  const paragraphs = t.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  const boundaryRe = /[.!?]+(?:["'”’»)\]]*)?(?=\s|$)/g;

  paragraphs.forEach((para) => {
    let start = 0;
    let m;
    boundaryRe.lastIndex = 0;
    while ((m = boundaryRe.exec(para)) !== null) {
      const end = m.index + m[0].length;
      const sentence = unmaskPunct(para.slice(start, end)).trim();
      if (sentence) out.push(sentence);
      start = end;
    }
    // Anything left over (no terminal punctuation at all) is still captured
    // here — this is what guarantees no text can silently disappear.
    const rest = unmaskPunct(para.slice(start)).trim();
    if (rest) out.push(rest);
  });

  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { splitSentences };
}


function wordCount(s) { return (s.match(/\S+/g) || []).length; }

// ---- voices ----
function populateVoices() {
  if (!hasSpeech) { reportDiag(); return; }
  const voices = NativeTTS ? nativeVoices : synth.getVoices();
  const current = voiceSel.value;
  voiceSel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'System default';
  voiceSel.appendChild(def);
  voices.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = i;
    o.textContent = `${v.name} (${v.lang})`;
    voiceSel.appendChild(o);
  });
  if (current) voiceSel.value = current;
  reportDiag();
}

function reportDiag() {
  const voices = NativeTTS ? nativeVoices : (synth ? synth.getVoices() : []);
  const engine = NativeTTS ? 'native (Android)' : (synth ? 'browser' : 'missing');
  diag.textContent = `speech engine: ${engine}\nvoices reported: ${voices.length}`;
}

if (NativeTTS) {
  // The phone's engine can still be starting up, or may not list voices at all
  // (it then reports null). Retry a few times, then carry on with the default voice.
  const loadNativeVoices = (attempt) => {
    NativeTTS.getSupportedVoices()
      .then((r) => {
        nativeVoices = (r && r.voices) || [];
        populateVoices();
        setupNote.textContent = nativeVoices.length
          ? `Voice engine: phone speech · ${nativeVoices.length} voices found`
          : 'Voice engine: phone speech · default voice';
      })
      .catch(() => {
        if (attempt < 4) { setTimeout(() => loadNativeVoices(attempt + 1), 800); return; }
        nativeVoices = [];
        populateVoices();
        setupNote.textContent = 'Voice engine: phone speech · default voice (no voice list)';
      });
  };
  loadNativeVoices(0);
} else if (synth) {
  synth.getVoices();
  synth.addEventListener('voiceschanged', populateVoices);
} else {
  setupNote.textContent = 'This browser has no built-in speech engine — try opening this file in Chrome.';
}
populateVoices();

// ---- sliders: speed + volume ----
function paintRange(el) {
  const min = parseFloat(el.min) || 0, max = parseFloat(el.max) || 1;
  el.style.setProperty('--pct', ((parseFloat(el.value) - min) / (max - min)) * 100 + '%');
}

function showSpeed() {
  speedLabel.textContent = parseFloat(speedRange.value).toFixed(2) + 'x';
  paintRange(speedRange);
}
try { const sv = localStorage.getItem('reader.speed'); if (sv) speedRange.value = sv; } catch (e) {}
showSpeed();
speedRange.addEventListener('input', showSpeed);

// In the Android app, volume is the phone's real media volume (window.__VOL, set by the
// bundled native plugin) and follows the hardware buttons. In a plain browser the page
// cannot touch system volume, so the slider sets this reader's own speech volume instead.
const VOL = (function () { try { return window.__VOL || null; } catch (e) { return null; } })();
let volDragging = false;

function showVolume() {
  volumeLabel.textContent = Math.round((volumeRange.value / volumeRange.max) * 100) + '%';
  paintRange(volumeRange);
}
function currentVolume() { return volumeRange.value / volumeRange.max; }   // 0..1

async function syncVolume() {
  if (!VOL || volDragging) return;
  try {
    const r = await VOL.getVolume();
    if (r && r.max > 0) { volumeRange.max = r.max; volumeRange.value = r.level; showVolume(); }
  } catch (e) {}
}

if (!VOL) {
  try { const vv = localStorage.getItem('reader.volume'); if (vv !== null) volumeRange.value = vv; } catch (e) {}
}
showVolume();
volumeRange.addEventListener('input', () => {
  showVolume();
  if (VOL) VOL.setVolume({ level: parseInt(volumeRange.value, 10) }).catch(() => {});
  else { try { localStorage.setItem('reader.volume', volumeRange.value); } catch (e) {} }
});
volumeRange.addEventListener('pointerdown', () => { volDragging = true; });
['pointerup', 'pointercancel'].forEach((evt) => window.addEventListener(evt, () => {
  if (volDragging) { volDragging = false; syncVolume(); }
}));
if (VOL) {
  syncVolume();
  setInterval(() => { if (playerView.classList.contains('active')) syncVolume(); }, 500);   // follows hardware buttons
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncVolume(); });
}

// ---- recent files (kept on this phone, with your reading position) ----
const RECENT_KEY = 'reader.recent', POS_KEY = 'reader.pos';
const MIN_KEEP = 10, MAX_KEEP = 30;   // always keep at least 10; up to 30 while space allows
let recent = [], positions = {}, currentId = null, recentExpanded = false;

try { const r = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); if (Array.isArray(r)) recent = r; } catch (e) {}
try { positions = JSON.parse(localStorage.getItem(POS_KEY) || '{}') || {}; } catch (e) {}

function hashText(t) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '-' + t.length;
}
function titleFor(text) {
  const first = (text.split('\n').find(l => l.trim()) || '').trim().replace(/^#{1,6}\s+/, '');
  return first.length > 48 ? first.slice(0, 47) + '…' : (first || 'Pasted note');
}
function persistPositions() {
  const ids = new Set(recent.map(r => r.id));
  Object.keys(positions).forEach(k => { if (!ids.has(k)) delete positions[k]; });
  try { localStorage.setItem(POS_KEY, JSON.stringify(positions)); } catch (e) {}
}
function persistRecent() {
  while (recent.length > MAX_KEEP) recent.pop();
  for (;;) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); return; }
    catch (e) {
      if (recent.length <= MIN_KEEP) { showToast('Could not save to Recent: phone storage is full.'); return; }
      recent.pop();   // storage full: drop the oldest, but never below the minimum
    }
  }
}
function savePos() {
  if (!currentId) return;
  positions[currentId] = idx;
  try { localStorage.setItem(POS_KEY, JSON.stringify(positions)); } catch (e) {}
}
function saveRecent(name, text, n) {
  const fromFile = !!name && name !== 'Untitled';
  const hash = hashText(text);
  const id = fromFile ? 'f:' + name : 'p:' + hash;
  const old = recent.find(r => r.id === id);
  recent = recent.filter(r => r.id !== id);
  recent.unshift({ id, name: fromFile ? name : titleFor(text), text, hash, words: wordCount(text), n, updated: Date.now() });
  if (old && old.hash !== hash) positions[id] = 0;   // file changed: start over
  persistRecent();
  persistPositions();
  return id;
}

const recentSection = document.getElementById('recent');
const recentList = document.getElementById('recentList');
const recentToggle = document.getElementById('recentToggle');

function buildRecentItem(r, inSheet) {
  const pos = positions[r.id] || 0;
  const pct = r.n > 1 ? Math.round((pos / (r.n - 1)) * 100) : 0;
  const li = document.createElement('li');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'recent-open';
  const title = document.createElement('span');
  title.className = 'recent-title';
  title.textContent = r.name;
  const meta = document.createElement('span');
  meta.className = 'recent-meta';
  meta.textContent = `${r.words.toLocaleString()} words · ${pct}%`;
  const bar = document.createElement('span');
  bar.className = 'recent-bar';
  const fill = document.createElement('span');
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  open.append(title, meta, bar);
  open.addEventListener('click', () => { if (inSheet) closeSheets(); openRecent(r.id); });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'recent-del';
  del.setAttribute('aria-label', 'Remove ' + r.name);
  del.textContent = '×';
  del.addEventListener('click', () => {
    recent = recent.filter(x => x.id !== r.id);
    persistRecent();
    persistPositions();
    renderRecent();
  });

  li.append(open, del);
  return li;
}

function fillRecent(ul, items, inSheet) {
  ul.innerHTML = '';
  items.forEach((r) => ul.appendChild(buildRecentItem(r, inSheet)));
}

function renderRecent() {
  recentSection.hidden = recent.length === 0;
  fillRecent(recentList, recent.slice(0, 3), false);
  recentToggle.hidden = recent.length <= 3;
  recentToggle.textContent = `All (${recent.length})`;
  if (recentSheet.classList.contains('open')) {
    if (recent.length) fillRecent(recentAllList, recent, true); else closeSheets();
  }
}

function openRecent(id) {
  const r = recent.find(x => x.id === id);
  if (!r) return;
  loadedName = id.startsWith('f:') ? r.name : 'Untitled';
  pasteText.value = r.text;
  startBtn.disabled = false;
  let p = positions[id] || 0;
  if (p >= r.n - 1) p = 0;   // finished last time: start from the top
  buildPlayer(r.text, p);
}

recentToggle.addEventListener('click', () => { fillRecent(recentAllList, recent, true); openSheet(recentSheet); });

// ---- setup view: loading text ----
function setSourceText(raw, label) {
  const cleaned = stripMarkdown(raw);
  pasteText.value = cleaned;
  startBtn.disabled = !cleaned.trim();
  setupNote.textContent = cleaned.trim() ? `Loaded ${wordCount(cleaned)} words${label ? ' from ' + label : ''}.` : '';
}

pasteText.addEventListener('input', () => {
  startBtn.disabled = !pasteText.value.trim();
  loadedName = 'Untitled';
});

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => loadFile(e.target.files[0]));
['dragenter', 'dragover'].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
['dragleave', 'drop'].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
dropzone.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

let loadedName = 'Untitled';
renderRecent();

async function loadDocument(f, ext) {
  if (!window.__DOCS) {
    setupNote.textContent = 'PDF, Word and PowerPoint files can be read in the Android app version.';
    return;
  }
  setupNote.textContent = 'Reading file…';
  try {
    const text = await window.__DOCS.read(f, ext, (p, n) => { setupNote.textContent = `Reading page ${p} of ${n}…`; });
    if (!text || !text.trim()) {
      setupNote.textContent = ext === 'pdf'
        ? 'No readable text found. This PDF may be scanned images.'
        : 'No readable text found in that file.';
      return;
    }
    setSourceText(text, f.name);
  } catch (err) {
    setupNote.textContent = 'Could not read that file: ' + ((err && err.message) || err);
  }
}

function loadFile(f) {
  if (!f) return;
  loadedName = f.name;
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || ext === 'docx' || ext === 'pptx') { loadDocument(f, ext); return; }
  if (ext === 'doc' || ext === 'ppt') {
    setupNote.textContent = `Old .${ext} files can't be read. Open it, save it as .${ext}x, then add it again.`;
    return;
  }
  const r = new FileReader();
  r.onload = () => setSourceText(r.result, f.name);
  r.onerror = () => { setupNote.textContent = 'Could not read that file. Try pasting the text instead.'; };
  r.readAsText(f);
}

startBtn.addEventListener('click', () => {
  if (!pasteText.value.trim()) return;
  buildPlayer(pasteText.value);
});

// ---- building the player ----
function buildPlayer(rawText, startIdx) {
  const text = stripMarkdown(rawText);   // idempotent: also tidies notes saved by older versions
  const blocks = parseBlocks(text);
  if (!blocks.length) { setupNote.textContent = 'Nothing readable in that text.'; return; }
  sentences = blocks.map(b => ({ text: b.text, level: b.level || 0, el: null }));
  resetLoops();
  idx = Math.max(0, Math.min(sentences.length - 1, startIdx || 0));
  playing = false;
  currentId = saveRecent(loadedName, text, sentences.length);

  sentencesEl.innerHTML = '';
  sentences.forEach((s, i) => {
    const div = document.createElement('div');
    div.className = 'sentence' + (s.level ? ' heading h' + Math.min(s.level, 3) : '');
    div.textContent = s.text;
    div.addEventListener('click', () => jumpTo(i, true));
    sentencesEl.appendChild(div);
    s.el = div;
  });

  buildSections();
  docTitle.textContent = loadedName !== 'Untitled' ? loadedName : `${sentences.length} sentences`;
  updateHighlight();
  updateProgress();
  setPlayingUI(false);

  setupView.classList.remove('active');
  playerView.classList.add('active');
  if (idx > 0) requestAnimationFrame(() => updateHighlight(true));
}

backBtn.addEventListener('click', () => {
  stopPlayback();
  playerView.classList.remove('active');
  setupView.classList.add('active');
  renderRecent();
});

// ---- background player glue (Android app) ----
let bgCmdAt = 0;          // time of our last command, so a late status reply can't undo it
let bgGen = 0;            // numbers our play requests; phone-side changes use -1
let bgLoadedFor = null;   // which sentences array the phone side currently holds

async function bgEnsureText() {
  if (bgLoadedFor === sentences) return;
  const texts = sentences.map((s) => s.text);
  const CH = 800;
  for (let k = 0; k < texts.length; k += CH) {
    await BG.setText({ texts: texts.slice(k, k + CH), reset: k === 0 });
  }
  bgLoadedFor = sentences;
}

async function bgPlay(i) {
  const myGen = ++bgGen;
  bgCmdAt = Date.now();
  try {
    await bgEnsureText();
    if (myGen !== bgGen || !playing) return;   // user already did something else
    const v = nativeVoices[voiceSel.value];
    bgCmdAt = Date.now();
    await BG.play({
      index: i,
      gen: myGen,
      rate: parseFloat(speedRange.value),
      voice: v ? (v.voiceURI || v.name || '') : '',
      lang: (v && v.lang) || 'en-US',
      loopA: loopRange().a,
      loopB: loopRange().b,
      repeat: repeatAll,
      title: loadedName !== 'Untitled' ? loadedName : 'Reader'
    });
  } catch (err) {
    if (myGen !== bgGen) return;
    playing = false; setPlayingUI(false);
    showToast('Could not play: ' + ((err && err.message) || err));
  }
}

// Pull the phone side's position/state (it may have moved on while the screen was off).
async function bgSync() {
  if (!BG || bgLoadedFor !== sentences || Date.now() - bgCmdAt < 1500) return;
  try {
    const s = await BG.getState();
    if (Date.now() - bgCmdAt < 1500) return;
    if (s.active && s.count === sentences.length) {
      if (s.index !== idx && s.index >= 0 && s.index < sentences.length) {
        idx = s.index; updateHighlight(true); updateProgress();
      }
      if (s.playing !== playing) { playing = s.playing; setPlayingUI(playing); }
    } else if (playing && !s.active) {
      playing = false; setPlayingUI(false);   // service ended while we were away
    }
  } catch (e) {}
}

if (BG) {
  // sentence changes (and notification/lock screen buttons) while the app is open
  BG.addListener('sentence', (e) => {
    if (e.gen !== -1 && e.gen !== bgGen) return;   // late event from something we already replaced
    if (e.index !== idx && e.index >= 0 && e.index < sentences.length) {
      idx = e.index; updateHighlight(); updateProgress();
    }
  });
  BG.addListener('state', (e) => {
    if (e.index !== idx && e.index >= 0 && e.index < sentences.length) {
      idx = e.index; updateHighlight(); updateProgress();
    }
    playing = !!e.playing;
    setPlayingUI(playing);
  });
  BG.addListener('error', (e) => { showToast('Speech error: ' + (e && e.message)); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) bgSync(); });
  window.addEventListener('focus', bgSync);
  setInterval(() => { if (!document.hidden && playerView.classList.contains('active')) bgSync(); }, 1000);
}

// ---- playback core (sentence-queue, never relies on native pause/resume) ----
function speakSentence(i) {
  if (!hasSpeech) return;
  if (i < 0) i = 0;
  if (i >= sentences.length) { playing = false; setPlayingUI(false); return; }
  idx = i;
  updateHighlight();
  updateProgress();

  if (BG) {
    bgPlay(i);
    return;
  }

  if (NativeTTS) {
    const token = ++speakToken;
    const opts = { text: sentences[i].text, rate: parseFloat(speedRange.value), lang: 'en-US' };
    if (!VOL) opts.volume = currentVolume();
    const vIdx = voiceSel.value;
    if (vIdx !== '' && nativeVoices[vIdx]) { opts.voice = Number(vIdx); opts.lang = nativeVoices[vIdx].lang || opts.lang; }
    NativeTTS.speak(opts)
      .then(() => { if (token === speakToken && playing) speakSentence(nextAfter(idx)); })
      .catch((err) => {
        if (token !== speakToken) return;
        playing = false; setPlayingUI(false);
        showToast('Speech error: ' + ((err && err.message) || err));
      });
    return;
  }

  synth.cancel();
  const u = new SpeechSynthesisUtterance(sentences[i].text);
  u.rate = parseFloat(speedRange.value);
  u.volume = currentVolume();
  const vIdx = voiceSel.value;
  if (vIdx !== '') u.voice = synth.getVoices()[vIdx];

  u.onend = () => { if (playing) speakSentence(nextAfter(idx)); };
  u.onerror = () => { setPlayingUI(false); };
  synth.speak(u);
}

function play() {
  if (!hasSpeech) { setupNote.textContent = 'No speech engine available.'; return; }
  playing = true;
  setPlayingUI(true);
  speakSentence(idx);
}

function pausePlayback() {
  playing = false;
  cancelSpeech(); // cancel, don't rely on the unreliable native pause()
  setPlayingUI(false);
}

function stopPlayback() {
  playing = false;
  cancelSpeech();
  if (BG) { bgCmdAt = Date.now(); BG.stop().catch(() => {}); }
  idx = 0;
  setPlayingUI(false);
}

function jumpTo(i, autoplay) {
  idx = Math.max(0, Math.min(sentences.length - 1, i));
  if (autoplay) { playing = true; setPlayingUI(true); speakSentence(idx); }
  else { cancelSpeech(); updateHighlight(); updateProgress(); }
}

// ---- repeat file / A-B loop ----
function loopRange() { return (abA >= 0 && abB >= abA) ? { a: abA, b: abB } : { a: -1, b: -1 }; }

// Which sentence comes after i: back to A at the end of an A-B loop, back to 1 at the end of the file if Repeat is on.
function nextAfter(i) {
  if (abA >= 0 && abB >= abA && i === abB) return abA;
  if (i + 1 >= sentences.length && repeatAll) return 0;
  return i + 1;
}

function loopButtonsUI() {
  repeatBtn.classList.toggle('on', repeatAll);
  repeatBtn.setAttribute('aria-pressed', String(repeatAll));
  abBtn.classList.toggle('on', abA >= 0);
  abBtn.setAttribute('aria-pressed', String(abA >= 0));
  abText.textContent = abA < 0 ? 'A-B' : (abB < 0 ? 'A-?' : 'A-B');
}

function paintLoop() {
  sentences.forEach((s, i) => {
    if (!s.el) return;
    const c = s.el.classList;
    c.toggle('ab-a', i === abA);
    c.toggle('ab-b', i === abB);
    c.toggle('ab-in', abA >= 0 && abB >= 0 && i > abA && i < abB);
  });
  loopButtonsUI();
}

function resetLoops() { abA = -1; abB = -1; loopButtonsUI(); }

function pushLoop() {
  if (!BG) return;
  const r = loopRange();
  BG.setLoop({ a: r.a, b: r.b, repeat: repeatAll }).catch(() => {});
}

repeatBtn.addEventListener('click', () => {
  repeatAll = !repeatAll;
  loopButtonsUI();
  pushLoop();
  showToast(repeatAll ? 'Repeat file: on' : 'Repeat file: off');
});

abBtn.addEventListener('click', () => {
  if (!sentences.length) return;
  if (abA < 0) {
    abA = idx; abB = -1;
    showToast('Loop start (A) set. Tap again to set the end (B).');
  } else if (abB < 0) {
    if (idx < abA) { abB = abA; abA = idx; } else { abB = idx; }
    showToast('Looping sentences ' + (abA + 1) + ' to ' + (abB + 1));
  } else {
    abA = -1; abB = -1;
    showToast('Loop cleared');
  }
  paintLoop();
  pushLoop();
});

playBtn.addEventListener('click', () => { playing ? pausePlayback() : play(); });
prevBtn.addEventListener('click', () => jumpTo(idx - 1, playing));
nextBtn.addEventListener('click', () => jumpTo(idx + 1, playing));

// ---- drag to scrub (tap still jumps) ----
const scrubPreview = document.getElementById('scrubPreview');
let scrubbing = false;
let resumeAfterScrub = false;

function scrubTo(clientX) {
  if (!sentences.length) return;
  const rect = progressTrack.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const i = Math.round(ratio * (sentences.length - 1));
  if (i !== idx) {
    idx = i;
    updateHighlight(true);
    updateProgress();
  }
  scrubPreview.querySelector('.scrub-count').textContent = `${idx + 1} / ${sentences.length}`;
  scrubPreview.querySelector('.scrub-text').textContent = sentences[idx].text;
}

progressWrap.addEventListener('pointerdown', (e) => {
  if (!sentences.length || (e.pointerType === 'mouse' && e.button !== 0)) return;
  scrubbing = true;
  resumeAfterScrub = playing;
  playing = false;                 // stop auto-advance while the finger is down
  cancelSpeech();
  progressWrap.setPointerCapture(e.pointerId);
  progressWrap.classList.add('scrubbing');
  scrubPreview.classList.add('show');
  scrubTo(e.clientX);
});

progressWrap.addEventListener('pointermove', (e) => { if (scrubbing) scrubTo(e.clientX); });

function endScrub(e, commit) {
  if (!scrubbing) return;
  scrubbing = false;
  progressWrap.classList.remove('scrubbing');
  scrubPreview.classList.remove('show');
  if (commit) scrubTo(e.clientX);
  if (resumeAfterScrub) { playing = true; speakSentence(idx); }
  resumeAfterScrub = false;
}
progressWrap.addEventListener('pointerup', (e) => endScrub(e, true));
progressWrap.addEventListener('pointercancel', (e) => endScrub(e, false));

// ---- UI updates ----
function setPlayingUI(isPlaying) {
  const iconSvg = playBtn.querySelector('svg');
  if (iconSvg) {
    iconSvg.innerHTML = isPlaying ? ICON_PAUSE : ICON_PLAY;
  }
}

function updateHighlight(instant) {
  sentences.forEach((s, i) => s.el.classList.toggle('current', i === idx));
  const cur = sentences[idx];
  if (cur) cur.el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
}

function updateProgress() {
  const total = sentences.length || 1;
  progressFill.style.width = `${(idx / Math.max(1, total - 1)) * 100}%`;
  progressCount.textContent = `${Math.min(idx + 1, total)} / ${total}`;
  savePos();

  const wordsTotal = sentences.reduce((n, s) => n + wordCount(s.text), 0);
  const wordsDone = sentences.slice(0, idx).reduce((n, s) => n + wordCount(s.text), 0);
  const wordsLeft = Math.max(0, wordsTotal - wordsDone);
  const speed = parseFloat(speedRange.value) || 1;
  const minsLeft = wordsLeft / (155 * speed);
  progressEta.textContent = minsLeft < 1 ? '< 1 min left' : `~${Math.round(minsLeft)} min left`;
}

// ---- settings sheet ----
function openSheet(el) { el.classList.add('open'); scrim.classList.add('open'); }
function closeSheets() {
  document.querySelectorAll('.sheet.open').forEach((el) => el.classList.remove('open'));
  scrim.classList.remove('open');
}
settingsBtn.addEventListener('click', () => openSheet(settingsSheet));
closeSettings.addEventListener('click', closeSheets);
document.querySelectorAll('[data-close-sheet]').forEach((b) => b.addEventListener('click', closeSheets));
scrim.addEventListener('click', closeSheets);

speedRange.addEventListener('change', () => {
  try { localStorage.setItem('reader.speed', speedRange.value); } catch (e) {}
  if (playing) speakSentence(idx); else updateProgress();
});

// ---- jump to section (markdown headings, PDF table of contents, Word headings) ----
let sections = [];
function buildSections() {
  sections = [];
  sentences.forEach((s, i) => { if (s.level) sections.push({ i, level: s.level, title: s.text }); });
  sectionsBtn.hidden = sections.length === 0;
}
function openSections() {
  if (!sections.length) return;
  const base = Math.min(...sections.map((x) => x.level));
  let cur = -1;
  sections.forEach((x, k) => { if (x.i <= idx) cur = k; });
  sectionsList.innerHTML = '';
  sections.forEach((x, k) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sec-item' + (k === cur ? ' current' : '');
    b.style.paddingLeft = (14 + Math.min(x.level - base, 4) * 16) + 'px';
    b.textContent = x.title;
    b.addEventListener('click', () => { closeSheets(); jumpTo(x.i, playing); });
    sectionsList.appendChild(b);
  });
  openSheet(sectionsSheet);
  const el = sectionsList.children[cur];
  sectionsList.scrollTop = el ? Math.max(0, el.offsetTop - sectionsList.clientHeight / 2 + el.offsetHeight / 2) : 0;
}
sectionsBtn.addEventListener('click', openSections);
voiceSel.addEventListener('change', () => { if (playing) speakSentence(idx); });

// ---- text size & line spacing ----
function applyTextPrefs(save) {
  const size = parseFloat(sizeRange.value);
  const lh = parseFloat(lhRange.value);
  sentencesEl.style.setProperty('--read-size', size + 'rem');
  sentencesEl.style.setProperty('--read-lh', lh);
  paintRange(sizeRange); paintRange(lhRange);
  sizeLabel.textContent = size.toFixed(2);
  lhLabel.textContent = lh.toFixed(2);
  if (save) {
    try { localStorage.setItem('reader.textPrefs', JSON.stringify({ size, lh })); } catch (e) {}
    const cur = sentences[idx];
    if (cur && cur.el) cur.el.scrollIntoView({ block: 'center' });
  }
}
try {
  const saved = JSON.parse(localStorage.getItem('reader.textPrefs') || 'null');
  if (saved) { sizeRange.value = saved.size; lhRange.value = saved.lh; }
} catch (e) {}
sizeRange.addEventListener('input', () => applyTextPrefs(true));
lhRange.addEventListener('input', () => applyTextPrefs(true));
applyTextPrefs(false);
