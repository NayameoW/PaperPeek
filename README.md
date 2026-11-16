# PaperPeek

**English** | [简体中文](README.zh-CN.md)

Read paper PDFs in the browser: two-page spreads, plus hover previews of citations, figures, tables and equations. Built on pdf.js, with no build step.

## Option 1: Local web app

```bash
node server.mjs
```

Open <http://localhost:8177/>, then open a PDF in either of these ways:

- Drag a PDF file into the window, or click **Open file**
- Paste a PDF link, an arXiv page URL or an arXiv ID (e.g. `1706.03762`) into the address box and press Enter

Requires Node 18 or later. `server.mjs` listens on localhost only (127.0.0.1). Besides serving static files, it has a small
proxy endpoint that downloads PDFs from sites that don't allow cross-origin reads (arXiv allows them, so it doesn't go through the proxy).

## Option 2: Chrome / Edge extension

1. Open `chrome://extensions` (`edge://extensions` in Edge) and turn on **Developer mode**
2. Click **Load unpacked** and select this repository's folder (from `git clone`, or a downloaded ZIP after unzipping)
3. To take over local PDFs (`file://`), turn on **Allow access to file URLs** in the extension's **Details**

From then on, any PDF you open in the browser is redirected to PaperPeek automatically. Click the extension's toolbar icon
to pause / resume (the icon shows OFF while paused). Pressing the browser's **Back** in the viewer returns to the browser's
built-in PDF view; going back once more leaves the page.

## Features

| Feature | How |
| --- | --- |
| Single / two-page / two-page with separate cover | The three buttons in the middle of the toolbar |
| Hover preview | Hover over internal links: citation numbers, "Figure 3", "Eq. (2)", "Section 4", footnote marks, etc. |
| Jump | Click the link, or click the preview in the popup; references, equations and footnotes flash briefly after the jump |
| Go back | The **Back** button at the bottom, or `Alt + ←` / `Backspace` (multiple levels) |
| Zoom | − / + / dropdown in the toolbar, `Ctrl/⌘ + scroll` (trackpad pinch), `Ctrl/⌘ + +/−/0` |
| Outline | ☰ at the top left (from the PDF's bookmarks) |
| Download PDF | The ↓ button right of the search icon, or `Ctrl/⌘ + S` (saves the loaded PDF, no re-download) |
| Find | `Ctrl/⌘ + F`; Enter for next, `Shift + Enter` for previous, `Esc` to close |
| Turn pages | `←` / `→` (a whole spread at a time in two-page mode), or type a page number in the page box |
| Interface language | The dropdown at the far right of the toolbar: 中文 / English |

Layout, zoom and language choices are remembered (globally, not per file). Until you pick a language, it follows the
browser: Chinese if any Chinese language is in your preferred languages list, English otherwise.
The extension's name and description on the extensions page follow the browser's own UI language, not this dropdown.

## Files

```
viewer.html / viewer.css / viewer.js   Viewer UI
preview.js                             Preview logic: works out which part of the target page to crop from a link's destination
i18n.js                                UI strings (Chinese / English) and language switching; add strings or languages here
server.mjs                             Local server (static files + PDF proxy)
manifest.json, extension/              Extension shell: when a tab is showing a PDF, redirects it to viewer.html
_locales/                              Extension name and description in Chinese and English (format required by the browser)
icons/                                 Icons: icon.svg is the large version (48/128px, welcome screen); icon-small.svg is the
                                       16/32px version (pixel-grid aligned, also the page favicon); icon-NN.png are exported from the matching SVG
vendor/pdfjs/                          pdf.js 5.6.205 (Apache-2.0)
```

### How previews are cropped

Previews rely only on the PDF's own internal links; there is no text recognition:

- **References**: from the destination to the next reference's destination in the same column, which crops exactly one entry.
- **Figures / tables**: find the matching caption on the target page (`Figure 3:` / `Table 2.`), then decide whether the figure is above or below it.
- **Equations**: find the `(N)` number near the destination and take a region around it.
- **Sections, footnotes and others**: take a strip starting at the destination.

Columns are detected automatically from the horizontal projection of the text (only near the target, so pages that are
half full-width and half two-column work too). After rendering, blank margins and half-cut neighbouring lines are trimmed.

## Known limitations

- PDFs without internal links (scans, some older papers) get no hover previews. This is intentionally out of scope.
- When a reference entry spans columns or pages, only the first part is shown.
- Very tall figures (a full column) may need scrolling inside the popup.
- The extension has been tested in Edge (Chromium 157). Chrome uses the same extension APIs but hasn't been tested yet.

## License

[MIT](LICENSE). `vendor/pdfjs/` is Mozilla's [pdf.js](https://github.com/mozilla/pdf.js), licensed under Apache-2.0;
see `LICENSE` in that directory and the license files in its subdirectories.
