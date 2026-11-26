'use strict';
/**
 * Outcomes Measurability: a measurable target for each technical skill in each of three
 * financial years — on the form, the pages, versions, the PDF and the Excel import.
 * Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const ExcelJS = require('exceljs');
const { build, signIn, get, freeDesignations, approveFully } = require('./smoke');
const db = require('../src/lib/db');
const roleProfile = require('../src/models/roleProfile');
const measures = require('../src/lib/measures');
const importer = require('../src/lib/importer');
const sampleSheet = require('../src/lib/sampleSheet');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};
function post(port, path, who, form) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) (Array.isArray(v) ? v : [v]).forEach((x) => params.append(k, x));
  params.append('csrf_test_name', 'test-token');
  const body = params.toString();
  return new Promise((r) => {
    const req = http.request({ port, path, method: 'POST', headers: {
      'x-test-user': who, 'content-type': 'application/x-www-form-urlencoded',
      'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', () => r(res.headers.location || '')); });
    req.end(body);
  });
}
function fetchRaw(port, path, who) {
  return new Promise((resolve) => {
    http.get({ port, path, headers: { 'x-test-user': who } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(parts) }));
    });
  });
}

/** A sheet laid out like the "Technical Competency Framework" format. */
async function frameworkSheet() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('RP');
  ws.getCell('A1').value = 'Mission Statement';
  ws.getCell('A2').value = 'Availability of plant for continuous production with the best automation practices';
  ws.getCell('A4').value = 'Major Key Outcomes (2030)';
  ws.getCell('A5').value = 'Outcome 1\nEasy operation & precise measurement and control with automation';
  ws.mergeCells('A5:C5');
  ws.getCell('D5').value = 'Outcome 2\nZero unplanned down time';
  ws.mergeCells('D5:E5');
  ws.getCell('F5').value = 'Outcome 3\nAvailability of spares at optimum level';
  ws.mergeCells('F5:H5');
  ws.getCell('A7').value = 'Technical Competency Framework';
  [['A', 'SN'], ['B', 'Outcome-based Technical Skill'], ['C', 'Measurable Attribute / Required Capability'], ['G', 'Weightage'], ['H', 'Sub-Weightage']]
    .forEach(([c, v]) => { ws.getCell(`${c}8`).value = v; ws.mergeCells(`${c}8:${c}9`); });
  ws.getCell('D8').value = 'Outcomes Measurability (2026–2029)';
  ws.mergeCells('D8:F8');
  ['2026-27', '2027-28', '2028-29'].forEach((y, i) => { ws.getCell(9, 4 + i).value = y; });
  [
    [1, 'Identification & Understanding of the technical Documents', 'Understanding of P&I Diagrams and Cable Schedules', '100% documents mapped & verified', '≥90% digitalized', '100% digitalized', 50, 15],
    [null, null, 'Knowledge of Loop wiring diagrams and UPS', null, null, null, null, 20],
    [null, null, 'Knowledge of Logics development & Interlocks', null, null, null, null, 15],
    [2, 'Operational Process of Table ware', 'Knowledge of basic process of Table ware product plant', '≥85% automated', '≥92% automated', '≥98% automated', 50, 25],
    [null, null, 'Knowledge of the machine and its controls', null, null, null, null, 25],
  ].forEach((vals, i) => vals.forEach((v, c) => { if (v !== null) ws.getCell(10 + i, c + 1).value = v; }));
  ['A', 'B', 'D', 'E', 'F', 'G'].forEach((c) => { ws.mergeCells(`${c}10:${c}12`); ws.mergeCells(`${c}13:${c}14`); });
  ws.getCell('A15').value = 'Total'; ws.getCell('G15').value = 100; ws.getCell('H15').value = 100;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  /* ------------------------------------------------------------ year labels */
  check('labels', measures.labels('2026-2027').join(' '), '2026-27 2027-28 2028-29');
  check('span', measures.span('2026-27'), '2026–2029');
  check('any spelling of a year', `${measures.fullYear('2027–28')}|${measures.fullYear('soon')}`, '2027-2028|null');

  /* ------------------------------------------------------------ Excel import */
  const fromSample = await importer.parse(Buffer.from(await sampleSheet.build('2026-2027')));
  check('the sample reads back cleanly', `${fromSample.error || ''}|${fromSample.warnings.length}|${fromSample.measureFrom}`, '|0|2026-2027');
  check('...with each skill\'s three targets', fromSample.attributes.map((a) => a.measures.filter(Boolean).length).join(' '), '3 3 3');
  check('...and the outcome links still read', fromSample.attributes[0].skills.map((k) => k.outcomes).join(' '), '1,3 1 3');

  const fw = await importer.parse(await frameworkSheet());
  check('framework layout: no warnings', `${fw.error || ''}|${fw.warnings.length}`, '|0');
  check('...mission from the line under "Mission Statement"', fw.mission, 'Availability of plant for continuous production with the best automation practices');
  check('...three outcomes side by side', fw.outcomes.join(' / '), 'Easy operation & precise measurement and control with automation / Zero unplanned down time / Availability of spares at optimum level');
  check('..."Outcome-based Technical Skill" is the skill column', fw.attributes.map((a) => a.attribute).join(' / '), 'Identification & Understanding of the technical Documents / Operational Process of Table ware');
  check('..."Measurable Attribute" is the attribute column', fw.attributes[0].skills.map((k) => k.skill).join(' / '),
    'Understanding of P&I Diagrams and Cable Schedules / Knowledge of Loop wiring diagrams and UPS / Knowledge of Logics development & Interlocks');
  check('...targets per skill, years from the second header row', `${fw.measureFrom}|${fw.attributes[1].measures.join(' / ')}`, '2026-2027|≥85% automated / ≥92% automated / ≥98% automated');
  check('...weights', fw.attributes.map((a) => `${a.weight}:${a.skills.map((k) => k.weight).join('+')}`).join(' '), '50:15+20+15 50:25+25');

  /* ---------------------------------------------------- the form and the pages */
  const app = build(); const server = app.listen(0); const port = server.address().port;
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  signIn(CREATOR);
  const free = await freeDesignations(CREATOR.code, CREATOR.name);
  const d = free.find((x) => Number(x.members) > 0) || free[0];
  await post(port, '/role-profiles/store', CREATOR.code, {
    sangh_code: d.sangh_code, designation_name: d.designation, mission: 'Keep it running', outcomes: ['Outcome A'],
    measure_from: '2027-2028',
    'attribute[0]': 'Skill one', 'attribute_weight[0]': '60', 'assessment[0]': '',
    'measure[0][]': ['Target year one', 'Target year two', 'Target year three'],
    'tech_skill[0][]': ['Attr 1', 'Attr 2'], 'tech_weight[0][]': ['30', '30'], 'tech_outcomes[0][]': ['', ''],
    'attribute[1]': 'Skill two', 'attribute_weight[1]': '40', 'assessment[1]': '',
    'measure[1][]': ['', 'Only year two', ''],
    'tech_skill[1][]': 'Attr 3', 'tech_weight[1][]': '40', 'tech_outcomes[1][]': '',
    action: 'submit',
  });
  const id = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  const p = await roleProfile.fullProfile(id);
  check('the first year is saved', p.measure_from, '2027-2028');
  check('targets saved per skill', p.attributes.map((a) => a.measures.join('|')).join(' / '), 'Target year one|Target year two|Target year three / |Only year two|');
  check('...on every row of the skill', (await db.query(
    'SELECT measure_2 FROM rp_role_profile_details WHERE role_profile_id = ? AND attribute_no = 1', [id])).map((r) => r.measure_2).join(','), 'Target year two,Target year two');

  const edit = (await get(port, `/role-profiles/${id}/edit`, CREATOR.code)).body;
  check('the form seeds them back', edit.includes('"Target year one"') && edit.includes('value="2027-2028" selected'), true);

  const show = (await get(port, `/role-profiles/${id}`, CREATOR.code)).body;
  check('profile page shows the targets with their years', show.includes('Outcomes Measurability') && show.includes('2027-28') && show.includes('Target year three'), true);
  const sheet = (await get(port, `/role-profiles/${id}/view`, CREATOR.code)).body;
  check('the sheet has the three year columns', sheet.includes('Outcomes Measurability') && /\(2027.{1,3}2030\)/.test(sheet)
    && sheet.includes('2028-29') && sheet.includes('2029-30'), true);

  /* ---------------------------------------------------- versions and the PDF */
  await approveFully(post, port, id, { assign: false });
  const v1 = await db.first('SELECT * FROM rp_profile_versions WHERE role_profile_id = ? AND version_no = 1', [id]);
  check('the version keeps the first year', v1 && v1.measure_from, '2027-2028');
  check('...and the targets', (await db.first(
    'SELECT measure_3 FROM rp_version_details WHERE version_id = ? AND attribute_no = 1 LIMIT 1', [v1.id])).measure_3, 'Target year three');
  const vpage = (await get(port, `/role-profiles/${id}/versions/${v1.id}`, CREATOR.code)).body;
  check('version page shows them', vpage.includes('Target year one') && vpage.includes('2027-28'), true);

  const pdfProfile = await fetchRaw(port, `/role-profiles/${id}/pdf`, CREATOR.code);
  check('profile PDF downloads', `${pdfProfile.status}|${/pdf/.test(pdfProfile.type)}`, '200|true');
  const pdfVersion = await fetchRaw(port, `/role-profiles/${id}/versions/${v1.id}/pdf`, CREATOR.code);
  check('version PDF downloads', `${pdfVersion.status}|${/pdf/.test(pdfVersion.type)}`, '200|true');

  /* ---------------------------------------------- an older profile is untouched */
  const old = await db.first(
    "SELECT p.id FROM rp_role_profiles p WHERE p.measure_from IS NULL AND p.status = 'approved' LIMIT 1");
  if (old) {
    const oldSheet = (await get(port, `/role-profiles/${old.id}/view`, 'MM008')).body;
    check('a profile without targets keeps its five columns', oldSheet.includes('Outcomes Measurability'), false);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
