// PaperPeek：双页阅读 + 悬停预览引用 / 图 / 公式
// 导入顺序有讲究：pdf.mjs 先执行并设置 globalThis.pdfjsLib，后两个模块才能用。
import * as pdfjsLib from './vendor/pdfjs/build/pdf.mjs';
import { EventBus, PDFViewer, PDFLinkService, PDFFindController, FindState, LinkTarget } from './vendor/pdfjs/web/pdf_viewer.mjs';
import { PaperModel } from './preview.js';

const BASE = new URL('./vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + 'build/pdf.worker.mjs';

// 文字层（选区、搜索高亮用的透明文字）固定用西文字体。否则在中文系统上通用字体会被解析成
// 苹方/雅黑：字宽比例和论文字体差得多，行框也更高，高亮会错位、溢出到下一行。
const fontMap = pdfjsLib.TextLayer.fontFamilyMap;
fontMap.set('sans-serif', 'Helvetica, Arial, sans-serif');
fontMap.set('serif', '"Times New Roman", Times, serif');
fontMap.set('monospace', 'Menlo, Consolas, "Courier New", monospace');

const $ = id => document.getElementById(id);
const container = $('viewerContainer');
const popup = $('popup');
const popupBody = popup.querySelector('.pv-body');
const IS_EXTENSION = location.protocol === 'chrome-extension:' || location.protocol === 'moz-extension:';
const IS_LOCAL_SERVER = /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const i18n = globalThis.PaperPeekI18n; // 由 viewer.html 里的 i18n.js 提供
const t = i18n.t;

// ---------------------------------------------------------------- 偏好

const PREF_KEY = 'paperpeek.prefs';
const prefs = { spread: 1, scale: 'page-fit', sidebar: false };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch {}
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch {} };

// ---------------------------------------------------------------- pdf.js 组件

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer' });
const findController = new PDFFindController({ eventBus, linkService });
const viewer = new PDFViewer({
  container,
  viewer: $('viewer'),
  eventBus,
  linkService,
  findController,
  textLayerMode: 1,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE,
  imageResourcesPath: BASE + 'web/images/',
});
linkService.setViewer(viewer);

let pdf = null;
let model = null;
let loadingTask = null;
let openSeq = 0;
let docName = 'document.pdf'; // 下载时用的文件名

// ---------------------------------------------------------------- 打开文档

function setProgress(v) {
  const bar = $('progressBar');
  if (v == null || v >= 1) { bar.style.width = '100%'; bar.style.opacity = '0'; return; }
  bar.style.opacity = '1';
  bar.style.width = Math.max(2, v * 100) + '%';
}

let toastTimer = 0;
function toast(msg, ms = 4500) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

async function openDocument(src, label) {
  const seq = ++openSeq;
  hidePopup();
  setProgress(0.02);
  const task = pdfjsLib.getDocument({
    ...src,
    cMapUrl: BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: BASE + 'standard_fonts/',
    wasmUrl: BASE + 'wasm/',
    iccUrl: BASE + 'iccs/',
  });
  task.onProgress = ({ loaded, total }) => { if (seq === openSeq && total) setProgress(Math.min(0.98, loaded / total)); };
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (seq === openSeq) setProgress(null);
    throw err;
  }
  if (seq !== openSeq) { task.destroy(); return; }
  const prev = loadingTask;
  loadingTask = task;
  pdf = doc;
  docName = pdfFileName(label);
  $('btnDownload').disabled = false;
  model = new PaperModel(doc);
  backStack.length = 0; updateBackBtn();
  closeFind();
  viewer.setDocument(doc);
  linkService.setDocument(doc, null);
  prev?.destroy().catch(() => {});
  setProgress(null);
  document.body.classList.add('has-doc');
  $('pageCount').textContent = '/ ' + doc.numPages;
  $('pageInput').value = '1';
  document.title = (label || 'PDF') + ' – PaperPeek';
  doc.getMetadata().then(({ info }) => {
    if (seq === openSeq && info?.Title?.trim()) document.title = info.Title.trim() + ' – PaperPeek';
  }).catch(() => {});
  buildOutline(doc, seq);
  // 空闲时预先建立目的地索引，第一次悬停就不用等
  idle(() => model?.getDestIndex());
  container.focus({ preventScroll: true });
}

