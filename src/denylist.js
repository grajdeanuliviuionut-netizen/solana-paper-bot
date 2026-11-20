// Tokenized equities / RWA stock tokens (Backpack Securities, xStocks, ...) are never traded.
// This is a universe filter, deliberately kept OUT of config.configHashFor so strategy hashes
// (and their 50-trade go-live counts) do not change when the list is updated.
const axios = require('axios');

const JUP_TOKENS = process.env.JUPITER_TOKENS_URL || 'https://lite-api.jup.ag/tokens/v2';
let http = axios;
function setHttp(h) { http = h; }

// Known tokenized-equity mints (from Jupiter's verified token list, tags "stocks"/"rwa").
const MINTS = {
  // Backpack Securities
  TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo: 'TTWO (Backpack)',
  ANTBTZQ1EUuTxUs3tfeampxdqTWPHmwyJmcWj4xoAyNe: 'ANT (Backpack)',
  SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb: 'SPCX (Backpack)',
  NVDAVuiB7hwd3m5Wa1JuHNovPaPG6BH1QNztbKFxNjv: 'NVDA (Backpack)',
  DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF: 'DJT (Backpack)',
  AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc: 'AMC (Backpack)',
  TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S: 'TSLA (Backpack)',
  AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES: 'AMD (Backpack)',
  SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3: 'SKHY (Backpack)',
  MSTRdWXMeZxdE8osAQy3fA4rvTY5rgummDSMEx6U7Nz: 'MSTR (Backpack)',
  METAaH6MMZZgy2CTEJq3QdNi7AFVTV3NxHFBfFgLEDd: 'META (Backpack)',
  GooGLMvZtJZXHdNZy95RUrAMCCKxV6ghK3qE5ddBgVm5: 'GOOGL (Backpack)',
  SQQQAa3gUxgnqcEsdjPA4RQNQBgB97TnG2hJhk2WaGE: 'SQQQ (Backpack)',
  BABANGA4JE7Kkam4nTrALAwAVgsNJUuFJnnkF7S16BZp: 'BABA (Backpack)',
  MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1: 'MU (Backpack)',
  AMZNw7cwU9L9c7ewZXxTws2PwQYxBGm2Rxg3FLDBJz9B: 'AMZN (Backpack)',
  QQQvDYxG7g11Rr4rnaJqDddmP9ocH74YhE3mDaG37R9: 'QQQ (Backpack)',
  AAPLEDt8RpzPgXyhvFzkMBofvFSQw9gpeMCoUdPdLnB8: 'AAPL (Backpack)',
  NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg: 'NKE (Backpack)',
  DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw: 'DRAM (Backpack)',
  // xStocks (Backed Finance)
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: 'NVDAx',
  XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: 'SPYx',
  Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc: 'GMEx',
  XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: 'TSLAx',
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: 'AAPLx',
  Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8: 'SPCXx',
  Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ: 'QQQx',
  XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1: 'CRCLx',
  XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX: 'MSFTx',
  XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN: 'GOOGLx',
  Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re: 'GLDx',
  XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ: 'MSTRx',
  XsYzw7XHj8K2WHeoeNQVyevMmzjzXfcJ8tQ4FmdN1DL: 'ANTx',
  Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu: 'METAx',
  XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2: 'MCDx',
  XsgSaSvNSqLTtFuyWPBhK9196Xb9Bbdyjj4fH3cPJGo: 'AVGOx',
  Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg: 'AMZNx',
  Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu: 'COINx',
  Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH: 'STRCx',
  XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg: 'HOODx'
};

// Issuer accounts (Jupiter "dev" / mint authority) of tokenized-equity programs.
const ISSUERS = {
  Ahye46UtLMq4qM2NhKCNzMjgSvQSVtQpZLEpFKz4W8Kd: 'Backpack Securities',
  '6wEAMnRmjvUhEPH3WvbVQxCARSJ6AVESRZkGCa9YPq3Q': 'Backpack Securities',
  FWAQuQAehvGMUdTBPHfSegx2nGJbT8ZWcakDBNL1BxGX: 'Backpack Securities',
  S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS: 'xStocks (Backed)',
  '7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj': 'xStocks (Backed)'
};

// Jupiter token tags that mark tokenized stocks / RWAs.
const EQUITY_TAGS = new Set(['stocks', 'equities', 'xstocks', 'backpack', 'rwa']);
const ISSUER_NAME_RE = /backpack securities|\bx-?stocks?\b|backed finance|tokenized (stock|equity)|ondo global markets/i;

// Pure, synchronous check on what DEX data gives us (mint, symbol, name).
// Returns null or a short reason string.
function staticCheck({ mint, symbol, name } = {}) {
  if (mint && MINTS[mint]) return `mint ${MINTS[mint]}`;
  const sym = String(symbol || '').trim();
  const nm = String(name || '');
  if (ISSUER_NAME_RE.test(nm)) return `issuer-name "${nm.slice(0, 40)}"`;
  // xStocks style: ticker + lowercase "x" on an Xs... vanity mint (all Backed xStocks use that prefix).
  if (/^[A-Z]{1,6}x$/.test(sym) && mint && mint.startsWith('Xs')) return `xstocks-style ${sym}`;
  return null;
}

// Pure check on a Jupiter token record.
function jupiterCheck(t) {
  if (!t) return null;
  const tags = (t.tags || []).map(x => String(x).toLowerCase());
  const hit = tags.find(x => EQUITY_TAGS.has(x));
  if (hit) return `jupiter-tag ${hit}`;
  if (t.dev && ISSUERS[t.dev]) return `issuer ${ISSUERS[t.dev]}`;
  if (t.mintAuthority && ISSUERS[t.mintAuthority]) return `issuer ${ISSUERS[t.mintAuthority]}`;
  return staticCheck({ mint: t.id, symbol: t.symbol, name: t.name });
}

const jupCache = new Map(); // mint -> { at, reason }
// Async check via Jupiter's token search (free). Fails OPEN on API errors (the static list
// still applies, and the rug gate fails closed anyway). Cached 6h per mint.
async function check({ mint, symbol, name }) {
  const s = staticCheck({ mint, symbol, name });
  if (s) return s;
  if (!mint) return null;
  const c = jupCache.get(mint);
  if (c && Date.now() - c.at < 6 * 3600 * 1000) return c.reason;
  try {
    const res = await http.get(`${JUP_TOKENS}/search`, { timeout: 6000, params: { query: mint } });
    const t = (Array.isArray(res.data) ? res.data : []).find(x => x.id === mint);
    const reason = jupiterCheck(t);
    jupCache.set(mint, { at: Date.now(), reason });
    if (jupCache.size > 5000) jupCache.clear();
    return reason;
  } catch (e) {
    return null;
  }
}

module.exports = { MINTS, ISSUERS, staticCheck, jupiterCheck, check, setHttp, REASON: 'tokenized-equity' };
