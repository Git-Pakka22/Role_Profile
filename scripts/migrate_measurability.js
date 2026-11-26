'use strict';
/**
 * Adds "Outcomes Measurability" to the role profile format: for each technical skill, a
 * measurable target for each of three financial years (2026-27, 2027-28, 2028-29 …).
 *
 *  - rp_role_profile_details / rp_version_details: measure_1, measure_2, measure_3 — the
 *    targets for the first, second and third year. Like the assessment mechanism they
 *    belong to the skill and repeat across its attribute rows.
 *  - rp_role_profiles / rp_profile_versions: measure_from — the first of the three years
 *    ("2026-2027").
 *
 * All nullable, so every existing profile reads exactly as before. Safe to run more than once.
 */
const db = require('../src/lib/db');

const say = (msg) => console.log('  ' + msg);

async function columnExists(table, column) {
  const row = await db.first(
    `SELECT COUNT(*) n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return Number(row.n) > 0;
}

const COLUMNS = [];
for (const table of ['rp_role_profile_details', 'rp_version_details']) {
  COLUMNS.push([table, 'measure_1', `ALTER TABLE ${table} ADD COLUMN measure_1 TEXT NULL AFTER assessment`]);
  COLUMNS.push([table, 'measure_2', `ALTER TABLE ${table} ADD COLUMN measure_2 TEXT NULL AFTER measure_1`]);
  COLUMNS.push([table, 'measure_3', `ALTER TABLE ${table} ADD COLUMN measure_3 TEXT NULL AFTER measure_2`]);
}
COLUMNS.push(['rp_role_profiles', 'measure_from', 'ALTER TABLE rp_role_profiles ADD COLUMN measure_from VARCHAR(20) DEFAULT NULL']);
COLUMNS.push(['rp_profile_versions', 'measure_from', 'ALTER TABLE rp_profile_versions ADD COLUMN measure_from VARCHAR(20) DEFAULT NULL']);

async function main() {
  console.log(`Migrating ${(await db.first('SELECT DATABASE() d')).d}\n`);
  for (const [table, column, ddl] of COLUMNS) {
    if (await columnExists(table, column)) { say(`${table}.${column} — already there`); continue; }
    await db.run(ddl);
    say(`${table}.${column} — added`);
  }
  console.log('\nDone.');
}

module.exports = { main };
if (require.main === module) main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
