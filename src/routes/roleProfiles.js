'use strict';
const express = require('express');
const config = require('../config');
const db = require('../lib/db');
const employee = require('../models/employee');
const roleProfile = require('../models/roleProfile');
const ldp = require('../models/ldp');
const scope = require('../lib/scope');
const assessment = require('../models/assessment');
const financialYear = require('../models/financialYear');
const history = require('../models/history');
const notification = require('../models/notification');
const mw = require('../middleware');
const pdf = require('../lib/pdf');
const version = require('../models/version');
const translation = require('../models/translation');
const translate = require('../lib/translate');
const importer = require('../lib/importer');
const sampleSheet = require('../lib/sampleSheet');
const multer = require('multer');

const router = express.Router();
router.use(mw.loggedIn);

const S = roleProfile.STATUS;
const me = (req) => ({
  code: req.session.emp_code || '',
  name: req.session.emp_name || '',
  isAdmin: !!req.session.is_admin,
  isLdpAdmin: !!req.session.is_ldp_admin,
});
/** Sanghs beyond the ones a person leads: PSP ones for the PSP Approver, SS/SS1 for the LDP Admin. */
const reachOf = (actor) => ({ psp: !!actor.isAdmin, ldp: !!actor.isLdpAdmin });

/**
 * Who may write role profiles: anyone leading members (RP Creator, RP Approver, Pracharak),
 * plus the PSP Approver and the LDP Admin for the sanghs they oversee.
 */
async function canCreate(req) {
  const actor = me(req);
  return actor.isAdmin || actor.isLdpAdmin || (await mw.leadsCount(req)) > 0;
}

const num = (v) => String(Math.round(Number(v) * 100) / 100).replace(/\.00$/, '');

/* --------------------------------------------------------- approver rules */

/**
 * The RP Approver recorded against this person's own member row, if any.
 * Empty when that person is the author themselves — 6 members are their own approver,
 * and letting them clear their own submission would make the first stage meaningless.
 *
 * Empty too when a member of an LDP sangh (Sanghrakshak / Seva Sangh, SS/SS1) writes a PSP
 * profile: their RP Approver is on the LDP side, so a PSP profile goes straight to the PSP
 * Approver. Their LDP profiles still go to that RP Approver first. Leave `program` out to get
 * the approver on record whatever the profile.
 */
async function approverFor(empCode, program = null) {
  // Read straight from tbl_employee, not employee.findActiveByCode(): that one leaves out the
  // LDP sanghs (SS/SS1), and people there still write profiles for their members.
  const row = await db.first(
    'SELECT sangh_code, rp_approver_code, rp_approver_name FROM tbl_employee WHERE emp_code = ? AND status = ? LIMIT 1',
    [empCode, employee.STATUS_ACTIVE]);
  const code = String((row && row.rp_approver_code) || '').trim();
  if (!code || code === empCode) return { code: '', name: '' };
  if (program === roleProfile.PROGRAM.PSP && row
      && roleProfile.sanghProgram(row.sangh_code) === roleProfile.PROGRAM.LDP) {
    return { code: '', name: '', ldpOnly: { code, name: String(row.rp_approver_name || '').trim() } };
  }
  return { code, name: String((row && row.rp_approver_name) || '').trim() };
}

// `profile` (or a header about to be saved) carries the programme, which decides whether the
// final approver is the PSP Approver or the LDP Admin.
const routeNote = (a, profile) => (a.code !== ''
  ? `Sent to ${a.name} for approval`
  : `Sent straight to the ${roleProfile.finalApprover(profile).label}`);

const submittedMessage = (a, profile, t) => (a.code !== ''
  ? t('Submitted to {name} for approval.', { name: a.name })
  : t('Submitted for {approver} approval (you have no separate RP Approver on record).', { approver: t(roleProfile.finalApprover(profile).label) }));

/** A model's result message, in the reader's language when the model says how to word it. */
const said = (req, result) => (result.i18n ? req.t(result.i18n[0], result.i18n[1]) : req.t(result.message));

/* --------------------------------------------------------- notifications */

async function notifyPending(profile, id, approver, actor) {
  const link = `role-profiles/${id}`;
  const what = `${profile.designation_name} (${profile.sangh_name})`;

  if (approver.code !== '') {
    return notification.notify([approver.code], notification.TYPE.PENDING,
      'Role profile needs your approval',
      `${actor.name} submitted "${what}" for your approval.`, link, id, actor.code);
  }
  const final = roleProfile.finalApprover(profile);
  return notification.notify(final.codes, notification.TYPE.PENDING,
    `Role profile needs ${final.label} approval`,
    `${actor.name} submitted "${what}" for approval.`, link, id, actor.code);
}

/** The people responsible for the given members. */
async function leadersOf(empCodes) {
  if (!empCodes.length) return [];
  const rows = await db.query(
    'SELECT rp_approver_code, rp_creator_code, pracharak_code FROM tbl_employee WHERE emp_code IN (?)',
    [empCodes]
  );
  const set = new Set();
  for (const row of rows) {
    for (const col of ['rp_approver_code', 'rp_creator_code', 'pracharak_code']) {
      const c = String(row[col] || '').trim();
      if (c) set.add(c);
    }
  }
  return [...set];
}

/**
 * On final approval: the author is told it is live and waiting for members to be assigned.
 * A re-approved profile already has members — they and their leaders hear about the new
 * version. Nobody else is put on it: members are only ever assigned by the admin.
 */
async function notifyApproved(profile, id, actor) {
  const fresh = await roleProfile.find(id);
  const members = await roleProfile.effectiveMembers(fresh);
  const what = `${profile.designation_name} (${profile.sangh_name})`;
  const link = `role-profiles/${id}`;

  await notification.notify([profile.created_by], notification.TYPE.APPROVED,
    'Your role profile was approved',
    members.length
      ? `"${what}" is approved and applies to the ${members.length} member(s) assigned to it.`
      : `"${what}" is approved. It applies to members once the ${roleProfile.finalApprover(profile).label} assigns them.`,
    link, id, actor.code);

  const codes = members.map((m) => m.emp_code);
  if (codes.length) {
    await notification.notify(codes, notification.TYPE.APPROVED,
      'Your role profile was updated',
      `A new version of your role profile "${what}" has been approved.`, link, id, actor.code);
    const leaders = await leadersOf(codes);
    if (leaders.length) {
      await notification.notify(leaders, notification.TYPE.APPROVED,
        'Role profile updated for your members',
        `A new version of "${what}" has been approved for members you are responsible for.`, link, id, actor.code);
    }
  }
  return members;
}