/** 由文件名 / 链接末段得到下载用的文件名：去掉文件系统不允许的字符，补上 .pdf。 */
function pdfFileName(label) {
  let name = String(label || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim() || 'document';
  if (!/\.pdf$/i.test(name)) name += '.pdf';
  return name;
}

/** 下载当前文档：用已加载好的原始字节，不再请求网络（需要登录的期刊链接也能存）。 */
async function downloadPdf() {
  if (!pdf) return;
  const doc = pdf;
  let data;
  try { data = await doc.getData(); } catch (err) {
    console.error(err);
    toast(t('err.download', { msg: err?.message || err }), 8000);
    return;
  }
  if (doc !== pdf) return;
  const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = docName;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
$('btnDownload').addEventListener('click', downloadPdf);

/** 把用户输入（链接 / arXiv 编号 / abs 页面地址）变成 PDF 地址。 */
function normalizeInput(raw) {
  let s = raw.trim();
  if (!s) return null;
  const id = s.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i);
  if (id) return 'https://arxiv.org/pdf/' + id[1];
  if (/^(\.{0,2}\/)/.test(s)) return new URL(s, location.href).href; // 相对路径：同站文件
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  const abs = s.match(/^https?:\/\/(?:www\.|export\.)?arxiv\.org\/abs\/(.+?)\/?$/i);
  if (abs) return 'https://arxiv.org/pdf/' + abs[1];
  return s;
}

async function openUrl(raw, { updateAddress = true } = {}) {
  const url = normalizeInput(raw);
  if (!url) return;
  $('urlInput').value = url;
  const label = decodeURIComponent(url.split(/[?#]/)[0].split('/').pop() || url);
  const sameOrigin = (() => { try { return new URL(url, location.href).origin === location.origin; } catch { return false; } })();
  try {
    try {
      // 插件里有站点权限，带上登录状态（学校/机构订阅的期刊需要）
      await openDocument(IS_EXTENSION && /^https?:/i.test(url) ? { url, withCredentials: true } : { url }, label);
    } catch (err) {
      // 站点不允许跨域读取时，经由本地服务器转发（仅 node server.mjs 方式运行时可用）
      if (!IS_LOCAL_SERVER || sameOrigin) throw err;
      await openDocument({ url: 'proxy?url=' + encodeURIComponent(url) }, label);
    }
    if (updateAddress) history.replaceState(null, '', location.pathname + '?file=' + encodeURIComponent(url));
  } catch (err) {
    console.error(err);
    const hint = IS_EXTENSION
      ? (/^file:/i.test(url) ? t('err.hintFileAccess') : '')
      : IS_LOCAL_SERVER ? '' : t('err.hintCors');
    toast(t('err.openUrl', { msg: err?.message || err }) + hint, 8000);
  }
}

async function openFile(file) {
  if (!file) return;
  try {
    await openDocument({ data: await file.arrayBuffer() }, file.name);
    $('urlInput').value = '';
    if (location.search) history.replaceState(null, '', location.pathname);
  } catch (err) {
    console.error(err);
    toast(t('err.openFile', { msg: err?.message || err }), 8000);
  }
}

$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });
$('urlForm').addEventListener('submit', e => { e.preventDefault(); openUrl($('urlInput').value); });

// 拖放
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types || [])].some(t => t === 'Files' || t === 'text/uri-list');
window.addEventListener('dragenter', e => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; } });
window.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
window.addEventListener('drop', e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; $('dropOverlay').hidden = true;
  const file = [...e.dataTransfer.files].find(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) || e.dataTransfer.files[0];
  if (file) openFile(file);
  else {
    const uri = e.dataTransfer.getData('text/uri-list').split('\n').find(l => l && !l.startsWith('#'));
    if (uri) openUrl(uri);
  }
});

