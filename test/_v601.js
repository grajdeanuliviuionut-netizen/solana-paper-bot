// Preloaded (node -r) by test/runner6.js: the live config is runner-hunter v6.02 "filter-on" half-and-trail
// (Liviu t100u, 22 Nov 20:49). runner6.js covers v6/v6.01 (full +8% TP), so it restores v6.01 (same board runner-v6).
const config = require('../src/config');
const rh = config.books.list.find(b => b.id === 'runner-hunter');
const v = rh && (rh.previousVersions || []).find(x => x.version === 6.01);
if (v) { rh.version = 6.01; rh.entry = v.entry; rh.exit = v.exit; rh.previousVersions = rh.previousVersions.filter(x => x.version < 6.01); }
