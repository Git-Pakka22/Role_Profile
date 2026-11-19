'use strict';
const express = require('express');
const roleProfile = require('../models/roleProfile');
const assessment = require('../models/assessment');
const ldpAssessment = require('../models/ldpAssessment');
const ldp = require('../models/ldp');
const financialYear = require('../models/financialYear');
const history = require('../models/history');
const notification = require('../models/notification');
const mw = require('../middleware');
const db = require('../lib/db');
const pdf = require('../lib/pdf');
const version = require('../models/version');
const outcomeLinks = require('../lib/outcomeLinks');

const router = express.Router({ mergeParams: true });
router.use(mw.loggedIn);

const me = (req) => ({
  code: req.session.emp_code || '',
  name: req.session.emp_name || '',
  isAdmin: !!req.session.is_admin,
});
const num = (v) => String(Math.round(Number(v) * 100) / 100).replace(/\.00$/, '');

/** The key outcomes of a version (or of the live profile), numbered as on the profile. */
async function outcomesOf(profileId, v) {
  const rows = v
    ? await version.outcomesFor(v.id)
    : await db.query('SELECT outcome FROM rp_role_key_outcomes WHERE role_profile_id = ? ORDER BY sort_order ASC', [profileId]);
  return rows.map((r, i) => ({ no: i + 1, outcome: r.outcome }));
}

async function chosenYear(req) {
  const asked = String(req.query.fy || req.body.financial_year || '').trim();
  return asked && (await financialYear.isValid(asked)) ? asked : financialYear.current();
}

/** Load the profile and confirm the member actually holds it. */
async function load(id, empCode) {
  const profile = await roleProfile.find(id);
  if (!profile) return { error: 'That role profile no longer exists.' };
  // A live profile can be assessed even while an update is going for approval: the
  // assessment runs against the version in force for the year.
  if (!roleProfile.isLive(profile)) {
    return { error: 'Only an approved role profile can be assessed.' };
  }
  const member = (await roleProfile.effectiveMembers(profile)).find((m) => m.emp_code === empCode);
  if (!member) return { error: 'That member does not hold this role profile.' };
  return { profile, member };
}

/**
 * Who may write an assessment for a given year. The RP Creator gets one shot per year —
 * once saved it is final for them. The PSP Approver may correct an existing one. Either
 * way only the current year and the one before it are open.
 */
async function canAssess(profile, actor, existing, year) {
  if (!(await financialYear.isOpen(year))) return false;
  if (actor.isAdmin) return true;
  return profile.created_by === actor.code && !existing;
}

/** A completed assessment as a PDF: the role profile plus ratings, scores and gaps. */
router.get('/:empCode/pdf', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const empCode = req.params.empCode;

  const { profile, member, error } = await load(id, empCode);
  if (error) { req.session.flashError = req.t(error); return res.redirect(`/role-profiles/${id}`); }

  if (profile.program === roleProfile.PROGRAM.LDP) {
    req.session.flashError = req.t('PDF download is not available for LDP assessments yet.');
    return res.redirect(`/role-profiles/${id}/assess/${encodeURIComponent(empCode)}`);
  }

  const mayView = profile.created_by === actor.code || actor.isAdmin
    || actor.code === empCode || profile.rp_approver_code === actor.code;
  if (!mayView) {
    req.session.flashError = req.t('That assessment is not yours to view.');
    return res.redirect(`/role-profiles/${id}`);
  }

  const chosen = await chosenYear(req);
  const existing = await assessment.forMember(id, empCode, chosen);
  if (!existing) {
    req.session.flashError = req.t('There is no assessment for {fy} to download yet.', { fy: chosen });
    return res.redirect(`/role-profiles/${id}/assess/${encodeURIComponent(empCode)}?fy=${encodeURIComponent(chosen)}`);
  }

  const v = existing.version_id ? await version.find(existing.version_id) : null;
  const outcomes = v
    ? await version.outcomesFor(v.id)
    : await db.query('SELECT outcome FROM rp_role_key_outcomes WHERE role_profile_id = ? ORDER BY sort_order ASC', [id]);
  const details = v
    ? await version.detailsFor(v.id, existing.id)
    : await assessment.skillsFor(id, existing.id);

  const who = (member.name || empCode).replace(/[^\w \-]/g, '');
  const name = `Assessment ${chosen} - ${who}`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
  // The header shows the wording of the day, not the profile as it reads now.
  pdf.roleProfile({
    profile: v ? { ...v, id } : profile,
    outcomes, details, assessment: existing,
    outcomeRatings: existing.method === assessment.METHOD.OUTCOME ? await assessment.outcomeRatingsFor(existing.id) : null,
    versionLabel: v ? `Version ${v.version_no}` : null,
  }).pipe(res);
});

