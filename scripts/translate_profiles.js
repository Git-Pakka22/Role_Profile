'use strict';
/**
 * Draft Hindi for every role profile's content that has none yet — current profiles and all
 * frozen versions — using Claude (see src/lib/translate.js). Text someone already translated
 * or corrected is left alone, so it is safe to run again.
 *
 *   node scripts/translate_profiles.js           how many texts would be translated (sends nothing)
 *   node scripts/translate_profiles.js --apply   translate them
 *
 * Needs ANTHROPIC_API_KEY in .env, and scripts/migrate_translations.js run first. Profile text
 * is sent to Anthropic's API.
 */
require('dotenv').config();
const translation = require('../src/models/translation');
const translate = require('../src/lib/translate');

(async () => {
  const texts = await translation.allTexts();
  const have = await translation.lookup(texts);
  const missing = texts.filter((t) => !have.has(translation.norm(t)));
  const chars = missing.reduce((n, t) => n + t.length, 0);
  console.log(`${texts.length} distinct texts, ${have.size} already have Hindi, ${missing.length} to translate (${chars.toLocaleString('en-IN')} characters).`);
  if (!process.argv.includes('--apply')) {
    console.log('\nNothing sent. Run with --apply to translate them.');
    process.exit(0);
  }
  if (!translate.enabled()) {
    console.error('\nTranslation is off: set ANTHROPIC_API_KEY in .env (and HINDI_TRANSLATION is not "off").');
    process.exit(1);
  }
  console.log(`Translating with ${translate.MODEL}…`);
  const stored = await translate.translateMissing(missing);
  console.log(`\n${stored} Hindi drafts stored. Check them in the portal: each role profile's Details page has a "Hindi" button.`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
