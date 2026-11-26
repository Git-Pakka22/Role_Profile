'use strict';
const ExcelJS = require('exceljs');
const roleProfile = require('../models/roleProfile');
// Messages are in English unless the caller passes its reader's translator as options.t.
const EN = require('./i18n').translator('en');
const measures = require('./measures');

// The widest layout: SN, skill, attribute, three measurability years, weightage,
// sub-weightage, key outcome no., assessment mechanism — and some room to spare.
const MAX_COLS = 12;
// A financial year as the sheets write it: 2026-27, 2026-2027, 2026–27.
const YEAR_RE = /^\s*\d{4}\s*[-–—/]\s*(\d{2}|\d{4})\s*$/;

/**
 * Read a role profile out of a spreadsheet laid out the way Pakka writes them:
 *
 *   A1                designation
 *   A2                Mission: / Mission- ...
 *   A3..              Key Outcomes:  then one numbered line each, or all in one cell
 *   header row        SN | Technical Skills | Attribute | Weightage | Sub-Weightage | Key Outcomes
 *   rows              the skill and its weightage span that skill's attributes
 *   last row          Total
 *
 * Outcomes Measurability is optional too: three year columns (2026-27, 2027-28, 2028-29)
 * between Attribute and Weightage, under a "Outcomes Measurability" heading or headed by the
 * years themselves, holding each skill's target for that year.
 *
 * Key Outcome No. is optional: for each attribute line, the numbers of the key outcomes it
 * delivers ("1, 3"; "O1, O3" is read too). Only numbers — outcome text there is not guessed
 * at, it is reported. Those become the links used by the outcome assessment.
 *
 * Merged cells leave the copies blank, so an attribute and its weight carry down until the
 * next one appears. Nothing here is saved — the parsed content goes back into the form for
 * the creator to check and adjust.
 */

const text = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    // Rich text and formula cells arrive as objects.
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if (value.result !== undefined) return String(value.result);
    if (value.text !== undefined) return String(value.text);
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
};

const number = (value) => {
  const raw = text(value).replace(/[^\d.\-]/g, '');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

const isHeaderRow = (cells) => {
  const joined = cells.map((c) => text(c).toLowerCase());
  return joined.some((c) => c === 'sn' || c === 's.n' || c === 'sr no')
    && joined.some((c) => c.includes('weightage') || c.includes('weight'));
};

/**
 * Which column is which, read off the header row itself rather than assumed fixed
 * positions — LDP's sheets add an "Assessment Mechanism" column between Skills and
 * Weightage that PSP's plain 5-column layout doesn't have, shifting everything after it.
 * Falls back to the original SN/Attribute/Skill/Weightage/Sub-Weightage positions for
 * anything the header text doesn't clearly identify.
 */
function detectColumns(cells) {
  const idx = {};
  cells.forEach((cell, i) => {
    const t = text(cell).toLowerCase();
    if (!t) return;
    if (idx.sn === undefined && /^(sn|s\.n\.?|sr\.?\s*no\.?)$/.test(t)) idx.sn = i;
    // "Outcomes Measurability" heads the year columns — it is not the Key Outcome No. column.
    else if (t.includes('measurability') || YEAR_RE.test(t)) return;
    // "Key Outcome No." — but not "Outcome-based Technical Skill", which is the skill column.
    else if (idx.outcomes === undefined && t.includes('outcome') && !/skill|attribute|capabilit/.test(t)) idx.outcomes = i;
    else if (idx.attribute === undefined && t.includes('attribute')) idx.attribute = i;
    else if (idx.skill === undefined && t.includes('skill')) idx.skill = i;
    else if (idx.assessment === undefined && t.includes('assessment')) idx.assessment = i;
    else if (idx.subWeight === undefined && (t.includes('sub-weight') || t.includes('sub weight') || t.includes('individual weight'))) idx.subWeight = i;
    else if (idx.weight === undefined && t.includes('weight')) idx.weight = i;
  });
  // The two name columns are told apart by position, not by their wording: the left one is
  // the weighted main line, the right one the sub-weighted lines under it. Sheets have used
  // "Attribute | Technical Skills", "Skill | Attributes" and "Technical Skills | Attribute".
  if (idx.attribute !== undefined && idx.skill !== undefined && idx.skill < idx.attribute) {
    [idx.attribute, idx.skill] = [idx.skill, idx.attribute];
  }
  return {
    sn: idx.sn ?? 0,
    attribute: idx.attribute ?? 1,
    skill: idx.skill ?? 2,
    assessment: idx.assessment,
    outcomes: idx.outcomes,
    weight: idx.weight ?? 3,
    subWeight: idx.subWeight ?? 4,
  };
}

/**
 * "1, 3" / "O1, O3" / "1 & 3" → [1, 3]; blank → []. Anything else — such as the outcome's own
 * wording, whose "2%" must not become a link to outcome 2 — gives null.
 */
function outcomeNumbers(value) {
  const raw = text(value).trim();
  if (raw === '') return [];
  const tokens = raw.split(/\s*(?:,|;|&|\/|\band\b|\s)\s*/i).filter(Boolean);
  if (!tokens.every((tk) => /^o?\d+$/i.test(tk))) return null;
  return [...new Set(tokens.map((tk) => Number(tk.replace(/^o/i, ''))).filter((n) => n > 0))].sort((a, b) => a - b);
}

/** "Mission- Build ..." / "Mission: Build ..." → "Build ..." */
const afterLabel = (value) => text(value).replace(/^[^:–—-]*[:–—-]\s*/, '').trim();

/**
 * "Outcome 2030 1. First - with a dash 2. Second 3. Third" → three entries.
 *
 * Splits at "1.", "2.", "3." ... in sequence, found anywhere in the text — never at a
 * plain dash, so an outcome that itself reads "Metric - Target%" (the normal Pakka style)
 * isn't mistaken for a label and chopped in half. Anything before the "1." (a title like
 * "Outcome 2030") is discarded, same as a "Key Outcomes:" label would be.
 */
function splitNumbered(value) {
  const raw = text(value);
  if (!raw) return [];

  const marker = /(\d+)[.)]\s+/g;
  const hits = [];
  let m;
  let expected = 1;
  while ((m = marker.exec(raw))) {
    if (Number(m[1]) === expected) {
      hits.push({ start: m.index, end: marker.lastIndex });
      expected++;
    }
  }

  if (!hits.length) {
    const single = afterLabel(raw);
    return single ? [single] : [];
  }

  const parts = [];
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].end;
    const stop = i + 1 < hits.length ? hits[i + 1].start : raw.length;
    const part = raw.slice(start, stop).trim();
    if (part) parts.push(part);
  }
  return parts;
}

