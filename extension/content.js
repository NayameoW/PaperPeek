// 内容脚本：当前标签页直接显示的是 PDF（包括本地 file://）时，通知后台转到 PaperPeek。
// 用浏览器「后退」回到这个 PDF 时不再转，否则会被困在查看器里退不出去。
(() => {
  if (window !== window.top || document.contentType !== 'application/pdf') return;
  const nav = performance.getEntriesByType('navigation')[0];
  if (nav && nav.type === 'back_forward') return;
  chrome.runtime.sendMessage({ type: 'paperpeek:pdf', url: location.href }).catch(() => {});
})();
