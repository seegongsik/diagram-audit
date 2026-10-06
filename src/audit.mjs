// diagram-audit · driver.
//
// Opens a URL in Chromium with the instrumentation injected, takes a snapshot of the resting
// state, then exercises the controls it finds (range inputs at several positions, selects,
// checkboxes and radios, buttons, div-based drag sliders) and judges every state it reaches.
// The result is one plain JSON record per URL x viewport width.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCanvas, analyzeDom, analyzeWatermark, issueSig, domIssueSig, THRESH, DOM_THRESH } from './analyze.mjs';
import { settle } from './settle.mjs';
import { dragTo } from './drag.mjs';
import { clickBtn } from './controls.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INSTRUMENT_SRC = fs.readFileSync(path.join(HERE, 'instrument.js'), 'utf8');

export const DEFAULTS = {
  vw: 1280,
  vh: 900,
  dpr: 1,
  locale: 'en-US',
  root: null, // CSS selector; default document.body
  watermark: null, // exact watermark text to keep out of overlap checks
  normalizeFonts: true,
  waitFor: null, // CSS selector to wait for after load
  interact: true,
  dom: true, // SVG and HTML text checks
  positions: 5, // positions tried per slider (ends included)
  maxRanges: 10,
  maxSelects: 5,
  maxToggles: 6,
  maxButtons: 30,
  maxDrags: 8,
  timeoutMs: 90000, // per URL x width
  navTimeoutMs: 30000,
  shotsDir: null, // write PNGs of flagged canvases / regions here
  shotsPerType: 3,
};

/** The script to pass to context.addInitScript(): configuration + instrumentation. */
export function instrumentScript(opts = {}) {
  const cfg = {
    root: opts.root || null,
    watermark: opts.watermark || null,
    normalizeFonts: opts.normalizeFonts !== false,
    blockSubmit: true,
  };
  return `window.__diagramAuditConfig = ${JSON.stringify(cfg)};\n${INSTRUMENT_SRC}`;
}

async function loadChromium() {
  for (const mod of ['playwright', 'playwright-core']) {
    try {
      const m = await import(mod);
      return m.chromium || (m.default && m.default.chromium);
    } catch {}
  }
  throw new Error('diagram-audit needs Playwright: npm install playwright && npx playwright install chromium');
}

/** Launch headless Chromium. `executablePath` lets you use a system Chromium. */
export async function launchBrowser({ executablePath } = {}) {
  const chromium = await loadChromium();
  return chromium.launch({ headless: true, executablePath: executablePath || undefined, args: ['--font-render-hinting=none'] });
}

// ── Page ────────────────────────────────────────────────────────────
async function openPage(browser, url, o) {
  const ctx = await browser.newContext({ viewport: { width: o.vw, height: o.vh }, deviceScaleFactor: o.dpr, locale: o.locale });
  if (/^https?:/.test(url)) {
    // copy buttons (navigator.clipboard) should not throw permission errors in headless mode
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(url).origin }).catch(() => {});
  }
  await ctx.addInitScript(instrumentScript(o));
  const page = await ctx.newPage();
  const sink = { errors: [] };
  page.on('pageerror', (e) => sink.errors.push({ type: 'pageerror', msg: String(e.message || e).slice(0, 300), stack: String(e.stack || '').split('\n').slice(1, 4).join(' | ').slice(0, 300) }));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource|favicon|net::ERR/i.test(t)) return;
    sink.errors.push({ type: 'console', msg: t.slice(0, 300) });
  });
  let status = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: o.navTimeoutMs });
    status = resp ? resp.status() : null;
  } catch (e) {
    sink.errors.push({ type: 'navigation', msg: String(e.message || e).split('\n')[0].slice(0, 300) });
    return { ctx, page, sink, status, failed: true };
  }
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  if (o.waitFor) {
    try {
      await page.waitForSelector(o.waitFor, { timeout: 10000 });
    } catch {
      sink.errors.push({ type: 'harness', msg: `selector not found: ${o.waitFor}` });
      return { ctx, page, sink, status, failed: true };
    }
  }
  await settle(page, 140);
  return { ctx, page, sink, status, failed: status !== null && status >= 400 };
}

