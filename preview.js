// 预览模型：把「链接的目的地」变成「目标页上应该裁出来的那一块」。
// 不依赖 DOM，只依赖 pdf.js 的文档对象，方便单独调试。
//
// 坐标约定：全部使用 scale=1 的视口坐标（单位 pt，原点在页面左上角，y 向下）。

const Util = globalThis.pdfjsLib.Util;

const CAPTION_RE = {
  figure: /^(figure|fig\.?|图)\s*([0-9]+|[IVXLC]+)\s*([:.：|]|$)/i,
  table: /^(table|tab\.?|表)\s*([0-9]+|[IVXLC]+)\s*([:.：|]|$)/i,
};

function classify(name) {
  if (!name) return 'generic';
  const n = name.toLowerCase();
  if (/^(cite\.|bib|b\d|cr\d|ref[-_.]?\d|r\d+$|reference|en\d)/.test(n)) return 'cite';
  if (/^(sub)?fig/.test(n)) return 'figure';
  if (/^(sub)?tab/.test(n)) return 'table';
  if (/^(equation|eq|align|ams|gather|multline)/.test(n)) return 'equation';
  if (/^(section|subsection|subsubsection|appendix|chapter|paragraph|part|sec)/.test(n)) return 'section';
  if (/^(hfootnote|footnote|fn)/.test(n)) return 'footnote';
  if (/^(theorem|lemma|definition|proposition|corollary|algorithm|alg|listing|lstlisting|remark|example|assumption|thm|lem|def|prop|cor|item|enumi)/.test(n)) return 'block';
  return 'generic';
}

const familyOf = name => (name ? (name.match(/^[A-Za-z]+/) || [''])[0].toLowerCase() : '');

function romanToInt(s) {
  const map = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  const u = s.toUpperCase();
  for (let i = 0; i < u.length; i++) {
    const v = map[u[i]], next = map[u[i + 1]] || 0;
    if (!v) return NaN;
    total += v < next ? -v : v;
  }
  return total;
}
const labelNumber = s => (/^\d+$/.test(s) ? parseInt(s, 10) : romanToInt(s));

/** 从链接文字里取出最后一个编号，例如 "Figure 3" → "3"，"(2.1)" → "2.1"。 */
function lastLabel(text) {
  const m = (text || '').match(/[0-9A-Z]*\d+(?:\.\d+)*[a-z]?/g);
  return m ? m[m.length - 1] : null;
}

/** 编号候选：优先用链接文字里的编号，其次从目的地名字里取（equation.3.12 → "3.12"、"12"）。 */
function labelCandidates(linkText, name) {
  const out = [];
  const a = lastLabel(linkText);
  if (a) out.push(a);
  if (name && !/caption/i.test(name)) {
    const m = name.match(/^[A-Za-z@]+\.(.+)$/);
    if (m) {
      out.push(m[1]);
      const tail = m[1].split('.').pop();
      if (tail !== m[1]) out.push(tail);
    }
  }
  return [...new Set(out)];
}

