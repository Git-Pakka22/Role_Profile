'use strict';
const express = require('express');
const mw = require('../middleware');
const report = require('../models/report');
const roleProfile = require('../models/roleProfile');
const financialYear = require('../models/financialYear');

/**
 * Reports. The role profile report counts profiles by stage, with a sangh × stage table, a
 * PSP / LDP split and the full list, all filterable. Open to the PSP Approver, the LDP Admin
 * and anyone who leads members; each sees only the profiles they may already see.
 */
const router = express.Router();
router.use(mw.loggedIn);

const me = (req) => ({
  code: req.session.emp_code || '',
  name: req.session.emp_name || '',
  isAdmin: !!req.session.is_admin,
  isLdpAdmin: !!req.session.is_ldp_admin,
});

async function mayReport(req) {
  const actor = me(req);
  return actor.isAdmin || actor.isLdpAdmin || (await mw.leadsCount(req)) > 0;
}

router.get('/', (req, res) => res.redirect('/reports/role-profiles'));

router.get('/role-profiles', async (req, res) => {
  if (!(await mayReport(req))) {
    req.session.flashError = 'Reports are for RP Creators, RP Approvers, the PSP Approver and the LDP Admin.';
    return res.redirect('/role-profiles');
  }
  const actor = me(req);
  const fyNow = await financialYear.current();
  const data = await report.build(actor, req.query, fyNow);

  // A link to this report with some filters changed (empty value removes one).
  const link = (changes = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...data.filters, ...changes })) if (v) params.set(k, v);
    const qs = params.toString();
    return `/reports/role-profiles${qs ? `?${qs}` : ''}`;
  };

  await res.page('reports/role_profiles', {
    ...data,
    stages: report.STAGES,
    UPDATE_PENDING: report.UPDATE_PENDING,
    years: await financialYear.years(),
    fyNow,
    link,
    scopeNote: actor.isAdmin && actor.isLdpAdmin ? 'all PSP and LDP role profiles'
      : actor.isAdmin ? 'all PSP role profiles' : actor.isLdpAdmin ? 'all LDP role profiles'
        : 'the role profiles you can see',
    finalLabel: actor.isLdpAdmin && !actor.isAdmin ? 'LDP Admin' : 'PSP Approver / LDP Admin',
    statusLabels: roleProfile.STATUS_LABELS,
    title: 'Role Profile Report — Pakka Role Profile',
    pageTitle: 'Role Profile Report',
    activeNav: 'reports',
  });
});

module.exports = router;
