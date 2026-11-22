// Preloaded (node -r) by the behaviour test files: the live config pauses everything except runner-hunter
// (Liviu t83u, 22 Nov). These suites exercise entry logic, so they run on the pre-t83u active set (only
// aggressive-flow paused, all four books active, dip-hold slot reserve). test/pause.js covers the live set.
const config = require('../src/config');
for (const s of config.strategies) s.paused = s.id === 'aggressive-flow';
for (const b of config.books.list) b.paused = false;
config.slotReserve = { 'dip-hold': 1 };