let measureCtx = null;
/** 一个文字块里每个字符的左右边界（长度 = 字符数 + 1），单位同页面坐标。 */
function charEdges(b) {
  measureCtx ||= document.createElement('canvas').getContext('2d');
  const loaded = b.font && document.fonts?.check?.(`100px "${b.font}"`);
  measureCtx.font = loaded ? `100px "${b.font}"` : '100px serif';
  const s = b.str, unit = b.fh / 100, total = b.x1 - b.x0;
  const w = new Array(s.length);
  let sum = 0, spaces = 0;
  for (let i = 0; i < s.length; i++) {
    w[i] = measureCtx.measureText(s[i]).width * unit;
    sum += w[i];
    if (s[i] === ' ') spaces++;
  }
  // 与真实宽度的差：两端对齐的行差在空格上；没有空格就按比例摊开
  const extra = total - sum;
  if (spaces && Math.abs(extra) < total * 0.5) {
    for (let i = 0; i < s.length; i++) if (s[i] === ' ') w[i] = Math.max(0, w[i] + extra / spaces);
  } else if (sum > 0) {
    const k = total / sum;
    for (let i = 0; i < s.length; i++) w[i] *= k;
  }
  const xs = [b.x0];
  for (let i = 0; i < s.length; i++) xs.push(xs[i] + w[i]);
  return xs;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class PaperModel {
  constructor(pdf) {
    this.pdf = pdf;
    this._annots = new Map();
    this._pages = new Map();
    this._pageIndex = new Map();
    this._previews = new Map();
    this._destIndex = null;
  }

  static destKey(dest) {
    return typeof dest === 'string' ? 'n:' + dest : 'e:' + JSON.stringify(dest);
  }

  /** 某一页上的链接批注：Map<annotationId, annotation> */
  getAnnots(pageIndex) {
    let p = this._annots.get(pageIndex);
    if (!p) {
      p = (async () => {
        const page = await this.pdf.getPage(pageIndex + 1);
        const list = await page.getAnnotations({ intent: 'display' });
        return new Map(list.filter(a => a.subtype === 'Link').map(a => [a.id, a]));
      })();
      this._annots.set(pageIndex, p);
    }
    return p;
  }

  /** 某一页的文字块（已转成视口坐标）和分栏信息。 */
  getPageInfo(pageIndex) {
    let p = this._pages.get(pageIndex);
    if (!p) {
      p = (async () => {
        const page = await this.pdf.getPage(pageIndex + 1);
        const vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        const boxes = [];
        for (const it of tc.items) {
          if (!it.str || !it.str.trim()) continue;
          const m = Util.transform(vp.transform, it.transform);
          // 跳过竖排/旋转文字（例如 arXiv 页边的水印），否则会干扰分栏判断
          if (Math.abs(m[1]) > Math.abs(m[0])) continue;
          const fh = Math.hypot(m[2], m[3]) || it.height || 10;
          boxes.push({
            str: it.str,
            x0: m[4],
            x1: m[4] + it.width,
            y0: m[5] - fh * 0.85,
            y1: m[5] + fh * 0.28,
            base: m[5],
            fh,
            font: it.fontName,
          });
        }
        const info = { page, boxes, width: vp.width, height: vp.height, vp };
        info.cols = computeColumns(info);
        return info;
      })();
      this._pages.set(pageIndex, p);
    }
    return p;
  }

  async _pageIndexOf(ref) {
    if (Number.isInteger(ref)) return ref;
    if (!ref || typeof ref !== 'object') return null;
    const key = `${ref.num}R${ref.gen}`;
    let p = this._pageIndex.get(key);
    if (!p) {
      p = this.pdf.getPageIndex(ref).catch(() => null);
      this._pageIndex.set(key, p);
    }
    return p;
  }

  /** 把目的地（命名或显式数组）解析成 {name, pageIndex, x, y}；x 可能为 null。 */
  async resolveDest(dest, knownName = null) {
    let name = knownName, explicit = dest;
    if (typeof dest === 'string') {
      name = dest;
      explicit = await this.pdf.getDestination(dest).catch(() => null);
    }
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const pageIndex = await this._pageIndexOf(explicit[0]);
    if (pageIndex == null || pageIndex < 0 || pageIndex >= this.pdf.numPages) return null;
    const page = await this.pdf.getPage(pageIndex + 1);
    const vp = page.getViewport({ scale: 1 });
    const mode = explicit[1]?.name;
    const a = explicit.slice(2);
    let left = null, top = null;
    switch (mode) {
      case 'XYZ': left = a[0]; top = a[1]; break;
      case 'FitH': case 'FitBH': top = a[0]; break;
      case 'FitV': case 'FitBV': left = a[0]; break;
      case 'FitR': left = a[0]; top = a[3]; break;
      default: break;
    }
    const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
    left = num(left); top = num(top);
    const [vx, vy] = vp.convertToViewportPoint(left ?? vp.viewBox[0], top ?? vp.viewBox[3]);
    return {
      name,
      pageIndex,
      x: left == null ? null : clamp(vx, 0, vp.width),
      y: top == null ? 0 : clamp(vy, 0, vp.height),
    };
  }

  /** 全文目的地索引：Map<pageIndex, [{name,x,y}]>，用来判断「下一条参考文献从哪里开始」。 */
  getDestIndex() {
    if (!this._destIndex) {
      this._destIndex = (async () => {
        const byPage = new Map();
        const add = t => {
          if (!t) return;
          let arr = byPage.get(t.pageIndex);
          if (!arr) byPage.set(t.pageIndex, (arr = []));
          arr.push(t);
        };
        const named = (await this.pdf.getDestinations().catch(() => null)) || {};
        const names = Object.keys(named);
        for (const name of names) add(await this.resolveDest(named[name], name));
        // 没有命名目的地的 PDF（部分期刊排版）：退而扫描所有链接的显式目的地
        if (!names.length && this.pdf.numPages <= 400) {
          const seen = new Set();
          for (let i = 0; i < this.pdf.numPages; i++) {
            for (const a of (await this.getAnnots(i)).values()) {
              if (!a.dest || typeof a.dest === 'string') continue;
              const key = JSON.stringify(a.dest);
              if (seen.has(key)) continue;
              seen.add(key);
              add(await this.resolveDest(a.dest));
            }
          }
        }
        return byPage;
      })();
    }
    return this._destIndex;
  }

  /**
   * 链接框住的文字（如 "[12]"、"3"）。用 PDF 内嵌字体实测每个字符的位置，
   * 比读文字层 DOM 准确（文字层用的是替代字体，会偏一两个字符）。
   */
  async linkText(pageIndex, annot) {
    const pg = await this.getPageInfo(pageIndex);
    const q = pg.vp.convertToViewportRectangle(annot.rect);
    const rx0 = Math.min(q[0], q[2]) - 0.6, rx1 = Math.max(q[0], q[2]) + 0.6;
    const ry0 = Math.min(q[1], q[3]) - 1.5, ry1 = Math.max(q[1], q[3]) + 2.5;
    let out = '';
    const hits = pg.boxes
      .filter(b => b.base >= ry0 && b.base <= ry1 && b.x1 > rx0 && b.x0 < rx1)
      .sort((a, b) => a.x0 - b.x0);
    for (const b of hits) {
      const xs = charEdges(b);
      for (let i = 0; i < b.str.length; i++) {
        const c = (xs[i] + xs[i + 1]) / 2;
        if (c >= rx0 && c <= rx1) out += b.str[i];
      }
    }
    return out.trim();
  }

  /**
   * 计算预览：{kind, pageIndex, region:{x0,y0,x1,y1}, text, target}
   * linkText 是链接本身的文字（如 "[12]"、"3"），用于找图注/公式编号，可为空。
   */
  getPreview(dest, linkText = '') {
    const key = PaperModel.destKey(dest);
    let p = this._previews.get(key);
    if (!p) {
      p = this._buildPreview(dest, linkText).catch(err => {
        console.warn('[paperpeek] preview failed', err);
        return null;
      });
      this._previews.set(key, p);
    }
    return p;
  }

  async _buildPreview(dest, linkText) {
    const t = await this.resolveDest(dest);
    if (!t) return null;
    const pg = await this.getPageInfo(t.pageIndex);
    let kind = classify(t.name);
    const labels = labelCandidates(linkText, t.name);
    const label = labels[0] || null;
    const cols = colsNear(pg, t.y);
    let col = columnAt(cols, t.x);
    let top = t.y - 8, bottom = t.y + 240, text = '';

    if (kind === 'generic' && looksLikeBibEntry(pg, col, t, linkText)) kind = 'cite';

    if (kind === 'cite') {
      const r = await this._citeRegion(pg, col, t);
      if (r) ({ top, bottom, text } = r);
      else bottom = t.y + 90;
    } else if (kind === 'figure' || kind === 'table') {
      const r = floatRegion(pg, kind, t, label);
      if (r) ({ top, bottom, col } = r);
      else bottom = t.y + 320;
    } else if (kind === 'equation') {
      const r = equationRegion(pg, col, t, labels);
      if (r) ({ top, bottom } = r);
      else bottom = t.y + 100;
    } else if (kind === 'section') {
      top = t.y - 6; bottom = t.y + 180;
    } else if (kind === 'footnote') {
      const lines = linesIn(pg, col);
      const i = lines.findIndex(l => l.base > t.y + 0.5);
      if (i >= 0) {
        const j = paragraphEnd(lines, i, 10);
        top = lines[i].y0 - 2;
        bottom = lines[j].y1 + 2;
        text = joinLines(lines.slice(i, j + 1));
      } else bottom = t.y + 90;
    }

    if (t.x == null && kind !== 'figure' && kind !== 'table') {
      col = [cols[0][0], cols[cols.length - 1][1]];
    }
    const region = {
      x0: clamp(col[0] - 8, 0, pg.width),
      x1: clamp(col[1] + 8, 0, pg.width),
      y0: clamp(top, 0, pg.height),
      y1: clamp(bottom, 0, pg.height),
    };
    if (region.y1 - region.y0 < 24) region.y1 = Math.min(pg.height, region.y0 + 24);
    if (region.x1 - region.x0 < 60) { region.x0 = 0; region.x1 = pg.width; }
    return { kind, pageIndex: t.pageIndex, region, text, target: t, pageWidth: pg.width, pageHeight: pg.height };
  }

  async _citeRegion(pg, col, t) {
    const lines = linesIn(pg, col);
    const first = lines.findIndex(l => l.base > t.y + 0.5);
    if (first < 0) return null;
    const index = await this.getDestIndex();
    const fam = familyOf(t.name);
    let nextY = Infinity;
    for (const d of index.get(t.pageIndex) || []) {
      if (d.y <= t.y + 4 || d.x == null) continue;
      if (d.x < col[0] - 20 || d.x >= col[1]) continue;
      if (familyOf(d.name) !== fam) continue;
      if (d.y < nextY) nextY = d.y;
    }
    let last = first;
    if (nextY < Infinity) {
      while (last + 1 < lines.length && lines[last + 1].base <= nextY + 0.5 && last - first < 24) last++;
    } else {
      // 本栏最后一条：没有「下一条」可参考，按行距找段落结尾
      const startRe = /^\s*(\[[^\]]{1,14}\]|\d{1,3}\.\s)/;
      const labelled = startRe.test(lines[first].text);
      last = paragraphEnd(lines, first, 14, l => labelled && startRe.test(l.text));
    }
    const chosen = lines.slice(first, last + 1);
    return {
      top: lines[first].y0 - 1,
      bottom: Math.min(lines[last].y1 + 1.5, lines[first].y0 + 340),
      text: joinLines(chosen),
    };
  }
}

