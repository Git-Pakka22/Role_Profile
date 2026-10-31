'use strict';
const db = require('../lib/db');
const report = require('./report');
const roleProfile = require('./roleProfile');

/**
 * The dashboard's numbers, for one person and one financial year. Built from the same pieces
 * as the role profile report, so the two always agree: the admin sees their whole programme,
 * leaders the profiles and sanghs they already see.
 */
async function build(actor, financialYear) {
  const profiles = await report.enrich(await report.baseProfiles(actor), financialYear);
  const stages = report.stageCounts(profiles);
  const cov = await report.coverage(actor);

  // Coverage per sangh: designations and how many have a role profile.
  const bySangh = new Map(cov.sanghs.map((x) => [x.sangh_code, { code: x.sangh_code, name: x.sangh_name, program: x.program, total: 0, created: 0 }]));
  for (const d of cov.rows) {
    const g = bySangh.get(d.sangh_code);
    if (!g) continue;
    g.total++;
    if (d.profile) g.created++;
  }
  const sanghCoverage = [...bySangh.values()].filter((g) => g.total)
    .sort((a, b) => b.created - a.created || b.total - a.total || String(a.name).localeCompare(String(b.name)));

  // Assessments this year: members on live profiles, and how many of them are assessed.
  const live = profiles.filter((p) => roleProfile.isLive(p));
  const membersOnProfiles = live.reduce((t, p) => t + p.members, 0);
  const assessed = live.reduce((t, p) => t + Math.min(p.assessments, p.members), 0);

  // What changed lately on these profiles.
  const ids = profiles.map((p) => p.id);
  const activity = ids.length ? await db.query(
    `SELECT h.role_profile_id, h.action, h.actor_code, h.actor_name, h.note, h.created_at, p.designation_name
     FROM rp_role_profile_history h JOIN rp_role_profiles p ON p.id = h.role_profile_id
     WHERE h.role_profile_id IN (?) ORDER BY h.id DESC LIMIT 8`, [ids]) : [];

  const byProgram = ['psp', 'ldp'].map((prog) => {
    const list = profiles.filter((p) => p.program === prog);
    return { program: prog, total: list.length, approved: list.filter((p) => p.status === 'approved').length };
  }).filter((x) => x.total > 0);

  return {
    stages,
    total: profiles.length,
    inApproval: (stages.pending_sevak || 0) + (stages.pending_admin || 0),
    coverage: { designations: cov.rows.length, created: cov.rows.filter((d) => d.profile).length, sanghs: cov.sanghs.length },
    sanghCoverage,
    membersOnProfiles,
    assessed,
    awaiting: await roleProfile.awaiting(actor.code, actor.isAdmin, actor.isLdpAdmin),
    recent: [...profiles].sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at)).slice(0, 6),
    activity,
    byProgram,
  };
}

module.exports = { build };
