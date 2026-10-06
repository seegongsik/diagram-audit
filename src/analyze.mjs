// diagram-audit · verdicts.
//
// Pure functions that turn what instrument.js recorded into a list of issues. No browser needed,
// which is why the self-test can call them directly.
//
// Severity
//   1  defect          TEXT_OVERLAP (25%+) · TEXT_CLIP (under 90% visible) · TEXT_OFFCANVAS ·
//                      TEXT_OCCLUDED (an opaque rectangle drawn later covers 50%+) · NONFINITE ·
//                      CANVAS_THROW · INVALID_COLOR
//   2  likely defect   TEXT_OVERLAP (8-25%) · TEXT_CLIP (90-97%) · TEXT_OCCLUDED (40-50%) · BLANK ·
//                      ZERO_SIZE · TEXT_TINY (under 6px: hiding an overlap by shrinking the text)
//   3  review          TEXT_ON_EDGE · EMPTY_BAND · WATERMARK_COVERS
//
// All coordinates are CSS px relative to the canvas's top-left corner.

export const THRESH = {
  overlapMinDim: 1.5, // px: the overlap must be wider and taller than this
  overlapS2: 0.08,
  overlapS1: 0.25,
  clipS2: 0.97,
  clipS1: 0.9,
  offcanvas: 0.02,
  occludeS2: 0.4,
  occludeS1: 0.5,
  erased: 0.9, // a rectangle drawn later that covers this much means "erased and redrawn": drop the old text
  edgeMin: 0.06,
  edgeMax: 0.85,
  edgeShapeMinArea: 500,
  duplicatePx: 2.5, // the same string drawn twice within this distance is an outline or shadow, not an overlap
  visibleAlpha: 0.2,
  tinyPx: 6,
};

// ── Geometry ────────────────────────────────────────────────────────
function polyArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}
function aabb(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
// Sutherland-Hodgman: clip convex polygon `subject` by convex polygon `clipper`
function clipPoly(subject, clipper) {
  let cp = clipper;
  let s = 0;
  for (let i = 0; i < cp.length; i++) {
    const [x1, y1] = cp[i];
    const [x2, y2] = cp[(i + 1) % cp.length];
    s += x1 * y2 - x2 * y1;
  }
  if (s < 0) cp = cp.slice().reverse(); // counter-clockwise clipper
  let out = subject;
  for (let i = 0; i < cp.length && out.length; i++) {
    const a = cp[i];
    const b = cp[(i + 1) % cp.length];
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const inter = (p, q) => {
      const A1 = q[1] - p[1], B1 = p[0] - q[0], C1 = A1 * p[0] + B1 * p[1];
      const A2 = b[1] - a[1], B2 = a[0] - b[0], C2 = A2 * a[0] + B2 * a[1];
      const det = A1 * B2 - A2 * B1;
      if (Math.abs(det) < 1e-12) return q;
      return [(B2 * C1 - B1 * C2) / det, (A1 * C2 - A2 * C1) / det];
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(inter(prev, cur));
        out.push(cur);
      } else if (inside(prev)) out.push(inter(prev, cur));
    }
  }
  return out;
}
function interPoly(p, q) {
  const r = clipPoly(p, q);
  return r.length >= 3 ? r : [];
}
function boxPoly(b) {
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
}

// ── Canvas ──────────────────────────────────────────────────────────
/**
 * @param {object} c     one entry of window.__auditSnapshot()
 * @param {object} [th]  thresholds (THRESH)
 * @param {{watermark?: string}} [opts]  watermark: exact text of a watermark drawn on the canvas
 * @returns {Array<{type:string, sev:1|2|3, detail:object}>}
 */
