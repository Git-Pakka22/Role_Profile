'use strict';
const db = require('../lib/db');
const roleProfile = require('./roleProfile');
const employee = require('./employee');

const S = roleProfile.STATUS;

/**
 * The stages a role profile can be counted in, in the order they are shown. "Update awaiting
 * approval" is not a status of its own: it is an approved profile whose update is going
 * through approval (or was sent back), so it is counted on top of its status.
 */
const STAGES = [
  { key: S.DRAFT, label: 'Draft', icon: 'mdi-content-save-outline' },
  { key: S.PENDING_SEVAK, label: 'Awaiting RP Approver', icon: 'mdi-clock-outline' },
  { key: S.PENDING_ADMIN, label: 'Awaiting final approval', icon: 'mdi-clock-fast' },
  { key: S.APPROVED, label: 'Approved', icon: 'mdi-check-circle-outline' },
  { key: S.REJECTED, label: 'Rejected', icon: 'mdi-close-circle-outline' },
];
const UPDATE_PENDING = 'update_pending';

/**
 * The profiles this person may report on.
 * PSP Approver: every PSP profile; LDP Admin: every LDP profile — drafts included, since the
 * point is to see how many are where. Everyone else: what they can already see.
 */
async function baseProfiles(actor) {
  if (actor.isAdmin || actor.isLdpAdmin) {
    const programs = [actor.isAdmin && roleProfile.PROGRAM.PSP, actor.isLdpAdmin && roleProfile.PROGRAM.LDP].filter(Boolean);
    return db.query(
      'SELECT * FROM rp_role_profiles WHERE program IN (?) OR created_by = ? ORDER BY created_at DESC',
      [programs, actor.code]);
  }
  return roleProfile.visibleTo(actor.code, false, false);
}

/** Attach the numbers the report shows: version in force, members, this year's assessments. */
async function enrich(profiles, financialYear) {
  if (!profiles.length) return profiles;
  const ids = profiles.map((p) => p.id);

  const versions = new Map((await db.query(
    `SELECT role_profile_id id, MAX(version_no) v, COUNT(*) n FROM rp_profile_versions
     WHERE role_profile_id IN (?) GROUP BY role_profile_id`, [ids])).map((r) => [Number(r.id), r]));
  const members = new Map((await db.query(
    `SELECT m.role_profile_id id, COUNT(*) n FROM rp_role_profile_members m
     JOIN tbl_employee e ON e.emp_code = m.emp_code AND e.status = ?
     WHERE m.role_profile_id IN (?) GROUP BY m.role_profile_id`, [employee.STATUS_ACTIVE, ids])).map((r) => [Number(r.id), Number(r.n)]));
  const assessed = new Map((await db.query(
    `SELECT role_profile_id id, COUNT(*) n FROM rp_assessments
     WHERE role_profile_id IN (?) AND financial_year = ? GROUP BY role_profile_id`, [ids, financialYear]))
    .map((r) => [Number(r.id), Number(r.n)]));

  return profiles.map((p) => {
    const v = versions.get(Number(p.id));
    return {
      ...p,
      program: p.program || roleProfile.sanghProgram(p.sangh_code),
      stage_label: roleProfile.statusLabel(p),
      update_pending: roleProfile.hasPendingUpdate(p),
      version_no: v ? Number(v.v) : null,
      versions: v ? Number(v.n) : 0,
      members: members.get(Number(p.id)) || 0,
      assessments: assessed.get(Number(p.id)) || 0,
    };
  });
}

/** A Date at the start of a 'YYYY-MM-DD' day, or null. */
const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null);

/** Financial year 'YYYY-YYYY' → [from, to] dates (April to March). */
function fyRange(fy) {
  const m = /^(\d{4})-(\d{4})$/.exec(String(fy || ''));
  return m ? [`${m[1]}-04-01`, `${m[2]}-03-31`] : null;
}

/** Normalise the query string into the filters the report understands. */
function readFilters(q) {
  const one = (k) => String(q[k] || '').trim();
  return {
    fy: one('fy'),
    from: day(q.from),
    to: day(q.to),
    sangh: one('sangh'),
    program: ['psp', 'ldp'].includes(one('program')) ? one('program') : '',
    stage: one('stage'),
    creator: one('creator'),
    approver: one('approver'),
    q: one('q'),
    members: ['yes', 'no'].includes(one('members')) ? one('members') : '',
    updated: ['yes', 'no'].includes(one('updated')) ? one('updated') : '',
    assessed: ['yes', 'no'].includes(one('assessed')) ? one('assessed') : '',
  };
}

