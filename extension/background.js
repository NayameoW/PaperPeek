// 后台脚本：发现标签页要显示 PDF，就把它转到 PaperPeek 查看器。
// 两条路径：
//   1) 在线 PDF：看响应头 Content-Type（arXiv 的地址不带 .pdf 后缀，所以不能只看网址）
//   2) 本地 file:// 或漏网的情况：内容脚本发现当前文档是 PDF 后发消息过来
importScripts('/i18n.js'); // 和查看器页面共用一份词典
const i18n = self.PaperPeekI18n;
const VIEWER = chrome.runtime.getURL('viewer.html');
let enabled = true;
// lang：用户在查看器里选的语言（没选过就跟随浏览器，由 i18n.js 判断）
const ready = chrome.storage.local.get({ enabled: true, lang: null }).then(v => {
  enabled = v.enabled;
  if (v.lang) i18n.setLang(v.lang);
  updateBadge();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.lang?.newValue) return;
  i18n.setLang(changes.lang.newValue);
  updateBadge();
});

function updateBadge() {
  chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({ color: '#7a7f87' });
  chrome.action.setTitle({ title: i18n.t(enabled ? 'action.on' : 'action.off') });
}

chrome.action.onClicked.addListener(async () => {
  await ready;
  enabled = !enabled;
  await chrome.storage.local.set({ enabled });
  updateBadge();
});

const recent = new Map(); // tabId -> { url, t }，避免两条路径对同一个 PDF 重复跳转

// 每个标签页上一次接管的 PDF。后台脚本随时会被浏览器回收，所以存在 storage.session 里。
const shownKey = tabId => 'shown:' + tabId;
const getShown = async tabId => (await chrome.storage.session.get(shownKey(tabId)))[shownKey(tabId)];

/**
 * fromPage=false：来自响应头（PDF 还没显示出来）；fromPage=true：来自内容脚本（PDF 已经显示）。
 * 同一个标签页再次请求刚接管过的那个 PDF，多半是用户在查看器里按了「后退」。这时不在响应头
 * 阶段拦，交给内容脚本判断：是后退就留在浏览器自带的查看器（再退一步就离开了），不是就照常接管。
 */
async function redirect(tabId, url, fromPage) {
  await ready;
  if (!enabled || tabId == null || tabId < 0 || !url || url.startsWith(VIEWER)) return;
  if (!fromPage && (await getShown(tabId)) === url) return;
  const last = recent.get(tabId);
  if (last && last.url === url && Date.now() - last.t < 3000) return;
  recent.set(tabId, { url, t: Date.now() });
  chrome.storage.session.set({ [shownKey(tabId)]: url });
  chrome.tabs.update(tabId, { url: VIEWER + '?file=' + encodeURIComponent(url) }).catch(() => {});
}
chrome.tabs.onRemoved.addListener(id => { recent.delete(id); chrome.storage.session.remove(shownKey(id)); });

chrome.webRequest.onHeadersReceived.addListener(
  d => {
    if (d.method !== 'GET' || d.statusCode !== 200) return;
    const header = name => d.responseHeaders?.find(h => h.name.toLowerCase() === name)?.value || '';
    if (!/^\s*application\/pdf\b/i.test(header('content-type'))) return;
    if (/^\s*attachment/i.test(header('content-disposition'))) return; // 网站要求下载的，不拦
    redirect(d.tabId, d.url, false);
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
  ['responseHeaders']
);

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'paperpeek:pdf' && sender.tab && sender.frameId === 0) redirect(sender.tab.id, sender.url || msg.url, true);
});
