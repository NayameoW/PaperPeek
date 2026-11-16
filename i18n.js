// 界面文案（中文 / English）与语言切换。
// 这是普通脚本，不是模块：查看器页面在 <head> 里同步加载它，赶在首次绘制前把文案换好；
// 插件的后台脚本用 importScripts 加载它，和页面共用同一份词典。
(() => {
  const MESSAGES = {
    zh: {
      'sidebar.title': '目录（PDF 书签）',
      'open.label': '打开文件',
      'open.title': '打开本地 PDF',
      'url.placeholder': '粘贴 PDF 链接或 arXiv 编号（如 1706.03762），回车打开',
      'mode.aria': '页面布局',
      'mode.single': '单页',
      'mode.single.title': '单页',
      'mode.double': '双页',
      'mode.double.title': '双页：1-2、3-4 …',
      'mode.cover': '双页 · 封面单独',
      'mode.cover.title': '双页，第一页（封面）单独显示：1、2-3、4-5 …',
      'zoom.out': '缩小',
      'zoom.in': '放大',
      'zoom.title': '缩放',
      'zoom.fit': '适合页面',
      'zoom.width': '适合宽度',
      'zoom.auto': '自动',
      'page.title': '页码',
      'find.title': '页内搜索',
      'find.placeholder': '在文档中查找',
      'find.prev': '上一个',
      'find.next': '下一个',
      'find.case': '区分大小写',
      'find.close': '关闭',
      'find.none': '无结果',
      'lang.title': '界面语言',
      'download.title': '下载 PDF（Ctrl/⌘ + S）',
      'outline.title': '目录',
      'outline.empty': '这个 PDF 没有书签目录',
      'welcome.title': '把 PDF 拖到这里',
      'welcome.sub': '或点击左上角「打开文件」，或在上方粘贴链接 / arXiv 编号',
      'drop.overlay': '松开鼠标以打开 PDF',
      'popup.hint': '点击预览跳转',
      'popup.page': '第 {n} 页',
      'back.label': '返回原位置',
      'back.title': '返回跳转前的位置（Alt + ←）',
      'kind.cite': '参考文献',
      'kind.figure': '图',
      'kind.table': '表',
      'kind.equation': '公式',
      'kind.section': '章节',
      'kind.footnote': '脚注',
      'kind.generic': '预览',
      'err.openUrl': '打不开这个 PDF：{msg}',
      'err.openFile': '打不开这个文件：{msg}',
      'err.download': '下载失败：{msg}',
      'err.hintFileAccess': '（本地文件需要在扩展管理页里为 PaperPeek 打开「允许访问文件网址」）',
      'err.hintCors': '（该站点可能不允许跨域读取：请用 node server.mjs 启动，或下载后拖入）',
      'action.on': 'PaperPeek 已开启：点击可暂停自动接管 PDF',
      'action.off': 'PaperPeek 已暂停：点击恢复自动接管 PDF',
    },
    en: {
      'sidebar.title': 'Outline (PDF bookmarks)',
      'open.label': 'Open file',
      'open.title': 'Open a local PDF',
      'url.placeholder': 'Paste a PDF link or arXiv ID (e.g. 1706.03762), then press Enter',
      'mode.aria': 'Page layout',
      'mode.single': 'Single',
      'mode.single.title': 'Single page',
      'mode.double': 'Two-page',
      'mode.double.title': 'Two pages: 1–2, 3–4 …',
      'mode.cover': 'Two-page + cover',
      'mode.cover.title': 'Two pages, with the first page (cover) on its own: 1, 2–3, 4–5 …',
      'zoom.out': 'Zoom out',
      'zoom.in': 'Zoom in',
      'zoom.title': 'Zoom',
      'zoom.fit': 'Fit page',
      'zoom.width': 'Fit width',
      'zoom.auto': 'Auto',
      'page.title': 'Page number',
      'find.title': 'Find in document',
      'find.placeholder': 'Find in document',
      'find.prev': 'Previous',
      'find.next': 'Next',
      'find.case': 'Match case',
      'find.close': 'Close',
      'find.none': 'No results',
      'lang.title': 'Interface language',
      'download.title': 'Download PDF (Ctrl/⌘ + S)',
      'outline.title': 'Outline',
      'outline.empty': 'This PDF has no bookmarks',
      'welcome.title': 'Drop a PDF here',
      'welcome.sub': 'or click “Open file” at the top left, or paste a link / arXiv ID above',
      'drop.overlay': 'Release to open the PDF',
      'popup.hint': 'Click the preview to jump',
      'popup.page': 'Page {n}',
      'back.label': 'Back',
      'back.title': 'Go back to where you were (Alt + ←)',
      'kind.cite': 'Reference',
      'kind.figure': 'Figure',
      'kind.table': 'Table',
      'kind.equation': 'Equation',
      'kind.section': 'Section',
      'kind.footnote': 'Footnote',
      'kind.generic': 'Preview',
      'err.openUrl': 'Can’t open this PDF: {msg}',
      'err.openFile': 'Can’t open this file: {msg}',
      'err.download': 'Download failed: {msg}',
      'err.hintFileAccess': ' (for local files, turn on “Allow access to file URLs” for PaperPeek on the extensions page)',
      'err.hintCors': ' (this site may not allow cross-origin reads: start PaperPeek with node server.mjs, or download the PDF and drop it in)',
      'action.on': 'PaperPeek is on: click to pause taking over PDFs',
      'action.off': 'PaperPeek is paused: click to resume taking over PDFs',
    },
  };

  const LANGS = Object.keys(MESSAGES);
  const STORE_KEY = 'paperpeek.lang';
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const hasDom = typeof document !== 'undefined';
  const listeners = new Set();

  /** 没选过语言时跟随浏览器：首选语言列表里只要有中文就用中文（哪怕排在英文后面），否则用英文。 */
  function detect() {
    const nav = globalThis.navigator;
    const list = nav?.languages?.length ? nav.languages : [nav?.language || ''];
    return list.some(l => /^zh\b/i.test(l)) ? 'zh' : 'en';
  }
  function stored() {
    try { const v = globalThis.localStorage?.getItem(STORE_KEY); return LANGS.includes(v) ? v : null; } catch { return null; }
  }

  let lang = stored() || detect();

  /** 取文案；{name} 占位符用 vars 里的值替换。 */
  function t(key, vars) {
    const s = MESSAGES[lang][key] ?? MESSAGES.zh[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  }

  /** 把 root 里带 data-i18n（文字）和 data-i18n-title / -placeholder / -aria-label（属性）的元素换成当前语言。 */
  function apply(root) {
    if (!hasDom) return; // 后台脚本里没有 document
    root ||= document;
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : lang;
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const attr of ATTRS) {
      for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
    }
  }

  /** 切换语言。persist=false 用于「别处已经存过了，这里只是跟着变」的情况。 */
  function setLang(next, { persist = true } = {}) {
    if (!LANGS.includes(next) || next === lang) return;
    lang = next;
    if (persist) { try { globalThis.localStorage?.setItem(STORE_KEY, lang); } catch {} }
    apply();
    for (const fn of listeners) fn(lang);
  }

  globalThis.PaperPeekI18n = {
    LANGS, t, apply, setLang,
    get lang() { return lang; },
    onChange(fn) { listeners.add(fn); },
  };

  if (hasDom) {
    // 文档一解析完就换文案（此时模块脚本还没执行，样式表也多半还没加载完，不会先闪一下中文）
    if (document.readyState === 'loading') {
      document.addEventListener('readystatechange', function once() {
        document.removeEventListener('readystatechange', once);
        apply();
      });
    } else apply();
    // 在另一个标签页里切了语言：这边跟着变
    window.addEventListener('storage', e => { if (e.key === STORE_KEY && e.newValue) setLang(e.newValue, { persist: false }); });
  }
})();