router.get('/:empCode', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const empCode = req.params.empCode;

  const { profile, member, error } = await load(id, empCode);
  if (error) { req.session.flashError = req.t(error); return res.redirect(`/role-profiles/${id}`); }

  if (profile.program === roleProfile.PROGRAM.LDP) {
    return renderLdp(req, res, profile, member, actor);
  }

  const chosen = await chosenYear(req);
  const existing = await assessment.forMember(id, empCode, chosen);

  // The member themselves, the RP Approver and the PSP Approver may read it.
  const mayView = profile.created_by === actor.code || actor.isAdmin
    || actor.code === empCode || profile.rp_approver_code === actor.code;
  if (!mayView) {
    req.session.flashError = req.t('That assessment is not yours to view.');
    return res.redirect(`/role-profiles/${id}`);
  }

  // An existing assessment shows the wording it was written against; a new one uses the
  // version this year's review settled on.
  const v = existing && existing.version_id
    ? await version.find(existing.version_id)
    : await version.versionForYear(id, chosen);
  const reviewDue = await version.reviewDue(id, chosen);
  const skills = v
    ? await version.detailsFor(v.id, existing ? existing.id : null)
    : await assessment.skillsFor(id, existing ? existing.id : null);

  const outcomes = await outcomesOf(id, v);
  await res.page('assessments/form', {
    profile, member, existing,
    version: v, reviewDue,
    // The outcome method is offered once the profile links its attributes to key outcomes.
    outcomes,
    byOutcomeReady: outcomes.length > 0 && outcomeLinks.hasLinks(skills),
    method: (existing && existing.method) || assessment.METHOD.ATTRIBUTE,
    outcomeRatings: existing ? await assessment.outcomeRatingsFor(existing.id) : new Map(),
    review: await version.reviewFor(id, chosen),
    outcomeLabels: version.OUTCOME_LABELS,
    skills,
    scale: assessment.ratingScale(),
    canAssess: await canAssess(profile, actor, existing, chosen),
    isAuthor: profile.created_by === actor.code,
    years: await financialYear.years(),
    chosen,
    current: await financialYear.current(),
    previous: await financialYear.previous(),
    yearOpen: await financialYear.isOpen(chosen),
    historyYears: await assessment.yearsForMember(id, empCode),
    title: req.t('Assessment · {name}', { name: member.name || empCode }),
    pageTitle: req.t('Assessment {fy} · {name}', { fy: chosen, name: member.name || empCode }),
    activeNav: 'assessments',
  });
});

router.post('/:empCode', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const empCode = req.params.empCode;

  const { profile, member, error } = await load(id, empCode);
  if (error) { req.session.flashError = req.t(error); return res.redirect(`/role-profiles/${id}`); }

  if (profile.program === roleProfile.PROGRAM.LDP) {
    return handleLdpPost(req, res, profile, member, actor);
  }

  const chosen = await chosenYear(req);
  const back = `/role-profiles/${id}/assess/${encodeURIComponent(empCode)}?fy=${encodeURIComponent(chosen)}`;
  const already = await assessment.forMember(id, empCode, chosen);

  if (!(await financialYear.isOpen(chosen))) {
    req.session.flashError = req.t('{fy} is closed. Only {current} and {previous} can be entered or corrected.',
      { fy: chosen, current: await financialYear.current(), previous: await financialYear.previous() });
    return res.redirect(back);
  }

  // Assessing means assessing against a settled version, so the year's review comes first.
  const settled = await version.reviewFor(id, chosen);
  if (!settled && !already) {
    req.session.flashError = req.t('{fy} has not been reviewed yet. Confirm the role profile still stands for this year — or update it — before assessing anyone against it.', { fy: chosen });
    return res.redirect(`/role-profiles/${id}?tab=versions`);
  }

  if (!(await canAssess(profile, actor, already, chosen))) {
    if (profile.created_by !== actor.code) {
      req.session.flashError = req.t('Only the RP Creator who wrote this profile can assess against it.');
      return res.redirect(`/role-profiles/${id}`);
    }
    req.session.flashError = req.t('{name} has already been assessed for {fy}. An assessment cannot be changed once saved — the next one is due in the following financial year, or the PSP Approver can correct it.',
      { name: member.name || empCode, fy: chosen });
    return res.redirect(back);
  }

  // Validate everything BEFORE saving: save() clears the previous ratings first, so
  // letting a bad value through would wipe a good assessment.
  // Fields come in as rating[d<id>]: the "d" stops the query parser treating the id as an
  // array index, which would renumber it and pin the rating to the wrong skill.
  const skillId = (key) => {
    const m = /^d(\d+)$/.exec(String(key));
    return m ? Number(m[1]) : null;
  };

  const ctx = { id, profile, member, empCode, actor, chosen, already, back, skillId };
  if (String(req.body.method || '') === assessment.METHOD.OUTCOME) return saveByOutcome(req, res, ctx);
  return saveByAttribute(req, res, ctx);
});

