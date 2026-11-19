'use strict';
const path = require('path');
const ejs = require('ejs');

const translation = require('../models/translation');

/** Every string in the data handed to a page (profiles, rows, versions), for the Hindi lookup. */
function stringsIn(value, out = [], depth = 0) {
  if (depth > 6 || out.length > 20000) return out;
  if (typeof value === 'string') { if (value.length > 1) out.push(value); return out; }
  if (Array.isArray(value)) { value.forEach((v) => stringsIn(v, out, depth + 1)); return out; }
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    for (const v of Object.values(value)) stringsIn(v, out, depth + 1);
  }
  return out;
}

const LAYOUT = path.join(__dirname, '..', 'views', 'partials', 'layout.ejs');
// A page on its own, without the sidebar and top bar — the sign-in screen.
const BARE = path.join(__dirname, '..', 'views', 'partials', 'bare.ejs');

/**
 * Render a page inside the shared layout. EJS has no template inheritance, so the page
 * is rendered first and injected as `body` — the same shape as the PHP layout's section.
 */
function attach(app) {
  app.use((req, res, next) => {
    res.page = async (view, data = {}) => {
      const locals = { ...res.locals, ...data };
      try {
        // Role profile content in Hindi: every string the page is given, looked up in one go.
        if (locals.lang === 'hi') {
          const hindi = await translation.lookup(stringsIn(data));
          locals.tc = (s) => { const h = hindi.get(translation.norm(s)); return h ? h.text : (s == null ? '' : s); };
        }
        const body = await ejs.renderFile(
          path.join(app.get('views'), `${view}.ejs`),
          locals,
          { async: true }
        );
        const html = await ejs.renderFile(locals.bare ? BARE : LAYOUT, { ...locals, body }, { async: true });
        res.send(html);
      } catch (err) {
        next(err);
      }
    };
    next();
  });
}

module.exports = { attach };
