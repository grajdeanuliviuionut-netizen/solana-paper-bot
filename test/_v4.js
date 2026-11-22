// Preloaded (node -r) by test/runner4.js: the live config is runner-hunter v5 (Liviu t90u, 22 Nov 13:56).
// runner4.js covers the t89u v4 behaviour, so it restores v4 from previousVersions and the runner-v4 epoch.
const config = require('../src/config');
const rh = config.books.list.find(b => b.id === 'runner-hunter');
const v4 = rh && (rh.previousVersions || []).find(v => v.version === 4);
if (v4) { rh.version = 4; rh.entry = v4.entry; rh.exit = v4.exit; rh.previousVersions = rh.previousVersions.filter(v => v.version < 4); }
config.books.epoch = 'runner-v4';