// ---------------------------------------------------------------- 几何工具

/** 用文字在 x 轴上的投影找栏间空白，返回每一栏的 [x0, x1]。 */
function computeColumns(pg, boxes = pg.boxes) {
  const { width } = pg;
  if (!boxes.length) return [[0, width]];
  const n = Math.ceil(width) + 1;
  const cov = new Uint16Array(n);
  let minX = Infinity, maxX = -Infinity, maxCov = 0;
  for (const b of boxes) {
    const a = clamp(Math.floor(b.x0), 0, n - 1), z = clamp(Math.ceil(b.x1), 0, n - 1);
    for (let i = a; i < z; i++) if (++cov[i] > maxCov) maxCov = cov[i];
    if (b.x0 < minX) minX = b.x0;
    if (b.x1 > maxX) maxX = b.x1;
  }
  const start0 = clamp(Math.floor(minX), 0, n - 1), end = clamp(Math.ceil(maxX), 0, n - 1);
  const thr = Math.max(1, maxCov * 0.12);
  const cols = [];
  let start = start0, gap = -1;
  for (let i = start0; i <= end; i++) {
    const empty = i < end && cov[i] < thr;
    if (empty) {
      if (gap < 0) gap = i;
    } else if (gap >= 0) {
      if (i - gap >= 7 && gap > start) { cols.push([start, gap]); start = i; }
      gap = -1;
    }
  }
  cols.push([start, end]);
  // 太窄的「栏」（页码、行号、页边注记）并入相邻的栏
  const total = end - start0;
  for (let i = 0; i < cols.length && cols.length > 1;) {
    if (cols[i][1] - cols[i][0] < total * 0.2) {
      if (i === 0) cols[1][0] = cols[0][0];
      else cols[i - 1][1] = cols[i][1];
      cols.splice(i, 1);
    } else i++;
  }
  // 栏的边界按阈值切出来会偏窄（行尾只有少数几行够得着），用实际文字范围撑回去
  for (let k = 0; k < cols.length; k++) {
    const c = cols[k];
    const prevEnd = k > 0 ? cols[k - 1][1] : -Infinity;
    const nextStart = k + 1 < cols.length ? cols[k + 1][0] : Infinity;
    for (const b of boxes) {
      if (b.x0 >= c[0] - 2 && b.x0 < c[1] && b.x1 > c[1] && b.x1 < nextStart - 3) c[1] = Math.ceil(b.x1);
      if (b.x1 > c[0] && b.x1 <= c[1] + 2 && b.x0 < c[0] && b.x0 > prevEnd + 3) c[0] = Math.floor(b.x0);
    }
  }
  // 论文的栏是等宽的；宽度差得多说明是表格、图里的文字造成的假分栏
  const widths = cols.map(c => c[1] - c[0]);
  if (cols.length > 1 && Math.min(...widths) < 0.7 * Math.max(...widths)) return [[start0, end]];
  return cols;
}

