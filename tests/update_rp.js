'use strict';
/**
 * Updating an approved role profile at any time in the year: it goes for approval as the
 * next version, the version in force keeps applying meanwhile, and old versions stay
 * viewable. Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, get, freeDesignations, approveFully, SESSIONS } = require('./smoke');
const db = require('../src/lib/db');
const roleProfile = require('../src/models/roleProfile');
const financialYear = require('../src/models/financialYear');

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
const form = (d, sangh, mission, extra = {}) => ({
  sangh_code: sangh, designation_name: d, mission, outcomes: ['Outcome A', 'Outcome B'],
  'attribute[0]': 'Skill one', 'attribute_weight[0]': '60', 'assessment[0]': '',
  'tech_skill[0][]': ['Attr 1', 'Attr 2'], 'tech_weight[0][]': ['30', '30'],
  'attribute[1]': 'Skill two', 'attribute_weight[1]': '40', 'assessment[1]': '',
  'tech_skill[1][]': 'Attr 3', 'tech_weight[1][]': '40', action: 'submit', ...extra,
});

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);
  const app = build(); const server = app.listen(0); const port = server.address().port;
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  signIn(CREATOR);
  const fy = await financialYear.current();

  const d = (await freeDesignations(CREATOR.code, CREATOR.name)).find((x) => Number(x.members) > 0)
    || (await freeDesignations(CREATOR.code, CREATOR.name))[0];
  await post(port, '/role-profiles/store', CREATOR.code, form(d.designation, d.sangh_code, 'Mission v1'));
  const id = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  // Ujjwal is in Sanghrakshak Sangh (LDP): his RP Approver is on the LDP side, so a PSP
  // profile he writes goes straight to the PSP Approver.
  const first = await db.first('SELECT status, rp_approver_code FROM rp_role_profiles WHERE id = ?', [id]);
  check('LDP-sangh creator, PSP profile: straight to the PSP Approver', `${first.status}|${first.rp_approver_code}`, 'pending_admin|');
  check('...and the history says so', (await db.first(
    "SELECT note FROM rp_role_profile_history WHERE role_profile_id = ? AND action = 'submitted'", [id])).note, 'Sent straight to the PSP Approver');
  check('...while his RP Approver is still on record for LDP',
    !!(await db.first("SELECT rp_approver_code c FROM tbl_employee WHERE emp_code = 'M00151'")).c, true);
  await approveFully(post, port, id);
  const row = () => roleProfile.find(id);
  const member = (await roleProfile.effectiveMembers(await row()))[0];
  check('approved as v1 with a member assigned', `${(await row()).status}|${!!member}`, 'approved|true');
  signIn({ code: member.emp_code, name: member.name, isAdmin: false });

  /* ------------------------------------------------- the Update RP button */
  const show = (await get(port, `/role-profiles/${id}`, CREATOR.code)).body;
  check('creator sees "Update RP" on the profile', show.includes('Update RP'), true);
  check('...and in the list', (await get(port, '/role-profiles', CREATOR.code)).body.includes('Update RP'), true);
  check('a member does not', (await get(port, `/role-profiles/${id}`, member.emp_code)).body.includes('Update RP'), false);
  const editPage = (await get(port, `/role-profiles/${id}/edit`, CREATOR.code)).body;
  check('the form is "Update Role Profile", with no draft button',
    `${editPage.includes('Update Role Profile')}|${editPage.includes('Save as draft')}`, 'true|false');

  /* -------------------------------------- assess against v1, then update mid-year */
  const v1 = await db.first('SELECT * FROM rp_profile_versions WHERE role_profile_id = ? AND version_no = 1', [id]);
  const ratings = { financial_year: fy };
  (await db.query('SELECT id FROM rp_version_details WHERE version_id = ?', [v1.id])).forEach((x) => { ratings[`rating[d${x.id}]`] = '3'; });
  await post(port, `/role-profiles/${id}/assess/${member.emp_code}`, CREATOR.code, ratings);
  const a1 = await db.first('SELECT * FROM rp_assessments WHERE role_profile_id = ? AND emp_code = ?', [id, member.emp_code]);
  check('assessed against v1', a1 && Number(a1.version_id), v1.id);

  await post(port, `/role-profiles/${id}/update`, CREATOR.code, form(d.designation, d.sangh_code, 'Mission v2 — mid-year update'));
  let p = await row();
  check('the update also goes straight to the PSP Approver', `${p.status}|${p.rp_approver_code}`, 'pending_admin|');
  check('history says v1 stays in force', /version 1 stays in force/.test((await db.first(
    "SELECT note FROM rp_role_profile_history WHERE role_profile_id = ? AND action = 'edited' ORDER BY id DESC LIMIT 1", [id])).note), true);

  /* ---------------------------------------------- v1 keeps applying meanwhile */
  check('still live', roleProfile.isLive(p), true);
  check('the member keeps it', (await roleProfile.effectiveMembers(p)).some((m) => m.emp_code === member.emp_code), true);
  check('...and can still see it', (await roleProfile.visibleTo(member.emp_code, false)).some((x) => x.id === id), true);
  const during = (await get(port, `/role-profiles/${id}`, CREATOR.code)).body;
  check('page says an update is awaiting approval', during.includes('update is awaiting approval'), true);
  check('...links to the version in force', during.includes(`/role-profiles/${id}/versions/${v1.id}`), true);
  check('...and keeps the Members tab', during.includes('data-tab="members"'), true);
  check('the assessment still opens', (await get(port, `/role-profiles/${id}/assess/${member.emp_code}?fy=${fy}`, CREATOR.code)).status, 200);

  /* ------------------------------------------- approval makes v2, v1 kept */
  await approveFully(post, port, id, { assign: false });
  p = await row();
  const v2 = await db.first('SELECT * FROM rp_profile_versions WHERE role_profile_id = ? AND version_no = 2', [id]);
  check('approved as v2', `${p.status}|${v2 ? v2.mission : 'none'}`, 'approved|Mission v2 — mid-year update');
  check('this year now runs on v2', (await db.first(
    'SELECT version_id FROM rp_profile_reviews WHERE role_profile_id = ? AND financial_year = ?', [id, fy])).version_id, v2.id);
  check('the assessment already written stays on v1', (await db.first('SELECT version_id FROM rp_assessments WHERE id = ?', [a1.id])).version_id, v1.id);
  check('the member is still assigned', (await roleProfile.effectiveMembers(p)).some((m) => m.emp_code === member.emp_code), true);
  const old = await get(port, `/role-profiles/${id}/versions/${v1.id}`, member.emp_code);
  check('v1 is still viewable, with its own wording', `${old.status}|${old.body.includes('Mission v1')}`, '200|true');
  check('both versions listed', (await get(port, `/role-profiles/${id}?tab=versions`, CREATOR.code)).body.includes(`/versions/${v2.id}`), true);

  /* ------------------------------------------------ a rejected update */
  await post(port, `/role-profiles/${id}/update`, CREATOR.code, form(d.designation, d.sangh_code, 'Mission v3 proposal'));
  p = await row();
  const decider = p.status === 'pending_sevak' ? p.rp_approver_code : 'MM008';
  signIn({ code: decider, name: 'Decider', isAdmin: decider === 'MM008' });
  await post(port, `/role-profiles/${id}/decide`, decider, { action: 'reject', reject_reason: 'not yet' });
  p = await row();
  check('rejected update: v2 still in force', `${p.status}|${roleProfile.isLive(p)}`, 'rejected|true');
  check('...member keeps it', (await roleProfile.effectiveMembers(p)).length > 0, true);
  check('...designation stays taken', !!(await roleProfile.profileForDesignation(p.sangh_code, p.designation_name)), true);
  const again = (await get(port, `/role-profiles/${id}/edit`, CREATOR.code)).body;
  check('editing it again is still an update, never a draft', `${again.includes('Update Role Profile')}|${again.includes('Save as draft')}`, 'true|false');
  await post(port, `/role-profiles/${id}/update`, CREATOR.code, form(d.designation, d.sangh_code, 'Mission v3', { action: 'draft' }));
  check('a "draft" post still goes for approval', ['pending_sevak', 'pending_admin'].includes((await row()).status), true);
  flash(CREATOR.code, 'flashSuccess');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