export function analyzeCanvas(c, th = THRESH, opts = {}) {
  const issues = [];
  const W = c.cssW || c.bmpW;
  const H = c.cssH || c.bmpH;

  if (c.inDom && (!c.cssW || !c.cssH)) issues.push({ type: 'ZERO_SIZE', sev: 2, detail: { cssW: c.cssW, cssH: c.cssH } });
  if (c.badTotal > 0) issues.push({ type: 'NONFINITE', sev: 1, detail: { total: c.badTotal, calls: c.bad } });
  if (c.errs && c.errs.length) issues.push({ type: 'CANVAS_THROW', sev: 1, detail: { errs: c.errs } });
  if (c.badColorTotal > 0) issues.push({ type: 'INVALID_COLOR', sev: 1, detail: { total: c.badColorTotal, colors: c.badColors } });

  const nDraw = c.texts.length + c.shapes.length;
  if (c.inDom && c.cssW && c.cssH && !c.webgl && c.fill !== null && c.fill < 0.002 && c.texts.length === 0 && c.shapes.length <= 2) {
    issues.push({ type: 'BLANK', sev: 2, detail: { fill: c.fill, shapes: c.shapes.length } });
  }
  if (!c.inDom || !W || !H || nDraw === 0) return issues;

  // Opaque filled rectangles, for occlusion
  const opaqueRects = c.shapes.filter((s) => s.k === 'fill' && s.rect && s.solid && s.al >= 0.95);
  const texts = c.texts.filter((t) => t.al >= th.visibleAlpha);

  // How much of each text is covered by an opaque rectangle drawn after it
  const hidden = new Map();
  for (const t of texts) {
    const tb = aabb(t.pts);
    const ta = Math.max(polyArea(t.pts), 1e-6);
    let worst = 0;
    for (const s of opaqueRects) {
      if (s.i < t.i) continue; // drawn before the text: background
      const ib = [Math.max(tb[0], s.bb[0]), Math.max(tb[1], s.bb[1]), Math.min(tb[2], s.bb[2]), Math.min(tb[3], s.bb[3])];
      if (ib[2] <= ib[0] || ib[3] <= ib[1]) continue;
      const cov = polyArea(interPoly(t.pts, boxPoly(s.bb))) / ta;
      if (cov > worst) worst = cov;
    }
    hidden.set(t, worst);
  }
  const liveAll = texts.filter((t) => (hidden.get(t) || 0) < th.erased);
  // A watermark is kept out of the overlap checks and judged separately
  const isWm = (t) => !!opts.watermark && t.t === opts.watermark;
  const wmTexts = liveAll.filter(isWm);
  const live = liveAll.filter((t) => !isWm(t));
  for (const w of wmTexts) {
    const wa = Math.max(polyArea(w.pts), 1e-6);
    for (const t of live) {
      const cov = polyArea(interPoly(w.pts, t.pts)) / wa;
      if (cov >= 0.08) { issues.push({ type: 'WATERMARK_COVERS', sev: 3, detail: { text: t.t, ratio: +cov.toFixed(2), at: pos(t) } }); break; }
    }
  }
  for (const t of texts) {
    const cov = hidden.get(t) || 0;
    if (cov >= th.occludeS2 && cov < th.erased) {
      issues.push({ type: 'TEXT_OCCLUDED', sev: cov >= th.occludeS1 ? 1 : 2, detail: { text: t.t, covered: +cov.toFixed(2), at: pos(t) } });
    }
  }

  // Unreadably small text. Shrinking text until it stops overlapping is not a fix.
  const tiny = live.filter((t) => t.px > 0 && t.px < th.tinyPx);
  if (tiny.length) issues.push({ type: 'TEXT_TINY', sev: 2, detail: { text: tiny[0].t, px: +tiny[0].px.toFixed(1), n: tiny.length } });

  // Cut off by the canvas edge
  for (const t of live) {
    if (t.clip) continue;
    const ta = Math.max(polyArea(t.pts), 1e-6);
    const vis = polyArea(interPoly(t.pts, boxPoly([-0.5, -0.5, W + 0.5, H + 0.5]))) / ta;
    if (vis < th.offcanvas) issues.push({ type: 'TEXT_OFFCANVAS', sev: 1, detail: { text: t.t, at: pos(t), canvas: [W, H] } });
    else if (vis < th.clipS2) issues.push({ type: 'TEXT_CLIP', sev: vis < th.clipS1 ? 1 : 2, detail: { text: t.t, visible: +vis.toFixed(2), at: pos(t), canvas: [W, H] } });
  }

  // Text on text
  const n = live.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = live[i], b = live[j];
      const ab = aabb(a.pts), bb = aabb(b.pts);
      const ow = Math.min(ab[2], bb[2]) - Math.max(ab[0], bb[0]);
      const oh = Math.min(ab[3], bb[3]) - Math.max(ab[1], bb[1]);
      if (ow <= th.overlapMinDim || oh <= th.overlapMinDim) continue;
      if (a.t === b.t && Math.abs(ab[0] - bb[0]) <= th.duplicatePx && Math.abs(ab[1] - bb[1]) <= th.duplicatePx) continue; // outline / shadow
      const inter = polyArea(interPoly(a.pts, b.pts));
      const ratio = inter / Math.max(Math.min(polyArea(a.pts), polyArea(b.pts)), 1e-6);
      if (ratio < th.overlapS2) continue;
      issues.push({
        type: 'TEXT_OVERLAP',
        sev: ratio >= th.overlapS1 ? 1 : 2,
        detail: { a: a.t, b: b.t, ratio: +ratio.toFixed(2), ow: +ow.toFixed(1), oh: +oh.toFixed(1), atA: pos(a), atB: pos(b) },
      });
    }
  }

  // Large empty band at the bottom (review): the canvas is taller than its content.
  // Background fills and the watermark are not content.
  {
    let bottom = 0;
    for (const t of live) bottom = Math.max(bottom, aabb(t.pts)[3]);
    for (const sh of c.shapes) if (!coversAll(sh, W, H)) bottom = Math.max(bottom, sh.bb[3]);
    if (H >= 200 && bottom > 0 && (H - bottom) / H > 0.3) issues.push({ type: 'EMPTY_BAND', sev: 3, detail: { emptyPx: Math.round(H - bottom), of: Math.round(H) } });
  }

  // Text straddling the edge of a large filled rectangle (review)
  const bigRects = c.shapes.filter((s) => s.k === 'fill' && s.rect && s.al >= 0.12 && (s.bb[2] - s.bb[0]) * (s.bb[3] - s.bb[1]) >= th.edgeShapeMinArea && !coversAll(s, W, H));
  for (const t of live) {
    const ta = Math.max(polyArea(t.pts), 1e-6);
    for (const s of bigRects) {
      if (s.i > t.i) continue; // drawn after the text: occlusion handles it
      const cov = polyArea(interPoly(t.pts, boxPoly(s.bb))) / ta;
      if (cov > th.edgeMin && cov < th.edgeMax) {
        issues.push({ type: 'TEXT_ON_EDGE', sev: 3, detail: { text: t.t, covered: +cov.toFixed(2), shape: s.bb.map((v) => +v.toFixed(0)), at: pos(t) } });
        break;
      }
    }
  }
  return issues;
}

