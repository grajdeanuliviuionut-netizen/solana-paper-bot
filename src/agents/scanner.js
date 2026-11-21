const { getCandidatePairs } = require('../dataFetcher');

async function scan() {
  const pairs = await getCandidatePairs();
  return Array.isArray(pairs) ? pairs : [];
}

module.exports = { scan };
