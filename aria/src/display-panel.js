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
      fig.innerHTML = sanitizeSvg(body);
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
  _typesetHtml(text) {
    const esc = (s) => s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let out = String(text)
      .split(/\n{2,}/)
      .map((para) => `<p>${esc(para.trim()).replace(/\n/g, '<br>')}</p>`)
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