// First stack frame that belongs to the page (where the canvas was sized), as url:line:col
function siteOf(stack) {
  if (!stack) return null;
  for (const line of stack.split('\n')) {
    const m = /((?:https?|file):\/\/[^\s)]+):(\d+):(\d+)/.exec(line);
    if (m) return `${m[1]}:${m[2]}:${m[3]}`;
  }
  return null;
}

async function capture(page, o, excludeRange = -1, excludeDrag = -1, values = null) {
  const snaps = await page.evaluate(() => window.__auditSnapshot());
  const dom = await page.evaluate(([x, d, v]) => window.__auditDomHash(x, d, v), [excludeRange, excludeDrag, values]);
  const layout = o.dom ? await page.evaluate(() => window.__auditDom()) : null;
  return { snaps, dom, layout };
}
function issuesOf(cap, state, o) {
  const out = [];
  for (const c of cap.snaps) {
    const site = siteOf(c.site);
    for (const i of analyzeCanvas(c, THRESH, { watermark: o.watermark })) out.push({ ...i, state, canvas: c.idx, path: c.path, size: [c.cssW, c.cssH], site });
  }
  if (cap.layout) {
    for (const i of analyzeDom(cap.layout, DOM_THRESH)) out.push({ ...i, state, canvas: -1, path: 'dom', size: [0, 0] });
    for (const i of analyzeWatermark(cap.snaps, cap.layout.dom)) out.push({ ...i, state });
  }
  return out;
}
const fingerprint = (cap) => cap.snaps.map((c) => c.hash).join(',') + '|' + cap.dom;
// The same label at different control values ("R = 40.8 m", "R = 14.0 m") is one defect.
const sigOf = (i) => `${i.canvas}|${(i.canvas < 0 ? domIssueSig(i) : issueSig(i)).replace(/\d+(?:[.,]\d+)*/g, '#')}`;

