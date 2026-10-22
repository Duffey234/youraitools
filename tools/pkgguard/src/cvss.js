// CVSS v3.0/v3.1 base score from a vector string (FIRST spec, section 7). Returns null for anything else.
const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
  C: { H: 0.56, L: 0.22, N: 0 }, I: { H: 0.56, L: 0.22, N: 0 }, A: { H: 0.56, L: 0.22, N: 0 },
};
const PR = { U: { N: 0.85, L: 0.62, H: 0.27 }, C: { N: 0.85, L: 0.68, H: 0.5 } };
const roundup = (x) => { const i = Math.round(x * 100000); return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10; };

export function cvss3Score(vector) {
  if (typeof vector !== 'string' || !/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = Object.fromEntries(vector.split('/').slice(1).map((p) => p.split(':')));
  const S = m.S;
  if (!W.AV[m.AV] || !W.AC[m.AC] || !PR[S]?.[m.PR] || !W.UI[m.UI] || W.C[m.C] === undefined || W.I[m.I] === undefined || W.A[m.A] === undefined) return null;
  const iss = 1 - (1 - W.C[m.C]) * (1 - W.I[m.I]) * (1 - W.A[m.A]);
  const impact = S === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  const expl = 8.22 * W.AV[m.AV] * W.AC[m.AC] * PR[S][m.PR] * W.UI[m.UI];
  if (impact <= 0) return 0;
  return S === 'U' ? roundup(Math.min(impact + expl, 10)) : roundup(Math.min(1.08 * (impact + expl), 10));
}

export const RANK = { NONE: 0, UNKNOWN: 1, LOW: 2, MEDIUM: 3, HIGH: 4, CRITICAL: 5 };
export function ratingFromScore(s) {
  if (s == null) return 'UNKNOWN';
  return s === 0 ? 'NONE' : s < 4 ? 'LOW' : s < 7 ? 'MEDIUM' : s < 9 ? 'HIGH' : 'CRITICAL';
}
