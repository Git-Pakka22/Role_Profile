'use strict';
/**
 * "Outcomes Measurability": for each technical skill, a measurable target for each of three
 * consecutive financial years. A profile records the first of them (measure_from,
 * "2026-2027"); the skill's targets are measure_1 … measure_3.
 */
const YEARS = 3;

/** "2026-2027" (or "2026-27", "2026–27") → 2026; anything else → null. */
function startOf(year) {
  const m = /^\s*(\d{4})\s*[-–—/]\s*(\d{2}|\d{4})\s*$/.exec(String(year || ''));
  return m ? Number(m[1]) : null;
}

/** Normalise any spelling of a financial year to "2026-2027"; null if it is not one. */
function fullYear(year) {
  const y = startOf(year);
  return y ? `${y}-${y + 1}` : null;
}

/** The three year labels, as the Pakka sheets write them: 2026-27, 2027-28, 2028-29. */
function labels(from) {
  const y = startOf(from);
  if (!y) return [];
  return Array.from({ length: YEARS }, (_, i) => `${y + i}-${String(y + i + 1).slice(2)}`);
}

/** "2026–2029" for the heading. */
function span(from) {
  const y = startOf(from);
  return y ? `${y}–${y + YEARS}` : '';
}

/** The three targets of a detail row (or a grouped skill), trimmed. */
function of(row) {
  return [row.measure_1, row.measure_2, row.measure_3].map((v) => String(v ?? '').trim());
}

/** Does any skill carry a target? */
function any(rows) {
  return (rows || []).some((r) => of(r).some(Boolean));
}

module.exports = { YEARS, startOf, fullYear, labels, span, of, any };
