// Minimal JSON Schema (draft 2020-12 subset) validator for x402 Bazaar declarations: type, const, enum, properties,
// required, additionalProperties (boolean or schema), items, minLength/maxLength, pattern, minimum/maximum, anyOf/oneOf/allOf
// and same-document $ref ("#/..."). External $ref / $id are reported, never resolved (no network, no file access).
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeOk = (t, v) => { const a = typeOf(v); return t === a || (t === 'number' && a === 'integer'); };

/** Lists every $ref / $id that is not a same-document fragment ("#..."). */
export function externalRefs(schema, path = '#', out = []) {
  if (!schema || typeof schema !== 'object') return out;
  for (const [k, v] of Object.entries(schema)) {
    if ((k === '$ref' || k === '$id') && typeof v === 'string' && !v.startsWith('#')) out.push(`${path}/${k}=${v.slice(0, 120)}`);
    else if (v && typeof v === 'object') externalRefs(v, `${path}/${k}`, out);
    if (out.length > 20) break;
  }
  return out;
}

function resolvePointer(root, ref) {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let cur = root;
  for (const raw of ref.slice(2).split('/')) { const k = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~'); if (cur == null || typeof cur !== 'object') return undefined; cur = cur[k]; }
  return cur;
}

/** Validate `value` against `schema`. Returns an array of { path, message } (empty = valid). */
export function validate(schema, value, { root = schema, path = '', depth = 0, errors = [] } = {}) {
  if (errors.length > 50 || depth > 40) return errors;
  if (schema === true || schema === undefined) return errors;
  if (schema === false) { errors.push({ path: path || '/', message: 'not allowed (schema false)' }); return errors; }
  if (typeof schema !== 'object' || schema === null) return errors;
  const err = (message) => errors.push({ path: path || '/', message });
  if (typeof schema.$ref === 'string') {
    if (!schema.$ref.startsWith('#')) { err(`external $ref ${schema.$ref} not allowed`); return errors; }
    const t = resolvePointer(root, schema.$ref);
    if (t === undefined) err(`unresolvable $ref ${schema.$ref}`); else validate(t, value, { root, path, depth: depth + 1, errors });
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) { err(`expected ${types.join('|')}, got ${typeOf(value)}`); return errors; }
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) err(`must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) err(`must be one of ${JSON.stringify(schema.enum).slice(0, 120)}`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) err(`shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) err(`longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string') { try { if (!new RegExp(schema.pattern, 'u').test(value)) err(`does not match ${schema.pattern}`); } catch { /* invalid pattern: reported by the caller's lint */ } }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) err(`below minimum ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) err(`above maximum ${schema.maximum}`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties || {};
    for (const r of Array.isArray(schema.required) ? schema.required : []) if (!(r in value)) err(`missing required property "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (k in props) validate(props[k], v, { root, path: `${path}/${k}`, depth: depth + 1, errors });
      else if (schema.additionalProperties === false) errors.push({ path: `${path}/${k}`, message: 'additional property not allowed' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(schema.additionalProperties, v, { root, path: `${path}/${k}`, depth: depth + 1, errors });
    }
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') value.slice(0, 50).forEach((v, i) => validate(schema.items, v, { root, path: `${path}/${i}`, depth: depth + 1, errors }));
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) validate(s, value, { root, path, depth: depth + 1, errors });
  for (const kw of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[kw])) continue;
    const n = schema[kw].filter((s) => !validate(s, value, { root, path, depth: depth + 1, errors: [] }).length).length;
    if (kw === 'anyOf' ? n === 0 : n !== 1) err(`${kw}: ${n} of ${schema[kw].length} subschemas matched`);
  }
  return errors;
}