async function listControls(page) {
  return page.evaluate(() => {
    const root = window.__auditRoot();
    const out = [];
    const lab = (el) => {
      const l = el.labels && el.labels[0] ? el.labels[0].innerText : el.getAttribute('aria-label') || '';
      return (l || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    };
    root.querySelectorAll('input[type=range]').forEach((el, i) => out.push({ kind: 'range', i, min: +el.min || 0, max: el.max === '' ? 100 : +el.max, step: +el.step || 1, value: +el.value, label: lab(el) }));
    const nDrag = window.__auditDragSliders().length;
    for (let i = 0; i < nDrag; i++) out.push({ kind: 'drag', i, label: '' });
    root.querySelectorAll('select').forEach((el, i) => out.push({ kind: 'select', i, n: el.options.length, label: lab(el) }));
    root.querySelectorAll('input[type=checkbox],input[type=radio]').forEach((el, i) => out.push({ kind: 'toggle', i, label: lab(el) }));
    // g = group of buttons sharing a parent (tabs, radio-like groups); occ = occurrence within the same label
    const groups = new Map();
    const seenLabel = {};
    window.__auditButtons().forEach(({ el, label }, i) => {
      const par = el.parentElement;
      if (!groups.has(par)) groups.set(par, groups.size);
      const occ = seenLabel[label] || 0;
      seenLabel[label] = occ + 1;
      out.push({ kind: 'button', i, label, occ, g: groups.get(par) });
    });
    return out;
  });
}
const setRange = (page, i, v) =>
  page.evaluate(([i, v]) => {
    const el = window.__auditRoot().querySelectorAll('input[type=range]')[i];
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [i, v]);
const setSelect = (page, i, idx) =>
  page.evaluate(([i, idx]) => {
    const el = window.__auditRoot().querySelectorAll('select')[i];
    if (!el) return false;
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    set.call(el, el.options[idx].value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [i, idx]);
const clickToggle = (page, i) =>
  page.evaluate((i) => {
    const el = window.__auditRoot().querySelectorAll('input[type=checkbox],input[type=radio]')[i];
    if (!el) return false;
    el.click();
    return true;
  }, i);

// ── Screenshots (flagged boxes outlined) ────────────────────────────
async function shoot(page, o, shotCount, label, state, cIdx, issues) {
  if (!o.shotsDir) return null;
  const kinds = [...new Set(issues.filter((i) => i.canvas === cIdx).map((i) => i.type))];
  const want = kinds.filter((k) => (shotCount.get(k) || 0) < o.shotsPerType);
  if (!want.length) return null;
  want.forEach((k) => shotCount.set(k, (shotCount.get(k) || 0) + 1));
  const boxes = [];
  for (const i of issues.filter((x) => x.canvas === cIdx)) {
    const d = i.detail || {};
    for (const b of [d.atA, d.atB, d.at, d.box]) if (b) boxes.push(b);
  }
  fs.mkdirSync(o.shotsDir, { recursive: true });
  const name = `${label}__${o.vw}__c${cIdx}__${state}`.replace(/[^\w.-]+/g, '_').slice(0, 180) + '.png';
  const file = path.join(o.shotsDir, name);
  try {
    if (cIdx < 0) {
      // SVG/HTML issue: page coordinates, crop around the union of the boxes
      const u = boxes.reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])], [1e9, 1e9, -1e9, -1e9]);
      if (!isFinite(u[0])) return null;
      const pad = 40;
      const clip = { x: Math.max(0, u[0] - pad), y: Math.max(0, u[1] - pad), width: Math.min(o.vw, u[2] - u[0] + pad * 2), height: Math.min(o.vh, u[3] - u[1] + pad * 2) };
      await page.evaluate((boxes) => {
        boxes.forEach((b) => {
          const d = document.createElement('div');
          d.className = '__auditbox';
          d.style.cssText = `position:absolute;left:${b[0] - 1}px;top:${b[1] - 1}px;width:${b[2] - b[0] + 2}px;height:${b[3] - b[1] + 2}px;outline:1.5px solid #ff2d55;pointer-events:none;z-index:2147483647`;
          document.body.appendChild(d);
        });
      }, boxes);
      await page.screenshot({ path: file, clip, fullPage: true });
    } else {
      // canvas issue: canvas coordinates, outline inside the canvas's parent and shoot the figure
      await page.evaluate(([cIdx, boxes]) => {
        const cv = window.__auditCanvases[cIdx];
        const host = cv.parentElement;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        const ox = cv.offsetLeft, oy = cv.offsetTop;
        boxes.forEach((b) => {
          const d = document.createElement('div');
          d.className = '__auditbox';
          d.style.cssText = `position:absolute;left:${ox + b[0] - 1}px;top:${oy + b[1] - 1}px;width:${b[2] - b[0] + 2}px;height:${b[3] - b[1] + 2}px;outline:1.5px solid #ff2d55;pointer-events:none;z-index:2147483647`;
          host.appendChild(d);
        });
        (cv.closest('figure') || cv).scrollIntoView({ block: 'center' });
      }, [cIdx, boxes]);
      const h = await page.evaluateHandle((cIdx) => window.__auditCanvases[cIdx].closest('figure') || window.__auditCanvases[cIdx].parentElement, cIdx);
      await h.asElement().screenshot({ path: file });
    }
    return name;
  } catch {
    return null;
  } finally {
    await page.evaluate(() => document.querySelectorAll('.__auditbox').forEach((n) => n.remove())).catch(() => {});
  }
}

// ── One page, one width ─────────────────────────────────────────────
/**
 * Audit an already opened page. The page's context must have had instrumentScript(opts) added
 * with addInitScript before navigation. `sink.errors` collects page errors you want reported
 * with the record (auditUrl wires pageerror and console errors into it).
 */
