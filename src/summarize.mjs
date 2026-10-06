// diagram-audit · human-readable summary of audit records.

const describe = (i) => {
  const d = i.detail || {};
  const q = (s) => JSON.stringify(String(s ?? '')).slice(0, 60);
  switch (i.type) {
    case 'TEXT_OVERLAP':
    case 'SVG_TEXT_OVERLAP':
    case 'DOM_TEXT_OVERLAP':
      return `${q(d.a)} x ${q(d.b)} overlap ${Math.round(d.ratio * 100)}%`;
    case 'TEXT_CLIP':
    case 'SVG_TEXT_CLIP':
    case 'DOM_TEXT_CLIPPED':
    case 'DOM_TEXT_BEYOND_VIEWPORT':
      return `${q(d.text)} ${Math.round((d.visible ?? 0) * 100)}% visible`;
    case 'TEXT_OFFCANVAS':
    case 'SVG_TEXT_OFFSVG':
      return `${q(d.text)} drawn completely outside`;
    case 'TEXT_OCCLUDED':
      return `${q(d.text)} ${Math.round(d.covered * 100)}% covered by a shape drawn later`;
    case 'TEXT_TINY':
      return `${q(d.text)} at ${d.px}px (${d.n} labels under 6px)`;
    case 'NONFINITE':
      return `${d.total} drawing call(s) with NaN/Infinity: ${(d.calls || []).map((c) => c.m).join(', ')}`;
    case 'INVALID_COLOR':
      return `unparseable colour ${(d.colors || []).map((c) => `${c.p}=${q(c.v)}`).join(', ')}`;
    case 'CANVAS_THROW':
      return (d.errs || []).map((e) => `${e.m}: ${e.msg}`).join('; ');
    case 'PAGE_HSCROLL':
      return `page scrolls ${d.over}px sideways at ${d.vw}px` + (d.culprits && d.culprits[0] ? ` (widest: ${d.culprits[0].el})` : '');
    case 'EMPTY_BAND':
      return `bottom ${d.emptyPx}px of ${d.of}px empty`;
    case 'TEXT_ON_EDGE':
      return `${q(d.text)} straddles a filled box edge`;
    case 'WATERMARK_COVERS':
      return `watermark sits on ${q(d.text)}`;
    default:
      return JSON.stringify(d).slice(0, 100);
  }
};

const counts = (r) => {
  const c = { 1: 0, 2: 0, 3: 0 };
  for (const i of r.issues || []) c[i.sev]++;
  return c;
};

/**
 * Does this record fail at severity threshold `failOn` (1 = only severity 1, 2 = 1 and 2,
 * 3 = everything, null = never)? Pages that did not load always fail; dead controls count as severity 2.
 */
export function isFailing(r, failOn) {
  if (failOn == null) return false;
  if (!r.rendered) return true;
  if ((r.issues || []).some((i) => i.sev <= failOn)) return true;
  return failOn >= 2 && (r.dead || []).length > 0;
}

/** Plain-text report. `sev` = highest severity listed per run, `max` = lines per run. */
export function summarize(records, { sev = 2, max = 12, failOn = 1 } = {}) {
  const lines = [];
  const urls = new Set(records.map((r) => r.url));
  const widths = [...new Set(records.map((r) => r.vw))].sort((a, b) => b - a);
  lines.push(`diagram-audit: ${urls.size} page(s) x ${widths.length} width(s) = ${records.length} run(s)`);
  lines.push('');
  for (const r of records) {
    const c = counts(r);
    const dead = (r.dead || []).length;
    const tag = isFailing(r, failOn) ? 'FAIL' : 'ok  ';
    if (!r.rendered) {
      lines.push(`${tag}  ${r.url} @${r.vw}px  did not load: ${(r.errors || []).map((e) => e.msg).join(' | ').slice(0, 200)}`);
      continue;
    }
    lines.push(`${tag}  ${r.url} @${r.vw}px  S1 ${c[1]} · S2 ${c[2]} · S3 ${c[3]} · dead controls ${dead} · ${r.canvases} canvas(es) · ${r.states} state(s)`);
    const listed = (r.issues || []).filter((i) => i.sev <= sev).sort((a, b) => a.sev - b.sev);
    for (const i of listed.slice(0, max)) {
      const where = i.canvas >= 0 ? `canvas ${i.canvas}` : 'dom';
      const states = i.states && i.states.length ? ` [${i.states.slice(0, 3).join(', ')}${i.states.length > 3 ? ', ...' : ''}]` : '';
      lines.push(`        S${i.sev} ${i.type.padEnd(24)} ${where.padEnd(9)} ${describe(i)}${states}`);
    }
    if (listed.length > max) lines.push(`        ... ${listed.length - max} more`);
    for (const d of (r.dead || []).slice(0, max)) {
      lines.push(`        S2 ${('DEAD_' + d.kind.toUpperCase().replace('-', '_')).padEnd(24)} ${'control'.padEnd(9)} ${d.kind} #${d.i}${d.label ? ` ${JSON.stringify(d.label)}` : ''}${d.tried ? ` (${d.distinct || 1} distinct of ${d.tried} positions)` : ''}`);
    }
    if ((r.errors || []).length) lines.push(`        errors: ${r.errors.map((e) => `${e.type}: ${e.msg}`).join(' | ').slice(0, 300)}`);
  }

  // Totals by type
  const byType = new Map();
  for (const r of records) for (const i of r.issues || []) {
    const k = `S${i.sev} ${i.type}`;
    const e = byType.get(k) || { n: 0, runs: new Set() };
    e.n++;
    e.runs.add(`${r.url}@${r.vw}`);
    byType.set(k, e);
  }
  const deadRuns = records.filter((r) => (r.dead || []).length);
  if (byType.size || deadRuns.length) {
    lines.push('');
    lines.push('issue type                     issues   runs');
    for (const [k, e] of [...byType.entries()].sort()) lines.push(`${k.padEnd(30)} ${String(e.n).padStart(6)} ${String(e.runs.size).padStart(6)}`);
    if (deadRuns.length) lines.push(`${'S2 DEAD_CONTROL'.padEnd(30)} ${String(deadRuns.reduce((n, r) => n + r.dead.length, 0)).padStart(6)} ${String(deadRuns.length).padStart(6)}`);
  }
  lines.push('');
  if (failOn == null) lines.push(`${records.filter((r) => isFailing(r, 2)).length} of ${records.length} run(s) have severity 1-2 issues (report only)`);
  else lines.push(`${records.filter((r) => isFailing(r, failOn)).length} of ${records.length} run(s) fail at severity <= ${failOn}`);
  return lines.join('\n');
}