/** "Asha Rao (E10001) and Ravi Kumar (E10002)", trimmed if the list is long. */
function nameList(members, limit = 6) {
  const names = members.map((m) => `${m.name || m.emp_code} (${m.emp_code})`);
  if (names.length <= limit) return names.join(', ');
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`;
}

/* ------------------------------------------------------------ validation */

/** Pull the repeatable attribute / skill inputs off the request. */
function collectAttributes(body) {
  const names = body.attribute || {};
  const assessments = body.assessment || {};
  const weights = body.attribute_weight || {};
  const skills = body.tech_skill || {};
  const skillWeights = body.tech_weight || {};
  // The key outcomes each attribute links to, as their positions on the form ("1,3").
  const skillOutcomes = body.tech_outcomes || {};

  const out = [];
  for (const key of Object.keys(names)) {
    const name = String(names[key] ?? '').trim();
    if (!name) continue;

    const rowSkills = [];
    const list = skills[key] || [];
    const wlist = skillWeights[key] || [];
    const olist = skillOutcomes[key] || [];
    (Array.isArray(list) ? list : [list]).forEach((skill, j) => {
      if (String(skill ?? '').trim() === '') return;
      rowSkills.push({
        skill,
        weight: (Array.isArray(wlist) ? wlist : [wlist])[j] ?? '',
        outcomes: String((Array.isArray(olist) ? olist : [olist])[j] ?? ''),
      });
    });

    out.push({
      attribute: name,
      assessment: assessments[key] ?? '',
      attribute_weight: weights[key] ?? '',
      // Enforced here as well as in the browser.
      skills: rowSkills.slice(0, roleProfile.MAX_SKILLS_PER_ATTR),
    });
  }
  return out.slice(0, roleProfile.MAX_ATTRIBUTES);
}

/**
 * Attribute weights must add up to their skill's weight, and skill weights must
 * total 100 — both hold for every profile in the PSP portal.
 */
function checkSkillWeights(attributes, t) {
  for (let i = 0; i < attributes.length; i++) {
    const attr = attributes[i];
    const skills = attr.skills || [];
    if (!skills.length) continue;

    const attrWeight = attr.attribute_weight === '' ? null : Number(attr.attribute_weight);
    const skillTotal = skills.reduce((sum, s) => sum + (s.weight === '' ? 0 : Number(s.weight)), 0);
    const label = t('Skill {n} ({name})', { n: i + 1, name: String(attr.attribute).trim() });

    if (attrWeight === null) {
      return t('Please check total — {label} has attribute weights but no skill weight. Give it a weight of {n}.', { label, n: num(skillTotal) });
    }
    if (Math.abs(attrWeight - skillTotal) > 0.001) {
      return t('Please check total — {label}: its attribute weights total {total}, which must equal the skill weight of {weight}.', { label, total: num(skillTotal), weight: num(attrWeight) });
    }
  }

  const attributeTotal = attributes.reduce(
    (sum, a) => sum + (a.attribute_weight === '' ? 0 : Number(a.attribute_weight)), 0);
  if (Math.abs(attributeTotal - roleProfile.TOTAL_WEIGHT) > 0.001) {
    return t('Please check total — the skill weights add up to {total}, but they must total {max}.', { total: num(attributeTotal), max: roleProfile.TOTAL_WEIGHT });
  }
  return null;
}

async function designationId(name) {
  const row = await db.first('SELECT id FROM designations WHERE designation_name = ? LIMIT 1', [name]);
  return row ? Number(row.id) : null;
}

/**
 * Parse and validate a submitted form. Returns parsed parts, or an error string.
 *
 * `locked` is the profile when it is edited while awaiting approval: the content changes, but
 * the sangh and designation stay as the author chose them — an approver does not lead those
 * members, so the author's picker rules cannot apply to them.
 */
async function validateSubmission(body, actor, exceptId = null, locked = null, t = require('../lib/i18n').translator('en')) {
  let designation;
  let sanghCode;
  let sanghName;

  if (locked) {
    designation = String(locked.designation_name || '').trim();
    sanghCode = String(locked.sangh_code || '');
    sanghName = String(locked.sangh_name || '');
  } else {
    designation = String(body.designation_name || '').trim();
    sanghCode = String(body.sangh_code || '').trim();

    if (!sanghCode) return t('Choose a sangh.');
    if (!designation) return t('Choose a designation.');

    // Any designation the sangh has, held now, held before, or created in the portal.
    const known = await roleProfile.knownDesignation(actor.code, actor.name, sanghCode, designation, reachOf(actor));
    if (known === null) {
      return t('That designation does not exist in that sangh. Create it with "+ New designation" first.');
    }
    designation = known.trim();

    // Enforced here as well as in the dropdown, so a stale page cannot create a second one.
    const clash = await roleProfile.profileForDesignation(sanghCode, designation, exceptId);
    if (clash) {
      return t('"{designation}" already has a role profile in that sangh — {status}, written by {name}. A designation can only have one. Open that profile to revise it, or clone it onto a different designation.',
        { designation, status: t(roleProfile.STATUS_LABELS[clash.status] || clash.status), name: clash.created_by_name || clash.created_by });
    }

    sanghName = sanghCode;
    for (const s of await roleProfile.sanghsFor(actor.code, actor.name, reachOf(actor))) {
      if (s.sangh_code === sanghCode) { sanghName = s.sangh_name; break; }
    }
  }

  const attributes = collectAttributes(body);
  if (!attributes.length) return t('Add at least one skill.');

  const weightError = checkSkillWeights(attributes, t);
  if (weightError) return weightError;

  const outcomes = body.outcomes ? (Array.isArray(body.outcomes) ? body.outcomes : [body.outcomes]) : [];

  const program = await programFor(sanghCode, designation);
  if (program === roleProfile.PROGRAM.LDP) {
    const named = outcomes.map((o) => String(o ?? '').trim()).filter(Boolean);
    if (named.length < roleProfile.MIN_OUTCOMES_LDP) {
      return t('LDP role profiles need at least {min} key outcomes (up to {max}) — only {n} given.',
        { min: roleProfile.MIN_OUTCOMES_LDP, max: roleProfile.MAX_OUTCOMES_LDP, n: named.length });
    }
  }

  return {
    designation, sangh_code: sanghCode, sangh_name: sanghName,
    mission: String(body.mission || '').trim(),
    outcomes, attributes, program,
  };
}

/**
 * LDP or PSP. A designation an active LDP member holds is LDP; so is anything in an LDP
 * sangh (SS/SS1), which covers designations nobody holds there at the moment.
 */
async function programFor(sanghCode, designation, ldpSet = null) {
  const set = ldpSet || (await ldp.designationSet());
  return set.has(`${sanghCode}|${designation}`) || scope.excluded().includes(sanghCode)
    ? roleProfile.PROGRAM.LDP : roleProfile.PROGRAM.PSP;
}

/**
 * Can this person assign members? Only the admin does it — the PSP Approver for a PSP
 * profile, the LDP Admin for an LDP one — and only once the profile is approved.
 */
const canAssign = (profile, actor) =>
  roleProfile.isLive(profile) && roleProfile.isFinalApprover(profile, actor.isAdmin, actor.isLdpAdmin);

const gone = (req, res) => {
  req.session.flashError = req.t('That role profile no longer exists.');
  return res.redirect('/role-profiles');
};

/* ----------------------------------------------------------------- pages */

router.get('/', async (req, res) => {
  const actor = me(req);
  const profiles = await roleProfile.visibleTo(actor.code, actor.isAdmin, actor.isLdpAdmin);

  // The list is read a year at a time: which version applies, and whether that year's
  // review is still outstanding.
  const years = await financialYear.years();
  const asked = String(req.query.fy || '').trim();
  const chosen = asked && years.some((y) => y.year === asked) ? asked : await financialYear.current();
  const state = await version.reviewStateFor(profiles.map((p) => p.id), chosen);
  const fyOpen = await financialYear.isOpen(chosen);
  const assignedNames = await roleProfile.assignedNames(profiles);

  for (const p of profiles) {
    const info = state.get(Number(p.id)) || {};
    p.assigned_names = assignedNames.get(Number(p.id)) || [];
    p.fy_review = info.review || null;
    p.fy_version = info.version_no || null;
    p.fy_would_use = info.would_use || null;
    p.fy_assessments = info.assessments || 0;
    p.fy_born_in = info.born_in || null;
    // A review is only outstanding for an approved profile, in a year that is still open,
    // and not for a year before the profile had its first version.
    p.fy_due = p.status === S.APPROVED && !info.review && !!info.would_use
      && fyOpen && (!info.born_in || chosen >= info.born_in);
    p.fy_can_review = p.fy_due && (p.created_by === actor.code || actor.isAdmin);
    p.fy_predates = !!info.born_in && chosen < info.born_in;
    // Drafts, rejections and anything still awaiting approval at a stage this person may edit.
    p.can_edit = p.status !== S.APPROVED && roleProfile.canEdit(p, actor.code, actor.isAdmin, actor.isLdpAdmin);
    // An approved profile can be updated by its creator at any time in the year.
    p.can_update = p.status === S.APPROVED && roleProfile.canEdit(p, actor.code, actor.isAdmin, actor.isLdpAdmin);
    p.is_live = roleProfile.isLive(p);
  }

  await res.page('role_profiles/list', {
    profiles,
    awaiting: await roleProfile.awaiting(actor.code, actor.isAdmin, actor.isLdpAdmin),
    canCreate: await canCreate(req),
    years, chosen, fyOpen,
    dueCount: profiles.filter((p) => p.fy_due).length,
    outcomeLabels: version.OUTCOME_LABELS,
    statusLabels: roleProfile.STATUS_LABELS,
    S,
    title: req.t('Role Profiles — Pakka Role Profile'),
    pageTitle: req.t('Role Profiles'),
    activeNav: 'role-profiles',
  });
});

async function formData(req, profile = null) {
  const actor = me(req);
  const designations = await roleProfile.designationChoices(actor.code, actor.name, '', reachOf(actor));
  // A designation that already carries a profile is shown but cannot be picked again —
  // two profiles for one designation would leave nobody able to say which one applies.
  const taken = await roleProfile.takenDesignations(profile ? profile.id : null);
  const ldpDesignations = await ldp.designationSet();

  const bySangh = {};
  let takenCount = 0;
  for (const row of designations) {
    const has = taken.get(`${row.sangh_code}|${row.designation}`) || null;
    if (has) takenCount++;
    (bySangh[row.sangh_code] = bySangh[row.sangh_code] || []).push({
      designation: row.designation,
      program: await programFor(row.sangh_code, row.designation, ldpDesignations),
      taken: has ? { id: has.id, status: has.status, by: has.created_by_name || has.created_by,
        label: req.t(roleProfile.statusLabel({ ...has, sangh_code: row.sangh_code })) } : null,
    });
  }
  const freeCount = designations.length - takenCount;
  // Profiles this person could start a new one from, newest first.
  const clonable = (await roleProfile.visibleTo(actor.code, actor.isAdmin, actor.isLdpAdmin))
    .filter((row) => !profile || Number(row.id) !== Number(profile.id))
    .map((row) => ({
      id: row.id,
      designation: row.designation_name,
      sangh: row.sangh_name || row.sangh_code,
      status: row.status,
      label: roleProfile.statusLabel(row),
      by: row.created_by_name || row.created_by,
    }));

  // Already tagged PSP / LDP; the PSP Approver and LDP Admin get the sanghs they oversee.
  const sanghs = await roleProfile.sanghsFor(actor.code, actor.name, reachOf(actor));

  return {
    profile,
    clonable,
    sanghs,
    bySangh,
    approver: await approverFor(actor.code),
    // An LDP-sangh member's RP Approver only sees their LDP profiles; PSP ones skip to the PSP Approver.
    approverLdpOnly: !!(await approverFor(actor.code, roleProfile.PROGRAM.PSP)).ldpOnly,
    maxOutcomes: roleProfile.MAX_OUTCOMES,
    minOutcomesLdp: roleProfile.MIN_OUTCOMES_LDP,
    maxOutcomesLdp: roleProfile.MAX_OUTCOMES_LDP,
    maxAttributes: roleProfile.MAX_ATTRIBUTES,
    maxSkills: roleProfile.MAX_SKILLS_PER_ATTR,
    totalWeight: roleProfile.TOTAL_WEIGHT,
    statusLabels: roleProfile.STATUS_LABELS,
    designationsEmpty: sanghs.length === 0,
    takenCount,
    freeCount,
    // Set by the variants of this form that need them.
    cloneFrom: null, imported: null, prefill: null,
    revision: false, inForce: null, fyNow: null, pendingEdit: null,
  };
}

/**
 * Arriving from Zoho Recruit with a sangh and designation already known: preselect them so
 * the creator starts on the right role rather than hunting for it. The designation is
 * resolved against the member data, so a typed name is either matched or flagged.
 */
async function prefillFrom(req) {
  const designation = String(req.query.designation || '').replace(/\s+/g, ' ').trim();
  const sangh = String(req.query.sangh || '').replace(/\s+/g, ' ').trim();
  if (!designation && !sangh) return null;

  const known = await roleProfile.designationExists(sangh, designation);
  return {
    designation: known ? known.designation : designation,
    sangh_code: known ? known.sangh_code : sangh,
    sangh_name: known ? known.sangh_name : '',
    recognised: !!known,
    from_mrf: String(req.query.mrf || '').trim(),
  };
}

router.get('/create', async (req, res) => {
  const data = await formData(req);
  if (data.designationsEmpty) {
    req.session.flashError = req.t('No members are assigned to you yet, so there are no designations to write a profile for.');
    return res.redirect('/role-profiles');
  }
  await res.page('role_profiles/form', {
    ...data,
    prefill: await prefillFrom(req),
    title: req.t('Create Role Profile — Pakka Role Profile'),
    pageTitle: req.t('Create Role Profile'),
    activeNav: 'role-profiles',
  });
});

router.post('/store', async (req, res) => {
  const actor = me(req);
  const isDraft = req.body.action === 'draft';

  const parsed = await validateSubmission(req.body, actor, null, null, req.t);
  if (typeof parsed === 'string') {
    req.session.flashError = parsed;
    return res.redirect('/role-profiles/create');
  }

  const approver = await approverFor(actor.code, parsed.program);
  const header = {
    designation_name: parsed.designation,
    designation_id: await designationId(parsed.designation),
    sangh_code: parsed.sangh_code,
    sangh_name: parsed.sangh_name,
    mission: parsed.mission,
    program: parsed.program,
    status: isDraft ? S.DRAFT : (approver.code !== '' ? S.PENDING_SEVAK : S.PENDING_ADMIN),
    created_by: actor.code,
    created_by_name: actor.name,
    rp_approver_code: approver.code,
    rp_approver_name: approver.name,
  };

  const id = await roleProfile.createProfile(header, parsed.outcomes, parsed.attributes);

  await history.log(id, history.ACTION.CREATED, actor);
  if (isDraft) {
    await history.log(id, history.ACTION.DRAFT_SAVED, actor);
  } else {
    await history.log(id, history.ACTION.SUBMITTED, actor, routeNote(approver, header));
    await notifyPending(header, id, approver, actor);
  }

  req.session.flashSuccess = isDraft
    ? req.t('Saved as a draft. Submit it for approval when you are ready.')
    : submittedMessage(approver, header, req.t);
  res.redirect(`/role-profiles/${id}`);
});

/** Why someone may not edit, worded for where the profile stands. */
function cannotEditMessage(profile, t) {
  if (profile.status === S.PENDING_SEVAK) {
    return t('Only the author or the RP Approver can edit this role profile while it awaits the RP Approver.');
  }
  if (profile.status === S.PENDING_ADMIN) {
    const final = t(roleProfile.finalApprover(profile).label);
    return roleProfile.skippedRpApprover(profile)
      ? t('Only the author or the {approver} can edit this role profile while it awaits the {approver}.', { approver: final })
      : t('The RP Approver has approved this role profile, so only the {approver} can edit it now.', { approver: final });
  }
  return t('Only the author can edit this role profile.');
}

/** The approval stage a pending edit belongs to, for the form and the messages. */
function pendingStage(profile) {
  return profile.status === S.PENDING_SEVAK
    ? { label: 'the RP Approver', who: profile.rp_approver_name || 'the RP Approver' }
    : { label: `the ${roleProfile.finalApprover(profile).label}`, who: `the ${roleProfile.finalApprover(profile).label}` };
}

router.get('/:id(\\d+)/edit', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.fullProfile(id);
  if (!profile) return gone(req, res);
  if (!roleProfile.canEdit(profile, actor.code, actor.isAdmin, actor.isLdpAdmin)) {
    req.session.flashError = cannotEditMessage(profile, req.t);
    return res.redirect(`/role-profiles/${id}`);
  }

  const revision = roleProfile.isRevision(profile);
  const pending = roleProfile.isPendingEdit(profile);
  const data = await formData(req, profile);

  // Waiting for approval, only the content may change — mission, outcomes, skills,
  // attributes and their weights. The sangh and designation are fixed for everyone.
  // So are they when the final approver updates someone else's approved profile: the
  // designation and sangh belong to the author.
  const onBehalf = revision && !pending && profile.created_by !== actor.code;
  const lockedFields = pending || onBehalf;
  if (lockedFields) {
    const designation = String(profile.designation_name || '').trim();
    data.sanghs = [{
      program: roleProfile.sanghProgram(profile.sangh_code),
      sangh_code: profile.sangh_code,
      sangh_name: profile.sangh_name,
      members: (await roleProfile.membersWithDesignation(designation, profile.sangh_code)).length,
    }];
    data.bySangh = {
      [profile.sangh_code]: [{ designation, program: await programFor(profile.sangh_code, designation), taken: null }],
    };
    data.takenCount = 0;
  }

  await res.page('role_profiles/form', {
    ...data,
    revision,
    inForce: revision ? await version.latestFor(id) : null,
    fyNow: await financialYear.current(),
    pendingEdit: pending ? { ...pendingStage(profile), lockedFields } : null,
    onBehalfOf: onBehalf ? (profile.created_by_name || profile.created_by) : null,
    title: req.t(pending ? 'Edit Role Profile — Pakka Role Profile'
      : (revision ? 'Update Role Profile — Pakka Role Profile' : 'Edit Draft — Pakka Role Profile')),
    pageTitle: req.t(pending ? 'Edit Role Profile' : (revision ? 'Update Role Profile' : 'Edit Draft')),
    activeNav: 'role-profiles',
  });
});

/**
 * Save an edit made while the profile waits for approval. It keeps its place: the status,
 * the RP Approver on record and the approvals already given are not touched, and the
 * others at that stage are told it changed.
 */
async function updatePending(req, res, profile, actor) {
  const id = Number(profile.id);
  const isAuthor = profile.created_by === actor.code;
  const parsed = await validateSubmission(req.body, actor, id, profile, req.t);
  if (typeof parsed === 'string') {
    req.session.flashError = parsed;
    return res.redirect(`/role-profiles/${id}/edit`);
  }

  await roleProfile.updateProfile(id, {
    designation_name: parsed.designation,
    designation_id: await designationId(parsed.designation),
    sangh_code: parsed.sangh_code,
    sangh_name: parsed.sangh_name,
    mission: parsed.mission,
    program: parsed.program,
    updated_at: roleProfile.nowStamp(),
  }, parsed.outcomes, parsed.attributes);

  const stage = pendingStage(profile);
  const role = isAuthor ? 'author'
    : (profile.status === S.PENDING_SEVAK ? 'RP Approver' : roleProfile.finalApprover(profile).label);
  await history.log(id, history.ACTION.EDITED, actor,
    `Edited by the ${role} while awaiting ${stage.label} — it stays with ${stage.who}`);

  // Everyone else involved so far hears about it; nobody is told about their own edit.
  const tell = [profile.created_by];
  if (profile.status === S.PENDING_SEVAK && profile.rp_approver_code) tell.push(profile.rp_approver_code);
  if (profile.status === S.PENDING_ADMIN && profile.rp_approver_action_by) tell.push(profile.rp_approver_action_by);
  // The final approver hears when someone else changes what is waiting on them.
  if (profile.status === S.PENDING_ADMIN) tell.push(...roleProfile.finalApprover(profile).codes);
  const what = `${parsed.designation} (${parsed.sangh_name})`;
  await notification.notify(tell, notification.TYPE.INFO,
    'A role profile awaiting approval was edited',
    `${actor.name} edited "${what}". It is still awaiting ${stage.label}.`,
    `role-profiles/${id}`, id, actor.code);

  req.session.flashSuccess = req.t('Changes saved. It is still awaiting {who}.', { who: req.t(stage.label) });
  return res.redirect(`/role-profiles/${id}`);
}

router.post('/:id(\\d+)/update', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile) return gone(req, res);
  if (!roleProfile.canEdit(profile, actor.code, actor.isAdmin, actor.isLdpAdmin)) {
    req.session.flashError = cannotEditMessage(profile, req.t);
    return res.redirect(`/role-profiles/${id}`);
  }
  if (roleProfile.isPendingEdit(profile)) return updatePending(req, res, profile, actor);

  // Revising something already approved: the frozen version stays in force for the years
  // that point at it, and a new one is only cut when this revision is approved.
  const revision = roleProfile.isRevision(profile);
  const isDraft = req.body.action === 'draft' && !revision;
  // The final approver updating someone else's approved profile: the sangh and designation
  // stay the author's, and the update goes through the author's own approval chain.
  const onBehalf = revision && profile.created_by !== actor.code;
  const parsed = await validateSubmission(req.body, actor, id, onBehalf ? profile : null, req.t);
  if (typeof parsed === 'string') {
    req.session.flashError = parsed;
    return res.redirect(`/role-profiles/${id}/edit`);
  }

  const approver = await approverFor(onBehalf ? profile.created_by : actor.code, parsed.program);
  const wasRejected = profile.status === S.REJECTED;

  const header = {
    designation_name: parsed.designation,
    designation_id: await designationId(parsed.designation),
    sangh_code: parsed.sangh_code,
    sangh_name: parsed.sangh_name,
    mission: parsed.mission,
    program: parsed.program,
    status: isDraft ? S.DRAFT : (approver.code !== '' ? S.PENDING_SEVAK : S.PENDING_ADMIN),
    rp_approver_code: approver.code,
    rp_approver_name: approver.name,
    updated_at: roleProfile.nowStamp(),
  };

  // Resubmitting clears the previous rejection; the history keeps it.
  if (wasRejected && !isDraft) {
    header.rejected_by = '';
    header.rejected_at = null;
    header.reject_reason = '';
  }

  await roleProfile.updateProfile(id, header, parsed.outcomes, parsed.attributes);
  const inForce = revision ? await version.latestFor(id) : null;
  await history.log(id, history.ACTION.EDITED, actor,
    (onBehalf ? `Updated by the ${roleProfile.finalApprover(profile).label} for ${profile.created_by_name || profile.created_by}. ` : '')
    + (revision && inForce ? `Revised — version ${inForce.version_no} stays in force until this is approved` : ''));

  if (isDraft) {
    await history.log(id, history.ACTION.DRAFT_SAVED, actor);
    req.session.flashSuccess = req.t('Draft saved.');
  } else {
    await history.log(id, wasRejected ? history.ACTION.RESUBMITTED : history.ACTION.SUBMITTED, actor, routeNote(approver, header));
    await notifyPending(header, id, approver, actor);
    if (onBehalf) {
      await notification.notify([profile.created_by], notification.TYPE.INFO,
        'Your role profile was updated',
        `${actor.name} updated "${parsed.designation} (${parsed.sangh_name})". The update goes for approval as the next version.`,
        `role-profiles/${id}`, id, actor.code);
    }
    const sent = onBehalf
      ? (approver.code !== ''
        ? req.t('Update submitted for {author}. It goes to {name} for approval.', { author: profile.created_by_name || profile.created_by, name: approver.name })
        : req.t('Update submitted for {author}. It goes straight to {approver} approval.', { author: profile.created_by_name || profile.created_by, approver: req.t(roleProfile.finalApprover(header).label) }))
      : submittedMessage(approver, header, req.t);
    req.session.flashSuccess = revision && inForce
      ? `${sent} ${req.t('Version {v} stays in force meanwhile, so assessments already written are untouched.', { v: inForce.version_no })}`
      : sent;
  }
  res.redirect(`/role-profiles/${id}`);
});

router.post('/:id(\\d+)/submit', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile) { req.session.flashError = req.t('That role profile no longer exists.'); return res.redirect('/role-profiles'); }
  if (!roleProfile.canSubmit(profile, actor.code)) {
    req.session.flashError = req.t('Only your own drafts can be submitted.');
    return res.redirect(`/role-profiles/${id}`);
  }

  const approver = await approverFor(actor.code, profile.program);
  await db.run(
    `UPDATE rp_role_profiles
     SET status = ?, rp_approver_code = ?, rp_approver_name = ?,
         rejected_by = '', rejected_at = NULL, reject_reason = '', updated_at = ?
     WHERE id = ?`,
    [approver.code !== '' ? S.PENDING_SEVAK : S.PENDING_ADMIN, approver.code, approver.name,
     roleProfile.nowStamp(), id]
  );

  await history.log(id, profile.status === S.REJECTED ? history.ACTION.RESUBMITTED : history.ACTION.SUBMITTED,
    actor, routeNote(approver, profile));
  await notifyPending(profile, id, approver, actor);

  req.session.flashSuccess = submittedMessage(approver, profile, req.t);
  res.redirect(`/role-profiles/${id}`);
});

router.post('/:id(\\d+)/decide', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile) { req.session.flashError = req.t('That role profile no longer exists.'); return res.redirect('/role-profiles'); }

  if (!roleProfile.canActOn(profile, actor.code, actor.isAdmin, actor.isLdpAdmin)) {
    req.session.flashError = req.t('This profile is not waiting on you.');
    return res.redirect(`/role-profiles/${id}`);
  }

  const action = String(req.body.action || '');
  const now = roleProfile.nowStamp();
  const what = `${profile.designation_name} (${profile.sangh_name})`;

  if (action === 'reject') {
    const reason = String(req.body.reject_reason || '').trim();
    await db.run(
      `UPDATE rp_role_profiles SET status = ?, rejected_by = ?, rejected_at = ?, reject_reason = ?, updated_at = ? WHERE id = ?`,
      [S.REJECTED, actor.code, now, reason, now, id]
    );
    await history.log(id, history.ACTION.REJECTED, actor, reason);
    await notification.notify([profile.created_by], notification.TYPE.REJECTED,
      'Your role profile was rejected',
      `"${what}" was rejected by ${actor.name}.${reason ? ' Reason: ' + reason : ''}`,
      `role-profiles/${id}`, id, actor.code);

    req.session.flashSuccess = req.t('Role profile rejected.');
    return res.redirect(`/role-profiles/${id}`);
  }

  if (action !== 'approve') {
    req.session.flashError = req.t('Unknown action.');
    return res.redirect(`/role-profiles/${id}`);
  }

  if (profile.status === S.PENDING_SEVAK) {
    await db.run(
      'UPDATE rp_role_profiles SET status = ?, rp_approver_action_by = ?, rp_approver_action_at = ?, updated_at = ? WHERE id = ?',
      [S.PENDING_ADMIN, actor.code, now, now, id]
    );
    const final = roleProfile.finalApprover(profile);
    await history.log(id, history.ACTION.SEVAK_APPROVED, actor, `Passed to the ${final.label}`);
    await notification.notify(final.codes, notification.TYPE.PENDING,
      `Role profile needs ${final.label} approval`,
      `"${what}" was approved by ${actor.name} and now needs your approval.`,
      `role-profiles/${id}`, id, actor.code);
    await notification.notify([profile.created_by], notification.TYPE.INFO,
      'Your role profile passed RP Approver approval',
      `"${what}" was approved by ${actor.name} and is now with the ${final.label}.`,
      `role-profiles/${id}`, id, actor.code);

    req.session.flashSuccess = req.t('Approved and passed to the {approver}.', { approver: req.t(final.label) });
    return res.redirect(`/role-profiles/${id}`);
  }

  await db.run(
    'UPDATE rp_role_profiles SET status = ?, admin_action_by = ?, admin_action_at = ?, updated_at = ? WHERE id = ?',
    [S.APPROVED, actor.code, now, now, id]
  );

  // Approval is what makes a version: freeze the wording so assessments written from
  // here on are tied to exactly this text, whatever happens to the profile later.
  const fresh = await roleProfile.find(id);
  const fy = await financialYear.current();
  const previous = await version.latestFor(id);
  const frozen = await version.freeze(fresh, {
    effectiveYear: fy,
    reason: previous ? `Approved by ${actor.name}` : 'First approved version',
    outcome: previous ? version.OUTCOME.UPDATED : version.OUTCOME.CREATED,
    actor,
  });

  const assigned = await notifyApproved(profile, id, actor);
  const count = assigned.length;
  const final = roleProfile.finalApprover(profile).label;
  await history.log(id, history.ACTION.ADMIN_APPROVED, actor, count
    ? `Version ${frozen.version_no} in force for ${fy} — applies to the ${count} assigned member${count === 1 ? '' : 's'}`
    : `Version ${frozen.version_no} in force for ${fy} — no members assigned yet`);

  req.session.flashSuccess = count
    ? req.t.n('Approved as version {v}, in force for {fy}. It applies to the {n} member already assigned to it.',
      'Approved as version {v}, in force for {fy}. It applies to the {n} members already assigned to it.', count, { v: frozen.version_no, fy })
    : req.t('Approved as version {v}, in force for {fy}. It applies to nobody yet — the {approver} assigns members from the Members tab.',
      { v: frozen.version_no, fy, approver: req.t(final) });
  res.redirect(`/role-profiles/${id}`);
});

/* ------------------------------------------------------ member assignment */

router.post('/:id(\\d+)/assign-members', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile || !canAssign(profile, actor)) {
    req.session.flashError = req.t('Only an approved profile can be assigned, and only by the PSP Approver (the LDP Admin for an LDP profile).');
    return res.redirect(`/role-profiles/${id}`);
  }

  const raw = req.body['emp_codes'] || req.body['emp_codes[]'] || [];
  const codes = (Array.isArray(raw) ? raw : [raw]).map(String);
  const added = await roleProfile.assignMembers(id, codes, actor);

  if (!added.length) {
    req.session.flashError = req.t('Select at least one member to assign.');
    return res.redirect(`/role-profiles/${id}`);
  }

  const who = added.map((m) => `${m.name} (${m.emp_code})`).join(', ');
  await history.log(id, history.ACTION.ASSIGNED, actor, `Assigned to ${who}`);
  const what = `${profile.designation_name} (${profile.sangh_name})`;
  await notification.notify(added.map((m) => m.emp_code), notification.TYPE.APPROVED,
    'A role profile was assigned to you',
    `"${what}" now applies to you.`,
    `role-profiles/${id}`, id, actor.code);
  // Their RP Creator, RP Approver and Pracharak — the creator assesses them against it.
  await notification.notify([...await leadersOf(added.map((m) => m.emp_code)), profile.created_by],
    notification.TYPE.INFO,
    'Members assigned to a role profile',
    `${actor.name} assigned "${what}" to ${nameList(added)}.`,
    `role-profiles/${id}`, id, actor.code);

  req.session.flashSuccess = req.t.n('{n} member assigned to this role profile.', '{n} members assigned to this role profile.', added.length);
  res.redirect(`/role-profiles/${id}`);
});

router.post('/:id(\\d+)/unassign-member', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile || !canAssign(profile, actor)) {
    req.session.flashError = req.t('Only the PSP Approver (the LDP Admin for an LDP profile) assigns and removes members.');
    return res.redirect(`/role-profiles/${id}`);
  }

  const code = String(req.body.emp_code || '').trim();
  // Read the name before the row goes, so the history can name them.
  const name = code ? await roleProfile.assignedMemberName(id, code) : '';

  if (!code || !(await roleProfile.unassignMember(id, code))) {
    req.session.flashError = req.t('That member is not assigned to this role profile.');
    return res.redirect(`/role-profiles/${id}`);
  }

  await history.log(id, history.ACTION.UNASSIGNED, actor, `Removed ${name ? `${name} (${code})` : code}`);
  req.session.flashSuccess = req.t('Member removed from this role profile.');
  res.redirect(`/role-profiles/${id}`);
});

/* ------------------------------------------------------- new designations */

/**
 * Create a designation in one of the sanghs this person leads, from the Create form, for a
 * role nobody has held there yet. Answers JSON so the form can select it straight away.
 * If the sangh already has it (any capitalisation), that one is returned instead.
 */
router.post('/designations', async (req, res) => {
  const result = await roleProfile.addDesignation(me(req),
    String(req.body.sangh_code || '').trim(), req.body.designation_name);
  if (!result.ok) return res.status(422).json({ ok: false, message: said(req, result) });

  return res.json({
    ok: true, created: result.created, sangh_code: result.sangh.sangh_code,
    designation: result.designation, program: await programFor(result.sangh.sangh_code, result.designation),
    message: said(req, result),
  });
});

/* ----------------------------------------------------------------- import */

// Held in memory only: the sheet is read, turned into form values, and dropped.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.xlsx$/i.test(file.originalname);
    cb(ok ? null : new Error('Only .xlsx files can be read.'), ok);
  },
});

/**
 * Read a role profile out of a spreadsheet and hand it back as a filled-in form. Nothing
 * is saved here — the creator picks the designation, checks what came across, and submits
 * it the usual way.
 */
router.post('/import', (req, res) => {
  upload.single('sheet')(req, res, async (uploadError) => {
    const back = '/role-profiles/create';
    if (uploadError) {
      req.session.flashError = uploadError.code === 'LIMIT_FILE_SIZE'
        ? req.t('That file is larger than 3 MB.')
        : req.t(uploadError.message);
      return res.redirect(back);
    }
    // The token travelled inside the multipart body, so it can only be checked now.
    if (!mw.verifyToken(req)) {
      res.status(403);
      return res.send(req.t('The action you requested is not allowed. (CSRF)'));
    }
    if (!req.file) {
      req.session.flashError = req.t('Choose an .xlsx file to read.');
      return res.redirect(back);
    }
    if (!(await canCreate(req))) {
      req.session.flashError = req.t('Only someone with members can write a role profile.');
      return res.redirect('/role-profiles');
    }

    const parsed = await importer.parse(req.file.buffer, { sheet: String(req.body.sheet || '').trim(), t: req.t });
    if (parsed.error) {
      req.session.flashError = parsed.error;
      return res.redirect(back);
    }

    // Shaped like a profile so the form seeds itself the same way a clone does.
    const draft = {
      id: null,
      // Chosen at the top of the Create form before the sheet was read.
      designation_name: String(req.body.designation_name || '').trim(),
      sangh_code: String(req.body.sangh_code || ''),
      mission: parsed.mission,
      outcomes: parsed.outcomes,
      attributes: parsed.attributes.map((a, i) => ({
        attribute_no: i + 1,
        attribute: a.attribute,
        assessment: a.assessment || '',
        attribute_weight: a.weight === null ? '' : a.weight,
        skills: a.skills.map((sk) => ({
          tech_skill: sk.skill,
          tech_weight: sk.weight === null ? '' : sk.weight,
          outcome_links: sk.outcomes || '',
        })),
      })),
    };

    const data = await formData(req, null);
    await res.page('role_profiles/form', {
      ...data,
      profile: draft,
      imported: {
        file: req.file.originalname,
        sheet: parsed.sheet,
        sheets: parsed.sheets || [],
        designation: parsed.designation,
        attributes: parsed.attributes.length,
        skills: parsed.skillCount,
        outcomes: parsed.outcomes.length,
        warnings: parsed.warnings,
      },
      title: req.t('Import Role Profile — Pakka Role Profile'),
      pageTitle: req.t('Import from Excel'),
      activeNav: 'role-profiles',
    });
  });
});

/** A filled-in example of the Excel format, to start a sheet from. */
router.get('/import/sample', async (req, res) => {
  const buffer = await sampleSheet.build();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="Role profile - sample.xlsx"');
  res.send(Buffer.from(buffer));
});

/* ------------------------------------------------------------------ clone */

/**
 * Start a new role profile from an existing one. The wording, outcomes, attributes and
 * weights come across; the designation does not, because the whole point is to put the
 * same shape of role onto a different one — and it must be a designation still free.
 */
router.get('/:id(\\d+)/clone', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const source = await roleProfile.fullProfile(id);
  if (!source) { req.session.flashError = req.t('That role profile no longer exists.'); return res.redirect('/role-profiles'); }

  if (!(await roleProfile.canView(source, actor.code, actor.isAdmin, actor.isLdpAdmin))) {
    req.session.flashError = req.t('That role profile is not yours to copy.');
    return res.redirect('/role-profiles');
  }
  if (!(await canCreate(req))) {
    req.session.flashError = req.t('Only someone with members can write a role profile.');
    return res.redirect('/role-profiles');
  }

  // Hand the form the source's content under a blank designation.
  const draft = {
    ...source,
    id: null,
    // The designation chosen at the top of the Create form, if any; never the source's own.
    designation_name: String(req.query.designation || '').trim(),
    sangh_code: String(req.query.sangh || source.sangh_code || ''),
  };

  const data = await formData(req, null);
  await res.page('role_profiles/form', {
    ...data,
    profile: draft,
    cloneFrom: { id: source.id, designation: source.designation_name, sangh: source.sangh_name },
    title: req.t('Clone Role Profile — Pakka Role Profile'),
    pageTitle: req.t('Clone Role Profile'),
    activeNav: 'role-profiles',
  });
});

/* ----------------------------------------------------------- yearly review */

/**
 * Each financial year the RP Creator confirms the profile still stands. Saying it is
 * unchanged carries the current version into the new year; changing it means editing the
 * profile, which goes through approval again and produces a new version.
 */
router.post('/:id(\\d+)/review', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile) { req.session.flashError = req.t('That role profile no longer exists.'); return res.redirect('/role-profiles'); }

  const mayReview = profile.created_by === actor.code || actor.isAdmin;
  if (!mayReview) {
    req.session.flashError = req.t('Only the RP Creator or the PSP Approver can record a review.');
    return res.redirect(`/role-profiles/${id}`);
  }
  if (profile.status !== S.APPROVED) {
    req.session.flashError = req.t('Only an approved role profile can be reviewed.');
    return res.redirect(`/role-profiles/${id}`);
  }

  // Normally this year, but a year that was missed can still be settled while it is open.
  const asked = String(req.body.financial_year || '').trim();
  const fy = asked && (await financialYear.isValid(asked)) ? asked : await financialYear.current();
  if (!(await financialYear.isOpen(fy))) {
    req.session.flashError = req.t('{fy} is closed — only {current} and {previous} can be reviewed.',
      { fy, current: await financialYear.current(), previous: await financialYear.previous() });
    return res.redirect(`/role-profiles/${id}?tab=versions`);
  }

  const note = String(req.body.note || '').trim();
  const result = await version.carryForward(id, fy, actor, note);
  if (!result.ok) {
    req.session.flashError = said(req, result);
    return res.redirect(`/role-profiles/${id}?tab=versions`);
  }

  await history.log(id, history.ACTION.REVIEWED, actor,
    `${fy} reviewed — no change; version ${result.version.version_no} carries forward${note ? `. ${note}` : ''}`);

  req.session.flashSuccess = req.t('{fy} reviewed. Version {v} stands for this year, so assessments run against it.', { fy, v: result.version.version_no });
  res.redirect(`/role-profiles/${id}?tab=versions`);
});

/* ------------------------------------------------------------- a version */

/** One frozen version, read-only, exactly as it was approved. */
router.get('/:id(\\d+)/versions/:versionId(\\d+)', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile) { req.session.flashError = req.t('That role profile no longer exists.'); return res.redirect('/role-profiles'); }
  if (!(await roleProfile.canView(profile, actor.code, actor.isAdmin, actor.isLdpAdmin))) {
    req.session.flashError = req.t('That role profile is not yours to view.');
    return res.redirect('/role-profiles');
  }

  const v = await version.find(Number(req.params.versionId));
  if (!v || Number(v.role_profile_id) !== id) {
    req.session.flashError = req.t('That version does not belong to this role profile.');
    return res.redirect(`/role-profiles/${id}?tab=versions`);
  }

  const all = await version.listFor(id);
  const mine = all.find((x) => Number(x.id) === Number(v.id));
  const older = all.find((x) => Number(x.version_no) === Number(v.version_no) - 1);

  let changes = null;
  if (older) {
    changes = version.diff(older, v,
      await version.detailsFor(older.id), await version.detailsFor(v.id),
      await version.outcomesFor(older.id), await version.outcomesFor(v.id), req.t);
  }

  await res.page('role_profiles/version', {
    profile, version: v,
    years: mine ? mine.years : [],
    assessmentCount: mine ? mine.assessment_count : 0,
    outcomes: await version.outcomesFor(v.id),
    details: await version.detailsFor(v.id),
    outcomeLabels: version.OUTCOME_LABELS,
    changes,
    isLatest: all.length > 0 && Number(all[0].id) === Number(v.id),
    title: req.t('Version {v} — {designation}', { v: v.version_no, designation: v.designation_name }),
    pageTitle: req.t('{designation} · Version {v}', { v: v.version_no, designation: v.designation_name }),
    activeNav: 'role-profiles',
  });
});

/** A frozen version as a PDF, in the wording of the day. */
router.get('/:id(\\d+)/versions/:versionId(\\d+)/pdf', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile) { req.session.flashError = req.t('That role profile no longer exists.'); return res.redirect('/role-profiles'); }
  if (!(await roleProfile.canView(profile, actor.code, actor.isAdmin, actor.isLdpAdmin))) {
    req.session.flashError = req.t('That role profile is not yours to view.');
    return res.redirect('/role-profiles');
  }

  const v = await version.find(Number(req.params.versionId));
  if (!v || Number(v.role_profile_id) !== id) {
    req.session.flashError = req.t('That version does not belong to this role profile.');
    return res.redirect(`/role-profiles/${id}?tab=versions`);
  }

  const name = `Role Profile v${v.version_no} - ${v.designation_name}`.replace(/[^\w \-]/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
  pdf.roleProfile({
    profile: { ...v, id },
    outcomes: await version.outcomesFor(v.id),
    details: await version.detailsFor(v.id),
    versionLabel: `Version ${v.version_no}`,
  }).pipe(res);
});

/* ------------------------------------------------------------------ view */

/**
 * The role profile as a sheet — the same layout as the PDF (mission, key outcomes, then
 * SN / Skill / Attributes / Weightage / Sub-Weightage) — in any stage, for anyone who may
 * see it. The admin may open every profile of their programme, drafts included.
 */
router.get('/:id(\\d+)/view', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.fullProfile(id);
  if (!profile) return gone(req, res);
  if (!(await roleProfile.canView(profile, actor.code, actor.isAdmin, actor.isLdpAdmin))) {
    req.session.flashError = req.t('That role profile is not yours to view.');
    return res.redirect('/role-profiles');
  }
  const versions = await version.listFor(id);
  const attributes = profile.attributes || [];
  await res.page('role_profiles/sheet', {
    profile,
    attributes,
    totalWeight: attributes.reduce((t, a) => t + Number(a.attribute_weight || 0), 0),
    subTotal: attributes.reduce((t, a) => t + a.skills.reduce((u, k) => u + Number(k.tech_weight || 0), 0), 0),
    hasMechanism: attributes.some((a) => String(a.assessment || '').trim() !== ''),
    inForce: versions.length ? versions[0] : null,
    pendingUpdate: roleProfile.hasPendingUpdate(profile),
    statusText: req.t(roleProfile.statusLabel(profile)),
    finalBy: req.t(roleProfile.finalApprover(profile).label),
    S,
    title: req.t('{designation} — Role Profile', { designation: profile.designation_name }),
    pageTitle: req.t('Role Profile · {designation}', { designation: profile.designation_name }),
    activeNav: 'role-profiles',
  });
});

/* ------------------------------------------------------------------- pdf */

/** The approved role profile as a PDF, laid out like the master spreadsheet. */
router.get('/:id(\\d+)/pdf', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.find(id);
  if (!profile) { req.session.flashError = req.t('That role profile no longer exists.'); return res.redirect('/role-profiles'); }

  if (!(await roleProfile.canView(profile, actor.code, actor.isAdmin, actor.isLdpAdmin))) {
    req.session.flashError = req.t('That role profile is not yours to view.');
    return res.redirect('/role-profiles');
  }
  if (profile.status !== S.APPROVED) {
    req.session.flashError = req.t('Only an approved role profile can be downloaded.');
    return res.redirect(`/role-profiles/${id}`);
  }

  const outcomes = await db.query(
    'SELECT outcome FROM rp_role_key_outcomes WHERE role_profile_id = ? ORDER BY sort_order ASC', [id]);
  // No assessment id, so every rating comes back null and the score columns are left off.
  const details = await assessment.skillsFor(id, null);

  const name = `Role Profile - ${profile.designation_name}`.replace(/[^\w \-]/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
  pdf.roleProfile({ profile, outcomes, details }).pipe(res);
});

/* ------------------------------------------------------------------ show */

router.get('/:id(\\d+)', async (req, res) => {
  const actor = me(req);
  const id = Number(req.params.id);
  const profile = await roleProfile.fullProfile(id);
  if (!profile) { req.session.flashError = req.t('That role profile no longer exists.'); return res.redirect('/role-profiles'); }

  if (!(await roleProfile.canView(profile, actor.code, actor.isAdmin, actor.isLdpAdmin))) {
    req.session.flashError = req.t('That role profile is not yours to view.');
    return res.redirect('/role-profiles');
  }

  const approved = profile.status === S.APPROVED;
  // Live on its version in force — also while an update is going for approval.
  const live = roleProfile.isLive(profile);
  const fy = await financialYear.current();

  const assessments = {};
  if (live) {
    for (const a of await assessment.forProfile(id, fy)) assessments[a.emp_code] = a;
  }

  const fyNow = await financialYear.current();
  const fyPrev = await financialYear.previous();
  // Versions stay visible while a revision is pending — that is exactly when someone needs
  // to see which version is still in force.
  const versions = await version.listFor(id);

  // The year-by-year picture: every year that is open for entry, plus any earlier year
  // that already carries a review, newest first.
  const known = await financialYear.years();
  const reviewed = new Set((await version.reviewsFor(id)).map((r) => r.financial_year));
  // A profile cannot be reviewed for a year that predates its first approved version.
  const bornIn = versions.length ? versions[versions.length - 1].effective_from_year : fyNow;
  const yearRows = await version.yearOverview(id,
    known
      // A year already reviewed always shows; otherwise only open years, and never one
      // that predates the profile's first approved version.
      .filter((y) => reviewed.has(y.year)
        || ((y.year === fyNow || y.year === fyPrev) && y.year >= bornIn))
      .map((y) => ({ year: y.year, is_current: y.year === fyNow, open: y.year === fyNow || y.year === fyPrev }))
      .sort((a, b) => (a.year < b.year ? 1 : -1)));
  await res.page('role_profiles/show', {
    profile,
    versions,
    reviews: await version.reviewsFor(id),
    reviewDue: approved && versions.length > 0 && (await version.reviewDue(id, fyNow)),
    canReview: approved && (profile.created_by === actor.code || actor.isAdmin),
    inForce: versions.length ? versions[0] : null,
    canClone: await canCreate(req),
    yearRows,
    fyPrev,
    outcomeLabels: version.OUTCOME_LABELS,
    fyNow,
    members: live ? await roleProfile.effectiveMembers(profile) : [],
    assignable: canAssign(profile, actor) ? await roleProfile.assignableMembers(profile) : [],
    canAssign: canAssign(profile, actor),
    canAssess: profile.created_by === actor.code && live,
    live,
    pendingUpdate: roleProfile.hasPendingUpdate(profile),
    // The creator may update an approved profile at any time in the year.
    canUpdate: approved && roleProfile.canEdit(profile, actor.code, actor.isAdmin, actor.isLdpAdmin),
    assessments,
    canAct: roleProfile.canActOn(profile, actor.code, actor.isAdmin, actor.isLdpAdmin),
    canEdit: roleProfile.canEdit(profile, actor.code, actor.isAdmin, actor.isLdpAdmin),
    canEditHindi: canEditHindi(profile, actor),
    hindiStatus: canEditHindi(profile, actor) ? await translation.status(id) : null,
    history: await history.forProfile(id),
    historyMeta: history.META,
    statusLabels: roleProfile.STATUS_LABELS,
    S,
    tab: String(req.query.tab || ''),
    title: req.t('{designation} — Role Profile', { designation: profile.designation_name }),
    pageTitle: req.t('Role Profile · {designation}', { designation: profile.designation_name }),
    activeNav: 'role-profiles',
  });
});

/* ----------------------------------------------------------------- hindi */

/**
 * Who may correct the Hindi of a profile's content: its author, its RP Approver and its final
 * approver. The Hindi is a translation, not new content, so correcting it does not make a new
 * version or send anything for approval — at any stage.
 */
function canEditHindi(profile, actor) {
  return profile.created_by === actor.code
    || (!!profile.rp_approver_code && profile.rp_approver_code === actor.code)
    || roleProfile.isFinalApprover(profile, actor.isAdmin, actor.isLdpAdmin);
}

const KIND_LABELS = { mission: 'Mission', outcome: 'Key outcome', skill: 'Technical Skill', attribute: 'Attribute', mechanism: 'Assessment Mechanism' };

router.get('/:id(\\d+)/hindi', async (req, res) => {
  const actor = me(req);
  const profile = await roleProfile.find(Number(req.params.id));
  if (!profile) return gone(req, res);
  if (!canEditHindi(profile, actor)) {
    req.session.flashError = req.t('Only the author, the RP Approver or the final approver can edit the Hindi of this role profile.');
    return res.redirect(`/role-profiles/${profile.id}`);
  }
  const items = await translation.profileTexts(profile.id);
  const have = await translation.lookup(items.map((i) => i.text));
  await res.page('role_profiles/hindi', {
    profile,
    rows: items.map((i) => ({ ...i, key: translation.hashOf(i.text), label: KIND_LABELS[i.kind], hindi: have.get(i.text) || null })),
    autoOn: translate.enabled(),
    title: req.t('Hindi — {designation}', { designation: profile.designation_name }),
    pageTitle: req.t('Hindi · {designation}', { designation: profile.designation_name }),
    activeNav: 'role-profiles',
  });
});

router.post('/:id(\\d+)/hindi', async (req, res) => {
  const actor = me(req);
  const profile = await roleProfile.find(Number(req.params.id));
  if (!profile) return gone(req, res);
  if (!canEditHindi(profile, actor)) {
    req.session.flashError = req.t('Only the author, the RP Approver or the final approver can edit the Hindi of this role profile.');
    return res.redirect(`/role-profiles/${profile.id}`);
  }
  // Only the profile's own lines can be written here, whatever the form sends. Each field is
  // keyed by its English text, so a profile edited in the meantime cannot shift the Hindi.
  const items = await translation.profileTexts(profile.id);
  const have = await translation.lookup(items.map((i) => i.text));
  const sent = req.body.hindi || {};
  let saved = 0;
  for (const item of items) {
    const value = String(sent[translation.hashOf(item.text)] ?? '').trim();
    if (!value) continue;
    const current = have.get(item.text);
    // Saving the page confirms the Hindi as it stands, so an unchanged AI draft counts as checked.
    if (current && current.text === value && current.origin === 'edited') continue;
    if (await translation.save(item.text, value, 'edited', actor)) saved++;
  }
  req.session.flashSuccess = req.t.n('Hindi saved — {n} line updated.', 'Hindi saved — {n} lines updated.', saved);
  res.redirect(`/role-profiles/${profile.id}/hindi`);
});

router.post('/:id(\\d+)/hindi/translate', async (req, res) => {
  const actor = me(req);
  const profile = await roleProfile.find(Number(req.params.id));
  if (!profile) return gone(req, res);
  if (!canEditHindi(profile, actor) || !translate.enabled()) return res.redirect(`/role-profiles/${profile.id}/hindi`);
  const texts = (await translation.profileTexts(profile.id)).map((i) => i.text);
  const n = await translate.translateMissing(texts);
  req.session.flashSuccess = req.t.n('{n} line drafted in Hindi. Check it below and save.', '{n} lines drafted in Hindi. Check them below and save.', n);
  res.redirect(`/role-profiles/${profile.id}/hindi`);
});

module.exports = router;
