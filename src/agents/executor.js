function executeEntry(signal, size, balance) {
  if (balance < size) return { ok: false, reason: 'insufficient balance' };
  return {
    ok: true,
    reason: `entry ${signal.symbol} size ${size.toFixed(3)}`,
    position: {
      id: Date.now() + Math.random(),
      strategyId: signal.strategyId,
      strategyName: signal.strategyName,
      symbol: signal.symbol,
      pairAddress: signal.pairAddress,
      mint: signal.mint || (signal.pair && signal.pair.mint) || null,
      entryPrice: signal.price,
      sizeSol: size,
      entryTime: new Date().toISOString(),
      exit: signal.exit,
      highest: signal.price,
      entryReason: signal.reason || 'signal'
    }
  };
}

module.exports = { executeEntry };