export async function auditPage(page, opts = {}, sink = { errors: [] }) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = Date.now();
  const startUrl = page.url().split('#')[0];
  const label = o.label || startUrl;
  const rec = { url: label, vw: o.vw, dpr: o.dpr, rendered: true, canvases: 0, states: 0, issues: [], dead: [], errors: [], shots: [] };
  const shotCount = new Map();

  const base = await capture(page, o);
  await settle(page, 60);
  const base2 = await capture(page, o);
  const animated = fingerprint(base) !== fingerprint(base2);
  rec.animated = animated;
  rec.canvases = base.snaps.filter((c) => c.inDom).length;
  rec.webgl = base.snaps.some((c) => c.webgl);
  rec.states = 1;
  const seen = new Map(); // signature -> issue
  const addAll = async (cap, state) => {
    const is = issuesOf(cap, state, o);
    for (const i of is) {
      const sig = sigOf(i);
      if (!seen.has(sig)) seen.set(sig, { ...i, states: [state] });
      else if (!seen.get(sig).states.includes(state)) seen.get(sig).states.push(state);
    }
    const flagged = is.filter((i) => i.sev <= 2);
    for (const cIdx of [...new Set(flagged.map((i) => i.canvas))]) {
      const f = await shoot(page, o, shotCount, label, state, cIdx, flagged);
      if (f) rec.shots.push(f);
    }
  };
  await addAll(base, 'base');

  // A control that navigates away ends the interaction phase: further states would belong to another page.
  let left = false;
  const stillHere = () => {
    if (left) return false;
    const now = page.url().split('#')[0];
    if (now !== startUrl) {
      left = true;
      rec.errors.push({ type: 'harness', msg: `a control navigated away to ${now.slice(0, 200)}; remaining controls skipped` });
      return false;
    }
    return true;
  };

  if (o.interact) {
    const controls = await listControls(page);
    const count = (k) => controls.filter((c) => c.kind === k).length;
    rec.controls = { range: count('range'), select: count('select'), toggle: count('toggle'), button: count('button'), drag: count('drag') };
    const baseFp = fingerprint(base);
    const positions = Math.max(3, o.positions);

    // Range inputs: try `positions` evenly spaced values, then restore. Reaction = how many
    // distinct fingerprints the positions produce. All equal -> dead; 40% or fewer distinct
    // (5+ positions) -> sparse (e.g. a slider that only reacts at one exact value).
    for (const c of controls.filter((c) => c.kind === 'range').slice(0, o.maxRanges)) {
      if (!stillHere()) break;
      if (!(c.max > c.min)) continue;
      const vals = new Set();
      for (let k = 0; k < positions; k++) {
        const raw = c.min + ((c.max - c.min) * k) / (positions - 1);
        vals.add(Math.min(c.max, Math.max(c.min, c.min + Math.round((raw - c.min) / c.step) * c.step)));
      }
      const tried = [...vals];
      const fps = new Map();
      for (const v of tried) {
        await setRange(page, c.i, v);
        await settle(page);
        const cap = await capture(page, o, c.i, -1, tried);
        rec.states++;
        fps.set(v, fingerprint(cap));
        if (v !== c.value) await addAll(cap, `range${c.i}=${v}`);
      }
      await setRange(page, c.i, c.value);
      await settle(page, 50);
      if (animated || tried.length < 2) continue;
      const distinct = new Set(fps.values()).size;
      if (distinct === 1) rec.dead.push({ kind: 'range', i: c.i, label: c.label, tried: tried.length });
      else if (tried.length >= 5 && distinct <= Math.ceil(tried.length * 0.4)) rec.dead.push({ kind: 'range-sparse', i: c.i, label: c.label, tried: tried.length, distinct });
    }
    for (const c of controls.filter((c) => c.kind === 'select').slice(0, o.maxSelects)) {
      if (!stillHere()) break;
      let changed = false;
      for (let k = 0; k < Math.min(c.n, 6); k++) {
        await setSelect(page, c.i, k);
        await settle(page);
        const cap = await capture(page, o);
        rec.states++;
        if (fingerprint(cap) !== baseFp) changed = true;
        await addAll(cap, `select${c.i}=${k}`);
      }
      if (!changed && !animated && c.n > 1) rec.dead.push({ kind: 'select', i: c.i, label: c.label });
    }
    for (const c of controls.filter((c) => c.kind === 'toggle').slice(0, o.maxToggles)) {
      if (!stillHere()) break;
      const before = fingerprint(await capture(page, o));
      await clickToggle(page, c.i);
      await settle(page);
      if (!stillHere()) break;
      const cap = await capture(page, o);
      rec.states++;
      await addAll(cap, `toggle${c.i}`);
      if (fingerprint(cap) === before && !animated) rec.dead.push({ kind: 'toggle', i: c.i, label: c.label });
    }
    // Buttons. If any button in a group (same parent: tabs, radio-like groups) changes the
    // drawing, the group's unresponsive buttons are "already selected", not dead. Only whole
    // unresponsive groups and lone buttons count.
    const btnRes = [];
    for (const c of controls.filter((c) => c.kind === 'button').slice(0, o.maxButtons)) {
      if (!stillHere()) break;
      const before = fingerprint(await capture(page, o));
      const clicked = await clickBtn(page, c);
      if (!clicked) continue; // removed by an earlier click: not unresponsive
      await settle(page);
      if (!stillHere()) break;
      const cap = await capture(page, o);
      rec.states++;
      await addAll(cap, `button${c.i}:${c.label}`);
      btnRes.push({ c, same: fingerprint(cap) === before });
    }
    const aliveGroup = new Set(btnRes.filter((r) => !r.same).map((r) => r.c.g));
    for (const r of btnRes) if (r.same && !animated && !aliveGroup.has(r.c.g)) rec.dead.push({ kind: 'button', i: r.c.i, label: r.c.label });
    // Drag sliders: put the thumb at `positions` spots (ends at 0.02 / 0.98) and judge each.
    // All fingerprints equal (slider itself excluded) -> dead.
    for (const c of controls.filter((c) => c.kind === 'drag').slice(0, o.maxDrags)) {
      if (!stillHere()) break;
      const fracs = [];
      for (let k = 0; k < positions; k++) fracs.push(Math.min(0.98, Math.max(0.02, k / (positions - 1))));
      const fps = new Set();
      let ok = true;
      for (const f of fracs) {
        ok = await dragTo(page, c.i, f);
        if (!ok) break;
        await settle(page);
        const cap = await capture(page, o, -1, c.i);
        rec.states++;
        fps.add(fingerprint(cap));
        await addAll(cap, `drag${c.i}=${f.toFixed(2)}`);
      }
      if (ok && !animated && fps.size === 1) rec.dead.push({ kind: 'drag', i: c.i, label: c.label, tried: fracs.length });
    }
  }

  rec.issues = [...seen.values()];
  rec.errors = [...rec.errors, ...sink.errors].slice(0, 8);
  rec.ms = Date.now() - t0;
  return rec;
}

/** Open `url` at one viewport width, audit it, close it. Never throws: failures become records. */
export async function auditUrl(browser, url, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = Date.now();
  const label = o.label || url;
  let env = null;
  const fail = (msg, extra = {}) => ({ url: label, vw: o.vw, dpr: o.dpr, rendered: false, issues: [], dead: [], errors: [...(env ? env.sink.errors : []), ...(msg ? [{ type: 'harness', msg }] : [])].slice(0, 8), ms: Date.now() - t0, ...extra });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        env = await openPage(browser, url, o);
        if (env.failed) return fail(null, { status: env.status });
        const rec = await auditPage(env.page, { ...o, label }, env.sink);
        rec.status = env.status;
        return rec;
      })(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${o.timeoutMs / 1000}s`)), o.timeoutMs); }),
    ]);
  } catch (e) {
    return fail(String(e.message || e).split('\n')[0].slice(0, 200), { hang: true });
  } finally {
    clearTimeout(timer);
    if (env) await env.ctx.close().catch(() => {});
  }
}