// ---------------------------------------------------------------- 布局 / 缩放 / 页码

const modeButtons = [...$('modeGroup').querySelectorAll('button')];
function updateModeButtons() {
  for (const b of modeButtons) b.setAttribute('aria-checked', String(+b.dataset.spread === prefs.spread));
}
function setSpread(mode) {
  prefs.spread = mode; savePrefs(); updateModeButtons();
  if (!pdf) return;
  hidePopup();
  const page = viewer.currentPageNumber;
  viewer.spreadMode = mode;
  if (isNaN(prefs.scale)) viewer.currentScaleValue = prefs.scale; // 「适合页面/宽度」需要按新布局重算
  viewer.currentPageNumber = page;
}
for (const b of modeButtons) b.addEventListener('click', () => setSpread(+b.dataset.spread));
updateModeButtons();

eventBus.on('pagesinit', () => {
  viewer.spreadMode = prefs.spread;
  viewer.currentScaleValue = prefs.scale;
});

const scaleSelect = $('scaleSelect');
const customOpt = scaleSelect.querySelector('option[value="custom"]');
eventBus.on('scalechanging', ({ scale, presetValue }) => {
  hidePopup();
  prefs.scale = presetValue || String(scale); savePrefs();
  const opt = [...scaleSelect.options].find(o => presetValue ? o.value === presetValue : parseFloat(o.value) === scale);
  if (opt) { scaleSelect.value = opt.value; customOpt.hidden = true; }
  else { customOpt.hidden = false; customOpt.textContent = Math.round(scale * 100) + '%'; scaleSelect.value = 'custom'; }
});
scaleSelect.addEventListener('change', () => {
  if (scaleSelect.value !== 'custom') viewer.currentScaleValue = scaleSelect.value;
  container.focus({ preventScroll: true });
});
$('btnZoomIn').addEventListener('click', () => viewer.increaseScale());
$('btnZoomOut').addEventListener('click', () => viewer.decreaseScale());

// Ctrl/⌘ + 滚轮（触控板捏合）缩放，以光标位置为中心
let wheelAcc = 1;
container.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  if (!pdf) return;
  const unit = e.deltaMode === 1 ? 0.05 : 0.0035;
  wheelAcc *= Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * unit);
  if (Math.abs(wheelAcc - 1) >= 0.02) {
    viewer.updateScale({ scaleFactor: wheelAcc, origin: [e.clientX, e.clientY], drawingDelay: 250 });
    wheelAcc = 1;
  }
}, { passive: false });

function refit() {
  if (pdf && isNaN(viewer.currentScaleValue)) viewer.currentScaleValue = viewer.currentScaleValue;
  viewer.update();
}
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(refit, 120); });

const pageInput = $('pageInput');
eventBus.on('pagechanging', ({ pageNumber }) => { pageInput.value = pageNumber; });
pageInput.addEventListener('change', () => {
  const n = parseInt(pageInput.value, 10);
  if (pdf && n >= 1 && n <= pdf.numPages) viewer.currentPageNumber = n;
  else pageInput.value = viewer.currentPageNumber;
  container.focus({ preventScroll: true });
});
pageInput.addEventListener('focus', () => pageInput.select());

// ---------------------------------------------------------------- 目录

function setSidebar(open) {
  prefs.sidebar = open; savePrefs();
  $('sidebar').hidden = !open;
  document.body.classList.toggle('with-sidebar', open);
  $('btnSidebar').setAttribute('aria-pressed', String(open));
  refit();
}
$('btnSidebar').addEventListener('click', () => setSidebar($('sidebar').hidden));

