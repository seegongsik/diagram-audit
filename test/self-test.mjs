// diagram-audit self-test: does the tool catch known defects (positive cases), leave sound
// drawings alone (negative cases), and do its moving parts behave (structural cases)?
// Usage: node test/self-test.mjs   (needs Chromium; exit 0 = all pass)
//
// Many sample labels are Korean, Japanese or Chinese on purpose: CJK text is where width
// estimates and line breaking go wrong most often.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyzeCanvas, analyzeDom, analyzeWatermark } from '../src/analyze.mjs';
import { instrumentScript, launchBrowser, auditUrl } from '../src/audit.mjs';
import { settle } from '../src/settle.mjs';
import { dragTo } from '../src/drag.mjs';
import { clickBtn } from '../src/controls.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// Each case runs `draw` on a 400x200 canvas. has = issue types that must be reported,
// not = issue types that must not be reported.
const CASES = [
  // ── positive ─────────────────────────────────────────────
  { n: 'P1 two labels on top of each other', k: 'pos', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('속도 N [rpm]',100,100); ctx.fillText('■ 압연기',120,102);`, has: ['TEXT_OVERLAP'] },
  { n: 'P2 label cut off at the right edge', k: 'pos', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('1393 MW long label',360,100);`, has: ['TEXT_CLIP'] },
  { n: 'P3 label drawn entirely below the canvas', k: 'pos', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('配電線路',100,260);`, has: ['TEXT_OFFCANVAS'] },
  { n: 'P4 opaque rectangle drawn later covers a label', k: 'pos', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('hidden label',100,100); ctx.fillStyle='#123456'; ctx.fillRect(90,85,60,30);`, has: ['TEXT_OCCLUDED'] },
  { n: 'P5 rotated label overlaps a horizontal one (transform applied)', k: 'pos', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('horizontal label',100,100); ctx.save(); ctx.translate(140,140); ctx.rotate(-Math.PI/2); ctx.fillText('torque T [N·m]',0,0); ctx.restore();`, has: ['TEXT_OVERLAP'] },
  { n: 'P6 non-finite coordinate (part of the drawing silently vanishes)', k: 'pos', draw: `ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(NaN,50); ctx.stroke();`, has: ['NONFINITE'] },
  { n: 'P7 canvas API throws', k: 'pos', draw: `try { ctx.arc(10,10,-5,0,1); } catch(e) {}`, has: ['CANVAS_THROW'] },
  { n: 'P8 bitmap 2x larger than CSS size: judged in CSS px', k: 'pos', bmp: 800, draw: `ctx.scale(2,2); ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('a long label past the right edge',330,100);`, has: ['TEXT_CLIP'] },
  { n: 'P9 layout scaled by sc while the height stays capped in px', k: 'pos',
    draw: `const sc=1.4; ctx.font=(12*sc)+'px sans-serif'; ctx.fillStyle='#fff'; for(let i=0;i<8;i++) ctx.fillText('row '+i,10,20*sc+i*22*sc);`, has: ['TEXT_OFFCANVAS'] },
  { n: 'P10 text under 6px (shrinking instead of fixing an overlap)', k: 'pos', draw: `ctx.font='5px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('very small text',20,40);`, has: ['TEXT_TINY'] },
  { n: 'P11 bottom of the canvas left empty', k: 'pos', draw: `ctx.font='14px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('content only at the top',20,30); ctx.fillRect(20,40,100,20);`, has: ['EMPTY_BAND'] },
  { n: 'P12 unparseable colour (3-digit hex + alpha suffix)', k: 'pos', draw: `ctx.fillStyle='#aaa'+'33'; ctx.fillRect(10,10,50,50);`, has: ['INVALID_COLOR'] },

  // ── negative ─────────────────────────────────────────────
  { n: 'N1 two labels far apart', k: 'neg', draw: `ctx.font='14px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('left',20,40); ctx.fillText('right',300,160);`, not: ['TEXT_OVERLAP', 'TEXT_CLIP', 'TEXT_OFFCANVAS'] },
  { n: 'N2 same label drawn 1px apart (outline or shadow)', k: 'neg', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#000'; ctx.fillText('outlined',100,100); ctx.fillStyle='#fff'; ctx.fillText('outlined',101,100);`, not: ['TEXT_OVERLAP'] },
  { n: 'N3 erased with an opaque rectangle and redrawn in place', k: 'neg', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('old value 100',100,100); ctx.fillStyle='#000'; ctx.fillRect(90,80,160,30); ctx.fillStyle='#fff'; ctx.fillText('new value 200',100,100);`, not: ['TEXT_OVERLAP', 'TEXT_OCCLUDED'] },
  { n: 'N4 assigning canvas.width starts a new frame', k: 'neg', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('overlap A',100,100); ctx.fillText('overlap B',102,101); cv.width = cv.width; const c2=cv.getContext('2d'); c2.font='16px sans-serif'; c2.fillStyle='#fff'; c2.fillText('clean frame',20,40);`, not: ['TEXT_OVERLAP'] },
  { n: 'N5 full-canvas opaque fillRect starts a new frame', k: 'neg', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('overlap A',100,100); ctx.fillText('overlap B',102,101); ctx.fillStyle='#0a0d11'; ctx.fillRect(0,0,400,200); ctx.fillStyle='#fff'; ctx.fillText('clean frame',20,40);`, not: ['TEXT_OVERLAP'] },
  { n: 'N6 text cut on purpose inside clip()', k: 'neg', draw: `ctx.save(); ctx.beginPath(); ctx.rect(0,0,400,200); ctx.clip(); ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('deliberately clipped long text',330,100); ctx.restore();`, not: ['TEXT_CLIP', 'TEXT_OFFCANVAS'] },
  { n: 'N7 label fully inside its box', k: 'neg', draw: `ctx.fillStyle='#345'; ctx.fillRect(80,70,200,50); ctx.font='16px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('label in a box',100,100);`, not: ['TEXT_ON_EDGE', 'TEXT_OVERLAP', 'TEXT_OCCLUDED'] },
  { n: 'N8 transparent text is ignored', k: 'neg', draw: `ctx.font='16px sans-serif'; ctx.fillStyle='rgba(255,255,255,0)'; ctx.fillText('invisible A',100,100); ctx.fillText('invisible B',100,100); ctx.fillStyle='#fff'; ctx.fillText('visible',20,40);`, not: ['TEXT_OVERLAP'] },
  { n: 'N9 height that grows with the layout scale: nothing cut off', k: 'neg',
    draw: `const sc=1.0; ctx.font=(12*sc)+'px sans-serif'; ctx.fillStyle='#fff'; for(let i=0;i<8;i++) ctx.fillText('row '+i,10,20*sc+i*22*sc);`, not: ['TEXT_OFFCANVAS', 'TEXT_CLIP', 'TEXT_OVERLAP'] },
  { n: 'N10 11px text is not tiny', k: 'neg', draw: `ctx.font='11px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('normal text',20,40);`, not: ['TEXT_TINY'] },
  { n: 'N11 canvas filled top to bottom', k: 'neg', draw: `ctx.font='14px sans-serif'; ctx.fillStyle='#fff'; ctx.fillText('top',20,30); ctx.fillRect(20,60,100,120); ctx.fillText('bottom',20,192);`, not: ['EMPTY_BAND'] },
  { n: 'N12 valid colours (hex3, hex6, hex8, rgba, hsl, named)', k: 'neg', draw: `ctx.fillStyle='#abc'; ctx.fillStyle='#aabbcc'; ctx.fillStyle='#aabbcc33'; ctx.fillStyle='rgba(1,2,3,0.4)'; ctx.fillStyle='hsl(30,50%,50%)'; ctx.fillStyle='red'; ctx.strokeStyle='#fff'; ctx.shadowColor='rgba(0,0,0,0.3)';`, not: ['INVALID_COLOR'] },
];

const canvasPage = (bmp, cssW, cssH) => `<!doctype html><body style="margin:0"><canvas id="cv" width="${bmp}" height="${Math.round(bmp / 2)}" style="width:${cssW}px;height:${cssH}px"></canvas></body>`;

let fail = 0;
let structural = 0;
const ok = (c, msg) => { if (!c) { fail++; console.log('  FAIL ·', msg); } return c; };
const report = (pass, label) => console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);

const browser = await launchBrowser({ executablePath: process.env.CHROMIUM_PATH });
const ctx0 = await browser.newContext({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 1 });
await ctx0.addInitScript(instrumentScript({ watermark: 'example.com' }));

console.log('# diagram-audit self-test');
for (const c of CASES) {
  const page = await ctx0.newPage();
  await page.setContent(canvasPage(c.bmp || 400, 400, 200));
  const snap = await page.evaluate((src) => {
    const cv = document.getElementById('cv');
    const ctx = cv.getContext('2d');
    // eslint-disable-next-line no-new-func
    new Function('cv', 'ctx', src)(cv, ctx);
    return window.__auditSnapshot();
  }, c.draw);
  await page.close();
  const canvas = snap.find((s) => s.inDom) || snap[0];
  const issues = canvas ? analyzeCanvas(canvas) : [];
  const types = new Set(issues.map((i) => i.type));
  let pass = true;
  if (c.has) for (const t of c.has) pass = ok(types.has(t), `${c.n}: missed ${t} (found: ${[...types].join(',') || 'nothing'})`) && pass;
  if (c.not) for (const t of c.not) pass = ok(!types.has(t), `${c.n}: false ${t} ${JSON.stringify(issues.find((i) => i.type === t)?.detail || {}).slice(0, 120)}`) && pass;
  report(pass, `${c.k === 'pos' ? 'positive' : 'negative'} ${c.n}`);
}

// ── SVG and HTML text ─────────────────────────────────────────
const DOM_CASES = [
  { n: 'DP1 two different HTML labels on top of each other', k: 'pos',
    body: `<div style="position:relative;width:300px;height:60px"><span style="position:absolute;left:10px;top:10px;font:16px sans-serif">overlapping label one</span><span style="position:absolute;left:14px;top:12px;font:16px sans-serif">second label</span></div>`, has: ['DOM_TEXT_OVERLAP'] },
  { n: 'DP2 overlap inside the visible part of a scroll box is still caught', k: 'pos',
    body: `<div style="position:relative;width:300px;height:60px;overflow:auto"><span style="position:absolute;left:10px;top:10px;font:16px sans-serif">overlapping label one</span><span style="position:absolute;left:14px;top:12px;font:16px sans-serif">second label</span></div>`, has: ['DOM_TEXT_OVERLAP'] },
  { n: 'DP3 two SVG labels on top of each other', k: 'pos',
    body: `<svg width="300" height="80"><text x="10" y="40" font-size="16" font-family="sans-serif">vx = v cos θ</text><text x="40" y="42" font-size="16" font-family="sans-serif">vy = v sin θ</text></svg>`, has: ['SVG_TEXT_OVERLAP'] },
  { n: 'DP4 nowrap row wider than the viewport', k: 'pos',
    body: `<div style="white-space:nowrap;font:16px sans-serif">${'a row of legend entries that does not wrap '.repeat(3)}</div>`, has: ['PAGE_HSCROLL'] },
  { n: 'DN1 text-overflow: ellipsis (two fragments of one text node)', k: 'neg',
    body: `<div style="width:300px"><span style="display:block;width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:8px sans-serif">ストロンチウム rutherfordium</span></div>`, not: ['DOM_TEXT_OVERLAP'] },
  { n: 'DN2 paragraph wrapped over several lines', k: 'neg',
    body: `<p style="width:120px;font:14px/1.5 sans-serif;margin:0">여러 줄로 자연스럽게 줄바꿈되는 문단입니다 겹치지 않습니다</p>`, not: ['DOM_TEXT_OVERLAP'] },
  { n: 'DN3 ellipsis cell whose text box reaches into the next cell (visible parts do not overlap)', k: 'neg',
    body: `<div style="display:flex;width:200px"><span style="display:block;width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px sans-serif">ストロンチウムストロンチウム</span><span style="display:block;width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px sans-serif">イットリウム</span></div>`, not: ['DOM_TEXT_OVERLAP'] },
  { n: 'DN4 position:fixed toast over body text', k: 'neg',
    body: `<p style="margin:0;font:14px sans-serif;height:40px">body text sits here</p><div role="status" style="position:fixed;left:0;top:8px;font:14px sans-serif">Link copied</div>`, not: ['DOM_TEXT_OVERLAP'] },
  { n: 'DN5 rows scrolled out of an overflow-y:auto box, paragraph right below', k: 'neg',
    body: `<div style="width:260px"><div style="height:40px;overflow-y:auto;font:14px sans-serif"><div style="height:30px">top row</div><div>hidden row A</div><div>hidden row B</div></div><p style="margin:0;font:14px sans-serif">paragraph right below the scroll box</p></div>`, not: ['DOM_TEXT_OVERLAP'] },
  { n: 'DN6 ellipsis cells scrolled outside an overflow:hidden box', k: 'neg',
    body: `<div style="width:300px;overflow:hidden"><div style="width:200px;overflow-x:auto"><div style="display:flex;width:3000px"><span style="flex:none;width:500px"></span><span style="flex:none;width:34px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px sans-serif">ストロンチウムストロンチウム</span><span style="flex:none;width:9px"></span><span style="flex:none;width:34px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px sans-serif">レントゲニウムレントゲニウム</span></div></div></div>`, not: ['DOM_TEXT_OVERLAP'] },
  { n: 'DN7 wide table inside an overflow-x:auto wrapper', k: 'neg',
    body: `<div style="width:300px;overflow-x:auto"><table style="width:900px;font:14px sans-serif"><tr><td>a wide table that scrolls inside its own box</td><td>more cells</td></tr></table></div>`, not: ['PAGE_HSCROLL', 'DOM_TEXT_BEYOND_VIEWPORT'] },
];
for (const c of DOM_CASES) {
  const page = await ctx0.newPage();
  await page.setContent(`<!doctype html><body style="margin:0"><div id="root">${c.body}</div></body>`);
  const d = await page.evaluate(() => window.__auditDom());
  await page.close();
  const issues = analyzeDom(d);
  const types = new Set(issues.map((i) => i.type));
  let pass = true;
  if (c.has) for (const t of c.has) pass = ok(types.has(t), `${c.n}: missed ${t} (found: ${[...types].join(',') || 'nothing'})`) && pass;
  if (c.not) for (const t of c.not) pass = ok(!types.has(t), `${c.n}: false ${t} ${JSON.stringify(issues.find((i) => i.type === t)?.detail || {}).slice(0, 140)}`) && pass;
  report(pass, `${c.k === 'pos' ? 'positive' : 'negative'} ${c.n}`);
}

// ── settle: no measuring mid-transition ───────────────────────
{
  structural++;
  const page = await ctx0.newPage();
  await page.setContent(`<!doctype html><body style="margin:0"><div id="b" style="position:absolute;left:0;top:60px;width:40px;height:20px;transition:left .6s linear">box</div><button id="go" onclick="document.getElementById('b').style.left='300px'">move</button></body>`);
  await page.click('#go');
  await settle(page);
  const left = await page.evaluate(() => document.getElementById('b').getBoundingClientRect().left);
  // an infinite animation (spinner) must not be waited for
  await page.setContent(`<!doctype html><body style="margin:0"><div style="animation:spin 1s linear infinite;width:10px;height:10px;background:#888"></div><style>@keyframes spin{to{transform:rotate(360deg)}}</style></body>`);
  const t0 = Date.now();
  await settle(page);
  const dt = Date.now() - t0;
  await page.close();
  const pass = ok(Math.abs(left - 300) < 1, `settle returned mid-transition (left=${left.toFixed(1)}, expected 300)`) && ok(dt < 1500, `settle waited ${dt}ms on an infinite animation`);
  report(pass, 'structural settle: waits for finite transitions, not for infinite animations');
}

// ── buttons: found again by label + occurrence ────────────────
{
  structural++;
  const html = `<!doctype html><body style="margin:0">
    <button id="rev" onclick="this.remove()">Reveal</button><button onclick="window.hitA=(window.hitA||0)+1">A</button><button onclick="window.hitB=(window.hitB||0)+1">B</button><button onclick="window.hitB2=(window.hitB2||0)+1">B</button>
    <button>Next step</button><button>다음</button><button>Share</button>
    <nav><button>Menu</button></nav></body>`;
  const page = await ctx0.newPage();
  await page.setContent(html);
  const list = await page.evaluate(() => window.__auditButtons().map((b) => b.label));
  const mk = (label, occ) => ({ label, occ });
  const r1 = await clickBtn(page, mk('Reveal', 0)); // disappears when pressed
  const r2 = await clickBtn(page, mk('B', 0)); // index shifted, label still finds it
  const r3 = await clickBtn(page, mk('B', 1)); // second button with the same label
  const r4 = await clickBtn(page, mk('Reveal', 0)); // already gone -> false
  const hit = await page.evaluate(() => [window.hitA || 0, window.hitB || 0, window.hitB2 || 0]);
  await page.close();
  let pass = ok(JSON.stringify(list) === JSON.stringify(['Reveal', 'A', 'B', 'B', 'Next step']), `button list ${JSON.stringify(list)} (expected 5 diagram buttons; "다음" (next), "Share" and the nav button are page chrome)`);
  pass = ok(r1 && r2 && r3 && !r4, `click results ${[r1, r2, r3, r4]} (expected true true true false)`) && pass;
  pass = ok(hit[1] === 1 && hit[2] === 1, `second button with the same label not pressed ${JSON.stringify(hit)}`) && pass;
  report(pass, 'structural buttons: a disappearing button does not shift later clicks, and a gone button is not "dead"');
}

// ── div-based drag sliders ────────────────────────────────────
{
  structural++;
  // s1 prints its position and only at the far end (> 0.9) moves the second SVG label onto the first.
  // s2 only moves its thumb (dead). area is a large touch area, not a slider.
  const html = `<!doctype html><body style="margin:0">
    <div id="s1" style="position:relative;width:200px;height:26px;touch-action:none;background:#444"></div><p id="out1" style="margin:0;font:14px sans-serif">A</p>
    <div id="s2" style="position:relative;width:200px;height:26px;touch-action:none;background:#444"><div id="th" style="position:absolute;left:0;top:4px;width:18px;height:18px;background:#fa0"></div></div>
    <div id="area" style="width:300px;height:200px;touch-action:none;background:#222"></div>
    <svg width="320" height="60"><text x="10" y="20" font-size="14" font-family="sans-serif">first label here</text><text id="t2" x="170" y="20" font-size="14" font-family="sans-serif">second label</text></svg>
    <script>
      const at = (el, e) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
      document.getElementById('s1').addEventListener('pointerdown', (e) => { const f = at(e.currentTarget, e); document.getElementById('out1').textContent = 'v' + Math.round(f * 100); document.getElementById('t2').setAttribute('x', f > 0.9 ? 10 : 170); });
      document.getElementById('s2').addEventListener('pointerdown', (e) => { const f = at(e.currentTarget, e); document.getElementById('th').style.left = (f * 182) + 'px'; });
    </script></body>`;
  const page = await ctx0.newPage();
  await page.setContent(html);
  const n = await page.evaluate(() => window.__auditDragSliders().length);
  const fracs = [0.02, 0.5, 0.98];
  const liveFp = new Set(), deadFp = new Set();
  const overlapAt = {};
  for (const f of fracs) {
    await dragTo(page, 0, f);
    await settle(page, 30);
    liveFp.add(await page.evaluate(() => window.__auditDomHash(-1, 0)));
    const iss = analyzeDom(await page.evaluate(() => window.__auditDom()));
    overlapAt[f] = iss.some((i) => i.type === 'SVG_TEXT_OVERLAP');
  }
  for (const f of fracs) {
    await dragTo(page, 1, f);
    await settle(page, 30);
    deadFp.add(await page.evaluate(() => window.__auditDomHash(-1, 1)));
  }
  await page.close();
  let pass = ok(n === 2, `found ${n} drag sliders (expected 2; a large touch area is not a slider)`);
  pass = ok(liveFp.size >= 2, `live drag slider judged dead (${liveFp.size} fingerprint(s))`) && pass;
  pass = ok(deadFp.size === 1, `thumb-only drag slider judged alive (${deadFp.size} fingerprints)`) && pass;
  pass = ok(!overlapAt[0.02] && overlapAt[0.98], `overlap that only happens at the far end not caught (0.02=${overlapAt[0.02]} · 0.98=${overlapAt[0.98]})`) && pass;
  report(pass, 'structural drag sliders: detection, positioning, dead slider, overlap at one end only');
}

// ── dead range sliders (DOM fingerprint) ──────────────────────
{
  structural++;
  // live: result text next to the slider changes. dead: only the printed value changes.
  // geometry (4th slider): the value is written into an SVG attribute, which must count as alive.
  // quiet: not wired at all, on a page whose attributes and text contain the same numbers the
  // slider is tried at (viewBox "0 0", stroke-width "3", "5 apples"). Replacing the printed value
  // across the whole markup used to make this slider look alive.
  const html = `<!doctype html><body style="margin:0">
    <div><span id="lv">10</span><input type="range" min="0" max="100" value="10"><p id="res">result A</p></div>
    <div><span id="dv">10</span><input type="range" min="0" max="100" value="10"><p>fixed sentence</p></div>
    <div><input type="range" min="0" max="10" value="0"><svg viewBox="0 0 360 120" width="200"><line x1="0" y1="5" x2="10" y2="8" stroke-width="3"/></svg><p>5 apples, 3 pears, 10 plums</p></div>
    <div><input type="range" min="0" max="10" value="0"><svg width="60" height="60"><circle id="dot" cx="30" cy="30" r="0"/></svg></div>
    <script>
      const rs = document.querySelectorAll('input[type=range]');
      rs[0].addEventListener('input', () => { document.getElementById('lv').textContent = rs[0].value; document.getElementById('res').textContent = 'result ' + (rs[0].value * 2); });
      rs[1].addEventListener('input', () => { document.getElementById('dv').textContent = rs[1].value; });
      rs[3].addEventListener('input', () => { document.getElementById('dot').setAttribute('r', rs[3].value); });
    </script></body>`;
  const page = await ctx0.newPage();
  await page.setContent(html);
  const hashAt = async (idx, v, values) => page.evaluate(([idx, v, values]) => {
    const el = window.__auditRoot().querySelectorAll('input[type=range]')[idx];
    el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true }));
    return window.__auditDomHash(idx, -1, values);
  }, [idx, v, values]);
  const liveA = await hashAt(0, 30), liveB = await hashAt(0, 70);
  const deadA = await hashAt(1, 30), deadB = await hashAt(1, 55);
  const tried = [0, 3, 5, 8, 10];
  const quiet = new Set();
  for (const v of tried) quiet.add(await hashAt(2, v, tried));
  // geometry: the value goes straight into an SVG attribute (circle radius). That is a reaction.
  const geom = new Set();
  for (const v of tried) geom.add(await hashAt(3, v, tried));
  await page.close();
  let pass = ok(liveA !== liveB, 'live slider (result text in the same box) judged dead');
  pass = ok(deadA === deadB, 'slider that only echoes its value judged alive') && pass;
  pass = ok(quiet.size === 1, `unwired slider judged alive because unrelated numbers matched its values (${quiet.size} fingerprints)`) && pass;
  pass = ok(geom.size === tried.length, `slider that sets an SVG attribute to its value judged dead (${geom.size} of ${tried.length} fingerprints differ)`) && pass;
  report(pass, 'structural slider fingerprint: result text and geometry = alive, echo only = dead, unrelated numbers do not count');
}

