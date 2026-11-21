function logDecision(type, symbol, reason, extra = {}) {
  return {
    time: new Date().toISOString(),
    type,
    symbol,
    reason,
    ...extra
  };
}

module.exports = { logDecision };