/** The original method: every attribute line is rated directly. */
async function saveByAttribute(req, res, ctx) {
  const { id, member, actor, chosen, back, skillId } = ctx;
  const postedRatings = req.body.rating || {};
  const ratings = {};
  for (const [key, value] of Object.entries(postedRatings)) {
    const detailId = skillId(key);
    if (detailId === null || String(value).trim() === '') continue;
    const rating = Number(value);
    if (!assessment.isValidRating(rating)) {
      req.session.flashError = req.t('Ratings must be between {min} and {max} in steps of {step} — "{value}" is not allowed. Nothing was changed.',
        { min: num(assessment.RATING_MIN), max: num(assessment.RATING_MAX), step: num(assessment.RATING_STEP), value });
      return res.redirect(back);
    }
    ratings[detailId] = rating;
  }

  const postedGaps = req.body.gap || {};
  const gaps = {};
  for (const [key, text] of Object.entries(postedGaps)) {
    const detailId = skillId(key);
    if (detailId === null) continue;
    const t = String(text).trim();
    if (t !== '') gaps[detailId] = t;
  }

  // A low rating needs a plan behind it — the gap is what makes the low score useful.
  const lowUnexplained = Object.entries(ratings)
    .filter(([, r]) => r <= 2)
    .map(([detailId]) => Number(detailId))
    .filter((detailId) => !gaps[detailId]);
  if (lowUnexplained.length) {
    const named = await db.query('SELECT tech_skill FROM rp_role_profile_details WHERE id IN (?)', [lowUnexplained]);
    req.session.flashError = req.t('A rating of 2 or below needs a training gap noted — missing for: {list}. Nothing was changed.', { list: named.map((n) => n.tech_skill).join(', ') });
    return res.redirect(back);
  }

  if (!Object.keys(ratings).length && !Object.keys(gaps).length) {
    req.session.flashError = req.t('Rate at least one skill, or note a training gap, before saving. Nothing was changed.');
    return res.redirect(back);
  }

  const forYear = await version.versionForYear(id, chosen);
  const result = await assessment.save(id, member, actor, ratings, chosen, gaps,
    forYear ? forYear.id : null);
  return afterSave(req, res, { ...ctx, result });
}

/**
 * The outcome-based method: the key outcomes are rated, and every attribute line linked to
 * them takes the average of their ratings. Lines linked to no outcome are rated directly.
 * Everything is checked before anything is saved, as in the attribute method.
 */
