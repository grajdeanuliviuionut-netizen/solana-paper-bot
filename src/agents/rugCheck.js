function rugCheck(pair) {
  if (!pair) return { pass: false, reason: 'no pair' };
  if ((pair.liquidityUsd || 0) < 8000) return { pass: false, reason: 'low liquidity' };
  if ((pair.volumeH1 || 0) < 1000) return { pass: false, reason: 'low volume' };
  const age = pair.ageDays || 0;
  if (age < 0.01 && (pair.liquidityUsd || 0) < 20000) return { pass: false, reason: 'too new + thin' };
  return { pass: true, reason: 'basic checks ok' };
}

module.exports = { rugCheck };
