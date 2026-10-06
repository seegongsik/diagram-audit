#!/usr/bin/env node
// diagram-audit CLI
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { launchBrowser, auditUrl, DEFAULTS } from '../src/audit.mjs';
import { summarize, isFailing } from '../src/summarize.mjs';

const HELP = `diagram-audit: find overlapping, clipped and hidden text in canvas, SVG and HTML
diagrams, and controls that do nothing, by rendering the page in headless Chromium.

usage
  diagram-audit [options] <url|file> [<url|file> ...]
  diagram-audit summarize <results.jsonl> [...] [--sev N] [--fail-on N|none]

options
  --urls <file>          read URLs (one per line, # comments) from a file
  --vw <list>            viewport widths, comma separated (default 1280,390)
  --vh <px>              viewport height (default 900)
  --dpr <n>              device pixel ratio (default 1; phones are 2-3)
  --root <selector>      audit only this subtree (default: body)
  --wait-for <selector>  wait for this element after load
  --watermark <text>     exact watermark text to keep out of overlap checks
  --no-interact          judge the resting state only; do not touch controls
  --no-dom               skip SVG and HTML text checks (canvas only)
  --positions <n>        positions tried per slider (default 5)
  --max-buttons <n>      buttons pressed per page (default 30)
  --no-font-normalize    measure with the container's own sans-serif font
  --timeout <s>          time limit per page and width (default 90)
  --out <file>           write one JSON record per page and width (JSONL)
  --shots-dir <dir>      save screenshots of flagged canvases and regions
  --shots <n>            screenshots per issue type (default 3)
  --sev <n>              list issues up to this severity in the report (default 2)
  --fail-on <n|none>     exit 1 if any run has an issue at severity <= n (default 1)
  --shard <i/n>          run only every n-th job, starting at i (parallel runs)
  --executable-path <p>  use this Chromium binary instead of Playwright's
  -h, --help             show this help
  -v, --version          show the version

exit codes: 0 no failing runs · 1 failing runs · 2 usage error or nothing to audit`;

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const VALUE_FLAGS = new Set(['--urls', '--vw', '--vh', '--dpr', '--root', '--wait-for', '--watermark', '--positions', '--max-buttons', '--timeout', '--out', '--shots-dir', '--shots', '--sev', '--fail-on', '--shard', '--executable-path']);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const positional = argv.filter((a, i) => !a.startsWith('-') && !VALUE_FLAGS.has(argv[i - 1]));
const usage = (msg) => {
  if (msg) console.error(`diagram-audit: ${msg}\n`);
  console.error(HELP);
  process.exit(2);
};
const num = (k, d) => {
  const v = arg(k, null);
  if (v == null) return d;
  const n = Number(v);
  if (!Number.isFinite(n)) usage(`${k} expects a number, got ${JSON.stringify(v)}`);
  return n;
};
const parseFailOn = () => {
  const v = arg('--fail-on', '1');
  if (v === 'none') return null;
  const n = Number(v);
  if (![1, 2, 3].includes(n)) usage('--fail-on expects 1, 2, 3 or none');
  return n;
};

if (has('-h') || has('--help')) {
  console.log(HELP);
  process.exit(0);
}
if (has('-v') || has('--version')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}
for (const a of argv) if (a.startsWith('-') && !VALUE_FLAGS.has(a) && !['--no-interact', '--no-dom', '--no-font-normalize'].includes(a)) usage(`unknown option ${a}`);

// ── summarize ───────────────────────────────────────────────────────
if (positional[0] === 'summarize') {
  const files = positional.slice(1);
  if (!files.length) usage('summarize needs at least one results file');
  const records = [];
  for (const f of files) for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) records.push(JSON.parse(l));
  if (!records.length) {
    console.error('diagram-audit: no records in the results file(s) (empty scan)');
    process.exit(2);
  }
  const failOn = parseFailOn();
  console.log(summarize(records, { sev: num('--sev', 2), failOn }));
  process.exit(records.some((r) => isFailing(r, failOn)) ? 1 : 0);
}

// ── audit ───────────────────────────────────────────────────────────
const toUrl = (s) => {
  if (/^(https?|file|data):/i.test(s)) return s;
  if (fs.existsSync(s)) return pathToFileURL(path.resolve(s)).href;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(s)) return `https://${s}`;
  usage(`not a URL or an existing file: ${s}`);
};
let inputs = [...positional];
const listFile = arg('--urls', null);
if (listFile) {
  if (!fs.existsSync(listFile)) usage(`--urls file not found: ${listFile}`);
  inputs.push(...fs.readFileSync(listFile, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
}
const urls = inputs.map((s) => ({ input: s, url: toUrl(s) }));
const widths = arg('--vw', '1280,390').split(',').map((s) => Number(s.trim()));
if (!widths.length || widths.some((w) => !Number.isFinite(w) || w < 200)) usage('--vw expects widths of at least 200px, e.g. 1280,390');
const [SHARD_I, SHARD_N] = arg('--shard', '0/1').split('/').map(Number);
if (!(SHARD_N >= 1 && SHARD_I >= 0 && SHARD_I < SHARD_N)) usage('--shard expects i/n with 0 <= i < n');

const jobs = [];
for (const u of urls) for (const vw of widths) jobs.push({ ...u, vw });
const mine = jobs.filter((_, i) => i % SHARD_N === SHARD_I);
if (!mine.length) {
  console.error('diagram-audit: nothing to audit (empty scan). Pass at least one URL or file.');
  process.exit(2);
}

const opts = {
  ...DEFAULTS,
  vh: num('--vh', DEFAULTS.vh),
  dpr: num('--dpr', DEFAULTS.dpr),
  root: arg('--root', null),
  waitFor: arg('--wait-for', null),
  watermark: arg('--watermark', null),
  interact: !has('--no-interact'),
  dom: !has('--no-dom'),
  normalizeFonts: !has('--no-font-normalize'),
  positions: num('--positions', DEFAULTS.positions),
  maxButtons: num('--max-buttons', DEFAULTS.maxButtons),
  timeoutMs: num('--timeout', DEFAULTS.timeoutMs / 1000) * 1000,
  shotsDir: arg('--shots-dir', null),
  shotsPerType: num('--shots', DEFAULTS.shotsPerType),
};
const failOn = parseFailOn();
const OUT = arg('--out', null);
if (OUT) fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
const outFd = OUT ? fs.openSync(OUT, 'w') : null;

let browser;
try {
  browser = await launchBrowser({ executablePath: arg('--executable-path', null) });
} catch (e) {
  console.error(`diagram-audit: could not start Chromium: ${String(e.message || e).split('\n')[0]}`);
  console.error('Install it with: npx playwright install chromium   (or pass --executable-path)');
  process.exit(2);
}
const records = [];
const t0 = Date.now();
for (const [n, job] of mine.entries()) {
  const rec = await auditUrl(browser, job.url, { ...opts, vw: job.vw, label: job.input });
  records.push(rec);
  if (outFd !== null) fs.writeSync(outFd, JSON.stringify(rec) + '\n');
  if (mine.length > 4) process.stderr.write(`[${n + 1}/${mine.length}] ${job.input} @${job.vw}px · ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);
}
if (outFd !== null) fs.closeSync(outFd);
await browser.close();

console.log(summarize(records, { sev: num('--sev', 2), failOn }));
if (OUT) console.log(`records: ${OUT}`);
if (opts.shotsDir) console.log(`screenshots: ${opts.shotsDir}`);
process.exit(records.some((r) => isFailing(r, failOn)) ? 1 : 0);