/** 只看目标附近一段的分栏：同一页上半通栏、下半双栏时也能判断对。 */
function colsNear(pg, y) {
  const band = pg.boxes.filter(b => b.base >= y - 150 && b.base <= y + 250);
  return band.length >= 8 ? computeColumns(pg, band) : pg.cols;
}

function columnAt(cols, x) {
  if (x == null) return cols[0];
  for (const c of cols) if (x < c[1] - 4) return c;
  return cols[cols.length - 1];
}

/** 把一栏里的文字块聚成行（按基线），从上到下排序。 */
function linesIn(pg, col) {
  const bs = pg.boxes
    .filter(b => b.x0 >= col[0] - 4 && b.x0 < col[1])
    .sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const lines = [];
  let cur = null;
  for (const b of bs) {
    if (cur && Math.abs(b.base - cur.base) <= 0.45 * Math.max(cur.fh, b.fh)) {
      cur.boxes.push(b);
      if (b.x1 - b.x0 > cur.wide) { cur.wide = b.x1 - b.x0; cur.base = b.base; cur.fh = b.fh; }
    } else {
      cur = { boxes: [b], base: b.base, fh: b.fh, wide: b.x1 - b.x0 };
      lines.push(cur);
    }
  }
  for (const l of lines) {
    l.boxes.sort((a, b) => a.x0 - b.x0);
    l.x0 = l.boxes[0].x0;
    l.x1 = Math.max(...l.boxes.map(b => b.x1));
    l.y0 = Math.min(...l.boxes.map(b => b.y0));
    l.y1 = Math.max(...l.boxes.map(b => b.y1));
    let s = '', prev = null, maxGap = 0;
    for (const b of l.boxes) {
      if (prev) {
        const g = b.x0 - prev.x1;
        if (g > maxGap) maxGap = g;
        if (g > 0.15 * b.fh && !/\s$/.test(s) && !/^\s/.test(b.str)) s += ' ';
      }
      s += b.str;
      prev = b;
    }
    l.text = s.replace(/\s+/g, ' ').trim();
    l.maxGap = maxGap;
  }
  lines.sort((a, b) => a.base - b.base);
  return lines;
}

