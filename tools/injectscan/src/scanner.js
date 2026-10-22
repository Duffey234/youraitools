// Service layer: scan plain text, a fetched web page (visible text + hidden HTML), or a list of MCP tool definitions.
import { scan } from './detect.js';
import { hiddenSegments } from './htmlhidden.js';

/** Scan plain text. */
export function scanText(text, { maxChars = 100000 } = {}) {
  const r = scan(text, { maxChars });
  return { input: 'text', ...r };
}

/**
 * Scan a page read by the Reader with includeRaw: the visible Markdown, plus text hidden in the HTML
 * (comments, CSS/attribute-hidden elements, alt/title/aria-label, meta). Instructions found in hidden text weigh more:
 * hiding text from the human reader is itself a signal.
 */
export function scanPage(page, { maxChars = 100000 } = {}) {
  const segs = page.raw ? hiddenSegments(page.raw) : [];
  const extra = []; const flaggedSegs = [];
  segs.forEach((seg, i) => {
    const sub = scan(seg.text, { maxChars: 20000, detail: false });
    const real = sub._findings.filter((f) => f.weight >= 0.3);
    if (!real.length) return;
    flaggedSegs.push({ segment: i, kind: seg.kind, text: seg.text.slice(0, 500), risk_score: sub.risk_score });
    extra.push({ rule: 'hidden.instructions_in_hidden_html', category: 'hidden_text', weight: 0.5, start: 0, end: seg.text.length, location: seg.kind, segment: i });
    for (const f of sub._findings) extra.push({ ...f, weight: Math.min(0.95, f.weight + 0.15), location: seg.kind, segment: i });
  });
  const r = scan(page.markdown, { maxChars, extraFindings: extra });
  const findings = r.findings.map((f) => (f.segment != null
    ? { ...f, text: segs[f.segment].text.slice(f.start, Math.min(f.end, f.start + 200)) }
    : { ...f, location: f.location === 'text' ? 'visible' : f.location }));
  return {
    input: 'url', url: page.url, finalUrl: page.finalUrl, title: page.title, ...r, findings,
    hidden_html: { segments_checked: segs.length, flagged: flaggedSegs },
    page: { status: page.status, contentType: page.contentType, visibleChars: page.chars, sourceBytes: page.sourceBytes, robots: page.robots, fetchedAt: page.fetchedAt },
  };
}

/** Collect every human-readable string of an MCP tool definition with its JSON path. */
function toolStrings(tool) {
  const out = [];
  const walk = (v, path, depth) => {
    if (depth > 8 || out.length > 400) return;
    if (typeof v === 'string') { if (v.trim()) out.push({ path, text: v }); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      if (['type', '$schema', 'format', 'pattern', '$ref', '$id'].includes(k)) continue;
      walk(x, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk({ name: tool?.name, title: tool?.title, description: tool?.description, inputSchema: tool?.inputSchema ?? tool?.input_schema ?? tool?.parameters, annotations: tool?.annotations }, '', 0);
  return out;
}

/** Scan MCP / function-calling tool definitions for tool poisoning. */
export function scanTools(tools, { maxChars = 100000 } = {}) {
  const results = tools.map((tool, idx) => {
    const fields = toolStrings(tool); const extra = [];
    let budget = maxChars;
    for (const f of fields) {
      if (budget <= 0) break;
      const t = f.text.slice(0, budget); budget -= t.length;
      const sub = scan(t, { maxChars: t.length, detail: false });
      for (const x of sub._findings) extra.push({ ...x, location: f.path, field: f.path, snippet: t.slice(x.start, Math.min(x.end, x.start + 200)) });
    }
    // Long descriptions hide instructions more easily; flag unusually long ones (weak).
    const desc = typeof tool?.description === 'string' ? tool.description : '';
    if (desc.length > 2000) extra.push({ rule: 'tool.long_description', category: 'tool_hijack', weight: 0.15, start: 0, end: desc.length, location: 'description', field: 'description' });
    const r = scan('', { extraFindings: extra });
    
    return {
      index: idx, name: typeof tool?.name === 'string' ? tool.name : null,
      risk_score: r.risk_score, verdict: r.verdict, flagged: r.flagged, categories: r.categories,
      findings: r.findings.map(({ text, snippet, ...f }) => ({ ...f, text: snippet })),
    };
  });
  const worst = results.reduce((a, b) => (b.risk_score > (a?.risk_score ?? -1) ? b : a), null);
  return {
    input: 'tools', risk_score: worst?.risk_score ?? 0, verdict: worst?.verdict ?? 'safe', flagged: results.some((t) => t.flagged),
    tools_scanned: results.length, tools_flagged: results.filter((t) => t.flagged).length, tools: results,
  };
}
