const config = require('./config');

// priceFresh=false means the pinned pair could not be quoted this tick: only the time
// stop may fire (at the last known price) so we never fake TP/SL off a stale number.
function shouldExit(pos, currentPrice, priceFresh = true) {
  const ex = pos.exit || {};
  if (priceFresh) {
    const changePct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    if (changePct >= ex.takeProfitPct) return { reason: 'tp', fillPrice: currentPrice };
    if (changePct <= -ex.stopLossPct) return { reason: 'sl', fillPrice: currentPrice };

    if (ex.trailAfterPct) {
      const peakPct = (((pos.highest || pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100;
      if (peakPct >= ex.trailAfterPct) {
        const trailPrice = (pos.highest || pos.entryPrice) * (1 - (ex.trailPct || 5) / 100);
        if (currentPrice <= trailPrice) return { reason: 'trail', fillPrice: currentPrice };
      }
    }
  }

  const maxHold = ex.maxHoldMinutes || config.defaultMaxHoldMinutes;
  const minsOpen = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
  if (minsOpen >= maxHold) return { reason: priceFresh ? 'time' : 'time-stale', fillPrice: currentPrice };

  return null;
}

function computePnl(pos, exitPrice) {
  const gross = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const net = gross - config.costRoundtripPct / 100;
  return net * pos.sizeSol;
}

module.exports = { shouldExit, computePnl };
