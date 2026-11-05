'use strict';
/**
 * Core Teams (CT) is an LDP sangh, the same as SS and SS1: its members leave PSP's lists for
 * LDP's, and its profiles go to the LDP Admin. Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';
process.env.EXCLUDED_SANGHS = 'SS,SS1,CT';

const db = require('../src/lib/db');
const roleProfile = require('../src/models/roleProfile');
const employee = require('../src/models/employee');
const ldp = require('../src/models/ldp');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);

  check('CT is LDP', roleProfile.sanghProgram('CT'), roleProfile.PROGRAM.LDP);
  check('SS is still LDP', roleProfile.sanghProgram('SS'), roleProfile.PROGRAM.LDP);
  check('SS1 is still LDP', roleProfile.sanghProgram('SS1'), roleProfile.PROGRAM.LDP);
  check('other sanghs stay PSP', roleProfile.sanghProgram('MSS'), roleProfile.PROGRAM.PSP);
  check('the final approver of a CT profile is the LDP Admin',
    roleProfile.finalApprover({ sangh_code: 'CT' }).label, 'LDP Admin');

  const member = await db.first("SELECT emp_code FROM tbl_employee WHERE sangh_code = 'CT' AND status = 0 LIMIT 1");
  check('the sandbox has an active Core Teams member', !!member, true);
  check('they are on the LDP member list', (await ldp.activeMembers()).some((m) => m.emp_code === member.emp_code), true);
  check('they can be managed from LDP Members', !!(await ldp.findActiveByCode(member.emp_code)), true);
  check('they are off the PSP member list', (await employee.getDirectory()).some((m) => m.emp_code === member.emp_code), false);
  const ct = (await roleProfile.allSanghs()).find((s) => s.sangh_code === 'CT');
  check('the sangh dropdowns class it as LDP', ct && ct.program, roleProfile.PROGRAM.LDP);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