function coversAll(s, W, H) {
  return s.bb[0] <= 1 && s.bb[1] <= 1 && s.bb[2] >= W - 1 && s.bb[3] >= H - 1;
}
function pos(t) {
  const b = aabb(t.pts);
  return [b[0], b[1], b[2], b[3]].map((v) => +v.toFixed(0));
}

/** Issue signature: the same defect seen in several control states gets the same value. */
export function issueSig(i) {
  const d = i.detail || {};
  switch (i.type) {
    case 'TEXT_OVERLAP': return `${i.type}|${d.a}|${d.b}`;
    case 'TEXT_CLIP':
    case 'TEXT_OFFCANVAS':
    case 'TEXT_OCCLUDED':
    case 'TEXT_ON_EDGE':
    case 'WATERMARK_COVERS': return `${i.type}|${d.text}`;
    case 'EMPTY_BAND':
    case 'TEXT_TINY': return i.type;
    case 'INVALID_COLOR': return `${i.type}|${(d.colors || []).map((x) => x.p + ':' + x.v).join(',')}`;
    case 'NONFINITE': return `${i.type}|${(d.calls || []).map((c) => c.m).join(',')}`;
    case 'CANVAS_THROW': return `${i.type}|${(d.errs || []).map((e) => e.m + ':' + e.msg).join(',')}`;
    default: return i.type;
  }
}

// ── SVG and HTML ────────────────────────────────────────────────────
// Judges window.__auditDom(). Text boxes are font boxes (ascent + descent), taller than the ink,
// so they are shrunk vertically by 20% (10% top and bottom) to keep tightly set paragraphs from
// reading as overlaps.
export const DOM_THRESH = {
  shrinkH: 0.8,
  svgOverlapS2: 0.12,
  svgOverlapS1: 0.3,
  domOverlapS2: 0.2,
  domOverlapS1: 0.4,
  minDim: 2,
  clipS2: 0.9,
  clipS1: 0.6,
  svgClipS2: 0.97,
  svgClipS1: 0.9,
  hscrollMin: 2,
};

function shrinkPoly(pts) {
  const ys = pts.map((p) => p[1]);
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  // shrink along screen y only; rotated SVG text is left as is
  const rot = Math.abs(pts[0][1] - pts[1][1]) > 0.5;
  if (rot) return pts;
  return pts.map(([x, y]) => [x, mid + (y - mid) * DOM_THRESH.shrinkH]);
}

