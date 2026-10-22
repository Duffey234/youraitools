// Manifest / lockfile parsing: turns a dependency file into [{ ecosystem, name, version, pinned, spec }].
// Supported: package.json, package-lock.json (v1/v2/v3), requirements.txt, Pipfile.lock, poetry.lock, go.mod,
// Cargo.lock, composer.lock. Pure string parsing, no network. Unpinned specs (e.g. "*", "latest", git URLs,
// bare requirement names) are returned with version null and reported as "unpinned" (not queried).
export const ECOSYSTEMS = ['npm', 'PyPI', 'Go', 'crates.io', 'Packagist', 'RubyGems', 'Maven', 'NuGet', 'Pub', 'Hex'];
export const MANIFEST_TYPES = ['package.json', 'package-lock.json', 'requirements.txt', 'Pipfile.lock', 'poetry.lock', 'go.mod', 'Cargo.lock', 'composer.lock'];
const ECO_ALIASES = Object.fromEntries(ECOSYSTEMS.map((e) => [e.toLowerCase(), e]).concat([['pypi', 'PyPI'], ['pip', 'PyPI'], ['python', 'PyPI'], ['golang', 'Go'], ['go', 'Go'], ['cargo', 'crates.io'], ['crates', 'crates.io'], ['rust', 'crates.io'], ['composer', 'Packagist'], ['php', 'Packagist'], ['gem', 'RubyGems'], ['ruby', 'RubyGems'], ['node', 'npm'], ['javascript', 'npm']]));

export function normalizeEcosystem(e) { return typeof e === 'string' ? ECO_ALIASES[e.trim().toLowerCase()] || null : null; }

const VERSION_RE = /^v?\d+(\.\d+){0,3}([-+.][0-9A-Za-z.+-]*)?$/;
/** npm-style range -> lowest version it allows ("^4.17.0" -> 4.17.0, "~1.2" -> 1.2.0), or null if not resolvable. */
export function floorVersion(spec) {
  if (typeof spec !== 'string') return null;
  let s = spec.trim();
  if (!s || /^(\*|x|latest|next|workspace:|file:|link:|git|github:|http|npm:)/i.test(s) || s.includes('/')) return null;
  s = s.split('||')[0].trim().split(/\s+-\s+/)[0].trim().split(/\s+/)[0];
  s = s.replace(/^(\^|~>|~=|~|>=|==|=|v(?=\d))/, '');
  if (/^[<>]/.test(s)) return null;
  s = s.replace(/\.(x|\*)(?=\.|$)/gi, '.0');
  if (!VERSION_RE.test(s)) return null;
  const parts = s.split(/(?=[-+])/)[0].split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.') + s.slice(s.split(/(?=[-+])/)[0].length);
}

export function detectType(text, filename = '') {
  const f = String(filename).split(/[\\/]/).pop().toLowerCase();
  const byName = MANIFEST_TYPES.find((t) => t.toLowerCase() === f);
  if (byName) return byName;
  if (/requirements.*\.txt$/.test(f)) return 'requirements.txt';
  const t = text.trimStart();
  if (t.startsWith('{')) {
    if (/"lockfileVersion"\s*:/.test(t)) return 'package-lock.json';
    if (/"_meta"\s*:/.test(t) && /"default"\s*:/.test(t)) return 'Pipfile.lock';
    if (/"content-hash"\s*:/.test(t) && /"packages"\s*:/.test(t)) return 'composer.lock';
    if (/"(dependencies|devDependencies|name)"\s*:/.test(t)) return 'package.json';
    return null;
  }
  if (/^module\s+\S+/m.test(t) && /^(require|go)\s/m.test(t)) return 'go.mod';
  if (/^\[\[package\]\]/m.test(t)) return /^source\s*=\s*"registry\+https:\/\/github\.com\/rust-lang/m.test(t) || /^checksum\s*=/m.test(t) || /^version\s*=\s*\d+\s*$/m.test(t) ? 'Cargo.lock' : 'poetry.lock';
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]*\])?\s*(==|>=|~=|<=|!=|>|<|===)?/m.test(t)) return 'requirements.txt';
  return null;
}

const pkg = (ecosystem, name, spec, { exact = false, dev = false } = {}) => {
  const version = exact ? (VERSION_RE.test(String(spec || '').trim()) ? String(spec).trim().replace(/^v(?=\d)/, ecosystem === 'Go' ? 'v' : '') : null) : floorVersion(spec);
  const pinned = !!version && (exact || /^=?v?\d+(\.\d+){2}([-+][0-9A-Za-z.+-]*)?$/.test(String(spec).trim()));
  return { ecosystem, name, version, pinned, spec: spec == null ? null : String(spec), ...(dev ? { dev: true } : {}) };
};

function parseJson(text, what) {
  try { const j = JSON.parse(text); if (j && typeof j === 'object') return j; } catch { /* fallthrough */ }
  throw new ManifestError(`${what} is not valid JSON`);
}
export class ManifestError extends Error { constructor(m) { super(m); this.name = 'ManifestError'; } }

