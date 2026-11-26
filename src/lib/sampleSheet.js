'use strict';
const ExcelJS = require('exceljs');
const measures = require('./measures');

/**
 * A filled-in example of the role profile Excel format, for people to download and copy.
 * It is laid out exactly the way lib/importer.js reads a sheet — the designation, mission,
 * numbered key outcomes, then the table:
 *
 *   SN | Technical Skills | Attribute | Outcomes Measurability (3 years) | Weightage | Sub-Weightage | Key Outcome No.
 *
 * with the years on a second header row under "Outcomes Measurability" — so reading it back
 * gives a clean profile with no warnings. The content is an example only.
 */
const EXAMPLE = {
  designation: 'Maintenance Head',
  mission: 'Keep the plant running safely, on plan and within budget.',
  outcomes: [
    'Unplanned downtime below 2%',
    'Zero lost-time safety incidents',
    'Maintenance cost within the approved budget',
  ],
  skills: [
    { name: 'Preventive Maintenance', weight: 40,
      measures: [
        '100% PM schedule in SAP; breakdowns down 20%',
        '≥95% PM compliance; breakdowns down 35%',
        '≥98% PM compliance; unplanned downtime below 2%',
      ],
      attributes: [
        ['Planning and scheduling PM in SAP PM module', 15, '1, 3'],
        ['Root cause analysis of breakdowns', 15, '1'],
        ['Spares planning and inventory control', 10, '3'],
      ] },
    { name: 'Safety', weight: 30,
      measures: [
        '100% permits issued for high-risk jobs',
        'Monthly safety audits; all near-misses closed in 7 days',
        'Zero lost-time incidents for the year',
      ],
      attributes: [
        ['Permit to work and lockout / tagout', 15, '2'],
        ['Safety audits and near-miss reporting', 15, '2'],
      ] },
    { name: 'Team Leadership', weight: 30,
      measures: [
        'Shift handover checklist in use on every shift',
        'Each team member trained on 2 new skills',
        'Team runs the plant without escalation for routine faults',
      ],
      attributes: [
        ['Shift planning and handovers', 10, '1'],
        ['Training and skill development of the team', 10, ''],
        ['Clear reporting to leaders', 10, ''],
      ] },
  ],
};

const MAROON = 'FFA3243C';
const SAND = 'FFFAE7C1';
const SAND_LIGHT = 'FFFDF3E0';
const thin = { style: 'thin', color: { argb: 'FFBFB6A8' } };
const box = { top: thin, left: thin, bottom: thin, right: thin };
const COLS = 9; // SN, skill, attribute, 3 years, weightage, sub-weightage, key outcome no.

