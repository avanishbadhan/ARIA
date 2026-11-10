/**
 * ARIA Display — the big popup canvas for visual answers.
 *
 * When ARIA has something to SHOW (a Wolfram math result, a diagram or a
 * drawing the model produced as SVG), the answer opens on a large centered
 * panel covering roughly 80% of the screen. While it is open the AI core
 * (neural sphere) flies down into the bottom-right corner as a live widget
 * with a motion-graphics transition, and flies back when the panel closes.
 *
 * Math answers are typeset with KaTeX when one loads (CDN, lazy) and plain
 * text otherwise; SVG drawings are sanitized before insertion.
 */

// Pure string sanitizer for SVG coming from the LLM (testable in node).
// Strips executable/scripting surface: scripts, inline event handlers,
// javascript: URLs, and foreignObject (HTML-in-SVG) blocks.
export function sanitizeSvg(svg) {
  return String(svg || '')
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<foreignObject[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '');
}

const ROOT_SVG_RE = /<svg\b([^>]*)>/i;
const SVG_DIM_RE = /\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

function stripFixedDims(svgText) {
  return svgText.replace(ROOT_SVG_RE, (tag, attrs) => `<svg${attrs.replace(SVG_DIM_RE, '')}>`);
}

/**
 * Pure string normalizer for SVG coming from the LLM (testable in node).
 * Models often emit an SVG with fixed width/height attributes and NO
 * viewBox — CSS then rescales the viewport but the shapes keep drawing at
 * their raw coordinate size, so the picture explodes far past the panel
 * (observed: the solar system render was miles too big). Rebuild the root
 * tag here: derive a viewBox from width/height when missing, drop the fixed
 * dimensions, and widen the canvas to the real content bounds when the
 * model drew past its own viewBox. Renderer path uses DOMParser; in node
 * tests (no DOM) it degrades to dimension-stripping.
 */
export function normalizeSvg(svg) {
  const svgText = String(svg || '');
  if (!ROOT_SVG_RE.test(svgText)) return svgText;
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const el = doc.querySelector('svg');
      if (el && el.querySelector) {
        const existing = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
        if (existing.length === 4 && existing.every(n => !Number.isNaN(n))) {
          var [vx, vy, vw, vh] = existing;
        } else {
          var vx = 0, vy = 0;
          var vw = parseFloat(el.getAttribute('width')) || 400;
          var vh = parseFloat(el.getAttribute('height')) || 300;
        }
        el.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
        el.removeAttribute('width');
        el.removeAttribute('height');
        el.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        const expanded = _expandViewBoxToContent(el, vx, vy, vw, vh);
        if (expanded) el.setAttribute('viewBox', expanded);
        return new XMLSerializer().serializeToString(el);
      }
    } catch (e) { /* fall through to the string path */ }
  }
  return stripFixedDims(svgText);
}

/**
 * Estimates the content bounding box of a parsed SVG document from its
 * coordinate attributes (cx/x/x1…, r/width as extents, labels approximated
 * by character count) and returns a wider viewBox when the shapes overflow
 * the declared canvas. Only usable with a real DOM — the node-test stubs
 * carry no querySelectorAll and are skipped.
 */
