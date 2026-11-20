// Loads the trading wallet from WALLET_PRIVATE_KEY (base58 secret key, e.g. a Solflare/Phantom
// export; a 64-number JSON array is also accepted). The key is never logged or persisted.
function loadKeypair(secret = process.env.WALLET_PRIVATE_KEY) {
  if (!secret) return { ok: false, error: 'WALLET_PRIVATE_KEY missing' };
  try {
    const { Keypair } = require('@solana/web3.js');
    const bs58mod = require('bs58');
    const bs58 = bs58mod.default || bs58mod;
    const trimmed = String(secret).trim();
    let bytes;
    if (trimmed.startsWith('[')) bytes = Uint8Array.from(JSON.parse(trimmed));
    else bytes = bs58.decode(trimmed);
    if (bytes.length !== 64) return { ok: false, error: `WALLET_PRIVATE_KEY decodes to ${bytes.length} bytes, expected 64` };
    const keypair = Keypair.fromSecretKey(bytes);
    return { ok: true, keypair, publicKey: keypair.publicKey.toBase58() };
  } catch (e) {
    // Do not include e.message: some decoders echo the input.
    return { ok: false, error: 'WALLET_PRIVATE_KEY could not be decoded (expected base58 secret key)' };
  }
}

module.exports = { loadKeypair };
