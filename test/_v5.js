// Preloaded (node -r) by test/runner5.js: the live config is runner-hunter v6 Trend Following (Liviu t93u,
// 22 Nov 14:53). runner5.js covers the t90u v5 behaviour, so it restores v5 from previousVersions and runner-v5.
const config = require('../src/config');
const rh = config.books.list.find(b => b.id === 'runner-hunter');
const v5 = rh && (rh.previousVersions || []).find(v => v.version === 5);
if (v5) { rh.version = 5; rh.name = 'Runner hunter'; rh.entry = v5.entry; rh.exit = v5.exit; rh.previousVersions = rh.previousVersions.filter(v => v.version < 5); }
config.books.epoch = 'runner-v5';
// t117u: this suite pins an older runner-hunter board, from before the social-spike book (covered by test/social.js).
config.books.list = config.books.list.filter(b => b.id !== 'social-spike');
if (Array.isArray(config.onlyStrategies)) config.onlyStrategies = config.onlyStrategies.filter(id => id !== 'social-spike');
