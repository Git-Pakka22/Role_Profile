'use strict';
/**
 * Lists text the portal translates that has no Hindi yet in src/locales/hi.js.
 *
 *   node scripts/i18n_check.js
 *
 * It looks for the first argument of t(), t.html(), t.n() (both forms), req.t() and tr()
 * when it is a plain quoted string, and every quoted string inside tjs([...]). Text built at
 * run time (status labels, history labels and the like) is checked at run time instead:
 * start the portal with I18N_REPORT=1 and browse in Hindi — each missing string is logged once.
 */
const fs = require('fs');
const path = require('path');
const hi = require('../src/locales/hi');

const ROOT = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { if (name !== 'locales') walk(p); } else if (/\.(ejs|js)$/.test(name)) files.push(p);
  }
})(path.join(ROOT, 'src'));
files.push(path.join(ROOT, 'server.js'));

const str = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"`;
const call = new RegExp(String.raw`(?<![\w.$])(?:req\.)?(?:t|t\.html|tr)\(\s*(?:${str})`, 'g');
const plural = new RegExp(String.raw`(?<![\w.$])(?:req\.)?t\.n\(\s*(?:${str})\s*,\s*(?:${str})`, 'g');
const list = /\btjs\(\[([\s\S]*?)\]\)/g;
const unquote = (s) => s.replace(/\\(.)/g, '$1');

const missing = new Map();
const note = (key, file) => {
  if (!key || !/[A-Za-z]/.test(key) || key in hi) return;
  if (!missing.has(key)) missing.set(key, new Set());
  missing.get(key).add(path.relative(ROOT, file));
};
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(call)) note(unquote(m[1] ?? m[2]), file);
  for (const m of text.matchAll(plural)) { note(unquote(m[1] ?? m[2]), file); note(unquote(m[3] ?? m[4]), file); }
  for (const m of text.matchAll(list)) for (const s of m[1].matchAll(new RegExp(str, 'g'))) note(unquote(s[1] ?? s[2]), file);
}

if (!missing.size) {
  console.log(`All translated text has Hindi (${Object.keys(hi).length} entries).`);
} else {
  for (const [key, where] of missing) console.log(`${JSON.stringify(key)}  — ${[...where].join(', ')}`);
  console.log(`\n${missing.size} string(s) without Hindi.`);
  process.exitCode = 1;
}