async function saveByOutcome(req, res, ctx) {
  const { id, member, actor, chosen, already, back, skillId } = ctx;
  const forYear = await version.versionForYear(id, chosen);
  // The same version save() will score against: a correction stays on its original one.
  const versionId = (already && already.version_id) || (forYear ? forYear.id : null);
  const v = versionId ? await version.find(versionId) : null;
  const lines = v ? await version.detailsFor(v.id) : await assessment.skillsFor(id, null);
  const outcomes = await outcomesOf(id, v);
  if (!outcomes.length || !outcomeLinks.hasLinks(lines)) {
    req.session.flashError = req.t('This role profile does not link its attributes to key outcomes, so it can only be assessed by attribute. Nothing was changed.');
    return res.redirect(back);
  }

  const badRating = (value) => req.t('Ratings must be between {min} and {max} in steps of {step} — "{value}" is not allowed. Nothing was changed.',
    { min: num(assessment.RATING_MIN), max: num(assessment.RATING_MAX), step: num(assessment.RATING_STEP), value });

  // Key outcome ratings come in as orating[o<no>] and onote[o<no>].
  const postedO = req.body.orating || {};
  const postedNotes = req.body.onote || {};
  const rated = new Map();
  for (const o of outcomes) {
    const value = String(postedO[`o${o.no}`] ?? '').trim();
    if (value === '') continue;
    const rating = Number(value);
    if (!assessment.isValidRating(rating)) { req.session.flashError = badRating(value); return res.redirect(back); }
    rated.set(o.no, { rating, note: String(postedNotes[`o${o.no}`] ?? '').trim() });
  }

  const lowOutcomes = outcomes.filter((o) => rated.has(o.no) && rated.get(o.no).rating <= 2 && !rated.get(o.no).note);
  if (lowOutcomes.length) {
    req.session.flashError = req.t('A key outcome rated 2 or below needs a training gap noted — missing for: {list}. Nothing was changed.',
      { list: lowOutcomes.map((o) => `O${o.no}`).join(', ') });
    return res.redirect(back);
  }

  // Lines linked to no outcome are rated directly, as in the attribute method.
  const unlinked = new Set(lines.filter((l) => !outcomeLinks.parse(l.outcome_links).length).map((l) => Number(l.id)));
  const direct = {};
  for (const [key, value] of Object.entries(req.body.rating || {})) {
    const detailId = skillId(key);
    if (detailId === null || !unlinked.has(detailId) || String(value).trim() === '') continue;
    const rating = Number(value);
    if (!assessment.isValidRating(rating)) { req.session.flashError = badRating(value); return res.redirect(back); }
    direct[detailId] = rating;
  }
  // Gaps typed on the Preview tab: for an unlinked line its own, for a linked line an edit of
  // what its outcomes gave it.
  const directGaps = {};
  const editedGaps = {};
  for (const [key, text] of Object.entries(req.body.gap || {})) {
    const detailId = skillId(key);
    if (detailId === null) continue;
    const t = String(text).trim();
    if (t === '') continue;
    if (unlinked.has(detailId)) directGaps[detailId] = t; else editedGaps[detailId] = t;
  }
  const lowDirect = lines.filter((l) => direct[l.id] !== undefined && direct[l.id] <= 2 && !directGaps[l.id]);
  if (lowDirect.length) {
    req.session.flashError = req.t('A rating of 2 or below needs a training gap noted — missing for: {list}. Nothing was changed.', { list: lowDirect.map((l) => l.tech_skill).join(', ') });
    return res.redirect(back);
  }

  if (!rated.size && !Object.keys(direct).length) {
    req.session.flashError = req.t('Rate at least one key outcome before saving. Nothing was changed.');
    return res.redirect(back);
  }

  const { ratings, gaps } = outcomeLinks.derive(lines, rated, direct, directGaps);
  for (const line of lines) {
    const lid = Number(line.id);
    if (editedGaps[lid] && ratings[lid] !== undefined) gaps[lid] = editedGaps[lid];
  }
  const result = await assessment.save(id, member, actor, ratings, chosen, gaps, forYear ? forYear.id : null, {
    method: assessment.METHOD.OUTCOME,
    outcomes: outcomes.filter((o) => rated.has(o.no)).map((o) => ({ ...o, ...rated.get(o.no) })),
  });
  return afterSave(req, res, { ...ctx, result, byOutcome: true });
}

/** History, notification and the message — the same for both methods. */
async function afterSave(req, res, { id, profile, member, empCode, actor, chosen, already, back, result, byOutcome = false }) {
  // A re-save that leaves every rating and gap as they were is not an event: logging it
  // would fill the timeline with entries that say nothing happened.
  if (result.changed) {
    await history.log(id, history.ACTION.ASSESSED, actor,
      `${already && actor.isAdmin ? 'Corrected assessment of ' : 'Assessed '}`
      + `${member.name || empCode} (${empCode}) for ${chosen}${byOutcome ? ' by key outcome' : ''} — `
      + `${num(result.percentage)}% (${num(result.total)} of ${num(result.max)})`);

    await notification.notify([empCode], notification.TYPE.INFO,
      'You have been assessed against your role profile',
      `"${profile.designation_name}" for ${chosen} — you scored ${num(result.percentage)}% `
      + `(${num(result.total)} of ${num(result.max)}).`,
      `role-profiles/${id}/assess/${empCode}?fy=${encodeURIComponent(chosen)}`, id, actor.code);
  }

  const scoreVars = { fy: chosen, pct: num(result.percentage), total: num(result.total), max: num(result.max), rated: result.rated, gaps: result.gaps };
  req.session.flashSuccess = result.changed
    ? (result.gaps > 0
      ? req.t.n('Assessment saved for {fy} — {pct}% ({total} of {max}) across {rated} skills, {n} training gap noted.',
        'Assessment saved for {fy} — {pct}% ({total} of {max}) across {rated} skills, {n} training gaps noted.', result.gaps, scoreVars)
      : req.t('Assessment saved for {fy} — {pct}% ({total} of {max}) across {rated} skills.', scoreVars))
    : req.t('Nothing changed — {name} still stands at {pct}% for {fy}, so the history is unchanged.', { ...scoreVars, name: member.name || empCode });
  res.redirect(back);
}

