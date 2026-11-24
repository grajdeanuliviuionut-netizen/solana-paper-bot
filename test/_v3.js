// Preloaded (node -r) by test/runner3.js: the live config is runner-hunter v4 (Liviu t89u, 22 Nov 13:18).
// runner3.js covers the t86u v3 behaviour (entry filters, 24 h stop cooldown, 4-loss guardrail, Manager v3
// rules), so it restores v3 from previousVersions and the runner-v3 epoch. v4 is covered by test/runner4.js.
const config = require('../src/config');
const rh = config.books.list.find(b => b.id === 'runner-hunter');
const v3 = rh && (rh.previousVersions || []).find(v => v.version === 3);
if (v3) { rh.version = 3; rh.entry = v3.entry; rh.exit = v3.exit; rh.previousVersions = rh.previousVersions.filter(v => v.version < 3); }
config.books.epoch = 'runner-v3';
// t117u: this suite pins an older runner-hunter board, from before the social-spike book (covered by test/social.js).
config.books.list = config.books.list.filter(b => b.id !== 'social-spike');
if (Array.isArray(config.onlyStrategies)) config.onlyStrategies = config.onlyStrategies.filter(id => id !== 'social-spike');
