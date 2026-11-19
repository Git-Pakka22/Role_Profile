'use strict';
/**
 * Adds the outcome-based assessment method, alongside the existing one.
 *
 *  - rp_role_profile_details.outcome_links / rp_version_details.outcome_links: which key
 *    outcomes (by number, "1,3") each attribute line is linked to. NULL means none, so
 *    every existing profile reads exactly as before.
 *  - rp_assessments.method: 'attribute' (the existing method, the default for every row
 *    already there) or 'outcome'.
 *  - rp_assessment_outcome_ratings: the rating given to each key outcome in an outcome-based
 *    assessment. The attribute ratings worked out from them are stored in
 *    rp_assessment_ratings as usual, so scores, reports and PDFs read them unchanged.
 *
 * Nothing existing is dropped or rewritten. Safe to run more than once.
 */
const db = require('../src/lib/db');

const say = (msg) => console.log('  ' + msg);

async function tableExists(name) {
  const row = await db.first(
    'SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]);
  return Number(row.n) > 0;
}
async function columnExists(table, column) {
  const row = await db.first(
    `SELECT COUNT(*) n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return Number(row.n) > 0;
}

const COLUMNS = [
  ['rp_role_profile_details', 'outcome_links',
    'ALTER TABLE rp_role_profile_details ADD COLUMN outcome_links VARCHAR(64) DEFAULT NULL AFTER tech_weight'],
  ['rp_version_details', 'outcome_links',
    'ALTER TABLE rp_version_details ADD COLUMN outcome_links VARCHAR(64) DEFAULT NULL AFTER tech_weight'],
  ['rp_assessments', 'method',
    "ALTER TABLE rp_assessments ADD COLUMN method VARCHAR(16) NOT NULL DEFAULT 'attribute' AFTER version_id"],
];

async function main() {
  console.log(`Migrating ${(await db.first('SELECT DATABASE() d')).d}\n`);

  for (const [table, column, ddl] of COLUMNS) {
    if (await columnExists(table, column)) { say(`${table}.${column} — already there`); continue; }
    await db.run(ddl);
    say(`${table}.${column} — added`);
  }

  if (await tableExists('rp_assessment_outcome_ratings')) {
    say('rp_assessment_outcome_ratings — already there');
  } else {
    await db.run(`
      CREATE TABLE rp_assessment_outcome_ratings (
        id INT(11) NOT NULL AUTO_INCREMENT,
        assessment_id INT(11) NOT NULL,
        outcome_no INT(11) NOT NULL,
        outcome TEXT,
        rating DECIMAL(3,1) NOT NULL DEFAULT '0.0',
        note TEXT,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_assessment_outcome (assessment_id, outcome_no)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    say('rp_assessment_outcome_ratings — created');
  }
  console.log('\nDone.');
}

module.exports = { main };
if (require.main === module) main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