// ── HTML watermark over canvas text (two canvases) ────────────
{
  structural++;
  const html = `<!doctype html><body style="margin:0">
    <figure style="position:relative;margin:0 0 200px;width:400px"><canvas id="c1" width="400" height="120" style="width:400px;height:120px;display:block"></canvas><div aria-hidden="true" style="position:absolute;right:5px;bottom:4px;font:9px sans-serif"><span>example.com</span></div></figure>
    <figure style="position:relative;margin:0;width:400px"><canvas id="c2" width="400" height="120" style="width:400px;height:120px;display:block"></canvas><div aria-hidden="true" style="position:absolute;right:5px;bottom:4px;font:9px sans-serif"><span>example.com</span></div></figure></body>`;
  const run = async (textAt) => {
    const page = await ctx0.newPage();
    await page.setContent(html);
    const r = await page.evaluate((textAt) => {
      const c = document.getElementById('c2').getContext('2d');
      c.font = '10px sans-serif'; c.fillStyle = '#fff';
      c.fillText('a note under the watermark', textAt[0], textAt[1]);
      document.getElementById('c1').getContext('2d').fillText('other canvas', 10, 20);
      return { snaps: window.__auditSnapshot(), dom: window.__auditDom().dom };
    }, textAt);
    await page.close();
    return analyzeWatermark(r.snaps, r.dom);
  };
  const hit = await run([280, 115]); // bottom right of the second canvas, where the watermark is
  const clean = await run([10, 60]);
  let pass = ok(hit.some((i) => i.type === 'WATERMARK_COVERS'), 'watermark over text on the second canvas not caught');
  pass = ok(clean.length === 0, `reported although nothing is covered ${JSON.stringify(clean).slice(0, 120)}`) && pass;
  report(pass, 'structural watermark: caught per canvas with two canvases and two watermarks');
}

