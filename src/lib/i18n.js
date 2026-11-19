'use strict';
/**
 * The portal's two languages. English is written in the code itself and doubles as the key:
 * t('Role Profiles') gives "Role Profiles" in English and the Hindi from locales/hi.js in
 * Hindi. A string the dictionary doesn't have yet falls back to English rather than breaking.
 *
 *   t(text, vars)            plain text — escape it in the view with <%= %>
 *   t.html(text, vars)       markup — the text may carry <strong> etc.; vars are escaped
 *                            unless wrapped in raw(). Output it with <%- %>
 *   t.n(one, other, n, vars) singular/plural; {n} is filled in
 *
 * {name} placeholders let the Hindi put a value where Hindi word order wants it.
 * The choice lives in the rp_lang cookie, so it holds on the sign-in page too.
 */
const hi = require('../locales/hi');

const LANGS = ['en', 'hi'];
const COOKIE = 'rp_lang';

const escape = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Marks a value as markup already, so t.html() puts it in as it is. */
const raw = (html) => ({ __html: String(html) });

const fill = (text, vars, html) => (vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => {
  if (!(k in vars)) return m;
  const v = vars[k];
  if (v && typeof v === 'object' && '__html' in v) return html ? v.__html : String(v.__html).replace(/<[^>]*>/g, '');
  return html ? escape(v) : String(v == null ? '' : v);
}) : String(text));

// Each missing Hindi string is reported once, so new text is easy to spot while developing.
const reported = new Set();
function lookup(dict, key) {
  if (!dict) return key;
  const found = dict[key];
  if (found !== undefined) return found;
  if (process.env.I18N_REPORT && !reported.has(key)) {
    reported.add(key);
    console.warn(`[i18n] no Hindi for: ${JSON.stringify(key)}`);
  }
  return key;
}

function translator(lang) {
  const dict = lang === 'hi' ? hi : null;
  const t = (key, vars) => fill(lookup(dict, key), vars, false);
  t.html = (key, vars) => fill(lookup(dict, key), vars, true);
  t.n = (one, other, n, vars) => t(Number(n) === 1 ? one : other, { n, ...vars });
  t.lang = lang;
  return t;
}

/** The language a request asked for: the rp_lang cookie, else English. */
function langOf(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)rp_lang=([a-z]{2})/);
  return m && LANGS.includes(m[1]) ? m[1] : 'en';
}

/** Where to go back to after switching: a path on this site only, never another host. */
function safeNext(next) {
  const s = String(next || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/';
}

module.exports = { translator, langOf, safeNext, raw, escape, LANGS, COOKIE };
