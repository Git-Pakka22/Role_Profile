'use strict';
const crypto = require('crypto');
const db = require('../lib/db');

/**
 * Hindi for role profile content. One row per distinct English text, so the wording a
 * profile shares with its frozen versions, or with another profile, carries one Hindi text.
 * An AI draft is marked 'ai' until someone corrects or confirms it ('edited').
 *
 * Everything here tolerates a database where scripts/migrate_translations.js has not run yet:
 * lookups come back empty and the content simply shows in English.
 */
const LANG = 'hi';
const norm = (s) => String(s == null ? '' : s).trim();
const hashOf = (s) => crypto.createHash('sha256').update(norm(s)).digest('hex');
const translatable = (s) => /[A-Za-z]/.test(norm(s)) && norm(s).length <= 4000;

/** English text -> { text, origin, ... } for the given strings that have Hindi. */
async function lookup(texts) {
  const wanted = [...new Set(texts.map(norm).filter(translatable))];
  const out = new Map();
  if (!wanted.length) return out;
  try {
    for (let i = 0; i < wanted.length; i += 500) {
      const chunk = wanted.slice(i, i + 500);
      const rows = await db.query(
        `SELECT source_text, text, origin, updated_by, updated_by_name, updated_at FROM rp_translations
         WHERE lang = ? AND source_hash IN (?)`, [LANG, chunk.map(hashOf)]);
      for (const r of rows) out.set(norm(r.source_text), r);
    }
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  return out;
}

/** Save one Hindi text. An AI draft never overwrites something a person wrote. */
async function save(source, hindi, origin, actor = {}) {
  const src = norm(source);
  const text = norm(hindi);
  if (!translatable(src) || !text) return false;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const res = await db.run(
    `INSERT INTO rp_translations (source_hash, lang, source_text, text, origin, updated_by, updated_by_name, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       text = IF(origin = 'edited' AND VALUES(origin) = 'ai', text, VALUES(text)),
       updated_by = IF(origin = 'edited' AND VALUES(origin) = 'ai', updated_by, VALUES(updated_by)),
       updated_by_name = IF(origin = 'edited' AND VALUES(origin) = 'ai', updated_by_name, VALUES(updated_by_name)),
       updated_at = IF(origin = 'edited' AND VALUES(origin) = 'ai', updated_at, VALUES(updated_at)),
       origin = IF(origin = 'edited' AND VALUES(origin) = 'ai', origin, VALUES(origin))`,
    [hashOf(src), LANG, src, text, origin, actor.code || '', actor.name || '', now]);
  return res.affectedRows > 0;
}

/** Every piece of content in a role profile as it stands now, in reading order, labelled. */
async function profileTexts(profileId) {
  const items = [];
  const p = await db.first('SELECT mission FROM rp_role_profiles WHERE id = ?', [profileId]);
  if (!p) return items;
  if (translatable(p.mission)) items.push({ kind: 'mission', text: norm(p.mission) });
  for (const o of await db.query('SELECT outcome FROM rp_role_key_outcomes WHERE role_profile_id = ? ORDER BY sort_order', [profileId])) {
    if (translatable(o.outcome)) items.push({ kind: 'outcome', text: norm(o.outcome) });
  }
  const seen = new Set();
  for (const d of await db.query(
    `SELECT attribute_no, attribute, assessment, measure_1, measure_2, measure_3, tech_skill FROM rp_role_profile_details
     WHERE role_profile_id = ? ORDER BY attribute_no, sort_order`, [profileId])) {
    if (!seen.has(d.attribute_no)) {
      seen.add(d.attribute_no);
      if (translatable(d.attribute)) items.push({ kind: 'skill', no: d.attribute_no, text: norm(d.attribute) });
      if (translatable(d.assessment)) items.push({ kind: 'mechanism', no: d.attribute_no, text: norm(d.assessment) });
      for (const m of [d.measure_1, d.measure_2, d.measure_3]) {
        if (translatable(m)) items.push({ kind: 'measure', no: d.attribute_no, text: norm(m) });
      }
    }
    if (translatable(d.tech_skill)) items.push({ kind: 'attribute', no: d.attribute_no, text: norm(d.tech_skill) });
  }
  // The same wording twice in one profile is one translation.
  const once = new Set();
  return items.filter((i) => (once.has(i.text) ? false : once.add(i.text)));
}

/** Every content text in the database — current profiles and all frozen versions. */
async function allTexts() {
  const texts = new Set();
  const add = (rows) => rows.forEach((r) => Object.values(r).forEach((v) => translatable(v) && texts.add(norm(v))));
  add(await db.query('SELECT mission FROM rp_role_profiles'));
  add(await db.query('SELECT outcome FROM rp_role_key_outcomes'));
  add(await db.query('SELECT attribute, assessment, measure_1, measure_2, measure_3, tech_skill FROM rp_role_profile_details'));
  add(await db.query('SELECT mission FROM rp_profile_versions'));
  add(await db.query('SELECT outcome FROM rp_version_outcomes'));
  add(await db.query('SELECT attribute, assessment, measure_1, measure_2, measure_3, tech_skill FROM rp_version_details'));
  return [...texts];
}

/** How far a profile's Hindi has got: how many lines, how many still AI drafts, how many missing. */
async function status(profileId) {
  const items = await profileTexts(profileId);
  const have = await lookup(items.map((i) => i.text));
  let ai = 0; let edited = 0; let missing = 0;
  for (const i of items) {
    const h = have.get(i.text);
    if (!h) missing++; else if (h.origin === 'edited') edited++; else ai++;
  }
  return { total: items.length, ai, edited, missing };
}

module.exports = { LANG, norm, hashOf, translatable, lookup, save, profileTexts, allTexts, status };
