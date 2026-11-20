// Redaction of secrets in anything we log. Installed globally on console.* at startup so a stray
// error message can never print the wallet key or the kill token.
const MASK = '<hidden>';
const SECRET_ENV = ['WALLET_PRIVATE_KEY', 'KILL_TOKEN', 'RPC_URL'];
// (No generic base58 pattern: tx signatures have the same length as secret keys. Exact secret
// values are redacted instead, plus 64-number JSON byte arrays.)
// JSON byte-array keys ([12,34,...] with 64 numbers).
const ARRAYLIKE = /\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g;

function secrets() {
  return SECRET_ENV.map(k => process.env[k]).filter(v => v && v.length >= 8);
}

function redact(input) {
  let s = typeof input === 'string' ? input : (input instanceof Error ? (input.stack || input.message) : safeJson(input));
  for (const v of secrets()) s = s.split(v).join(MASK);
  return s.replace(ARRAYLIKE, MASK);
}

function safeJson(v) {
  if (typeof v !== 'object' || v === null) return String(v);
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

let installed = false;
function installConsoleRedaction() {
  if (installed) return;
  installed = true;
  for (const m of ['log', 'error', 'warn', 'info']) {
    const orig = console[m].bind(console);
    console[m] = (...args) => orig(...args.map(a => (typeof a === 'string' || a instanceof Error || (a && typeof a === 'object')) ? redact(a) : a));
  }
}

module.exports = { redact, installConsoleRedaction };