/**
 * @param {object} d  result of window.__auditDom()
 * @returns {Array<{type:string, sev:1|2|3, detail:object}>}
 */
export function analyzeDom(d, th = DOM_THRESH) {
  const issues = [];

  // SVG text: overlap, outside the svg, cut by an ancestor's overflow
  const bySvg = new Map();
  for (const t of d.svg) (bySvg.get(t.svg) || bySvg.set(t.svg, []).get(t.svg)).push(t);
  for (const [, list] of bySvg) {
    for (const t of list) {
      const ta = Math.max(polyArea(t.pts), 1e-6);
      if (!t.svgVisible) {
        const vis = polyArea(interPoly(t.pts, boxPoly(t.svgBox))) / ta;
        if (vis < 0.02) issues.push({ type: 'SVG_TEXT_OFFSVG', sev: 1, detail: { text: t.t, box: rnd(aabb(t.pts)) } });
        else if (vis < th.svgClipS2) issues.push({ type: 'SVG_TEXT_CLIP', sev: vis < th.svgClipS1 ? 1 : 2, detail: { text: t.t, visible: +vis.toFixed(2), box: rnd(aabb(t.pts)) } });
      }
      if (t.clipVis < th.clipS2 && t.svgVisible !== false) {
        issues.push({ type: 'SVG_TEXT_CLIP', sev: t.clipVis < th.clipS1 ? 1 : 2, detail: { text: t.t, visible: +t.clipVis.toFixed(2), by: t.clipBy, box: rnd(aabb(t.pts)) } });
      }
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const pa = shrinkPoly(a.pts), pb = shrinkPoly(b.pts);
        const ab = aabb(pa), bb = aabb(pb);
        const ow = Math.min(ab[2], bb[2]) - Math.max(ab[0], bb[0]);
        const oh = Math.min(ab[3], bb[3]) - Math.max(ab[1], bb[1]);
        if (ow <= 1.5 || oh <= 1.5) continue;
        if (a.t === b.t && Math.abs(ab[0] - bb[0]) < 2.5 && Math.abs(ab[1] - bb[1]) < 2.5) continue;
        const ratio = polyArea(interPoly(pa, pb)) / Math.max(Math.min(polyArea(pa), polyArea(pb)), 1e-6);
        if (ratio < th.svgOverlapS2) continue;
        issues.push({ type: 'SVG_TEXT_OVERLAP', sev: ratio >= th.svgOverlapS1 ? 1 : 2, detail: { a: a.t, b: b.t, ratio: +ratio.toFixed(2), atA: rnd(ab), atB: rnd(bb) } });
      }
    }
  }

  // HTML text: clipping and overlap
  for (const t of d.dom) {
    if (t.wm) continue;
    if (t.clipVis < th.clipS2) issues.push({ type: 'DOM_TEXT_CLIPPED', sev: t.clipVis < th.clipS1 ? 1 : 2, detail: { text: t.t, visible: +t.clipVis.toFixed(2), by: t.clipBy, el: t.el } });
  }
  // Overlap is measured on the visible box (rv: cut by clipping ancestors) when there is one.
  // Text that ancestors cut away completely (rvHidden) is not visible and cannot overlap.
  const L = d.dom.filter((t) => !t.wm && !t.rvHidden).map((t) => {
    const v = t.rv || t.r;
    return { ...t, r2: [v[0], (v[1] + v[3]) / 2 - ((v[3] - v[1]) * th.shrinkH) / 2, v[2], (v[1] + v[3]) / 2 + ((v[3] - v[1]) * th.shrinkH) / 2] };
  });
  L.sort((a, b) => a.r2[1] - b.r2[1]);
  for (let i = 0; i < L.length; i++) {
    const a = L[i];
    for (let j = i + 1; j < L.length; j++) {
      const b = L[j];
      if (b.r2[1] >= a.r2[3]) break; // sorted by y: nothing further down can overlap
      const ow = Math.min(a.r2[2], b.r2[2]) - Math.max(a.r2[0], b.r2[0]);
      const oh = Math.min(a.r2[3], b.r2[3]) - Math.max(a.r2[1], b.r2[1]);
      if (ow <= th.minDim || oh <= th.minDim) continue;
      // Fixed overlays (toasts, cookie banners) sit on top of content by design
      if (a.pos === 'fixed' || b.pos === 'fixed') continue;
      // Same text starting at the same spot: two fragments of one text node (ellipsis returns two rects)
      if (a.t === b.t && Math.abs(a.r[0] - b.r[0]) < 2.5 && Math.abs(a.r[1] - b.r[1]) < 2.5) continue;
      const inter = ow * oh;
      const ratio = inter / Math.max(Math.min((a.r2[2] - a.r2[0]) * (a.r2[3] - a.r2[1]), (b.r2[2] - b.r2[0]) * (b.r2[3] - b.r2[1])), 1e-6);
      if (ratio < th.domOverlapS2) continue;
      issues.push({ type: 'DOM_TEXT_OVERLAP', sev: ratio >= th.domOverlapS1 ? 1 : 2, detail: { a: a.t, b: b.t, ratio: +ratio.toFixed(2), elA: a.el, elB: b.el, atA: rnd(a.r), atB: rnd(b.r) } });
    }
  }

  // Text running off the right edge of the viewport. Sites with body{overflow-x:hidden} cannot
  // even be scrolled to it. Box coordinates alone miss text that escapes its box (nowrap etc.).
  const beyond = [];
  for (const t of d.dom) {
    if (t.wm || t.clipVis < 0.9 || t.inScrollX) continue; // inside a horizontal scroller (tables): reachable
    if (t.r[2] > d.vw + 2) {
      const w = Math.max(t.r[2] - t.r[0], 1e-6);
      const vis = Math.max(0, d.vw - t.r[0]) / w;
      beyond.push({ t, vis });
    }
  }
  if (beyond.length) {
    const worst = beyond.reduce((a, b) => (b.vis < a.vis ? b : a));
    issues.push({ type: 'DOM_TEXT_BEYOND_VIEWPORT', sev: worst.vis < 0.6 ? 1 : 2, detail: { text: worst.t.t, visible: +worst.vis.toFixed(2), n: beyond.length, el: worst.t.el, at: rnd(worst.t.r), vw: d.vw } });
  }

  if (d.hscroll && d.hscroll.over > th.hscrollMin) {
    issues.push({ type: 'PAGE_HSCROLL', sev: 2, detail: { over: d.hscroll.over, vw: d.vw, culprits: d.hscroll.culprits } });
  }
  return issues;
}
const rnd = (a) => a.map((v) => +v.toFixed(0));