/** `from` is the first measurability year ("2026-2027"); this year if not given. */
async function build(from = null) {
  const first = measures.fullYear(from) || require('../models/financialYear').yearFor();
  const years = measures.labels(first);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pakka Role Profile';
  const ws = wb.addWorksheet('Role Profile');
  ws.columns = [
    { width: 6 }, { width: 26 }, { width: 40 }, { width: 26 }, { width: 26 }, { width: 26 },
    { width: 12 }, { width: 15 }, { width: 17 },
  ];

  const wide = (row, value, opts = {}) => {
    ws.mergeCells(row, 1, row, COLS);
    const cell = ws.getCell(row, 1);
    cell.value = value;
    cell.alignment = { wrapText: true, vertical: 'middle' };
    Object.assign(cell, opts);
    return cell;
  };
  const headerCell = (row, c, value) => {
    const cell = ws.getCell(row, c);
    cell.value = value;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MAROON } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = box;
  };

  let r = 1;
  wide(r, EXAMPLE.designation, { font: { bold: true, size: 14, color: { argb: MAROON } } });
  ws.getRow(r).height = 22;
  r++;
  wide(r, `Mission: ${EXAMPLE.mission}`);
  ws.getRow(r).height = 30;
  r++;
  wide(r, 'Key Outcomes:', { font: { bold: true } });
  r++;
  EXAMPLE.outcomes.forEach((o, i) => { wide(r, `${i + 1}. ${o}`); r++; });
  r++; // a blank line before the table

  // Two header rows: the years sit under "Outcomes Measurability"; the rest span both rows.
  const top = r;
  const sub = r + 1;
  [[1, 'SN'], [2, 'Technical Skills'], [3, 'Attribute'], [7, 'Weightage'], [8, 'Sub-Weightage'], [9, 'Key Outcome No.']]
    .forEach(([c, label]) => {
      headerCell(top, c, label);
      headerCell(sub, c, label);
      ws.mergeCells(top, c, sub, c);
    });
  for (let c = 4; c <= 6; c++) headerCell(top, c, `Outcomes Measurability (${measures.span(first)})`);
  ws.mergeCells(top, 4, top, 6);
  years.forEach((y, i) => headerCell(sub, 4 + i, y));
  ws.getRow(top).height = 20;
  ws.getRow(sub).height = 18;
  r = sub + 1;

  EXAMPLE.skills.forEach((skill, i) => {
    const firstRow = r;
    skill.attributes.forEach(([attribute, weight, links]) => {
      const values = [i + 1, skill.name, attribute, ...skill.measures, skill.weight, weight, links];
      values.forEach((v, c) => {
        const cell = ws.getCell(r, c + 1);
        cell.value = v === '' ? null : v;
        cell.border = box;
        cell.alignment = { vertical: c >= 3 && c <= 5 ? 'top' : 'middle', wrapText: true,
          horizontal: [0, 6, 7, 8].includes(c) ? 'center' : 'left' };
        if (c === 1) cell.font = { bold: true };
        if (i % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND_LIGHT } };
      });
      r++;
    });
    // The skill, its number, its yearly targets and its weight span its attributes.
    if (r - 1 > firstRow) [1, 2, 4, 5, 6, 7].forEach((c) => ws.mergeCells(firstRow, c, r - 1, c));
  });

  ['Total', '', '', '', '', '', 100, 100, ''].forEach((v, c) => {
    const cell = ws.getCell(r, c + 1);
    cell.value = v === '' ? null : v;
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND } };
    cell.border = box;
    cell.alignment = { horizontal: c === 0 ? 'left' : 'center' };
  });

  const help = wb.addWorksheet('How to fill');
  help.columns = [{ width: 110 }];
  [
    ['How to fill this sheet', true],
    ['Row 1: the designation. Row 2: "Mission:" followed by the mission.'],
    ['"Key Outcomes:" then one numbered outcome per row (1., 2., 3. …). PSP profiles take up to 3, LDP profiles 3 to 5.'],
    ['The table: SN | Technical Skills | Attribute | Outcomes Measurability (three years) | Weightage | Sub-Weightage | Key Outcome No.'],
    ['Write each technical skill once, with its weightage, and list its attributes underneath (up to 3). Merging the skill cells is fine.'],
    [`Outcomes Measurability (optional): for each skill, the measurable target for each of the three years (${years.join(', ')}). Keep the years in the second header row — the first one is taken as the starting year.`],
    ['Skill weightages must add up to 100, and each skill\'s attribute sub-weightages must add up to that skill\'s weightage.'],
    ['Key Outcome No. (optional): for each attribute, only the NUMBERS of the key outcomes it delivers — 1, or 1, 3 for more than one. Do not copy the outcome text here. Leave it blank for none.'],
    ['Attributes linked to outcomes can be assessed by key outcome: each outcome\'s rating becomes the rating of the attributes linked to it.'],
    ['End the table with a "Total" row. Upload the file on Create Role Profile → "Fill it in from an Excel sheet"; nothing is saved until you submit.'],
  ].forEach(([line, bold], i) => {
    const cell = help.getCell(i + 1, 1);
    cell.value = line;
    cell.alignment = { wrapText: true };
    if (bold) cell.font = { bold: true, size: 13, color: { argb: MAROON } };
  });

  return wb.xlsx.writeBuffer();
}

module.exports = { build, EXAMPLE };