// ── instrumentation and font normalisation ────────────────────
{
  structural++;
  const page = await ctx0.newPage();
  await page.setContent(canvasPage(400, 400, 200));
  const r = await page.evaluate(() => {
    const ctx = document.getElementById('cv').getContext('2d');
    const w = (f) => { ctx.font = f; return ctx.measureText('Hello').width; };
    return {
      installed: window.__auditInstalled === true,
      sans: w('100px sans-serif'),
      sysStack: w('100px Inter, system-ui, sans-serif'),
      sansBold: w('bold 100px sans-serif'),
      sysStackBold: w('bold 100px Inter, system-ui, sans-serif'),
      liberation: w('100px "Liberation Sans"'),
      fallback: w('100px "No Such Font 9f2c"'),
    };
  });
  await page.close();
  let pass = ok(r.installed, 'instrumentation not installed');
  pass = ok(Math.abs(r.sysStack - r.sans) / r.sans < 0.01, `system UI stack measures differently from sans-serif: ${r.sysStack.toFixed(1)} vs ${r.sans.toFixed(1)}`) && pass;
  pass = ok(Math.abs(r.sysStackBold - r.sansBold) / r.sansBold < 0.01, `bold system UI stack measures differently: ${r.sysStackBold.toFixed(1)} vs ${r.sansBold.toFixed(1)}`) && pass;
  const haveLiberation = Math.abs(r.liberation - r.fallback) > 0.5;
  if (haveLiberation) {
    // Arial 'Hello' at 100px = 227.8; Liberation Sans is metric-compatible
    pass = ok(Math.abs(r.sans - 227.8) / 227.8 < 0.03, `font normalisation failed: 'Hello' measures ${r.sans.toFixed(1)} (Arial metric 227.8)`) && pass;
  } else {
    console.log('  note · Liberation Sans is not installed; Arial-metric check skipped (install fonts-liberation for stable measurements)');
  }
  report(pass, `structural instrumentation installed · sans-serif and system UI stacks share one metric (${r.sans.toFixed(1)})`);
}