async function buildOutline(doc, seq) {
  const box = $('outline');
  box.textContent = '';
  let outline = null;
  try { outline = await doc.getOutline(); } catch {}
  if (seq !== openSeq) return;
  if (!outline?.length) {
    const d = document.createElement('div');
    d.className = 'empty'; d.dataset.i18n = 'outline.empty'; d.textContent = t('outline.empty');
    box.append(d);
    return;
  }
  const build = (items, depth) => {
    const ul = document.createElement('ul');
    for (const it of items) {
      const li = document.createElement('li');
      const row = document.createElement('div'); row.className = 'row';
      const tw = document.createElement('button');
      tw.className = 'tw' + (it.items?.length ? '' : ' leaf');
      tw.textContent = '▾';
      tw.addEventListener('click', () => {
        li.classList.toggle('collapsed');
        tw.textContent = li.classList.contains('collapsed') ? '▸' : '▾';
      });
      const a = document.createElement('a');
      a.textContent = it.title;
      if (it.bold) a.style.fontWeight = '600';
      a.addEventListener('click', () => {
        if (it.dest) linkService.goToDestination(it.dest);
        else if (it.url) window.open(it.url, '_blank', 'noopener');
      });
      row.append(tw, a); li.append(row);
      if (it.items?.length) {
        li.append(build(it.items, depth + 1));
        if (depth >= 2) { li.classList.add('collapsed'); tw.textContent = '▸'; }
      }
      ul.append(li);
    }
    return ul;
  };
  box.append(build(outline, 0));
}

// ---------------------------------------------------------------- 搜索

const findInput = $('findInput');
function dispatchFind(type = '', findPrevious = false) {
  eventBus.dispatch('find', {
    source: window, type, query: findInput.value,
    caseSensitive: $('findCase').checked, entireWord: false,
    highlightAll: true, findPrevious, matchDiacritics: false,
  });
}
function openFind() {
  $('findbar').hidden = false;
  $('btnFind').setAttribute('aria-pressed', 'true');
  findInput.focus(); findInput.select();
  if (findInput.value) dispatchFind('');
}
function closeFind() {
  if ($('findbar').hidden) return;
  $('findbar').hidden = true;
  $('btnFind').setAttribute('aria-pressed', 'false');
  $('findCount').textContent = '';
  lastFindCount = null;
  eventBus.dispatch('findbarclose', { source: window });
  container.focus({ preventScroll: true });
}
let lastFindCount = null; // 最近一次搜索结果，切换语言时用它重画计数
function showFindCount({ current = 0, total = 0 } = {}, notFound = false) {
  lastFindCount = [{ current, total }, notFound];
  const el = $('findCount');
  el.classList.toggle('none', notFound);
  el.textContent = !findInput.value ? '' : notFound || !total ? t('find.none') : `${current} / ${total}`;
}
$('btnFind').addEventListener('click', () => ($('findbar').hidden ? openFind() : closeFind()));
$('findClose').addEventListener('click', closeFind);
$('findNext').addEventListener('click', () => dispatchFind('again', false));
$('findPrev').addEventListener('click', () => dispatchFind('again', true));
$('findCase').addEventListener('change', () => dispatchFind('casesensitivitychange'));
findInput.addEventListener('input', () => dispatchFind(''));
findInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); dispatchFind('again', e.shiftKey); }
});
eventBus.on('updatefindmatchescount', ({ matchesCount }) => showFindCount(matchesCount));
eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
  if (state !== FindState.PENDING) showFindCount(matchesCount, state === FindState.NOT_FOUND);
});

// ---------------------------------------------------------------- 跳转与返回

const backStack = [];
function capturePos() {
  if (!pdf) return null;
  const pn = viewer.currentPageNumber;
  const div = viewer.getPageView(pn - 1)?.div;
  if (!div) return null;
  const r = div.getBoundingClientRect(), c = container.getBoundingClientRect();
  return { pn, fx: (c.left - r.left) / r.width, fy: (c.top - r.top) / r.height };
}
function restorePos(p) {
  const div = viewer.getPageView(p.pn - 1)?.div;
  if (!div) return;
  const r = div.getBoundingClientRect(), c = container.getBoundingClientRect();
  container.scrollTop += r.top + p.fy * r.height - c.top;
  container.scrollLeft += r.left + p.fx * r.width - c.left;
}
function updateBackBtn() {
  const btn = $('backBtn');
  btn.hidden = !backStack.length;
}
function goBack() {
  const p = backStack.pop();
  if (!p) return false;
  hidePopup();
  restorePos(p);
  updateBackBtn();
  return true;
}
$('backBtn').addEventListener('click', goBack);