function _expandViewBoxToContent(root, vx, vy, vw, vh) {
  if (typeof root.querySelectorAll !== 'function') return null;
  let minX = vx, minY = vy, maxX = vx + vw, maxY = vy + vh;
  const num = (node, name) => {
    const v = parseFloat(node.getAttribute(name));
    return Number.isNaN(v) ? null : v;
  };
  const nodes = root.querySelectorAll('*');
  for (const node of nodes) {
    const cx = num(node, 'cx'), cy = num(node, 'cy'), r = num(node, 'r') || 0;
    if (cx !== null || cy !== null) {
      if (cx !== null) { minX = Math.min(minX, cx - r); maxX = Math.max(maxX, cx + r); }
      if (cy !== null) { minY = Math.min(minY, cy - r); maxY = Math.max(maxY, cy + r); }
    }
    const x = num(node, 'x'), y = num(node, 'y');
    const rw = num(node, 'width'), rh = num(node, 'height');
    const isText = (node.tagName || '').toLowerCase() === 'text';
    if (x !== null) {
      let x0 = x, x1 = x + (rw || 0);
      if (isText) {
        const fs = num(node, 'font-size') || 14;
        const estW = String(node.textContent || '').length * fs * 0.62;
        const anchor = (node.getAttribute('text-anchor') || 'start').toLowerCase();
        if (anchor === 'middle') { x0 = x - estW / 2; x1 = x + estW / 2; }
        else if (anchor === 'end') { x0 = x - estW; x1 = x; }
        else x1 = x + estW;
      }
      minX = Math.min(minX, x0); maxX = Math.max(maxX, x1);
    }
    if (y !== null) {
      minY = Math.min(minY, y - (isText ? 14 : 0));
      maxY = Math.max(maxY, y + (rh || (isText ? 4 : 0)));
    }
    const x1a = num(node, 'x1'), y1a = num(node, 'y1'), x2a = num(node, 'x2'), y2a = num(node, 'y2');
    for (const [px, py] of [[x1a, y1a], [x2a, y2a]]) {
      if (px !== null) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); }
      if (py !== null) { minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
    }
  }
  if (minX < vx || minY < vy || maxX > vx + vw || maxY > vy + vh) {
    const padX = 0.03 * (maxX - minX);
    const padY = 0.03 * (maxY - minY);
    return [minX - padX, minY - padY, (maxX - minX) + 2 * padX, (maxY - minY) + 2 * padY]
      .map(v => Math.round(v * 10) / 10).join(' ');
  }
  return null;
}

const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
const KATEX_JS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js';
const DOCK_WIDGET_WIDTH = 210;   // px of the docked sphere widget (wide edge)
const DOCK_MARGIN = 26;           // px from window edges
const DOCK_MS = 820;              // keep in sync with the CSS transition

export class DisplayPanel {
  constructor({ stageEl, panelEl, titleEl, bodyEl, closeBtnEl } = {}) {
    this.stageEl = stageEl || null;
    this.panelEl = panelEl || null;
    this.titleEl = titleEl || null;
    this.bodyEl = bodyEl || null;
    this.closeBtnEl = closeBtnEl || null;
    this.isOpen = false;
    this._onKey = (e) => {
      if (e.key === 'Escape' && this.isOpen) { e.stopPropagation(); this.close(); }
    };
    if (this.closeBtnEl) {
      this.closeBtnEl.addEventListener('click', () => this.close());
    }
    window.addEventListener('keydown', this._onKey);
    // Keep the docked widget pinned to the corner if the window resizes
    // while the display is open.
    this._onResize = () => { if (this.isOpen) this._dock(true); };
    window.addEventListener('resize', this._onResize);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('resize', this._onResize);
  }

  open({ title = 'Display', body = '', kind = 'text' } = {}) {
    if (!this.panelEl || !this.bodyEl) {
      console.warn('[ARIA-DISPLAY] panel markup missing — nothing to show');
      return;
    }
    this._fill({ title, body, kind });
    this.panelEl.hidden = false;
    this.isOpen = true;
    // Restart the entrance animation each time it opens.
    this.panelEl.classList.remove('enter');
    void this.panelEl.offsetWidth;
    this.panelEl.classList.add('enter');
    document.body.classList.add('display-open');
    this._commandDockFlight();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panelEl.hidden = true;
    document.body.classList.remove('display-open');
    this._commandDockFlight(true);
  }

  // ---- Content rendering ------------------------------------------------
  _fill({ title, body, kind }) {
    if (this.titleEl) this.titleEl.textContent = title || 'Display';
    this.bodyEl.innerHTML = '';
    if (kind === 'svg') {
      const fig = document.createElement('div');
      fig.className = 'display-figure';
      fig.innerHTML = normalizeSvg(sanitizeSvg(body));
      this.bodyEl.appendChild(fig);
      // Scale the drawing to the panel: SVGs produced without a viewBox
      // still stretch to fit because the container is a flex box.
    } else {
      this._fillText(String(body || ''));
    }
  }

  _fillText(text) {
    const wrap = document.createElement('div');
    wrap.className = 'display-prose';
    this._paraIndex = 0;
    // Render inline `$math$` / display `$$math$$` with KaTeX when available.
    const mathSpans = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
    const hasMath = mathSpans.test(text);
    if (hasMath) {
      this._ensureKatex(() => {
        wrap.innerHTML = this._typesetHtml(text);
        this.bodyEl.appendChild(wrap);
      });
    } else {
      wrap.innerHTML = this._typesetHtml(text);
      this.bodyEl.appendChild(wrap);
    }
  }

