'use strict';
/** The role profile report: counts by stage match the data, filters narrow, access is limited. Sandbox only. */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';
process.env.LDP_ADMIN_CODES = 'LDPTEST';

const { build, signIn, get, SESSIONS } = require('./smoke');
const db = require('../src/lib/db');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};
const shown = (body) => Number((/Showing <strong>(\d+)<\/strong>/.exec(body) || [])[1]);
const card = (body, label) => Number((new RegExp(`class="n">(\\d+)</span>\\s*<span class="l">${label}<`).exec(body) || [])[1]);

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);
  const app = build(); const server = app.listen(0); const port = server.address().port;
  const PSP = { code: 'MM008', name: 'LMS', isAdmin: true };
  const LDP = { code: 'LDPTEST', name: 'LDP Admin', isAdmin: false };
  const MEMBER = { code: 'M01078', name: 'Heena Kumari', isAdmin: false };
  [PSP, LDP, MEMBER].forEach(signIn);
  SESSIONS[LDP.code].is_ldp_admin = true;

  const truth = async (where, params = []) => Number((await db.first(`SELECT COUNT(*) n FROM rp_role_profiles WHERE ${where}`, params)).n);
  const psp = (await get(port, '/reports/role-profiles', PSP.code)).body;
  check('PSP Approver: total = every PSP profile (plus their own)', shown(psp), await truth("program = 'psp' OR created_by = 'MM008'"));
  check('...approved card matches', card(psp, 'Approved'), await truth("status = 'approved' AND (program = 'psp' OR created_by = 'MM008')"));
  check('...drafts are counted too', card(psp, 'Draft'), await truth("status = 'draft' AND (program = 'psp' OR created_by = 'MM008')"));

  const ldp = (await get(port, '/reports/role-profiles', LDP.code)).body;
  check('LDP Admin: only LDP profiles', shown(ldp), await truth("program = 'ldp' OR created_by = 'LDPTEST'"));

  const sangh = (await db.first("SELECT sangh_code s FROM rp_role_profiles WHERE program = 'psp' GROUP BY sangh_code ORDER BY COUNT(*) DESC LIMIT 1")).s;
  const bySangh = (await get(port, `/reports/role-profiles?sangh=${sangh}`, PSP.code)).body;
  check('sangh filter', shown(bySangh), await truth("program = 'psp' AND sangh_code = ?", [sangh]));
  const approved = (await get(port, `/reports/role-profiles?sangh=${sangh}&stage=approved`, PSP.code)).body;
  check('sangh + stage filter', shown(approved), await truth("program = 'psp' AND sangh_code = ? AND status = 'approved'", [sangh]));
  check('stage cards still show the spread under a stage filter', card(approved, 'All role profiles'), await truth("program = 'psp' AND sangh_code = ?", [sangh]));
  const none = (await get(port, '/reports/role-profiles?q=zzzz-no-such-designation', PSP.code)).body;
  check('designation search with no match', `${shown(none)}|${none.includes('No role profiles match these filters')}`, '0|true');
  const future = (await get(port, '/reports/role-profiles?from=2099-01-01', PSP.code));
  check('date filter', shown(future.body), 0);
  check('the matrix links into filtered views', psp.includes(`/reports/role-profiles?sangh=${sangh}&amp;stage=`) || psp.includes(`/reports/role-profiles?sangh=${sangh}&stage=`), true);
  check('Excel / CSV export offered', psp.includes("extend: 'excel'") && psp.includes("extend: 'csv'"), true);

  /* ------------------------------------------- every sangh, and designation coverage */
  const sanghsInDb = Number((await db.first("SELECT COUNT(DISTINCT sangh_code) n FROM tbl_employee WHERE status = 0 AND TRIM(sangh_code) <> '' AND sangh_code NOT IN ('SS','SS1','CT')")).n);
  const sanghOptions = (psp.match(/<optgroup label="PSP sanghs">([\s\S]*?)<\/optgroup>/) || ['', ''])[1].match(/<option /g) || [];
  check('sangh dropdown lists every PSP sangh, with or without role profiles', sanghOptions.length, sanghsInDb);
  check('coverage panel shown', psp.includes('Role profile coverage') && psp.includes('RP not created yet'), true);
  check('designations without a role profile are listed', psp.includes('id="missingTable"'), true);

  /* ------------------------------------------------ admin sees every stage, incl. drafts */
  const CREATOR = { code: 'M00151', name: 'Ujjwal Agarwal', isAdmin: false };
  signIn(CREATOR);
  const roleProfile = require('../src/models/roleProfile');
  const d = `Draft For Admin ${Date.now()}`;
  await roleProfile.createDesignation('DVS', d, CREATOR);
  const draftId = await roleProfile.createProfile({ designation_name: d, sangh_code: 'DVS', sangh_name: 'Dakshta Vikas Sangh',
    mission: 'Draft mission', program: 'psp', status: 'draft', created_by: CREATOR.code, created_by_name: CREATOR.name,
    rp_approver_code: '', rp_approver_name: '' }, ['One'], [{ attribute: 'Skill', attribute_weight: '100', skills: [{ skill: 'Attr', weight: '100' }] }]);
  check('admin\'s list includes someone else\'s draft', (await roleProfile.visibleTo(PSP.code, true, false)).some((p) => p.id === draftId), true);
  check('a member\'s does not', (await roleProfile.visibleTo(MEMBER.code, false, false)).some((p) => p.id === draftId), false);
  const sheet = await get(port, `/role-profiles/${draftId}/view`, PSP.code);
  check('admin opens the draft as a sheet', `${sheet.status}|${sheet.body.includes('rps-table')}|${sheet.body.includes('Draft mission')}`, '200|true|true');
  check('member cannot open it', (await get(port, `/role-profiles/${draftId}/view`, MEMBER.code)).location, '/role-profiles');
  const list = (await get(port, '/role-profiles', PSP.code)).body;
  check('list: View opens the sheet, Details the full page', list.includes(`/role-profiles/${draftId}/view`) && list.includes(`href="/role-profiles/${draftId}"`), true);

  /* ------------------------------------------------------------------ dashboard */
  const dash = await get(port, '/dashboard', PSP.code);
  check('dashboard opens for the admin', `${dash.status}|${dash.body.includes('Role profiles by stage')}|${dash.body.includes('Coverage by sangh')}`, '200|true|true');
  check('dashboard opens for a leader', (await get(port, '/dashboard', CREATOR.code)).status, 200);
  check('a member is sent to role profiles', (await get(port, '/dashboard', MEMBER.code)).location, '/role-profiles');

  const member = await get(port, '/reports/role-profiles', MEMBER.code);
  check('a member who leads nobody is sent away', member.location, '/role-profiles');

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