// 所有内部跳转（正文链接、弹窗、目录）都走这里：先记下当前位置，跳转后高亮目标
const rawGoTo = linkService.goToDestination.bind(linkService);
linkService.goToDestination = async dest => {
  const pos = capturePos();
  hidePopup();
  await rawGoTo(dest);
  if (pos) { backStack.push(pos); if (backStack.length > 50) backStack.shift(); updateBackBtn(); }
  flashDest(dest);
};

async function flashDest(dest) {
  const m = model;
  const pv = await m?.getPreview(dest);
  if (!pv || m !== model || !['cite', 'equation', 'footnote'].includes(pv.kind)) return;
  const div = viewer.getPageView(pv.pageIndex)?.div;
  if (!div) return;
  const { region: r, pageWidth: W, pageHeight: H } = pv;
  const el = document.createElement('div');
  el.className = 'pv-flash';
  el.style.left = (r.x0 / W) * 100 + '%';
  el.style.top = (r.y0 / H) * 100 + '%';
  el.style.width = ((r.x1 - r.x0) / W) * 100 + '%';
  el.style.height = ((r.y1 - r.y0) / H) * 100 + '%';
  div.append(el);
  el.addEventListener('animationend', () => el.remove());
}

// ---------------------------------------------------------------- 悬停预览

const SHOW_DELAY = 90;   // 鼠标停稳多久后开始取预览
const HIDE_DELAY = 260;  // 离开链接后多久收起（留时间把鼠标移进弹窗）
let hoverLink = null, showTimer = 0, hideTimer = 0, popupToken = 0, popupDest = null;
const stats = { last: null };

const linkOf = e => e.target?.closest?.('.annotationLayer .linkAnnotation') || null;

container.addEventListener('pointerover', e => {
  if (e.pointerType === 'touch' || e.buttons) return;
  const sec = linkOf(e);
  if (!sec) return;
  clearTimeout(hideTimer);
  if (hoverLink === sec) return;
  hoverLink = sec;
  clearTimeout(showTimer);
  const t0 = performance.now();
  showTimer = setTimeout(() => showPopup(sec, t0), SHOW_DELAY);
});
container.addEventListener('pointerout', e => {
  const sec = linkOf(e);
  if (!sec || sec.contains(e.relatedTarget)) return;
  if (hoverLink === sec) hoverLink = null;
  clearTimeout(showTimer);
  scheduleHide();
});
popup.addEventListener('pointerenter', () => clearTimeout(hideTimer));
popup.addEventListener('pointerleave', scheduleHide);
popupBody.addEventListener('click', () => { if (popupDest) linkService.goToDestination(popupDest); });
container.addEventListener('scroll', () => { if (!popup.hidden) hidePopup(); }, { passive: true });

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePopup, HIDE_DELAY);
}
function hidePopup() {
  clearTimeout(showTimer); clearTimeout(hideTimer);
  popupToken++;
  hoverLink = null; popupDest = null;
  popup.hidden = true;
}

async function renderPreview(pv, cssScale) {
  if (pv._render?.scale === cssScale) return pv._render.canvas;
  const page = await pdf.getPage(pv.pageIndex + 1);
  const r = pv.region;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const wCss = Math.max(1, Math.round((r.x1 - r.x0) * cssScale));
  const hCss = Math.max(1, Math.round((r.y1 - r.y0) * cssScale));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(wCss * dpr);
  canvas.height = Math.round(hCss * dpr);
  canvas.style.width = wCss + 'px';
  canvas.style.height = hCss + 'px';
  const s = cssScale * dpr;
  const viewport = page.getViewport({ scale: s, offsetX: -r.x0 * s, offsetY: -r.y0 * s });
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  const out = trimBlankRows(canvas, dpr, cssScale);
  pv._render = { scale: cssScale, canvas: out };
  return out;
}