const dateOf = (v) => {
  if (!v) return '';
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
};

/** Apply every filter except the ones named in `skip` (so a breakdown can ignore its own axis). */
function applyFilters(rows, f, skip = []) {
  const range = f.fy ? fyRange(f.fy) : null;
  const q = f.q.toLowerCase();
  return rows.filter((p) => {
    const created = dateOf(p.created_at);
    if (range && (created < range[0] || created > range[1])) return false;
    if (f.from && created < f.from) return false;
    if (f.to && created > f.to) return false;
    if (f.sangh && !skip.includes('sangh') && p.sangh_code !== f.sangh) return false;
    if (f.program && !skip.includes('program') && p.program !== f.program) return false;
    if (f.stage && !skip.includes('stage')) {
      if (f.stage === UPDATE_PENDING ? !p.update_pending : p.status !== f.stage) return false;
    }
    if (f.creator && p.created_by !== f.creator) return false;
    if (f.approver && String(p.rp_approver_code || '') !== f.approver) return false;
    if (q && !String(p.designation_name || '').toLowerCase().includes(q)) return false;
    if (f.members === 'yes' && !p.members) return false;
    if (f.members === 'no' && p.members) return false;
    if (f.updated === 'yes' && !(p.version_no > 1)) return false;
    if (f.updated === 'no' && p.version_no > 1) return false;
    if (f.assessed === 'yes' && !p.assessments) return false;
    if (f.assessed === 'no' && p.assessments) return false;
    return true;
  });
}

/** Count rows per stage, with the "update awaiting approval" extra. */
function stageCounts(rows) {
  const c = { total: rows.length, [UPDATE_PENDING]: 0 };
  for (const s of STAGES) c[s.key] = 0;
  for (const p of rows) {
    c[p.status] = (c[p.status] || 0) + 1;
    if (p.update_pending) c[UPDATE_PENDING]++;
  }
  return c;
}

/**
 * Everything the report page needs. Stage cards and the sangh / programme breakdowns ignore
 * their own filter (stage, sangh, programme), so they keep showing the spread to click into.
 */
async function build(actor, query, financialYear) {
  const f = readFilters(query);
  const all = await enrich(await baseProfiles(actor), financialYear);
  const rows = applyFilters(all, f);

  const bySangh = new Map();
  for (const p of applyFilters(all, f, ['sangh'])) {
    const key = p.sangh_code || '—';
    if (!bySangh.has(key)) bySangh.set(key, { sangh_code: key, sangh_name: p.sangh_name || key, program: p.program, rows: [] });
    bySangh.get(key).rows.push(p);
  }
  const sanghRows = [...bySangh.values()]
    .map((g) => ({ ...g, counts: stageCounts(g.rows) }))
    .sort((a, b) => b.counts.total - a.counts.total || String(a.sangh_name).localeCompare(String(b.sangh_name)));

  const programRows = ['psp', 'ldp'].map((prog) => ({
    program: prog,
    counts: stageCounts(applyFilters(all, f, ['program']).filter((p) => p.program === prog)),
  })).filter((r) => r.counts.total);

  // Choices for the filter dropdowns, from everything this person can report on.
  const uniq = (list) => [...new Map(list.filter((x) => x.code).map((x) => [x.code, x])).values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const options = {
    sanghs: uniq(all.map((p) => ({ code: p.sangh_code, name: p.sangh_name || p.sangh_code, program: p.program }))),
    creators: uniq(all.map((p) => ({ code: p.created_by, name: p.created_by_name || p.created_by }))),
    approvers: uniq(all.map((p) => ({ code: p.rp_approver_code, name: p.rp_approver_name || p.rp_approver_code }))),
  };

  return {
    filters: f,
    rows,
    stageCards: stageCounts(applyFilters(all, f, ['stage'])),
    sanghRows,
    programRows,
    options,
    totalVisible: all.length,
    activeFilters: Object.entries(f).filter(([, v]) => v).length,
  };
}

module.exports = { STAGES, UPDATE_PENDING, build, readFilters, fyRange };
