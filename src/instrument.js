/* eslint-disable */
// diagram-audit · in-browser instrumentation.
//
// Injected with context.addInitScript() so it runs before any page script. It wraps the
// CanvasRenderingContext2D drawing calls and records, per canvas and per frame, what was drawn
// where: text boxes, shape boxes, non-finite arguments, thrown errors and colour strings the
// browser could not parse. It also collects SVG <text> and HTML text boxes on demand.
//
// It does not judge anything. Judging happens in Node (analyze.mjs), which keeps this file
// small and the verdicts easy to debug. The page under test is not modified.
//
// Frame boundaries: assigning canvas.width/height, a clearRect that covers the whole canvas,
// or an opaque fillRect that covers the whole canvas. Most drawing code does one of these at
// the start of every frame.
//
// Configuration is read from window.__diagramAuditConfig (set by instrumentScript() in audit.mjs):
//   root            CSS selector of the subtree to audit (default: document.body)
//   watermark       exact text of a watermark element to exclude from overlap checks (default: none)
//   normalizeFonts  map generic and system UI font families to Arial-metric fonts (default: true)
//   blockSubmit     prevent form submission while controls are exercised (default: true)
(function () {
  if (window.__auditInstalled) return;
  window.__auditInstalled = true;

  var CFG = window.__diagramAuditConfig || {};
  var NORMALIZE_FONTS = CFG.normalizeFonts !== false;
  var WATERMARK = typeof CFG.watermark === 'string' && CFG.watermark ? CFG.watermark : null;

  function getRoot() {
    if (CFG.root) {
      try {
        var el = document.querySelector(CFG.root);
        if (el) return el;
      } catch (e) {}
    }
    return document.body || document.documentElement;
  }
  window.__auditRoot = getRoot;

  if (CFG.blockSubmit !== false) {
    // Clicking buttons inside a <form> would submit it and navigate away mid-audit.
    document.addEventListener('submit', function (e) { e.preventDefault(); }, true);
  }

  var P = CanvasRenderingContext2D.prototype;
  var canvases = [];
  window.__auditCanvases = canvases;

  var MAX_TEXTS = 1500;
  var MAX_SHAPES = 3000;

  // ── Font normalisation ──────────────────────────────────────────────
  // Measured widths depend on which font the generic family resolves to. On many Linux images
  // sans-serif is DejaVu Sans, which is 8-21% wider than Arial, Helvetica, Segoe UI, SF or Roboto.
  // To measure closer to what real users see, generic and system UI families are mapped to
  // Liberation Sans (metric-compatible with Arial) plus a CJK fallback. If those fonts are not
  // installed the stack falls through to the original generic family.
  var SANS = '"Liberation Sans","WenQuanYi Zen Hei","Noto Sans CJK KR","Noto Sans CJK JP","Noto Sans CJK SC",sans-serif';
  var MONO = '"Liberation Mono","WenQuanYi Zen Hei Mono","Noto Sans Mono CJK KR",monospace';
  var SYS_FAMILY = /^["']?(?:Inter|system-ui|ui-sans-serif|-apple-system|BlinkMacSystemFont|Segoe UI|Roboto|Helvetica Neue|Helvetica|Arial)["']?$/i;
  // The font shorthand is "[style] size[/line-height] family, family...".
  function mapSystemFonts(v) {
    var m = /^(.*?\d*\.?\d+(?:px|pt|em|rem|%)(?:\/\S+)?)\s+(.+)$/.exec(v);
    if (!m) return v;
    var out = [];
    m[2].split(',').forEach(function (f) {
      f = f.trim();
      if (SYS_FAMILY.test(f)) f = '"Liberation Sans"';
      if (out.indexOf(f) < 0) out.push(f);
    });
    return m[1] + ' ' + out.join(', ');
  }
  var fontDesc = Object.getOwnPropertyDescriptor(P, 'font');
  if (NORMALIZE_FONTS) {
    Object.defineProperty(P, 'font', {
      configurable: true,
      enumerable: true,
      get: function () { return fontDesc.get.call(this); },
      set: function (v) {
        v = String(v);
        v = mapSystemFonts(v);
        v = v.replace(/\bsans-serif\s*$/i, SANS).replace(/\bmonospace\s*$/i, MONO);
        fontDesc.set.call(this, v);
      },
    });
  }

  // ── Colour parsing (fillStyle -> [r,g,b,a] | null) ──────────────────
  var tmpCtx = document.createElement('canvas').getContext('2d');
  var colorCache = new Map();
  function parseColor(v) {
    if (typeof v !== 'string') return null; // gradient / pattern
    if (colorCache.has(v)) return colorCache.get(v);
    var out = null;
    try {
      tmpCtx.fillStyle = '#000';
      tmpCtx.fillStyle = v;
      var n = tmpCtx.fillStyle;
      var m;
      if ((m = /^#([0-9a-f]{6})$/i.exec(n))) {
        out = [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
      } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(n))) {
        var p = m[1].split(',').map(function (s) { return parseFloat(s); });
        out = [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      }
    } catch (e) { out = null; }
    colorCache.set(v, out);
    return out;
  }

  // ── Invalid colour strings ──────────────────────────────────────────
  // A canvas silently ignores a colour it cannot parse (for example a 3-digit hex with an alpha
  // suffix glued on: '#aaa' + '33') and keeps the previous colour. Nothing throws; a shape just
  // comes out in the wrong colour. Caught at assignment time.
  var colorBadCache = new Map();
  var fsRaw = Object.getOwnPropertyDescriptor(P, 'fillStyle'); // original, before it is wrapped below
  function colorInvalid(v) {
    if (typeof v !== 'string' || v === '') return false;
    if (colorBadCache.has(v)) return colorBadCache.get(v);
    var bad = false;
    try {
      fsRaw.set.call(tmpCtx, '#000'); fsRaw.set.call(tmpCtx, v); var c1 = fsRaw.get.call(tmpCtx);
      fsRaw.set.call(tmpCtx, '#fff'); fsRaw.set.call(tmpCtx, v); var c2 = fsRaw.get.call(tmpCtx);
      bad = c1 !== c2; // a valid colour replaces the previous one regardless of what it was
    } catch (e) { bad = false; }
    colorBadCache.set(v, bad);
    return bad;
  }
  ['fillStyle', 'strokeStyle', 'shadowColor'].forEach(function (prop) {
    var d = Object.getOwnPropertyDescriptor(P, prop);
    if (!d || !d.set) return;
    Object.defineProperty(P, prop, {
      configurable: true,
      enumerable: true,
      get: function () { return d.get.call(this); },
      set: function (v) {
        if (this !== tmpCtx && colorInvalid(v)) {
          var a = rec(this);
          a.badColorTotal = (a.badColorTotal || 0) + 1;
          if (!a.badColors) a.badColors = [];
          if (a.badColors.length < 12 && !a.badColors.some(function (b) { return b.v === v && b.p === prop; })) a.badColors.push({ p: prop, v: String(v).slice(0, 40) });
        }
        d.set.call(this, v);
      },
    });
  });

  // ── Per-canvas record ───────────────────────────────────────────────
  function rec(ctx) {
    var cv = ctx.canvas;
    var a = cv.__audit;
    if (!a) {
      a = cv.__audit = { texts: [], shapes: [], bad: [], errs: [], frames: 0, ops: 0, badTotal: 0, dropped: 0, badColors: [], badColorTotal: 0 };
      canvases.push(cv);
    }
    return a;
  }
  function resetFrame(cv) {
    var a = cv.__audit;
    if (!a) return;
    a.texts.length = 0;
    a.shapes.length = 0;
    a.bad.length = 0;
    if (a.badColors) a.badColors.length = 0;
    a.badColorTotal = 0;
    a.frames++;
    a.ops = 0;
  }

  ['width', 'height'].forEach(function (k) {
    var d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, k);
    Object.defineProperty(HTMLCanvasElement.prototype, k, {
      configurable: true,
      enumerable: true,
      get: function () { return d.get.call(this); },
      set: function (v) {
        if (!this.__site) { try { this.__site = new Error().stack; } catch (e) {} } // where the drawing code sized this canvas
        if (this.__audit) {
          resetFrame(this);
          this.__clipDepth = 0;
          this.__stk = [];
        }
        d.set.call(this, v);
      },
    });
  });

  // Current transform -> CSS px coordinates
  function mat(ctx) {
    var T = ctx.getTransform();
    var cv = ctx.canvas;
    var sx = cv.width ? (cv.clientWidth || cv.width) / cv.width : 1;
    var sy = cv.height ? (cv.clientHeight || cv.height) / cv.height : 1;
    return { a: T.a * sx, b: T.b * sy, c: T.c * sx, d: T.d * sy, e: T.e * sx, f: T.f * sy };
  }
  function tp(M, x, y) { return [M.a * x + M.c * y + M.e, M.b * x + M.d * y + M.f]; }
  function bboxOf(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
    }
    return [x0, y0, x1, y1];
  }
  function alphaOf(ctx, colorStr) {
    var c = parseColor(colorStr);
    var ga = ctx.globalAlpha;
    if (c) return { rgb: [c[0], c[1], c[2]], a: c[3] * ga, solid: true };
    return { rgb: null, a: ga, solid: false }; // gradient / pattern
  }
  function fontPx(f) {
    var m = /(\d+(?:\.\d+)?)px/.exec(f);
    return m ? parseFloat(m[1]) : 0;
  }

  // ── Text ────────────────────────────────────────────────────────────
  function recText(ctx, kind, text, x, y, maxW) {
    var a = rec(ctx);
    text = String(text);
    if (!text.trim()) return;
    if (a.texts.length >= MAX_TEXTS) { a.dropped++; return; }
    var st = kind === 'fill' ? ctx.fillStyle : ctx.strokeStyle;
    var al = alphaOf(ctx, st);
    if (al.a < 0.04) return; // practically invisible
    var m;
    try { m = ctx.measureText(text); } catch (e) { return; }
    var l = x - m.actualBoundingBoxLeft, r = x + m.actualBoundingBoxRight;
    var t = y - m.actualBoundingBoxAscent, b = y + m.actualBoundingBoxDescent;
    if (typeof maxW === 'number' && maxW > 0 && m.width > maxW) {
      // maxWidth squeezes the text horizontally around the alignment point
      var k = maxW / m.width;
      l = x + (l - x) * k;
      r = x + (r - x) * k;
    }
    var M = mat(ctx);
    var pts = [tp(M, l, t), tp(M, r, t), tp(M, r, b), tp(M, l, b)];
    a.texts.push({
      t: text,
      k: kind,
      pts: pts,
      font: ctx.font,
      px: fontPx(ctx.font),
      col: al.rgb,
      al: al.a,
      clip: !!ctx.canvas.__clipDepth,
      i: a.ops++,
    });
  }

  // ── Shapes ──────────────────────────────────────────────────────────
  function recShape(ctx, kind, box, rect) {
    var a = rec(ctx);
    if (a.shapes.length >= MAX_SHAPES) { a.dropped++; return; }
    var st = kind === 'fill' ? ctx.fillStyle : ctx.strokeStyle;
    var al = alphaOf(ctx, st);
    a.shapes.push({
      k: kind,
      bb: box,
      rect: !!rect,
      col: al.rgb,
      al: al.a,
      solid: al.solid,
      lw: kind === 'stroke' ? ctx.lineWidth : 0,
      clip: !!ctx.canvas.__clipDepth,
      i: a.ops++,
    });
  }
  function pathPoints(ctx) { return ctx.__pp || (ctx.__pp = []); }
  function pushPts(ctx, list) {
    var M = mat(ctx);
    var pp = pathPoints(ctx);
    for (var i = 0; i < list.length; i++) pp.push(tp(M, list[i][0], list[i][1]));
  }

  function coversCanvas(ctx, box) {
    var cv = ctx.canvas;
    var W = cv.clientWidth || cv.width, H = cv.clientHeight || cv.height;
    if (!W || !H) return false;
    var vw = Math.min(box[2], W) - Math.max(box[0], 0);
    var vh = Math.min(box[3], H) - Math.max(box[1], 0);
    return vw * vh >= 0.95 * W * H;
  }

  // ── Wrapping ────────────────────────────────────────────────────────
  function wrap(name, impl) {
    var orig = P[name];
    if (typeof orig !== 'function') return;
    P[name] = function () {
      var args = arguments;
      // A non-finite argument makes the canvas spec silently ignore the call: part of the drawing vanishes.
      for (var i = 0; i < args.length; i++) {
        var v = args[i];
        if (typeof v === 'number' && !isFinite(v)) {
          var a = rec(this);
          a.badTotal++;
          if (a.bad.length < 8) a.bad.push({ m: name, args: Array.prototype.slice.call(args).map(function (x) { return typeof x === 'number' ? x : typeof x === 'string' ? x.slice(0, 20) : '·'; }) });
          break;
        }
      }
      try {
        impl.call(this, args);
      } catch (e) { /* recording errors are swallowed so the page behaves exactly as without the tool */ }
      try {
        return orig.apply(this, args);
      } catch (e) {
        var a2 = rec(this);
        if (a2.errs.length < 6) a2.errs.push({ m: name, msg: String(e && e.message || e).slice(0, 120), args: Array.prototype.slice.call(args).map(function (x) { return typeof x === 'number' ? x : typeof x === 'string' ? x.slice(0, 20) : '·'; }) });
        throw e;
      }
    };
  }

  wrap('fillText', function (a) { recText(this, 'fill', a[0], a[1], a[2], a[3]); });
  wrap('strokeText', function (a) { recText(this, 'stroke', a[0], a[1], a[2], a[3]); });

  wrap('beginPath', function () { this.__pp = []; this.__ppRect = true; });
  wrap('moveTo', function (a) { this.__ppRect = false; pushPts(this, [[a[0], a[1]]]); });
  wrap('lineTo', function (a) { this.__ppRect = false; pushPts(this, [[a[0], a[1]]]); });
  wrap('rect', function (a) { pushPts(this, [[a[0], a[1]], [a[0] + a[2], a[1]], [a[0] + a[2], a[1] + a[3]], [a[0], a[1] + a[3]]]); });
  wrap('roundRect', function (a) { pushPts(this, [[a[0], a[1]], [a[0] + a[2], a[1]], [a[0] + a[2], a[1] + a[3]], [a[0], a[1] + a[3]]]); });
  wrap('arc', function (a) { this.__ppRect = false; var x = a[0], y = a[1], r = Math.abs(a[2]); pushPts(this, [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]]); });
  wrap('ellipse', function (a) { this.__ppRect = false; var x = a[0], y = a[1], rx = Math.abs(a[2]), ry = Math.abs(a[3]); pushPts(this, [[x - rx, y - ry], [x + rx, y - ry], [x + rx, y + ry], [x - rx, y + ry]]); });
  wrap('arcTo', function (a) { this.__ppRect = false; pushPts(this, [[a[0], a[1]], [a[2], a[3]]]); });
  wrap('quadraticCurveTo', function (a) { this.__ppRect = false; pushPts(this, [[a[0], a[1]], [a[2], a[3]]]); });
  wrap('bezierCurveTo', function (a) { this.__ppRect = false; pushPts(this, [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]]]); });

  function shapeFromPath(ctx, kind) {
    var pp = ctx.__pp;
    if (!pp || !pp.length) return;
    var bb = bboxOf(pp);
    if (kind === 'fill' && coversCanvas(ctx, bb)) {
      var al = alphaOf(ctx, ctx.fillStyle);
      if (al.a >= 0.95) resetFrame(ctx.canvas);
    }
    recShape(ctx, kind, bb, ctx.__ppRect !== false);
  }
  wrap('fill', function (a) { if (a.length && typeof a[0] === 'object') return; shapeFromPath(this, 'fill'); });
  wrap('stroke', function (a) { if (a.length && typeof a[0] === 'object') return; shapeFromPath(this, 'stroke'); });

  function rectBox(ctx, x, y, w, h) {
    var M = mat(ctx);
    return bboxOf([tp(M, x, y), tp(M, x + w, y), tp(M, x + w, y + h), tp(M, x, y + h)]);
  }
  wrap('fillRect', function (a) {
    var bb = rectBox(this, a[0], a[1], a[2], a[3]);
    var al = alphaOf(this, this.fillStyle);
    if (coversCanvas(this, bb) && al.a >= 0.95) resetFrame(this.canvas);
    recShape(this, 'fill', bb, true);
  });
  wrap('strokeRect', function (a) { recShape(this, 'stroke', rectBox(this, a[0], a[1], a[2], a[3]), true); });
  wrap('clearRect', function (a) {
    var bb = rectBox(this, a[0], a[1], a[2], a[3]);
    if (coversCanvas(this, bb)) resetFrame(this.canvas);
  });

  // clip and save/restore: text drawn inside a clip may be cut on purpose
  wrap('save', function () { var c = this.canvas; (c.__stk || (c.__stk = [])).push(c.__clipDepth || 0); });
  wrap('restore', function () { var c = this.canvas; c.__clipDepth = c.__stk && c.__stk.length ? c.__stk.pop() : 0; });
  wrap('clip', function () { this.canvas.__clipDepth = (this.canvas.__clipDepth || 0) + 1; });

  // Calls that only need the non-finite argument check
  ['translate', 'scale', 'rotate', 'transform', 'setTransform', 'drawImage', 'createLinearGradient', 'createRadialGradient', 'setLineDash', 'putImageData']
    .forEach(function (n) { wrap(n, function () {}); });

  // ── Snapshot ────────────────────────────────────────────────────────
  function pixelInfo(cv) {
    try {
      var ctx = cv.getContext('2d');
      if (!ctx) return null;
      var W = cv.width, H = cv.height;
      if (!W || !H) return { hash: 0, fill: 0 };
      var d = ctx.getImageData(0, 0, W, H).data;
      var h = 2166136261 >>> 0, n = 0, diff = 0;
      var r0 = d[0], g0 = d[1], b0 = d[2], a0 = d[3];
      var step = 4 * 5;
      for (var i = 0; i < d.length; i += step) {
        var r = d[i], g = d[i + 1], b = d[i + 2], al = d[i + 3];
        h ^= r; h = Math.imul(h, 16777619);
        h ^= g; h = Math.imul(h, 16777619);
        h ^= b; h = Math.imul(h, 16777619);
        h ^= al; h = Math.imul(h, 16777619);
        n++;
        if (Math.abs(r - r0) + Math.abs(g - g0) + Math.abs(b - b0) + Math.abs(al - a0) > 24) diff++;
      }
      return { hash: h >>> 0, fill: n ? diff / n : 0, bg: [r0, g0, b0, a0] };
    } catch (e) { return null; } // a WebGL canvas has no 2D context
  }

  function domPath(el) {
    var parts = [];
    var n = el;
    for (var k = 0; n && k < 3; k++, n = n.parentElement) {
      parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : n.className && typeof n.className === 'string' ? '.' + n.className.split(' ')[0] : ''));
    }
    return parts.join('>');
  }

  window.__auditSnapshot = function () {
    var out = [];
    for (var i = 0; i < canvases.length; i++) {
      var cv = canvases[i];
      var a = cv.__audit;
      if (!a) continue;
      var r = cv.isConnected ? cv.getBoundingClientRect() : null;
      var px = pixelInfo(cv);
      out.push({
        idx: i,
        inDom: cv.isConnected,
        cssW: cv.clientWidth,
        cssH: cv.clientHeight,
        bmpW: cv.width,
        bmpH: cv.height,
        rect: r ? { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height } : null,
        texts: a.texts.slice(),
        shapes: a.shapes.slice(),
        bad: a.bad.slice(),
        badTotal: a.badTotal,
        badColors: (a.badColors || []).slice(),
        badColorTotal: a.badColorTotal || 0,
        errs: a.errs.slice(),
        frames: a.frames,
        dropped: a.dropped,
        hash: px ? px.hash : null,
        fill: px ? px.fill : null,
        webgl: px === null,
        site: cv.__site || null,
        path: cv.isConnected ? domPath(cv) : 'detached',
      });
    }
    return out;
  };

  // ── SVG and HTML text boxes ─────────────────────────────────────────
  // For diagrams that are not canvases (SVG, HTML widgets). Measures each text fragment's screen
  // box and, in the browser, how much of it ancestors with overflow hidden|clip cut away.
  // Overlap is judged in Node (analyzeDom).
  var MAX_DOM_TEXTS = 2500;
  function visibleEl(el) {
    for (var n = el, k = 0; n && n !== document.body && k < 40; n = n.parentElement, k++) {
      var cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
      // screen-reader-only text: clip:rect(0 0 0 0) · clip-path:inset(50%) · 1-2px box with overflow hidden
      if (cs.clip && /^rect\(0(px)?,? ?0(px)?,? ?0(px)?,? ?0(px)?\)$/.test(cs.clip)) return false;
      if (cs.clipPath && /inset\((50|100)%\)/.test(cs.clipPath)) return false;
      if (n.offsetWidth <= 2 && n.offsetHeight <= 2 && cs.overflow !== 'visible') return false;
    }
    return true;
  }
  function tagOf(n) {
    return n.tagName.toLowerCase() + (typeof n.className === 'string' && n.className ? '.' + n.className.split(' ')[0] : '');
  }
  function clipFraction(el, r) {
    // Visible fraction after intersecting with ancestors whose overflow is hidden or clip
    var x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    var area = Math.max((x1 - x0) * (y1 - y0), 1e-6);
    var ix0 = x0, iy0 = y0, ix1 = x1, iy1 = y1;
    var by = null;
    // Text inside a scroll container (overflow auto|scroll) can be scrolled into view, so on that
    // axis neither the container nor its outer boxes count as clipping it (e.g. a wide table
    // wrapped in overflow-x:auto).
    var scrollX = false, scrollY = false;
    for (var n = el.parentElement, k = 0; n && k < 12; n = n.parentElement, k++) {
      var cs = getComputedStyle(n);
      var ox = cs.overflowX, oy = cs.overflowY;
      var scrX = ox === 'auto' || ox === 'scroll', scrY = oy === 'auto' || oy === 'scroll';
      var clipX = (ox === 'hidden' || ox === 'clip') && !scrollX, clipY = (oy === 'hidden' || oy === 'clip') && !scrollY;
      if (scrX) scrollX = true;
      if (scrY) scrollY = true;
      if (!clipX && !clipY) continue;
      if (cs.textOverflow === 'ellipsis') continue; // ellipsis truncation is intentional
      var b = n.getBoundingClientRect();
      if (b.width <= 3 || b.height <= 3) continue; // sr-only and similar
      var bx0 = b.left + (parseFloat(cs.borderLeftWidth) || 0), bx1 = b.right - (parseFloat(cs.borderRightWidth) || 0);
      var by0 = b.top + (parseFloat(cs.borderTopWidth) || 0), by1 = b.bottom - (parseFloat(cs.borderBottomWidth) || 0);
      if (clipX) { ix0 = Math.max(ix0, bx0); ix1 = Math.min(ix1, bx1); }
      if (clipY) { iy0 = Math.max(iy0, by0); iy1 = Math.min(iy1, by1); }
      by = n;
    }
    var vis = (Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0)) / area;
    // The box that is actually visible on screen, for overlap checks: the text box cut by every
    // ancestor that limits what is shown (hidden, clip, and also auto/scroll viewports). Without
    // this, cells scrolled out of view or text cut by an ellipsis cell would "overlap" neighbours.
    var vx0 = x0, vy0 = y0, vx1 = x1, vy1 = y1;
    for (var m = el, q = 0; m && q < 12; m = m.parentElement, q++) {
      var mcs = getComputedStyle(m);
      var mox = mcs.overflowX, moy = mcs.overflowY;
      var mcx = mox === 'hidden' || mox === 'clip' || mox === 'auto' || mox === 'scroll', mcy = moy === 'hidden' || moy === 'clip' || moy === 'auto' || moy === 'scroll';
      if (!mcx && !mcy) continue;
      var mb = m.getBoundingClientRect();
      if (mb.width <= 3 || mb.height <= 3) continue;
      if (mcx) { vx0 = Math.max(vx0, mb.left); vx1 = Math.min(vx1, mb.right); }
      if (mcy) { vy0 = Math.max(vy0, mb.top); vy1 = Math.min(vy1, mb.bottom); }
    }
    // Text completely cut away by ancestors is not visible right now, so it cannot overlap anything.
    // Clipping itself is reported separately through vis.
    var rvHidden = !(vx1 > vx0 && vy1 > vy0);
    return { vis: vis, sx: scrollX, rvHidden: rvHidden, rv: rvHidden ? null : [vx0, vy0, vx1, vy1], by: by ? tagOf(by) : '' };
  }
  function isWatermark(p) {
    if (!WATERMARK) return false;
    for (var n = p, k = 0; n && k < 2; n = n.parentElement, k++) {
      if ((n.textContent || '').trim() === WATERMARK) return true;
    }
    return false;
  }

  window.__auditDom = function () {
    var root = getRoot();
    var sx = window.scrollX, sy = window.scrollY;
    var out = { svg: [], dom: [], hscroll: null, truncated: false, vw: window.innerWidth, docW: document.documentElement.scrollWidth };

    // SVG <text>
    var svgs = root.querySelectorAll('svg');
    for (var si = 0; si < svgs.length; si++) {
      var svg = svgs[si];
      var sr = svg.getBoundingClientRect();
      if (sr.width < 30 || sr.height < 20 || !visibleEl(svg)) continue;
      var svgOverflowVisible = getComputedStyle(svg).overflow === 'visible';
      var texts = svg.querySelectorAll('text');
      for (var ti = 0; ti < texts.length; ti++) {
        var t = texts[ti];
        var str = (t.textContent || '').replace(/\s+/g, ' ').trim();
        if (!str) continue;
        var cs = getComputedStyle(t);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05 || parseFloat(cs.fillOpacity) < 0.05) continue;
        var bb; try { bb = t.getBBox(); } catch (e) { continue; }
        var m = t.getScreenCTM(); if (!m) continue;
        var c = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x + bb.width, bb.y + bb.height], [bb.x, bb.y + bb.height]]
          .map(function (p) { return [m.a * p[0] + m.c * p[1] + m.e + sx, m.b * p[0] + m.d * p[1] + m.f + sy]; });
        var cf = clipFraction(t, t.getBoundingClientRect());
        out.svg.push({
          svg: si, t: str.slice(0, 48), pts: c, px: parseFloat(cs.fontSize) || 0,
          svgBox: [sr.left + sx, sr.top + sy, sr.right + sx, sr.bottom + sy], svgVisible: svgOverflowVisible,
          clipVis: cf.vis, clipBy: cf.by,
        });
        if (out.svg.length + out.dom.length > MAX_DOM_TEXTS) { out.truncated = true; break; }
      }
    }

    // HTML text fragments (one per line box)
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var v = node.nodeValue;
      if (!v || !v.trim()) continue;
      var p = node.parentElement;
      if (!p || p.closest('svg,script,style,noscript,canvas,textarea,option')) continue;
      if (!visibleEl(p)) continue;
      var rg = document.createRange();
      rg.selectNodeContents(node);
      var rects = rg.getClientRects();
      for (var i = 0; i < rects.length; i++) {
        var r = rects[i];
        if (r.width < 2 || r.height < 4) continue;
        var cf2 = clipFraction(p, r);
        out.dom.push({
          wm: isWatermark(p),
          t: v.trim().replace(/\s+/g, ' ').slice(0, 40),
          r: [r.left + sx, r.top + sy, r.right + sx, r.bottom + sy],
          el: tagOf(p),
          pos: getComputedStyle(p).position,
          clipVis: cf2.vis, clipBy: cf2.by, inScrollX: cf2.sx, rvHidden: cf2.rvHidden,
          rv: cf2.rv ? [cf2.rv[0] + sx, cf2.rv[1] + sy, cf2.rv[2] + sx, cf2.rv[3] + sy] : null,
        });
      }
      if (out.svg.length + out.dom.length > MAX_DOM_TEXTS) { out.truncated = true; break; }
    }

    // Horizontal page overflow (mobile) - top 3 elements responsible
    var over = document.documentElement.scrollWidth - window.innerWidth;
    if (over > 2) {
      var culprits = [];
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length && culprits.length < 400; j++) {
        var e = all[j];
        var br = e.getBoundingClientRect();
        if (br.width === 0 || br.right <= window.innerWidth + 2) continue;
        var clipped = false;
        for (var a = e.parentElement; a && a !== document.body; a = a.parentElement) {
          var acs = getComputedStyle(a);
          if (acs.overflowX !== 'visible') { clipped = true; break; }
        }
        if (!clipped) culprits.push({ el: tagOf(e), right: Math.round(br.right), w: Math.round(br.width), t: (e.textContent || '').trim().slice(0, 24) });
      }
      culprits.sort(function (a, b) { return b.right - a.right; });
      out.hscroll = { over: over, culprits: culprits.slice(0, 3) };
    }
    return out;
  };

  window.__auditReset = function () {
    for (var i = 0; i < canvases.length; i++) { try { delete canvases[i].__audit; } catch (e) {} }
    canvases.length = 0;
  };

  // Diagram buttons: everything under the root except page chrome. Share, bookmark, copy, save,
  // quiz and close buttons count as chrome when the label contains those words; pager buttons
  // (previous, next, back to top) only when that is the whole label, so a diagram control such as
  // "Next step" is still exercised. Buttons inside nav, header and footer are chrome too.
  // The list is rebuilt on every click and a button is found again by label + occurrence, because
  // some buttons disappear when pressed ("Reveal") and would shift every later index.
  window.__auditButtons = function () {
    var CHROME_BTN = /공유|share|分享|共有|シェア|compartir|북마크|bookmark|书签|ブックマーク|marcador|즐겨|저장|save|保存|guardar|복사|copy|复制|コピー|copiar|퀴즈|quiz|닫기|close/i;
    var PAGER_BTN = /^(맨 ?위로?|back to top|top|이전|다음|prev|previous|next|上一[页个]?|下一[页个]?|前へ|次へ|anterior|siguiente|arriba)$/i;
    var root = getRoot();
    var out = [];
    root.querySelectorAll('button:not([disabled])').forEach(function (el) {
      var label = ((el.innerText || el.getAttribute('aria-label') || '') + '').replace(/\s+/g, ' ').trim().slice(0, 30);
      if (CHROME_BTN.test(label) || PAGER_BTN.test(label) || el.closest('nav,header,footer')) return;
      out.push({ el: el, label: label });
    });
    return out;
  };

  // Div-based drag sliders: touch-action:none, a thin horizontal bar (width >= 60, height 10-48,
  // aspect ratio >= 3). They are not input[type=range], so they have to be driven with the mouse.
  window.__auditDragSliders = function () {
    var root = getRoot();
    var out = [];
    var divs = root.querySelectorAll('div');
    for (var i = 0; i < divs.length; i++) {
      var el = divs[i];
      if (getComputedStyle(el).touchAction !== 'none') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 60 || r.height < 10 || r.height > 48 || r.width / Math.max(r.height, 1) < 3) continue;
      out.push(el);
    }
    return out;
  };

  // DOM fingerprint for dead-control detection: markup, text and inline styles under the root, so a
  // filter button that only changes colour or opacity still counts as a reaction.
  // excludeRange: index of the range input being tested. The input itself is removed (its
  // background gradient changes with the value) and the printed value ("230 kV") is replaced by a
  // placeholder in its usual spellings (integer, 1-2 decimals, thousands separators), so a slider
  // whose only effect is echoing its own value counts as dead, while result text next to it still counts.
  // excludeDrag: index of the drag slider being tested (its thumb position changes by itself).
  // values: every value the runner tries for this slider. All of them are replaced at every
  // position, so static text that happens to contain one of those numbers reads the same at
  // each position instead of only at the one where it matches.
  window.__auditDomHash = function (excludeRange, excludeDrag, values) {
    var root = getRoot();
    var slider = null;
    if (typeof excludeRange === 'number' && excludeRange >= 0) slider = root.querySelectorAll('input[type=range]')[excludeRange] || null;
    var variants = [];
    if (slider) {
      var nums = Array.isArray(values) && values.length ? values.slice() : [];
      nums.push(parseFloat(slider.value));
      nums.forEach(function (num) {
        if (!isFinite(num)) return;
        [String(num), num.toFixed(1), num.toFixed(2), num.toLocaleString('en-US')].forEach(function (v) { if (v && variants.indexOf(v) < 0) variants.push(v); });
      });
      variants.sort(function (a, b) { return b.length - a.length; });
    }
    var clone = root.cloneNode(true);
    if (slider) {
      var rr = clone.querySelectorAll('input[type=range]')[excludeRange];
      if (rr) rr.remove();
    }
    if (typeof excludeDrag === 'number' && excludeDrag >= 0) {
      var dragEl = window.__auditDragSliders()[excludeDrag];
      if (dragEl) {
        var di = Array.prototype.indexOf.call(root.querySelectorAll('div'), dragEl);
        var dc = di >= 0 ? clone.querySelectorAll('div')[di] : null;
        if (dc) dc.remove();
      }
    }
    clone.querySelectorAll('script,style,canvas').forEach(function (n) { n.remove(); });
    if (variants.length) {
      // Replace the printed value in text nodes only. Replacing it across the serialized markup
      // also hits unrelated attribute numbers (viewBox="0 0 ...", stroke-width="3") differently at
      // every position, which makes a slider that does nothing look alive.
      var res = variants.map(function (v) {
        // whole number tokens only, never part of another number
        return new RegExp('(^|[^0-9.,])' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'g');
      });
      var tw = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
      var tn;
      while ((tn = tw.nextNode())) {
        var tv = tn.nodeValue;
        for (var k = 0; k < res.length; k++) tv = tv.replace(res[k], '$1§');
        tn.nodeValue = tv;
      }
    }
    var s = clone.innerHTML;
    var h = 2166136261 >>> 0;
    for (var j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
})();
