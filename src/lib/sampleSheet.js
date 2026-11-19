'use strict';
const ExcelJS = require('exceljs');

/**
 * A filled-in example of the role profile Excel format, for people to download and copy.
 * It is laid out exactly the way lib/importer.js reads a sheet — the designation, mission,
 * numbered key outcomes, then the SN / Technical Skills / Attribute / Weightage /
 * Sub-Weightage table with the optional Key Outcome No. column — so reading it back gives a
 * clean profile with no warnings. The content is an example only.
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
    { name: 'Preventive Maintenance', weight: 40, attributes: [
      ['Planning and scheduling PM in SAP PM module', 15, '1, 3'],
      ['Root cause analysis of breakdowns', 15, '1'],
      ['Spares planning and inventory control', 10, '3'],
    ] },
    { name: 'Safety', weight: 30, attributes: [
      ['Permit to work and lockout / tagout', 15, '2'],
      ['Safety audits and near-miss reporting', 15, '2'],
    ] },
    { name: 'Team Leadership', weight: 30, attributes: [
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

async function build() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Pakka Role Profile';
  const ws = wb.addWorksheet('Role Profile');
  ws.columns = [
    { width: 6 }, { width: 30 }, { width: 48 }, { width: 12 }, { width: 15 }, { width: 18 },
  ];

  const wide = (row, value, opts = {}) => {
    ws.mergeCells(row, 1, row, 6);
    const cell = ws.getCell(row, 1);
    cell.value = value;
    cell.alignment = { wrapText: true, vertical: 'middle' };
    Object.assign(cell, opts);
    return cell;
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

  const header = ['SN', 'Technical Skills', 'Attribute', 'Weightage', 'Sub-Weightage', 'Key Outcome No.'];
  header.forEach((h, i) => {
    const cell = ws.getCell(r, i + 1);
    cell.value = h;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MAROON } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = box;
  });
  ws.getRow(r).height = 20;
  r++;

  EXAMPLE.skills.forEach((skill, i) => {
    const first = r;
    skill.attributes.forEach(([attribute, weight, links]) => {
      const values = [i + 1, skill.name, attribute, skill.weight, weight, links];
      values.forEach((v, c) => {
        const cell = ws.getCell(r, c + 1);
        cell.value = v === '' ? null : v;
        cell.border = box;
        cell.alignment = { vertical: 'middle', wrapText: true, horizontal: [0, 3, 4, 5].includes(c) ? 'center' : 'left' };
        if (c === 1) cell.font = { bold: true };
        if (i % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAND_LIGHT } };
      });
      r++;
    });
    // The skill, its number and its weight span its attributes, as in the Pakka sheets.
    if (r - 1 > first) [1, 2, 4].forEach((c) => ws.mergeCells(first, c, r - 1, c));
  });

  ['Total', '', '', 100, 100, ''].forEach((v, c) => {
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
    ['The table: SN | Technical Skills | Attribute | Weightage | Sub-Weightage | Key Outcome No.'],
    ['Write each technical skill once, with its weightage, and list its attributes underneath (up to 3). Merging the skill cells is fine.'],
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