/** 裁掉预览图上下的空白行（锚点常常比图、公式本身高出一截）。 */
function trimBlankRows(canvas, dpr, cssScale) {
  const { width: w, height: h } = canvas;
  let data;
  try { data = canvas.getContext('2d').getImageData(0, 0, w, h).data; } catch { return canvas; }
  const blank = y => {
    const row = y * w * 4;
    for (let x = 0; x < w; x += 2) {
      const i = row + x * 4;
      if (data[i] < 244 || data[i + 1] < 244 || data[i + 2] < 244) return false;
    }
    return true;
  };
  let top = 0, bottom = h - 1;
  // 边缘上被切了一半的一行（相邻条目、上一个公式的尾巴）：在一行高度内找到空白就整条去掉
  const lineH = Math.round(15 * cssScale * dpr);
  if (!blank(0)) for (let y = 1; y < Math.min(lineH, h >> 2); y++) if (blank(y)) { top = y; break; }
  if (!blank(h - 1)) for (let y = h - 2; y > Math.max(h - lineH, h - (h >> 2)); y--) if (blank(y)) { bottom = y; break; }
  while (top < bottom && blank(top)) top++;
  while (bottom > top && blank(bottom)) bottom--;
  // 顶上孤零零的一行（页眉）后面跟着一大段空白：一起去掉
  const strip = Math.round(20 * cssScale * dpr), gapMin = Math.round(30 * cssScale * dpr);
  for (let y = top; y < Math.min(top + strip, bottom); y++) {
    if (!blank(y)) continue;
    let e = y;
    while (e < bottom && blank(e)) e++;
    if (e - y >= gapMin && bottom - e > strip) top = e;
    y = e;
  }
  const pad = Math.round(7 * dpr);
  top = Math.max(0, top - pad); bottom = Math.min(h - 1, bottom + pad);
  const nh = bottom - top + 1;
  if (nh >= h - 2 * dpr || nh < 8) return canvas;
  const out = document.createElement('canvas');
  out.width = w; out.height = nh;
  out.style.width = canvas.style.width;
  out.style.height = Math.round(nh / dpr) + 'px';
  out.getContext('2d', { alpha: false }).drawImage(canvas, 0, top, w, nh, 0, 0, w, nh);
  return out;
}

async function showPopup(sec, t0 = performance.now()) {
  const token = ++popupToken;
  const m = model;
  if (!m || !sec.isConnected) return;
  const pageNumber = +sec.closest('.page')?.dataset.pageNumber;
  if (!pageNumber) return;
  const annot = (await m.getAnnots(pageNumber - 1)).get(sec.dataset.annotationId);
  if (!annot?.dest || token !== popupToken) return; // 外部链接或没有目的地：不弹
  const linkText = await m.linkText(pageNumber - 1, annot);
  if (token !== popupToken) return;
  const pv = await m.getPreview(annot.dest, linkText);
  if (!pv || token !== popupToken || m !== model) return;

  const r = pv.region;
  const maxW = Math.min(880, window.innerWidth - 32);
  let s = Math.min(1.8, Math.max(1.3, viewer.currentScale));
  s = Math.min(s, (maxW - 2) / (r.x1 - r.x0));
  s = Math.round(s * 100) / 100;
  let canvas;
  try { canvas = await renderPreview(pv, s); } catch (err) { console.warn('[paperpeek] render failed', err); return; }
  if (token !== popupToken || !sec.isConnected) return;

  popup.querySelector('.pv-kind').textContent = t(['cite', 'figure', 'table', 'equation', 'section', 'footnote'].includes(pv.kind) ? 'kind.' + pv.kind : 'kind.generic');
  popup.querySelector('.pv-page').textContent = t('popup.page', { n: pv.pageIndex + 1 });
  popupBody.replaceChildren(canvas);
  popupBody.setAttribute('aria-label', pv.text || '');
  popupDest = annot.dest;

  // 定位：优先放在链接下方，放不下就放上方；再不够就限制高度并可滚动
  const a = sec.getBoundingClientRect();
  const headH = 28, gap = 6, margin = 12;
  const topLimit = container.getBoundingClientRect().top + 4;
  const want = parseFloat(canvas.style.height) + headH + 2;
  const below = window.innerHeight - a.bottom - gap - margin;
  const above = a.top - gap - topLimit;
  const placeBelow = want <= below || below >= above;
  const h = Math.min(want, Math.max(120, placeBelow ? below : above));
  const w = parseFloat(canvas.style.width) + 2 + (h < want ? 14 : 0);
  popup.style.width = w + 'px';
  popup.style.height = h + 'px';
  popup.style.left = Math.max(margin, Math.min(a.left - 18, window.innerWidth - w - margin)) + 'px';
  popup.style.top = (placeBelow ? a.bottom + gap : a.top - gap - h) + 'px';
  popup.hidden = false;
  popupBody.scrollTop = 0;
  stats.last = { ms: Math.round(performance.now() - t0), kind: pv.kind, linkText, text: pv.text, page: pv.pageIndex + 1, region: r };
}

