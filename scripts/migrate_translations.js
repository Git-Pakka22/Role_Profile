'use strict';
/**
 * Adds rp_translations: the Hindi for role profile content (mission, key outcomes, technical
 * skills, attributes, assessment mechanism), one row per distinct English text. Keyed by the
 * text itself, so every version and assessment that uses the same wording shares its Hindi.
 *
 * Safe to run more than once.
 */
const db = require('../src/lib/db');

async function main() {
  console.log(`Migrating ${(await db.first('SELECT DATABASE() d')).d}\n`);
  const exists = Number((await db.first(
    `SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'rp_translations'`)).n) > 0;
  if (exists) {
    console.log('  rp_translations — already there');
  } else {
    await db.run(`
      CREATE TABLE rp_translations (
        id INT(11) NOT NULL AUTO_INCREMENT,
        source_hash CHAR(64) NOT NULL,
        lang VARCHAR(8) NOT NULL DEFAULT 'hi',
        source_text TEXT NOT NULL,
        text TEXT NOT NULL,
        origin ENUM('ai','edited') NOT NULL DEFAULT 'ai',
        updated_by VARCHAR(50) NOT NULL DEFAULT '',
        updated_by_name VARCHAR(255) NOT NULL DEFAULT '',
        updated_at DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_source_lang (source_hash, lang)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    console.log('  rp_translations — created');
  }
  console.log('\nDone.');
}

module.exports = { main };
if (require.main === module) main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
