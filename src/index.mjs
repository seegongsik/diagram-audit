// diagram-audit · library entry point
export { DEFAULTS, instrumentScript, launchBrowser, auditPage, auditUrl } from './audit.mjs';
export { analyzeCanvas, analyzeDom, analyzeWatermark, issueSig, domIssueSig, THRESH, DOM_THRESH } from './analyze.mjs';
export { settle } from './settle.mjs';
export { summarize, isFailing } from './summarize.mjs';