/* ---------------------------------------------------------------- LDP ---- */

/** LDP's self+leader assessment page — no versioning, always against the live profile. */
async function renderLdp(req, res, profile, member, actor) {
  const id = Number(profile.id);
  const empCode = member.emp_code;
  const leader = await ldp.resolveLeader(empCode);

  const mayView = profile.created_by === actor.code || actor.isAdmin
    || actor.code === empCode || profile.rp_approver_code === actor.code
    || (leader && leader.code === actor.code);
  if (!mayView) {
    req.session.flashError = req.t('That assessment is not yours to view.');
    return res.redirect(`/role-profiles/${id}`);
  }

  const chosen = await chosenYear(req);
  const existing = await ldpAssessment.forMember(id, empCode, chosen);
  const yearOpen = await financialYear.isOpen(chosen);
  const selfSubmitted = !!(existing && existing.self_submitted_at);

  await res.page('assessments/ldp_form', {
    profile, member, leader, existing,
    skills: await ldpAssessment.skillsFor(id, existing ? existing.id : null),
    scale: ldpAssessment.ratingScale(),
    canSelf: actor.code === empCode && !selfSubmitted && yearOpen,
    canFinal: !!((leader && actor.code === leader.code) || actor.isAdmin) && selfSubmitted && yearOpen,
    isSelf: actor.code === empCode,
    isLeader: !!(leader && actor.code === leader.code),
    years: await financialYear.years(),
    chosen,
    current: await financialYear.current(),
    previous: await financialYear.previous(),
    yearOpen,
    historyYears: await ldpAssessment.yearsForMember(id, empCode),
    title: req.t('LDP Assessment · {name}', { name: member.name || empCode }),
    pageTitle: req.t('LDP Assessment {fy} · {name}', { fy: chosen, name: member.name || empCode }),
    activeNav: 'assessments',
  });
}

