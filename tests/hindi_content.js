'use strict';
/**
 * Hindi for role profile content: drafted after each save (a stand-in translator here, so
 * nothing leaves the machine), shown to Hindi readers, corrected by the author, and kept when
 * the wording does not change. Sandbox only.
 */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';

const http = require('http');
const { build, signIn, freeDesignations, approveFully, SESSIONS } = require('./smoke');
const db = require('../src/lib/db');
const translation = require('../src/models/translation');
const translate = require('../src/lib/translate');

let pass = 0, fail = 0;
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
};
function request(port, method, path, who, lang, form) {
  const body = form ? (() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) (Array.isArray(v) ? v : [v]).forEach((x) => p.append(k, x));
    p.append('csrf_test_name', 'test-token');
    return p.toString();
  })() : '';
  return new Promise((r) => {
    const req = http.request({ port, path, method, headers: {
      'x-test-user': who, cookie: `rp_lang=${lang || 'en'}`,
      'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (c) => (b += c)); res.on('end', () => r({ status: res.statusCode, body: b, location: res.headers.location || '' })); });
    req.end(body);
  });
}
const get = (port, path, who, lang) => request(port, 'GET', path, who, lang);
const post = (port, path, who, form) => request(port, 'POST', path, who, 'en', form).then((r) => r.location);
const form = (d, sangh, mission, a1 = 'Attr one') => ({
  sangh_code: sangh, designation_name: d, mission, outcomes: ['Outcome alpha', 'Outcome beta'],
  'attribute[0]': 'Skill north', 'attribute_weight[0]': '60', 'assessment[0]': '',
  'tech_skill[0][]': [a1, 'Attr two'], 'tech_weight[0][]': ['30', '30'],
  'attribute[1]': 'Skill south', 'attribute_weight[1]': '40', 'assessment[1]': '',
  'tech_skill[1][]': 'Attr three', 'tech_weight[1][]': '40', action: 'submit',
});

(async () => {
  check('sandbox', (await db.first('SELECT DATABASE() d')).d, process.env.DB_NAME);
  // The stand-in translator marks its output, and records what it was asked.
  const asked = [];
  translate.setEngine(async (items) => { items.forEach((i) => asked.push(i.text)); return new Map(items.map((i) => [i.id, `हिं ${i.text}`])); });

  const app = build(); const server = app.listen(0); const port = server.address().port;
  const CREATOR = { code: 'M00151', name: 'Creator', isAdmin: false };
  const OTHER = { code: 'NOBODY1', name: 'Nobody', isAdmin: false };
  [CREATOR, OTHER].forEach(signIn);
  const stamp = Date.now().toString(36);
  const mission = `Mission ${stamp}`;

  const d = (await freeDesignations(CREATOR.code, CREATOR.name))[0];
  await post(port, '/role-profiles/store', CREATOR.code, form(d.designation, d.sangh_code, mission));
  const id = (await db.first('SELECT MAX(id) id FROM rp_role_profiles')).id;
  await translate.idle();

  const drafted = await translation.lookup([mission, 'Skill north', 'Attr one', 'Outcome alpha']);
  check('saving drafts Hindi for the mission, skills, attributes and outcomes', drafted.size, 4);
  check('...marked as AI drafts', [...drafted.values()].every((h) => h.origin === 'ai'), true);

  let page = (await get(port, `/role-profiles/${id}`, CREATOR.code, 'hi')).body;
  check('a Hindi reader sees the Hindi mission', page.includes(`हिं ${mission}`), true);
  check('...and the Hindi attribute lines', page.includes('हिं Attr two'), true);
  check('...and the author is told some lines are unchecked AI drafts', page.includes('/hindi"') && page.includes('AI ड्राफ़्ट'), true);
  page = (await get(port, `/role-profiles/${id}`, CREATOR.code, 'en')).body;
  check('an English reader still sees the English', page.includes(mission) && !page.includes(`हिं ${mission}`), true);
  check('the sheet is in Hindi too', (await get(port, `/role-profiles/${id}/view`, CREATOR.code, 'hi')).body.includes('हिं Skill south'), true);

  /* --------------------------------------------------------------- editing */
  check('the author can open the Hindi editor', (await get(port, `/role-profiles/${id}/hindi`, CREATOR.code, 'en')).status, 200);
  const blocked = await get(port, `/role-profiles/${id}/hindi`, OTHER.code, 'en');
  check('someone else cannot', `${blocked.status}|${blocked.location}`, `302|/role-profiles/${id}`);
  const fields = {};
  for (const item of await translation.profileTexts(id)) fields[`hindi[${translation.hashOf(item.text)}]`] = (await translation.lookup([item.text])).get(item.text).text;
  fields[`hindi[${translation.hashOf('Attr one')}]`] = 'सुधारा गया एट्रिब्यूट';
  fields['hindi[not-a-line-of-this-profile]'] = 'should be ignored';
  await post(port, `/role-profiles/${id}/hindi`, CREATOR.code, fields);
  const after = await translation.lookup(['Attr one', 'Skill north']);
  check('the correction is saved and marked checked', `${after.get('Attr one').text}|${after.get('Attr one').origin}`, 'सुधारा गया एट्रिब्यूट|edited');
  check('saving the page confirms the other drafts as checked', after.get('Skill north').origin, 'edited');
  check('nothing outside the profile was written', !!(await db.first("SELECT id FROM rp_translations WHERE text = 'should be ignored'")), false);
  check('an AI draft never overwrites a correction', (await translation.save('Attr one', 'AI again', 'ai'), (await translation.lookup(['Attr one'])).get('Attr one').text), 'सुधारा गया एट्रिब्यूट');

  /* ------------------------------------------- the wording changes: only new lines are sent */
  await approveFully((port2, path, who, f) => post(port2, path, who, f), port, id);
  asked.length = 0;
  signIn(CREATOR);
  await post(port, `/role-profiles/${id}/update`, CREATOR.code, form(d.designation, d.sangh_code, mission, `Attr rewritten ${stamp}`));
  await translate.idle();
  check('an update sends only the changed line', JSON.stringify(asked), JSON.stringify([`Attr rewritten ${stamp}`]));
  check('unchanged lines keep their checked Hindi', (await translation.lookup(['Skill north'])).get('Skill north').origin, 'edited');

  const v = await db.first('SELECT id FROM rp_profile_versions WHERE role_profile_id = ? ORDER BY version_no LIMIT 1', [id]);
  check('the frozen version shows the Hindi as well', (await get(port, `/role-profiles/${id}/versions/${v.id}`, CREATOR.code, 'hi')).body.includes('सुधारा गया एट्रिब्यूट'), true);

  /* ---------------------------------------------------------- switched off */
  translate.setEngine(null);
  const prevKey = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  check('without an API key, translation is off', translate.enabled(), false);
  check('...and saving still works without it', await translate.translateMissing(['Something new']), 0);
  if (prevKey) process.env.ANTHROPIC_API_KEY = prevKey;

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
