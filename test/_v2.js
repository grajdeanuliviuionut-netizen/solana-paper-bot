// Preloaded (node -r) by test/pause.js and test/runner2.js: the live config is runner-hunter v3 (Liviu t86u,
// 22 Nov 12:12). Those suites cover the t83u/t85u behaviour (allow-list, epoch switch, v2 exits) on the v2
// entry rules, so they restore v2 from previousVersions and the runner-v2 epoch; the Manager loop is off.
// v3 (entry filters, cooldown, guardrail, Manager) is covered by test/runner3.js on the live config.
const config = require('../src/config');
const rh = config.books.list.find(b => b.id === 'runner-hunter');
const v2 = rh && (rh.previousVersions || []).find(v => v.version === 2);
if (v2) { rh.version = 2; rh.entry = v2.entry; rh.exit = v2.exit; rh.previousVersions = rh.previousVersions.filter(v => v.version < 2); }
config.books.epoch = 'runner-v2';
config.manager = Object.assign({}, config.manager, { enabled: false });