// ── end to end on the bundled examples ────────────────────────
{
  structural++;
  const opts = { vw: 390 };
  const broken = await auditUrl(browser, pathToFileURL(path.join(ROOT, 'examples/broken.html')).href, opts);
  const fixed = await auditUrl(browser, pathToFileURL(path.join(ROOT, 'examples/fixed.html')).href, opts);
  const types = new Set(broken.issues.map((i) => i.type));
  let pass = ok(broken.rendered && fixed.rendered, 'an example page did not load');
  for (const t of ['TEXT_OVERLAP', 'TEXT_CLIP', 'SVG_TEXT_OVERLAP', 'PAGE_HSCROLL']) pass = ok(types.has(t), `broken.html: missed ${t} (found: ${[...types].join(',')})`) && pass;
  pass = ok(broken.dead.some((d) => d.kind === 'range' && /Air resistance/.test(d.label)), `broken.html: unwired "Air resistance" slider not reported as dead (${JSON.stringify(broken.dead)})`) && pass;
  const fixedBad = fixed.issues.filter((i) => i.sev <= 2);
  pass = ok(fixedBad.length === 0 && fixed.dead.length === 0, `fixed.html: expected no severity 1-2 issues or dead controls, got ${JSON.stringify(fixedBad.map((i) => i.type))} dead ${JSON.stringify(fixed.dead)}`) && pass;
  report(pass, 'structural end to end: broken.html fails on every planted defect, fixed.html is clean');
}

// ── empty scan ────────────────────────────────────────────────
{
  structural++;
  const res = spawnSync(process.execPath, [path.join(ROOT, 'bin/diagram-audit.mjs')], { encoding: 'utf8' });
  const pass = ok(res.status === 2, `no input should exit 2 (got ${res.status})`);
  report(pass, 'structural nothing to audit -> exit 2');
}

await browser.close();
const all = [...CASES, ...DOM_CASES];
console.log(fail ? `\nFAIL · ${fail} check(s) failed` : `\nALL PASS · positive ${all.filter((c) => c.k === 'pos').length} · negative ${all.filter((c) => c.k === 'neg').length} · structural ${structural}`);
process.exit(fail ? 1 : 0);
