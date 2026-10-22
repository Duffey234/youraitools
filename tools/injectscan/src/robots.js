// robots.txt (RFC 9309): groups by user-agent, longest-match Allow/Disallow with * and $.
// Our product token is matched case-insensitively; falls back to the "*" group.
export function parseRobots(txt) {
  const groups = []; let cur = null; let lastWasAgent = false;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const key = m[1].toLowerCase(); const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  return groups;
}
function ruleMatches(pattern, path) {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const re = new RegExp('^' + pattern.replace(/\$$/, '').replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + (anchored ? '$' : ''));
  return re.test(path);
}
/** @returns {boolean} whether `path` (path + query) may be fetched by `agent`. */
export function isAllowed(groups, agent, path) {
  const a = agent.toLowerCase();
  let group = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  if (!group.length) group = groups.filter((g) => g.agents.includes('*'));
  const rules = group.flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}