// 页面的链接层渲染好后，空闲时预热：链接列表、目的地所在页的文字
const idle = fn => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 200));
eventBus.on('annotationlayerrendered', ({ pageNumber }) => {
  const m = model;
  idle(async () => {
    if (!m || m !== model) return;
    const annots = await m.getAnnots(pageNumber - 1);
    const seen = new Set();
    for (const a of annots.values()) {
      if (!a.dest || m !== model) continue;
      const t = await m.resolveDest(a.dest);
      if (t && !seen.has(t.pageIndex)) { seen.add(t.pageIndex); m.getPageInfo(t.pageIndex); }
    }
  });
});

// ---------------------------------------------------------------- 键盘

window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
  // 拦下浏览器默认的「另存网页」，存的是 PDF 本身
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); downloadPdf(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); viewer.increaseScale(); return; }
  if (mod && e.key === '-') { e.preventDefault(); viewer.decreaseScale(); return; }
  if (mod && e.key === '0') { e.preventDefault(); if (pdf) viewer.currentScaleValue = 'page-fit'; return; }
  if (e.altKey && e.key === 'ArrowLeft') { if (goBack()) e.preventDefault(); return; }
  if (e.key === 'Escape') {
    if (!popup.hidden) hidePopup();
    else if (!$('findbar').hidden) closeFind();
    else if (typing) container.focus({ preventScroll: true });
    return;
  }
  if (typing || mod || e.altKey || !pdf) return;
  if (e.key === 'Backspace') { if (goBack()) e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); viewer.previousPage(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); viewer.nextPage(); }
});

// ---------------------------------------------------------------- 语言

const langSelect = $('langSelect');
langSelect.value = i18n.lang;
langSelect.addEventListener('change', () => { i18n.setLang(langSelect.value); container.focus({ preventScroll: true }); });
// 带 data-i18n 的静态文案由 i18n.js 自己换；这里处理由脚本生成的那些
i18n.onChange(lang => {
  langSelect.value = lang;
  hidePopup();
  if (lastFindCount) showFindCount(...lastFindCount);
  // 插件的后台脚本读不到页面的 localStorage，另存一份给它（工具栏图标的提示文字用）
  if (IS_EXTENSION) globalThis.chrome?.storage?.local.set({ lang }).catch(() => {});
});

// ---------------------------------------------------------------- 启动

if (prefs.sidebar) setSidebar(true);
const initial = new URLSearchParams(location.search).get('file');
if (initial) openUrl(initial, { updateAddress: false });

// 调试 / 自动化测试用
window.__pv = { viewer, eventBus, linkService, stats, openUrl, downloadPdf, get docName() { return docName; }, get model() { return model; }, get pdf() { return pdf; }, backStack, showPopup, hidePopup };