/** 从第 i 行开始，按行距找到这一段的最后一行。 */
function paragraphEnd(lines, i, maxLines, stop = null) {
  let j = i;
  let pitch = i + 1 < lines.length ? lines[i + 1].base - lines[i].base : lines[i].fh * 1.2;
  pitch = clamp(pitch, lines[i].fh * 0.9, lines[i].fh * 1.7);
  while (j + 1 < lines.length && j - i + 1 < maxLines) {
    const a = lines[j], b = lines[j + 1];
    if (b.base - a.base > pitch * 1.35) break;
    if (Math.abs(b.fh - lines[i].fh) > lines[i].fh * 0.18) break;
    if (stop && stop(b)) break;
    j++;
  }
  return j;
}

function joinLines(lines) {
  let s = '';
  for (const l of lines) {
    if (!s) s = l.text;
    else if (/[A-Za-z]-$/.test(s) && /^[a-z]/.test(l.text)) s = s.slice(0, -1) + l.text;
    else s += ' ' + l.text;
  }
  return s;
}

/** 正文行：几乎占满一栏、中间没有大空隙（用来区分正文和图表里的零散文字）。 */
function isBodyLine(l, col) {
  return l.x1 - l.x0 >= 0.85 * (col[1] - col[0]) && l.maxGap < 1.2 * l.fh;
}

/** 无命名目的地时的兜底：目标行以 [12] / 12. 开头，且链接文字像引用编号。 */
function looksLikeBibEntry(pg, col, t, linkText) {
  const lines = linesIn(pg, col);
  const l = lines.find(x => x.base > t.y + 0.5);
  if (!l || l.base - t.y > 40) return false;
  if (!/^\s*(\[[^\]]{1,14}\]|\d{1,3}\.\s)/.test(l.text)) return false;
  const lt = (linkText || '').trim();
  return !lt || /^[\[(]?\s*\d{1,3}[a-z]?\s*[\]),;–-]?$/.test(lt) || /\d{4}[a-z]?\)?$/.test(lt);
}