const PARSERS = {
  'package.json': (text, o) => {
    const j = parseJson(text, 'package.json'); const out = [];
    for (const [sect, dev] of [['dependencies', false], ['optionalDependencies', false], ['peerDependencies', false], ['devDependencies', true]]) {
      if (dev && o.includeDev === false) continue;
      for (const [n, s] of Object.entries(j[sect] || {})) out.push(pkg('npm', n, s, { dev }));
    }
    return out;
  },
  'package-lock.json': (text, o) => {
    const j = parseJson(text, 'package-lock.json'); const out = [];
    if (j.packages && typeof j.packages === 'object') {
      for (const [path, v] of Object.entries(j.packages)) {
        if (!path || !v || typeof v !== 'object' || v.link) continue;
        const name = v.name || path.split('node_modules/').pop();
        if (!name || (v.dev && o.includeDev === false)) continue;
        out.push(pkg('npm', name, v.version, { exact: true, dev: !!v.dev }));
      }
    } else {
      const walk = (deps) => { for (const [n, v] of Object.entries(deps || {})) { if (v.dev && o.includeDev === false) continue; out.push(pkg('npm', n, v.version, { exact: true, dev: !!v.dev })); walk(v.dependencies); } };
      walk(j.dependencies);
    }
    return out;
  },
  'requirements.txt': (text) => {
    const out = [];
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trim();
      if (!line || line.startsWith('-') || /^[a-z+]+:\/\//i.test(line) || line.includes(' @ ')) continue;
      line = line.split(';')[0].trim();
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(===|==|~=|>=)?\s*([^,\s]*)?/);
      if (!m) continue;
      const [, name, , op, ver] = m;
      if (op === '==' || op === '===') out.push(pkg('PyPI', name, ver && !ver.includes('*') ? ver : null, { exact: true }));
      else if (op === '~=' || op === '>=') out.push({ ...pkg('PyPI', name, ver), spec: `${op}${ver || ''}` });
      else out.push({ ecosystem: 'PyPI', name, version: null, pinned: false, spec: line.slice(name.length).trim() || null });
    }
    return out;
  },
  'Pipfile.lock': (text, o) => {
    const j = parseJson(text, 'Pipfile.lock'); const out = [];
    for (const [sect, dev] of [['default', false], ['develop', true]]) {
      if (dev && o.includeDev === false) continue;
      for (const [n, v] of Object.entries(j[sect] || {})) out.push(pkg('PyPI', n, String(v?.version || '').replace(/^==/, '') || null, { exact: true, dev }));
    }
    return out;
  },
  'poetry.lock': (text) => tomlPackages(text, 'PyPI'),
  'Cargo.lock': (text) => tomlPackages(text, 'crates.io'),
  'go.mod': (text) => {
    const out = []; let block = false;
    for (let line of text.split(/\r?\n/)) {
      line = line.replace(/\/\/.*$/, '').trim();
      if (!line) continue;
      if (/^require\s*\($/.test(line)) { block = true; continue; }
      if (block && line === ')') { block = false; continue; }
      const m = block ? line.match(/^(\S+)\s+(v\S+)/) : line.match(/^require\s+(\S+)\s+(v\S+)/);
      if (m) out.push(pkg('Go', m[1], m[2], { exact: true }));
    }
    return out;
  },
  'composer.lock': (text, o) => {
    const j = parseJson(text, 'composer.lock'); const out = [];
    for (const [sect, dev] of [['packages', false], ['packages-dev', true]]) {
      if (dev && o.includeDev === false) continue;
      for (const v of j[sect] || []) if (v?.name) out.push(pkg('Packagist', v.name, String(v.version || '').replace(/^v(?=\d)/, ''), { exact: true, dev }));
    }
    return out;
  },
};

function tomlPackages(text, ecosystem) {
  const out = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const body = block.split(/^\[(?!\[package)/m)[0];
    const name = body.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = body.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (ecosystem === 'crates.io' && /^source\s*=/m.test(body) === false && !/^checksum/m.test(body)) continue; // local workspace crate
    if (name) out.push(pkg(ecosystem, name, version, { exact: true }));
  }
  return out;
}

/** Parse one manifest. Returns { type, packages } or throws ManifestError. Duplicates (same eco/name/version) are merged. */
export function parseManifest(text, { filename, type, includeDev = true } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new ManifestError('"manifest" must be a non-empty string (the file contents)');
  const t = type ? MANIFEST_TYPES.find((x) => x.toLowerCase() === String(type).toLowerCase()) : detectType(text, filename);
  if (!t) throw new ManifestError(`could not detect the manifest type; pass "type" (one of ${MANIFEST_TYPES.join(', ')})`);
  const packages = dedupe(PARSERS[t](text, { includeDev }));
  return { type: t, packages };
}

export function dedupe(list) {
  const seen = new Map();
  for (const p of list) {
    const k = `${p.ecosystem}\u0000${p.ecosystem === 'PyPI' ? p.name.toLowerCase().replace(/[-_.]+/g, '-') : p.name}\u0000${p.version || ''}`;
    if (!seen.has(k)) seen.set(k, p); else if (!p.dev) seen.get(k).dev = undefined;
  }
  return [...seen.values()].map((p) => (p.dev ? p : (({ dev, ...r }) => r)(p)));
}

/** Validate an explicit packages list [{ ecosystem, name, version }]. Returns { packages } or { error }. */
export function readPackageList(list, max) {
  if (!Array.isArray(list) || !list.length) return { error: '"packages" must be a non-empty array of {ecosystem, name, version}' };
  if (list.length > max) return { error: `at most ${max} packages per scan` };
  const out = [];
  for (const [i, p] of list.entries()) {
    if (!p || typeof p !== 'object') return { error: `packages[${i}] must be an object {ecosystem, name, version}` };
    const ecosystem = normalizeEcosystem(p.ecosystem || 'npm');
    if (!ecosystem) return { error: `packages[${i}].ecosystem must be one of ${ECOSYSTEMS.join(', ')}` };
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 214) return { error: `packages[${i}].name (string, 1-214 chars) is required` };
    const v = p.version == null || p.version === '' ? null : String(p.version).trim();
    if (v !== null && (v.length > 64 || !VERSION_RE.test(v))) return { error: `packages[${i}].version "${v.slice(0, 64)}" is not an exact version (e.g. 4.17.21)` };
    out.push({ ecosystem, name: p.name.trim(), version: v, pinned: !!v, spec: v });
  }
  return { packages: dedupe(out) };
}