export function domIssueSig(i) {
  const d = i.detail || {};
  switch (i.type) {
    case 'SVG_TEXT_OVERLAP':
    case 'DOM_TEXT_OVERLAP': return `${i.type}|${d.a}|${d.b}`;
    case 'PAGE_HSCROLL':
    case 'DOM_TEXT_BEYOND_VIEWPORT': return i.type + '|' + (d.el || '');
    default: return `${i.type}|${d.text}`;
  }
}

// ── HTML watermark over canvas text ─────────────────────────────────
// snaps = __auditSnapshot(), dom = __auditDom().dom. The watermark box is measured per canvas:
// with several canvases, a page-wide union grows so large that the ratio never crosses the threshold.
export function analyzeWatermark(snaps, dom) {
  const out = [];
  const wm = dom.filter((t) => t.wm).map((t) => t.r);
  if (!wm.length) return out;
  for (const c of snaps) {
    if (!c.rect) continue;
    const near = wm.filter((r) => r[2] > c.rect.x - 30 && r[0] < c.rect.x + c.rect.w + 30 && r[3] > c.rect.y - 30 && r[1] < c.rect.y + c.rect.h + 30);
    if (!near.length) continue;
    const W = [Math.min(...near.map((r) => r[0])), Math.min(...near.map((r) => r[1])), Math.max(...near.map((r) => r[2])), Math.max(...near.map((r) => r[3]))];
    for (const t of c.texts) {
      const xs = t.pts.map((p) => p[0] + c.rect.x), ys = t.pts.map((p) => p[1] + c.rect.y);
      const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const ow = Math.min(b[2], W[2]) - Math.max(b[0], W[0]);
      const oh = Math.min(b[3], W[3]) - Math.max(b[1], W[1]);
      if (ow > 2 && oh > 2 && (ow * oh) / Math.max((W[2] - W[0]) * (W[3] - W[1]), 1) >= 0.08) {
        out.push({ type: 'WATERMARK_COVERS', sev: 3, detail: { text: t.t, at: [b[0] - c.rect.x, b[1] - c.rect.y, b[2] - c.rect.x, b[3] - c.rect.y].map((v) => Math.round(v)) }, canvas: c.idx, path: c.path, size: [c.cssW, c.cssH] });
        break;
      }
    }
  }
  return out;
}