/** 图/表：找到图注，再推断整个浮动体的范围。 */
function floatRegion(pg, kind, t, label) {
  const re = CAPTION_RE[kind];
  const want = label && /^\d+$/.test(label) ? parseInt(label, 10) : null;
  let cands = [];
  for (const b of pg.boxes) {
    const m = b.str.trimStart().match(re);
    if (m) cands.push({ box: b, num: labelNumber(m[2]) });
  }
  if (!cands.length) return null;
  const numbered = want != null ? cands.filter(c => c.num === want) : [];
  let cap;
  if (numbered.length) {
    cap = numbered.sort((a, b) => Math.abs(a.box.y0 - t.y) - Math.abs(b.box.y0 - t.y))[0].box;
  } else {
    const below = cands.filter(c => c.box.y0 >= t.y - 16).sort((a, b) => a.box.y0 - b.box.y0);
    if (!below.length) return null;
    const near = colsNear(pg, t.y);
    const sameCol = t.x == null ? below : below.filter(c => columnAt(near, c.box.x0 + 2) === columnAt(near, t.x));
    cap = (sameCol[0] || below[0]).box;
  }
  // 图注第一行的横向范围 → 它跨了哪几栏
  const row = pg.boxes
    .filter(b => Math.abs(b.base - cap.base) < 2 && b.x0 >= cap.x0 - 1)
    .sort((a, b) => a.x0 - b.x0);
  let cx1 = cap.x1;
  for (const b of row) { if (b.x0 - cx1 < 14) cx1 = Math.max(cx1, b.x1); else break; }
  const cols = colsNear(pg, cap.base);
  const hit = cols.filter(c => Math.min(c[1], cx1) - Math.max(c[0], cap.x0) > 5);
  const col = hit.length ? [hit[0][0], hit[hit.length - 1][1]] : columnAt(cols, cap.x0);
  const lines = linesIn(pg, col);
  const ci = lines.findIndex(l => Math.abs(l.base - cap.base) < 2);
  if (ci < 0) return null;
  const ce = paragraphEnd(lines, ci, 16);
  const capTop = lines[ci].y0, capBottom = lines[ce].y1;

  if (capTop - t.y > 20) {
    // 锚点在浮动体顶部，图注在下面
    return { col, top: t.y - 6, bottom: capBottom + 6 };
  }
  // 表注可能在表的上方也可能在下方：表注后面紧跟正文，说明表在上方
  const after = lines[ce + 1];
  const tableAbove = kind === 'table' &&
    (!after || (isBodyLine(after, col) && after.base - lines[ce].base < 6 * lines[ce].fh && !lines.slice(ce + 2, ce + 5).some(l => l.maxGap > 2.5 * l.fh)));
  if (kind === 'figure' || tableAbove) {
    // 锚点就在图注上：图在图注上方，向上找到最近的正文行
    let top = Math.max(0, capTop - 420);
    for (let k = ci - 1; k >= 0; k--) {
      if (lines[k].base < top) break;
      if (isBodyLine(lines[k], col)) { top = lines[k].y1 + 4; break; }
      // 表格的行是密排的：往上遇到大段空白就到头了（再往上是别的图表）
      if (tableAbove && lines[k + 1].y0 - lines[k].y1 > 20) { top = lines[k + 1].y0 - 12; break; }
    }
    return { col, top, bottom: capBottom + 6 };
  }
  // 表：图注在上，表体在下，向下找到正文重新开始的地方
  let bottom = Math.min(pg.height, capBottom + 420);
  for (let k = ce + 1; k < lines.length; k++) {
    if (lines[k].y0 > bottom) break;
    const other = CAPTION_RE.figure.test(lines[k].text) || CAPTION_RE.table.test(lines[k].text);
    if ((isBodyLine(lines[k], col) && lines[k].base - capBottom > 30) || other) { bottom = lines[k].y0 - 4; break; }
  }
  return { col, top: Math.min(t.y, capTop) - 6, bottom };
}

/** 公式：在锚点下方找到 "(N)" 编号，围绕它取一块。 */
function equationRegion(pg, col, t, labels) {
  let best = null;
  for (const label of labels) {
    const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\(\\s*${esc}\\s*\\)$`);
    for (const b of pg.boxes) {
      if (b.x0 < col[0] - 4 || b.x0 >= col[1]) continue;
      if (b.base < t.y - 14 || b.base > t.y + 260) continue;
      if (!re.test(b.str.trim())) continue;
      if (!best || Math.abs(b.base - t.y) < Math.abs(best.base - t.y)) best = b;
    }
    if (best) break;
  }
  if (!best) return null;
  const mid = (best.y0 + best.y1) / 2;
  const half = Math.max(22, mid - t.y);
  return { top: Math.min(t.y - 4, mid - half - 4), bottom: mid + half + 8 };
}