  // Escape everything, then render trusted math fragments via KaTeX.
  // Each paragraph carries an --i stagger index so CSS can cascade the
  // entrance animation; a paragraph that begins with "Answer:" is flagged
  // as the summary line and styled as such.
  _typesetHtml(text) {
    const esc = (s) => s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let out = String(text)
      .split(/\n{2,}/)
      .map((para) => {
        const trimmed = para.trim();
        const i = this._paraIndex++;
        const cls = /^answer[:.\s]/i.test(trimmed) ? ' p-answer' : '';
        return `<p class="display-p${cls}" style="--i:${i}">${esc(trimmed).replace(/\n/g, '<br>')}</p>`;
      })
      .join('');
    if (window.katex) {
      out = out.replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => {
        try { return window.katex.renderToString(m.trim(), { displayMode: true, throwOnError: false }); }
        catch (e) { return `<span class="math-raw">$$${m}$$</span>`; }
      }).replace(/\$([^$\n]+?)\$/g, (_, m) => {
        try { return window.katex.renderToString(m.trim(), { throwOnError: false }); }
        catch (e) { return `<span class="math-raw">$${m}$</span>`; }
      });
    } else if (/\$[^$\n]+\$/.test(out)) {
      out = `<div class="math-plain">${out}</div>`;
    }
    return out;
  }

  _ensureKatex(cb) {
    if (window.katex) return cb(true);
    if (this._katexLoadStarted) { setTimeout(() => cb(Boolean(window.katex)), 600); return; }
    this._katexLoadStarted = true;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = KATEX_CSS;
    document.head.appendChild(link);
    const script = document.createElement('script');
    script.src = KATEX_JS;
    script.onload = () => cb(true);
    script.onerror = () => cb(false);
    document.head.appendChild(script);
    // Never hold up content longer than ~2.5s if the CDN is unreachable.
    setTimeout(() => cb(Boolean(window.katex)), 2500);
  }

  // ---- Core dock choreography -------------------------------------------
  // The motion: the core shrinks and flies into the bottom-right corner
  // (CSS transition supplies the eased flight; the ring flash runs on a
  // body class), and reverses back to center on close.
  _commandDockFlight(reverting = false) {
    const stage = this.stageEl;
    if (!stage) return;
    document.body.classList.remove('display-docking');
    void document.body.offsetWidth;
    document.body.classList.add('display-docking');
    clearTimeout(this._dockAnimTimer);
    this._dockAnimTimer = setTimeout(() => {
      document.body.classList.remove('display-docking');
    }, DOCK_MS);
    if (reverting) {
      this._restoreStageTransform();
    } else {
      this._dock();
    }
  }

  _dock(skipTransition = false) {
    const stage = this.stageEl;
    const r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const scale = Math.max(0.12, Math.min(0.24, DOCK_WIDGET_WIDTH / Math.max(1, r.width)));
    let baseCx = r.left + r.width / 2;
    let baseCy = r.top + r.height / 2;
    let baseW = r.width;
    if (this._dockOffset) {
      // When re-docking (window resize while open) the live rect is already
      // transformed — undo the previous flight to recover the resting rect.
      baseCx -= this._dockOffset.dx;
      baseCy -= this._dockOffset.dy;
      baseW = baseW / this._dockOffset.scale;
    }
    const targetCx = window.innerWidth - DOCK_MARGIN - (baseW * scale) / 2;
    const targetCy = window.innerHeight - DOCK_MARGIN - (baseW * scale) / 2;
    const dx = targetCx - baseCx;
    const dy = targetCy - baseCy;
    this._dockOffset = { dx, dy, scale };
    if (skipTransition) {
      stage.style.transition = 'none';
      stage.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)})`;
      void stage.offsetWidth;
      stage.style.transition = '';
    } else {
      stage.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    }
  }

  _restoreStageTransform() {
    const stage = this.stageEl;
    if (!stage) return;
    stage.style.transform = '';
    this._dockOffset = null;
  }
}
