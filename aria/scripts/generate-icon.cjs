// Renders aria/electron/assets/aria-logo.svg into a 256x256 app icon PNG
// (aria/electron/assets/aria-icon.png) using Electron's own Chromium as the
// rasterizer — no SVG->PNG dependency (sharp/resvg) is installed, and the
// platform browser via Playwright may not have its binary downloaded.
//
// Icon design: only the FIRST "A" glyph of the ARIA wordmark (the stylized
// triangle-A), tightly cropped via viewBox, centered on a dark rounded square
// with a cyan border — legible even at 16px taskbar size, which the full
// wide wordmark never was.
//
// Run from aria/:  npx electron scripts/generate-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG_PATH = path.join(__dirname, '..', 'electron', 'assets', 'aria-logo.svg');
const OUT_PATH = path.join(__dirname, '..', 'electron', 'assets', 'aria-icon.png');
const SIZE = 256;

// Tight crop around the first "A" glyph of the wordmark. IMPORTANT: these
// are the SVG's OUTER user units (after the internal transform
// translate(0,214) scale(0.1,-0.1)): outer x = 0.1*glyphX, outer y = 214 -
// 0.1*glyphY. The glyph spans outer x ~95..220, outer y ~54..190 (letters
// bottom at glyphY 240, tops at glyphY 1603); the speckle dots (~glyphX
// 995..1853, glyphY 729..1324) are glyph texture and stay inside.
const GLYPH_VIEWBOX = '85 45 145 150';

app.whenReady().then(async () => {
  const svg = fs.readFileSync(SVG_PATH, 'utf8');

  // Reuse the wordmark's <g> (transform + fill) but fit the viewBox to just
  // the first "A" glyph so it fills the icon instead of shrinking to a strip.
  const gMatch = svg.match(/<g[\s\S]*?<\/g>/);
  if (!gMatch) throw new Error('Could not find the <g> element in aria-logo.svg');
  const glyphSvg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${GLYPH_VIEWBOX}" preserveAspectRatio="xMidYMid meet">` +
    gMatch[0] +
    '</svg>';
  const svgDataUri = 'data:image/svg+xml;base64,' + Buffer.from(glyphSvg).toString('base64');

  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;background:transparent;">
  <div style="width:${SIZE}px;height:${SIZE}px;box-sizing:border-box;overflow:hidden;
              border-radius:58px;background:linear-gradient(145deg,#0b1120 0%,#0d1629 55%,#08101d 100%);
              border:5px solid rgba(0,240,255,0.30);
              display:flex;align-items:center;justify-content:center;">
    <img src="${svgDataUri}" style="width:184px;height:184px;display:block;
         filter:drop-shadow(0 0 10px rgba(0,240,255,0.45));"/>
  </div>
</body>
</html>`;

  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true }
  });

  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // Let the image decode/all raster settle before capture.
  await win.webContents.executeJavaScript('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
  await new Promise(r => setTimeout(r, 150));

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT_PATH, image.toPNG());
  console.log('[ICON] written', OUT_PATH, image.getSize());
  app.quit();
}).catch((e) => {
  console.error('[ICON] failed:', e);
  app.quit(1);
});
