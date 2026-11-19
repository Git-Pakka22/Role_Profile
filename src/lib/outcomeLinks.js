'use strict';
/**
 * Links between a role profile's key outcomes and its attribute lines, and the
 * outcome-based assessment worked out from them.
 *
 * Each attribute line stores the numbers of the key outcomes it is linked to ("1,3", by
 * the outcomes' order on the profile). In an outcome-based assessment the assessor rates
 * the key outcomes; each linked attribute line then takes the average of its outcomes'
 * ratings, and is scored with its weight exactly as in the attribute method. Lines linked
 * to no outcome are rated directly.
 */

/** "1, 3,3,x" -> [1, 3] */
function parse(value) {
  return [...new Set(String(value ?? '')
    .split(',')
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isInteger(n) && n > 0))]
    .sort((a, b) => a - b);
}

/** [3, 1] -> "1,3"; nothing -> null */
function format(list) {
  const clean = parse((list || []).join(','));
  return clean.length ? clean.join(',') : null;
}

/** Does any line of this profile or version link to an outcome? */
function hasLinks(lines) {
  return (lines || []).some((l) => parse(l.outcome_links).length > 0);
}

/**
 * Work out the attribute lines' ratings from the outcome ratings.
 *
 *   lines     [{ id, outcome_links, ... }]
 *   outcomes  Map(outcome_no -> { rating, note })
 *   direct    { lineId: rating } for lines linked to no outcome
 *   directGaps{ lineId: text }
 *
 * Returns { ratings: {lineId: rating}, gaps: {lineId: text} } ready for assessment.save().
 * A derived rating is the average of the linked outcomes that were rated, to one decimal.
 * A line's training gap collects the notes of its linked outcomes rated 2 or below.
 */
function derive(lines, outcomes, direct = {}, directGaps = {}, labelOf = (no) => `O${no}`) {
  const ratings = {};
  const gaps = {};
  for (const line of lines) {
    const id = Number(line.id);
    const links = parse(line.outcome_links);
    if (!links.length) {
      if (direct[id] !== undefined) ratings[id] = direct[id];
      if (directGaps[id]) gaps[id] = directGaps[id];
      continue;
    }
    const rated = links.map((no) => ({ no, ...(outcomes.get(no) || {}) })).filter((o) => o.rating > 0);
    if (!rated.length) continue;
    const avg = rated.reduce((t, o) => t + Number(o.rating), 0) / rated.length;
    ratings[id] = Math.round(avg * 10) / 10;
    const notes = rated
      .filter((o) => Number(o.rating) <= 2 && String(o.note || '').trim() !== '')
      .map((o) => `${labelOf(o.no)}: ${String(o.note).trim()}`);
    if (notes.length) gaps[id] = notes.join('; ');
  }
  return { ratings, gaps };
}

module.exports = { parse, format, hasLinks, derive };
