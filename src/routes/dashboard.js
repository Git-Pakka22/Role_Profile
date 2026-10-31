'use strict';
const express = require('express');
const mw = require('../middleware');
const dashboard = require('../models/dashboard');
const financialYear = require('../models/financialYear');
const history = require('../models/history');
const roleProfile = require('../models/roleProfile');
const report = require('../models/report');

/**
 * The dashboard: where role profiles stand, how many designations still need one, approvals
 * waiting, this year's assessments and recent activity. For the PSP Approver, the LDP Admin
 * and anyone who leads members; members go to their role profiles instead.
 */
const router = express.Router();
router.use(mw.loggedIn);

router.get('/', async (req, res) => {
  const actor = {
    code: req.session.emp_code || '',
    name: req.session.emp_name || '',
    isAdmin: !!req.session.is_admin,
    isLdpAdmin: !!req.session.is_ldp_admin,
  };
  if (!(actor.isAdmin || actor.isLdpAdmin || (await mw.leadsCount(req)) > 0)) return res.redirect('/role-profiles');

  const fy = await financialYear.current();
  const data = await dashboard.build(actor, fy);
  const hour = new Date().getHours();

  await res.page('dashboard', {
    ...data,
    fy,
    stagesList: report.STAGES,
    historyMeta: history.META,
    greeting: hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening',
    scopeNote: actor.isAdmin && actor.isLdpAdmin ? 'All PSP and LDP role profiles'
      : actor.isAdmin ? 'All PSP role profiles' : actor.isLdpAdmin ? 'All LDP role profiles' : 'Role profiles you work with',
    statusText: (p) => roleProfile.statusLabel(p),
    title: 'Dashboard — Pakka Role Profile',
    pageTitle: 'Dashboard',
    activeNav: 'dashboard',
  });
});

module.exports = router;
