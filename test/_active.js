// Preloaded (node -r) by the behaviour test files: the live config pauses everything except runner-hunter
// (Liviu t83u, 22 Nov). These suites exercise entry logic, so they run on the pre-t83u active set (only
// aggressive-flow paused, all four books active, dip-hold slot reserve). test/pause.js covers the live set.
const config = require('../src/config');
for (const s of config.strategies) s.paused = s.id === 'aggressive-flow';
for (const b of config.books.list) b.paused = false;
config.slotReserve = { 'dip-hold': 1 };
// t85u: behaviour suites exercise every strategy -> no allow-list, no epoch closeout.
config.onlyStrategies = null;
config.books.epochCloseout = false;
// t85u: runner-hunter v2 exits are covered by test/runner2.js on the live config; the older suites keep v1.
const rh = config.books.list.find(b => b.id === 'runner-hunter');
const v1 = rh && (rh.previousVersions || []).find(v => v.version === 1);
if (v1) { rh.version = 1; rh.exit = v1.exit; rh.entry = v1.entry; }
