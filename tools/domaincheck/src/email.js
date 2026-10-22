// Email address syntax + classification (no network). Practical RFC 5321/5322 subset: dot-atom local part
// (quoted local parts are flagged unusual), 64-char local / 254-char address limits, IDN domains via punycode.
import { DISPOSABLE_LIST, DISPOSABLE_COUNT } from './data/disposable.js';

let disposableSet = null;
const disposable = () => (disposableSet ||= new Set(DISPOSABLE_LIST.split('\n')));
export { DISPOSABLE_COUNT };

/** True if the domain or any parent domain is on the disposable list (e.g. "x.mailinator.com"). */
export function isDisposableDomain(domain) {
  const set = disposable(); const labels = String(domain || '').toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i++) if (set.has(labels.slice(i).join('.'))) return true;
  return false;
}

export const FREE_PROVIDERS = new Set(('gmail.com googlemail.com yahoo.com yahoo.co.uk yahoo.co.jp yahoo.fr yahoo.de yahoo.es yahoo.it yahoo.com.br yahoo.co.in ymail.com rocketmail.com ' +
  'outlook.com hotmail.com hotmail.co.uk hotmail.fr hotmail.de hotmail.it hotmail.es live.com live.co.uk live.fr msn.com outlook.fr outlook.de ' +
  'icloud.com me.com mac.com aol.com aim.com proton.me protonmail.com protonmail.ch pm.me tutanota.com tutanota.de tuta.io tutamail.com ' +
  'gmx.com gmx.net gmx.de gmx.at gmx.ch web.de mail.com email.com zoho.com zohomail.com yandex.com yandex.ru ya.ru mail.ru inbox.ru list.ru bk.ru rambler.ru ' +
  'qq.com 163.com 126.com sina.com sohu.com yeah.net naver.com daum.net hanmail.net fastmail.com fastmail.fm hey.com ' +
  'libero.it virgilio.it tiscali.it orange.fr wanadoo.fr laposte.net free.fr sfr.fr t-online.de freenet.de seznam.cz wp.pl o2.pl onet.pl interia.pl ' +
  'rediffmail.com comcast.net verizon.net att.net sbcglobal.net cox.net charter.net bellsouth.net shaw.ca rogers.com sympatico.ca btinternet.com sky.com ' +
  'bigpond.com optusnet.com.au xtra.co.nz uol.com.br bol.com.br terra.com.br ig.com.br').split(/\s+/));

export const ROLE_LOCALS = new Set(('admin administrator abuse billing contact customerservice dev devnull dns ftp help helpdesk hello hi hostmaster info inquiries ' +
  'jobs careers hr legal mail mailer-daemon marketing media news newsletter no-reply noreply donotreply do-not-reply office ops orders ' +
  'postmaster press privacy root sales security service support sysadmin team tech webmaster www accounts accounting finance enquiries feedback ' +
  'partners partnerships it list lists notifications alerts bounce bounces').split(/\s+/));

const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** Normalize a hostname: lowercase, strip trailing dot, IDN -> punycode. Returns null if invalid. */
export function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  if (!d) return null;
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^.*@/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!d.includes('.')) return null;
  try { d = new URL(`http://${d}`).hostname; } catch { return null; }
  if (d.length > 253 || /^\d+\.\d+\.\d+\.\d+$/.test(d) || d.startsWith('[')) return null;
  const labels = d.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null;
  return d;
}

/** Syntax + classification. Does NOT touch the network. */
export function parseEmail(input) {
  const raw = String(input ?? '').trim();
  const out = { input: raw, valid_syntax: false, reason: null, local: null, domain: null, normalized: null };
  if (!raw) return { ...out, reason: 'empty' };
  if (raw.length > 254) return { ...out, reason: 'address longer than 254 characters' };
  const at = raw.lastIndexOf('@');
  if (at < 1 || at === raw.length - 1) return { ...out, reason: 'missing local part or domain' };
  const local = raw.slice(0, at); const dom = raw.slice(at + 1);
  if (local.length > 64) return { ...out, reason: 'local part longer than 64 characters' };
  const quoted = /^".*"$/.test(local);
  if (!quoted) {
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return { ...out, reason: 'dot at start/end or consecutive dots in local part' };
    if (!local.split('.').every((p) => ATEXT.test(p))) {
      if (/[^\x00-\x7f]/.test(local) && local.split('.').every((p) => /^[^\s"(),:;<>@[\\\]]+$/.test(p))) { /* SMTPUTF8 local part: allowed, flagged */ } else return { ...out, reason: 'invalid characters in local part' };
    }
  }
  const domain = normalizeDomain(dom);
  if (!domain || dom.includes('/') || dom.includes(':')) return { ...out, reason: 'invalid domain' };
  const lower = local.toLowerCase();
  const tagAt = lower.indexOf('+');
  const base = tagAt > 0 ? lower.slice(0, tagAt) : lower;
  const gmail = domain === 'gmail.com' || domain === 'googlemail.com';
  return {
    ...out, valid_syntax: true, local, domain,
    normalized: `${lower}@${domain}`,
    canonical: `${gmail ? base.replace(/\./g, '') : base}@${gmail ? 'gmail.com' : domain}`,
    plus_tag: tagAt > 0 ? lower.slice(tagAt + 1) : null,
    quoted_local: quoted, smtputf8: /[^\x00-\x7f]/.test(local),
    role: ROLE_LOCALS.has(base),
    free_provider: FREE_PROVIDERS.has(domain),
    disposable: isDisposableDomain(domain),
  };
}
