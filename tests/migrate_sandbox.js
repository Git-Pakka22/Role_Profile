'use strict';
/** Run the migrations against the sandbox copy. */
process.env.DB_NAME = process.env.SANDBOX_DB || 'yashpakk_rp_sandbox';
require('../scripts/migrate_designations.js').main()
  .then(() => require('../scripts/migrate_translations.js').main())
  .then(() => require('../scripts/migrate_versions.js').main())
  // Needs the version tables, so it comes after them.
  .then(() => require('../scripts/migrate_outcome_assessment.js').main())
  .then(() => require('../scripts/migrate_measurability.js').main())
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
