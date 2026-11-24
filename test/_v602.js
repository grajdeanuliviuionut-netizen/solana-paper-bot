// Preloaded (node -r) by test/runner602.js: the live config is runner-hunter v6.03 (Liviu t115u, 24 Nov: stop trigger
// -2.5%, liquidity > $100k). runner602.js covers v6.02 (-4% stop, liquidity > $50k), so it restores v6.02 (same board runner-v6).
const config = require('../src/config');
const rh = config.books.list.find(b => b.id === 'runner-hunter');
const v = rh && (rh.previousVersions || []).find(x => x.version === 6.02);
if (v) { rh.version = 6.02; rh.entry = v.entry; rh.exit = v.exit; rh.previousVersions = rh.previousVersions.filter(x => x.version < 6.02); }
// t117u: this suite pins an older runner-hunter board, from before the social-spike book (covered by test/social.js).
config.books.list = config.books.list.filter(b => b.id !== 'social-spike');
if (Array.isArray(config.onlyStrategies)) config.onlyStrategies = config.onlyStrategies.filter(id => id !== 'social-spike');
