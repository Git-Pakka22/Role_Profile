'use strict';
/**
 * Linking attributes to key outcomes, and the outcome-based assessment built on it; plus
 * the PSP Approver updating someone else's approved profile. Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, get, freeDesignations, approveFully, SESSIONS } = require('./smoke');
const db = require('../src/lib/db');
const roleProfile = require('../src/models/roleProfile');
const financialYear = require('../src/models/financialYear');
const outcomeLinks = require('../src/lib/outcomeLinks');

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
const flash = (who, kind) => { const v = SESSIONS[who] && SESSIONS[who][kind]; if (SESSIONS[who]) delete SESSIONS[who][kind]; return v; };

// Three outcome rows on the form, the middle one blank: links are posted by form position
// (1 and 3) and must be saved as the outcomes' real numbers (1 and 2).
const form = (d, sangh, mission, extra = {}) => ({
  sangh_code: sangh, designation_name: d, mission, outcomes: ['Outcome A', '', 'Outcome B'],
  'attribute[0]': 'Skill one', 'attribute_weight[0]': '60', 'assessment[0]': '',
  'tech_skill[0][]': ['Attr 1', 'Attr 2'], 'tech_weight[0][]': ['30', '30'], 'tech_outcomes[0][]': ['1', '1,3'],
  'attribute[1]': 'Skill two', 'attribute_weight[1]': '40', 'assessment[1]': '',
  'tech_skill[1][]': 'Attr 3', 'tech_weight[1][]': '40', 'tech_outcomes[1][]': '',
  action: 'submit', ...extra,
});

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  /* ------------------------------------------------------------- the helper */
  const lines = [{ id: 1, outcome_links: '1' }, { id: 2, outcome_links: '1,2' }, { id: 3, outcome_links: null }];
  const derived = outcomeLinks.derive(lines, new Map([[1, { rating: 4 }], [2, { rating: 2, note: 'coach' }]]), { 3: 3 }, { 3: 'x' });
  check('derive: one outcome -> its rating', derived.ratings[1], 4);
  check('derive: two outcomes -> their average', derived.ratings[2], 3);
  check('derive: unlinked line keeps its direct rating and gap', `${derived.ratings[3]}|${derived.gaps[3]}`, '3|x');
  check('derive: low outcome note becomes the line gap', derived.gaps[2], 'O2: coach');
  check('parse/format', `${outcomeLinks.format([3, 1, 3])}|${outcomeLinks.format([])}`, '1,3|null');

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  const ADMIN = { code: 'MM008', name: 'Admin', isAdmin: true };
  signIn(CREATOR); signIn(ADMIN);
  const fy = await financialYear.current();

  /* --------------------------------------------------- linking on the profile */
  const d = (await freeDesignations(CREATOR.code, CREATOR.name)).find((x) => Number(x.members) > 0)
    || (await freeDesignations(CREATOR.code, CREATOR.name))[0];
  await post(port, '/role-profiles/store', CREATOR.code, form(d.designation, d.sangh_code, 'Mission v1'));
  const id = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  const live = await db.query('SELECT tech_skill, outcome_links FROM rp_role_profile_details WHERE role_profile_id = ? ORDER BY sort_order', [id]);
  check('links saved by outcome number, blanks skipped', live.map((l) => `${l.tech_skill}=${l.outcome_links}`).join(' '), 'Attr 1=1 Attr 2=1,2 Attr 3=null');

  const editForm = (await get(port, `/role-profiles/${id}/edit`, CREATOR.code)).body;
  check('the form seeds the links back', editForm.includes('"links":"1,2"'), true);

  await approveFully(post, port, id);
  const v1 = await db.first('SELECT * FROM rp_profile_versions WHERE role_profile_id = ? AND version_no = 1', [id]);
  const vlines = await db.query('SELECT id, tech_skill, outcome_links FROM rp_version_details WHERE version_id = ? ORDER BY sort_order', [v1.id]);
  check('the version freezes the links', vlines.map((l) => l.outcome_links).join(' '), '1 1,2 ');
  // Earlier suites can use up the designations that have members: assign anyone active.
  if (!(await roleProfile.effectiveMembers(await roleProfile.find(id))).length) {
    const anyone = await db.first(
      `SELECT e.emp_code, e.name FROM tbl_employee e WHERE e.status = ?
         AND NOT EXISTS (SELECT 1 FROM rp_role_profile_members m WHERE m.emp_code = e.emp_code) LIMIT 1`,
      [require('../src/models/employee').STATUS_ACTIVE]);
    await db.run(`INSERT INTO rp_role_profile_members (role_profile_id, emp_code, member_name, assigned_by, assigned_by_name, assigned_at)
      VALUES (?,?,?,?,?,NOW())`, [id, anyone.emp_code, anyone.name, 'MM008', 'Admin']);
  }
  const member = (await roleProfile.effectiveMembers(await roleProfile.find(id)))[0];
  check('a member is assigned', !!member, true);

  const show = (await get(port, `/role-profiles/${id}`, CREATOR.code)).body;
  check('profile page tags outcomes and attributes', show.includes('<span class="rp-otag">O1</span>') && show.includes('>O2</span>'), true);

  /* -------------------------------------------------- assessing by outcome */
  const page = (await get(port, `/role-profiles/${id}/assess/${member.emp_code}?fy=${fy}`, CREATOR.code)).body;
  check('assessment offers both methods', page.includes('By key outcome') && page.includes('By attribute'), true);
  check('...rating each outcome', page.includes('name="orating[o1]"') && page.includes('name="orating[o2]"'), true);
  check('...with a Rate tab and a Preview tab', page.includes('data-atab="rate"') && page.includes('data-atab="preview"'), true);
  check('...and the unlinked attribute pointed to Preview', page.includes('not linked to a key outcome'), true);

  const [l1, l2, l3] = vlines;
  const base = { financial_year: fy, method: 'outcome', 'orating[o1]': '4', 'orating[o2]': '2', [`rating[d${l3.id}]`]: '3' };
  await post(port, `/role-profiles/${id}/assess/${member.emp_code}`, CREATOR.code, base);
  check('a low outcome without a note is refused', /O2/.test(flash(CREATOR.code, 'flashError') || ''), true);
  check('...and nothing is saved', !!(await db.first('SELECT id FROM rp_assessments WHERE role_profile_id = ?', [id])), false);

  await post(port, `/role-profiles/${id}/assess/${member.emp_code}`, CREATOR.code,
    { ...base, 'onote[o2]': 'Needs coaching on planning', [`rating[d${l1.id}]`]: '1', [`gap[d${l1.id}]`]: 'Shadow the planner for a month' });
  const a = await db.first('SELECT * FROM rp_assessments WHERE role_profile_id = ? AND emp_code = ?', [id, member.emp_code]);
  check('saved by outcome', a && a.method, 'outcome');
  const r = new Map((await db.query('SELECT version_detail_id, rating, training_gap FROM rp_assessment_ratings WHERE assessment_id = ?', [a.id]))
    .map((x) => [Number(x.version_detail_id), x]));
  check('Attr 1 (O1) takes 4 — a direct rating posted for it is ignored', Number(r.get(l1.id).rating), 4);
  check('Attr 2 (O1+O2) takes the average 3', Number(r.get(l2.id).rating), 3);
  check('Attr 3 (no outcome) is rated directly', Number(r.get(l3.id).rating), 3);
  check('Attr 2 carries the low outcome note as its gap', r.get(l2.id).training_gap, 'O2: Needs coaching on planning');
  check('a gap edited on the Preview tab is kept', r.get(l1.id).training_gap, 'Shadow the planner for a month');
  check('score is weight x rating as before: 30x4 + 30x3 + 40x3 of 400', `${Number(a.total_score)}|${Number(a.max_score)}|${Number(a.percentage)}`, '330|400|82.5');
  const outs = await db.query('SELECT outcome_no, rating, note FROM rp_assessment_outcome_ratings WHERE assessment_id = ? ORDER BY outcome_no', [a.id]);
  check('outcome ratings are kept', outs.map((o) => `${o.outcome_no}:${Number(o.rating)}`).join(' '), '1:4 2:2');

  const done = (await get(port, `/role-profiles/${id}/assess/${member.emp_code}?fy=${fy}`, CREATOR.code)).body;
  check('the saved page reads "made by key outcome"', done.includes('This assessment was made by key outcome.'), true);
  const pdfRes = await get(port, `/role-profiles/${id}/assess/${member.emp_code}/pdf?fy=${fy}`, CREATOR.code);
  check('the PDF still downloads', pdfRes.status, 200);

  /* -------------------------------- the attribute method is unchanged */
  const ratings = { financial_year: fy, method: 'attribute' };
  vlines.forEach((x) => { ratings[`rating[d${x.id}]`] = '4'; });
  await post(port, `/role-profiles/${id}/assess/${member.emp_code}`, ADMIN.code, ratings);
  const corrected = await db.first('SELECT * FROM rp_assessments WHERE id = ?', [a.id]);
  check('a correction by attribute switches the method', `${corrected.method}|${Number(corrected.percentage)}`, 'attribute|100');
  check('...and drops the outcome ratings', (await db.first('SELECT COUNT(*) n FROM rp_assessment_outcome_ratings WHERE assessment_id = ?', [a.id])).n, 0);
  flash(ADMIN.code, 'flashSuccess');

  /* ----------------------------------------- Excel: sample file and the column */
  const sample = await new Promise((resolve) => {
    http.get({ port, path: '/role-profiles/import/sample', headers: { 'x-test-user': CREATOR.code } }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(parts) }));
    });
  });
  check('the sample Excel downloads', `${sample.status}|${/spreadsheetml/.test(sample.type)}`, '200|true');
  const importer = require('../src/lib/importer');
  const fromSample = await importer.parse(sample.body);
  check('...and reads back cleanly', `${fromSample.error || ''}|${fromSample.warnings.length}|${fromSample.outcomes.length}`, '|0|3');
  check('...with the Key Outcomes column as links', fromSample.attributes[0].skills.map((k) => k.outcomes).join(' '), '1,3 1 3');
  // An attribute linked to an outcome the sheet does not have.
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(sample.body);
  wb.getWorksheet('Role Profile').eachRow((row) => {
    const attr = String(row.getCell(3).value || '');
    if (attr.startsWith('Root cause')) row.getCell(6).value = '1, 7';
    // The outcome's wording pasted in: its "2%" must not become a link to outcome 2.
    if (attr.startsWith('Spares')) row.getCell(6).value = 'Unplanned downtime below 2%';
    if (attr.startsWith('Permit')) row.getCell(6).value = 'O2';
  });
  const bad = await importer.parse(Buffer.from(await wb.xlsx.writeBuffer()));
  check('the sample header says numbers', String(wb.getWorksheet('Role Profile').getRow(8).getCell(6).value), 'Key Outcome No.');
  check('a link to a missing outcome is dropped with a warning',
    `${bad.attributes[0].skills[1].outcomes}|${bad.warnings.some((w) => /outcome 7/.test(w))}`, '1|true');
  check('outcome text in the column links nothing, with a warning',
    `${bad.attributes[0].skills[2].outcomes}|${bad.warnings.some((w) => /only outcome numbers/.test(w))}`, '|true');
  check('"O2" is still read as 2', bad.attributes[1].skills[0].outcomes, '2');

  /* --------------------------- the PSP Approver updates someone else's profile */
  check('admin sees "Update RP" on the profile', (await get(port, `/role-profiles/${id}`, ADMIN.code)).body.includes('Update RP'), true);
  const adminEdit = await get(port, `/role-profiles/${id}/edit`, ADMIN.code);
  check('...the update form opens with the sangh and designation fixed',
    `${adminEdit.status}|${adminEdit.body.includes('you are updating')}`, '200|true');
  await post(port, `/role-profiles/${id}/update`, ADMIN.code, form('ignored', 'ignored', 'Mission v2 by admin'));
  const p = await roleProfile.find(id);
  check('it goes for approval, still the author\'s profile, same designation',
    `${['pending_sevak', 'pending_admin'].includes(p.status)}|${p.created_by}|${p.designation_name === d.designation}`, `true|${CREATOR.code}|true`);
  check('the author is told', !!(await db.first(
    "SELECT id FROM rp_notifications WHERE emp_code = ? AND title = 'Your role profile was updated' AND role_profile_id = ?", [CREATOR.code, id])), true);
  check('v1 stays in force meanwhile', roleProfile.isLive(p), true);
  await approveFully(post, port, id, { assign: false });
  check('approved as v2', (await db.first('SELECT MAX(version_no) v FROM rp_profile_versions WHERE role_profile_id = ?', [id])).v, 2);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