/**
 * Read one sheet. A workbook often holds an old version alongside the current one, so the
 * caller reads them all and keeps whichever comes out cleanest.
 */
function parseSheet(sheet, t = EN) {
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, (row, n) => {
    const cells = [];
    for (let c = 1; c <= MAX_COLS; c++) cells.push(row.getCell(c).value);
    rows.push({ n, cells });
  });

  const headerAt = rows.findIndex((r) => isHeaderRow(r.cells));
  if (headerAt === -1) {
    return { error: t('Could not find the table header — a row reading "SN, Attribute, Technical Skills, Weightage, Sub-Weightage". Check the sheet is laid out like the Pakka role profile format.') };
  }

  const warnings = [];

  /* ------------------------------------------------- title, mission, outcomes */
  const above = rows.slice(0, headerAt);
  const firstLine = text(above.length ? above[0].cells[0] : '');
  // A sheet that opens straight on "Mission Statement" has no designation line.
  const designation = /^mission/i.test(firstLine) ? '' : firstLine;
  // A row's distinct non-empty cells, left to right (a merged cell repeats its value).
  const cellsOf = (row) => row.cells.map(text).filter((v, i, all) => v !== '' && v !== all[i - 1]);
  // Section titles between the outcomes and the table, e.g. "Technical Competency Framework".
  const isTitle = (v) => /framework|^technical\s+(skills?|competenc)/i.test(v);

  let mission = '';
  const missionAt = above.findIndex((r) => /^mission/i.test(text(r.cells[0])));
  if (missionAt !== -1) {
    const raw = text(above[missionAt].cells[0]);
    // "Mission: Build …" / "Mission- Build …", or a "Mission Statement" heading with the
    // mission itself on the next line.
    mission = /[:–—-]/.test(raw) ? afterLabel(raw) : raw.replace(/^mission(\s+statement)?\s*/i, '').trim();
    if (!mission) {
      const next = above.slice(missionAt + 1).find((r) => cellsOf(r).length);
      if (next && !/^(major\s+)?(key\s+)?outcomes?\b/i.test(cellsOf(next)[0])) mission = cellsOf(next).join(' ');
    }
  }

  const outcomes = [];
  const outcomeHeaderAt = above.findIndex((r) => /^(major\s+)?(key\s+)?outcomes?\b/i.test(text(r.cells[0])));
  if (outcomeHeaderAt !== -1) {
    const header = above[outcomeHeaderAt];
    const inline = splitNumbered(header.cells[0]);
    // All in the one cell; one per row underneath; or side by side ("Outcome 1 …" boxes).
    if (inline.length > 1) {
      outcomes.push(...inline);
    } else {
      for (const row of above.slice(outcomeHeaderAt + 1)) {
        const values = cellsOf(row)
          .filter((v) => !/^\d+[.)]?$/.test(v))               // a bare "1" in an SN column
          .filter((v) => !/^outcome\s*\d+\s*:?$/i.test(v))     // an "Outcome 1" label on its own
          .map((v) => v.replace(/^outcome\s*\d+\s*[:.\-–]?\s*/i, '').replace(/^\d+[.)]\s*/, '').trim())
          .filter(Boolean);
        if (!values.length) continue;
        if (/^mission/i.test(values[0])) continue;
        if (isTitle(values[0])) break;
        outcomes.push(...values);
      }
      if (!outcomes.length && inline.length === 1) outcomes.push(inline[0]);
    }
  }

  /* ------------------------------------------------------------------ table */
  const cols = detectColumns(rows[headerAt].cells);
  const attributes = [];
  let current = null;

  // Outcomes Measurability: the year columns, headed by the years in the header row itself,
  // or under an "Outcomes Measurability" heading with the years on the row below it — in
  // which case that row is part of the header, not data.
  const yearsIn = (cells) => cells.map((c, i) => (YEAR_RE.test(text(c)) ? i : -1)).filter((i) => i !== -1);
  let measureCols = yearsIn(rows[headerAt].cells);
  let dataFrom = headerAt + 1;
  if (!measureCols.length && rows[headerAt + 1]) {
    const below = yearsIn(rows[headerAt + 1].cells);
    if (below.length) { measureCols = below; dataFrom = headerAt + 2; }
  }
  measureCols = measureCols.slice(0, measures.YEARS);
  const yearRow = dataFrom === headerAt + 2 ? rows[headerAt + 1] : rows[headerAt];
  const measureFrom = measureCols.length ? measures.fullYear(text(yearRow.cells[measureCols[0]])) : null;

  for (const row of rows.slice(dataFrom)) {
    const sn = row.cells[cols.sn];
    const attribute = row.cells[cols.attribute];
    const skill = row.cells[cols.skill];
    const assessment = cols.assessment !== undefined ? row.cells[cols.assessment] : null;
    const weight = row.cells[cols.weight];
    const subWeight = row.cells[cols.subWeight];
    const links = cols.outcomes !== undefined ? outcomeNumbers(row.cells[cols.outcomes]) : [];
    if (links === null && text(skill) !== '') {
      warnings.push(t('"{name}": the Key Outcome No. column takes only outcome numbers, such as 1, 3 — "{value}" was left out.',
        { name: text(skill), value: text(row.cells[cols.outcomes]) }));
    }
    if (/^total$/i.test(text(sn)) || /^total$/i.test(text(attribute))) break;

    const attrName = text(attribute);
    const skillName = text(skill);
    const assessmentText = text(assessment);
    const attrWeight = number(weight);
    const skillWeight = number(subWeight);

    if (attrName === '' && skillName === '' && assessmentText === '' && attrWeight === null && skillWeight === null) continue;

    // A new attribute starts wherever a name appears; blanks belong to the one above it.
    const targets = measureCols.map((c) => text(row.cells[c]));
    if (attrName !== '' && (!current || current.attribute !== attrName)) {
      current = { attribute: attrName, assessment: assessmentText, measures: ['', '', ''], weight: attrWeight, skills: [] };
      attributes.push(current);
    } else if (!current) {
      current = { attribute: attrName || `Attribute ${attributes.length + 1}`, assessment: assessmentText, measures: ['', '', ''], weight: attrWeight, skills: [] };
      attributes.push(current);
    }
    // A skill's targets span its rows; take each from the first row that has it.
    targets.forEach((v, i) => { if (v && !current.measures[i]) current.measures[i] = v; });
    if (current.weight === null && attrWeight !== null) current.weight = attrWeight;
    if (!current.assessment && assessmentText !== '') current.assessment = assessmentText;

    if (skillName !== '') current.skills.push({ skill: skillName, weight: skillWeight, outcomes: links || [] });
  }

  if (!attributes.length) {
    return { error: t('The table header was found but no attribute rows under it.') };
  }

  /* --------------------------------------------------------------- trimming */
  const MAX_A = roleProfile.MAX_ATTRIBUTES;
  const MAX_S = roleProfile.MAX_SKILLS_PER_ATTR;
  // The programme (and so the real outcome limit — PSP's 3 vs LDP's 5) isn't known until a
  // designation is chosen on the form itself; keep the wider bound here so nothing real is
  // silently dropped, and let the form enforce the right one once that choice is made.
  const MAX_O = roleProfile.MAX_OUTCOMES_LDP;

  if (attributes.length > MAX_A) {
    warnings.push(t('The sheet has {n} skills; only the first {max} were taken.', { n: attributes.length, max: MAX_A }));
  }
  const kept = attributes.slice(0, MAX_A);
  for (const attr of kept) {
    if (attr.skills.length > MAX_S) {
      warnings.push(t('"{name}" has {n} attributes; only the first {max} were taken.', { name: attr.attribute, n: attr.skills.length, max: MAX_S }));
      attr.skills = attr.skills.slice(0, MAX_S);
    }
  }
  if (outcomes.length > MAX_O) {
    warnings.push(t('The sheet has {n} key outcomes; only the first {max} were taken.', { n: outcomes.length, max: MAX_O }));
  }

  // A link to an outcome the sheet does not have is dropped, and said so.
  const outcomeCount = Math.min(outcomes.length, MAX_O);
  for (const attr of kept) {
    for (const sk of attr.skills) {
      const unknown = (sk.outcomes || []).filter((n) => n > outcomeCount);
      if (unknown.length) {
        warnings.push(t('"{name}" is linked to outcome {list}, but the sheet has only {n} key outcomes — that link was left out.',
          { name: sk.skill, list: unknown.join(', '), n: outcomeCount }));
      }
      sk.outcomes = (sk.outcomes || []).filter((n) => n <= outcomeCount).join(',');
    }
  }

  /* ---------------------------------------------------------------- totals */
  const attrTotal = kept.reduce((t, a) => t + (a.weight || 0), 0);
  if (Math.abs(attrTotal - roleProfile.TOTAL_WEIGHT) > 0.001) {
    warnings.push(t('The skill weights add up to {total}, not {max}. Fix them below before submitting.', { total: attrTotal, max: roleProfile.TOTAL_WEIGHT }));
  }
  for (const attr of kept) {
    const sum = attr.skills.reduce((t, s) => t + (s.weight || 0), 0);
    if (attr.weight !== null && Math.abs(sum - attr.weight) > 0.001) {
      warnings.push(t('"{name}": its attribute weights total {total}, but the skill weight is {weight}.', { name: attr.attribute, total: sum, weight: attr.weight }));
    }
  }

  return {
    sheet: sheet.name,
    designation,
    mission,
    measureFrom,
    outcomes: outcomes.slice(0, MAX_O),
    attributes: kept,
    skillCount: kept.reduce((t, a) => t + a.skills.length, 0),
    warnings,
  };
}

