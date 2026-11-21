function sizePosition(balance, maxPct = 0.08) {
  const size = Math.min(balance * maxPct, 0.32);
  return Math.max(0.05, size);
}

module.exports = { sizePosition };