async function handleLdpPost(req, res, profile, member, actor) {
  const id = Number(profile.id);
  const empCode = member.emp_code;
  const leader = await ldp.resolveLeader(empCode);
  const chosen = await chosenYear(req);
  const back = `/role-profiles/${id}/assess/${encodeURIComponent(empCode)}?fy=${encodeURIComponent(chosen)}`;
  const stage = String(req.body.stage || '').trim();

  if (!(await financialYear.isOpen(chosen))) {
    req.session.flashError = req.t('{fy} is closed. Only {current} and {previous} can be entered or corrected.',
      { fy: chosen, current: await financialYear.current(), previous: await financialYear.previous() });
    return res.redirect(back);
  }

  const skillId = (key) => {
    const m = /^d(\d+)$/.exec(String(key));
    return m ? Number(m[1]) : null;
  };
  const postedRatings = req.body.rating || {};
  const ratings = {};
  for (const [key, value] of Object.entries(postedRatings)) {
    const detailId = skillId(key);
    if (detailId === null || String(value).trim() === '') continue;
    const rating = Number(value);
    if (!ldpAssessment.isValidRating(rating)) {
      req.session.flashError = req.t('Ratings must be between {min} and {max} in steps of {step} — "{value}" is not allowed. Nothing was changed.',
        { min: num(ldpAssessment.RATING_MIN), max: num(ldpAssessment.RATING_MAX), step: num(ldpAssessment.RATING_STEP), value });
      return res.redirect(back);
    }
    ratings[detailId] = rating;
  }

  if (stage === 'self') {
    const existing = await ldpAssessment.forMember(id, empCode, chosen);
    if (actor.code !== empCode) {
      req.session.flashError = req.t('Only the member themselves can submit a self-rating.');
      return res.redirect(back);
    }
    if (existing && existing.self_submitted_at) {
      req.session.flashError = req.t('Your self-rating for this year is already submitted and cannot be changed.');
      return res.redirect(back);
    }
    if (!Object.keys(ratings).length) {
      req.session.flashError = req.t('Rate at least one skill before submitting. Nothing was changed.');
      return res.redirect(back);
    }

    const result = await ldpAssessment.saveSelf(id, member, ratings, chosen);
    if (result.error) { req.session.flashError = req.t(result.error); return res.redirect(back); }

    await history.log(id, history.ACTION.ASSESSED, actor,
      `${member.name || empCode} (${empCode}) self-rated for ${chosen} — ${num(result.percentage)}%`);
    if (leader) {
      await notification.notify([leader.code], notification.TYPE.PENDING,
        'A self-rating is waiting on your final rating',
        `${member.name || empCode} submitted their self-rating for "${profile.designation_name}" (${chosen}). `
        + 'Your final rating is now open.',
        `role-profiles/${id}/assess/${empCode}?fy=${encodeURIComponent(chosen)}`, id, actor.code);
    }
    req.session.flashSuccess = req.t('Self-rating submitted for {fy} — {pct}% ({total} of {max}).',
      { fy: chosen, pct: num(result.percentage), total: num(result.total), max: num(result.max) });
    return res.redirect(back);
  }

  if (stage === 'final') {
    const authorized = !!((leader && actor.code === leader.code) || actor.isAdmin);
    if (!authorized) {
      req.session.flashError = req.t('Only this member’s leader (or the PSP Approver) can give the final rating.');
      return res.redirect(back);
    }

    const postedPlans = req.body.gap || {};
    const gaps = {};
    for (const [key, text] of Object.entries(postedPlans)) {
      const detailId = skillId(key);
      if (detailId === null) continue;
      const t = String(text).trim();
      if (t !== '') gaps[detailId] = t;
    }
    if (!Object.keys(ratings).length && !Object.keys(gaps).length) {
      req.session.flashError = req.t('Rate at least one skill, or note a development plan, before saving. Nothing was changed.');
      return res.redirect(back);
    }

    // A low rating needs a plan behind it — the gap is what makes the low score useful.
    const lowUnexplained = Object.entries(ratings)
      .filter(([, r]) => r <= 2)
      .map(([detailId]) => Number(detailId))
      .filter((detailId) => !gaps[detailId]);
    if (lowUnexplained.length) {
      const named = await db.query('SELECT tech_skill FROM rp_role_profile_details WHERE id IN (?)', [lowUnexplained]);
      req.session.flashError = req.t('A rating of 2 or below needs a development plan noted — missing for: {list}. Nothing was changed.', { list: named.map((n) => n.tech_skill).join(', ') });
      return res.redirect(back);
    }

    const result = await ldpAssessment.saveFinal(id, member, actor, ratings, gaps, chosen);
    if (result.error) { req.session.flashError = req.t(result.error); return res.redirect(back); }

    await history.log(id, history.ACTION.ASSESSED, actor,
      `Final rating for ${member.name || empCode} (${empCode}) for ${chosen} — ${num(result.percentage)}%`);
    await notification.notify([empCode], notification.TYPE.INFO,
      'Your final rating is ready',
      `"${profile.designation_name}" for ${chosen} — you scored ${num(result.percentage)}% `
      + `(${num(result.total)} of ${num(result.max)}).`,
      `role-profiles/${id}/assess/${empCode}?fy=${encodeURIComponent(chosen)}`, id, actor.code);

    const finalVars = { fy: chosen, pct: num(result.percentage), total: num(result.total), max: num(result.max), rated: result.rated };
    req.session.flashSuccess = result.gaps > 0
      ? req.t.n('Final rating saved for {fy} — {pct}% ({total} of {max}) across {rated} skills, {n} development note recorded.',
        'Final rating saved for {fy} — {pct}% ({total} of {max}) across {rated} skills, {n} development notes recorded.', result.gaps, finalVars)
      : req.t('Final rating saved for {fy} — {pct}% ({total} of {max}) across {rated} skills.', finalVars);
    return res.redirect(back);
  }

  req.session.flashError = req.t('Nothing was changed.');
  return res.redirect(back);
}

module.exports = router;