/**
 * Parse the workbook. Without a sheet name every sheet is read and the tidiest result wins
 * — fewest warnings, then the most complete — because a file commonly carries the previous
 * draft on another tab.
 */
async function parse(buffer, options = {}) {
  const t = options.t || EN;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    return { error: t('That file could not be opened as a spreadsheet. Save it as .xlsx and try again.') };
  }
  if (!workbook.worksheets.length) return { error: t('That file has no sheets in it.') };

  const names = workbook.worksheets.map((s) => s.name);

  if (options.sheet) {
    const wanted = workbook.worksheets.find((s) => s.name === options.sheet);
    if (!wanted) return { error: t('That workbook has no sheet called "{sheet}".', { sheet: options.sheet }) };
    const one = parseSheet(wanted, t);
    return one.error ? { ...one, sheets: names } : { ...one, sheets: names };
  }

  const results = workbook.worksheets.map((sheet) => parseSheet(sheet, t)).filter((r) => !r.error);
  if (!results.length) {
    const first = parseSheet(workbook.worksheets[0], t);
    return { ...first, sheets: names };
  }

  results.sort((a, b) =>
    a.warnings.length - b.warnings.length
    || b.attributes.length - a.attributes.length
    || b.skillCount - a.skillCount);

  return { ...results[0], sheets: names };
}

module.exports = { parse, parseSheet };
