const config = require('./config');

function shouldExit(pos, currentPrice) {
  const changePct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const ex = pos.exit;

  if (changePct >= ex.takeProfitPct) return { reason: 'tp', fillPrice: currentPrice };
  if (changePct <= -ex.stopLossPct) return { reason: 'sl', fillPrice: currentPrice };

  if (ex.trailAfterPct && changePct >= ex.trailAfterPct) {
    const trailStop = pos.highest || pos.entryPrice;
    const trailPrice = trailStop * (1 - (ex.trailPct || 5) / 100);
    if (currentPrice <= trailPrice) return { reason: 'trail', fillPrice: currentPrice };
  }

  const minsOpen = (Date.now() - new Date(pos.entryTime).getTime()) / 60000;
  if (minsOpen >= ex.maxHoldMinutes) return { reason: 'time', fillPrice: currentPrice };

  return null;
}

function computePnl(pos, exitPrice) {
  const gross = (exitPrice - pos.entryPrice) / pos.entryPrice;
  const net = gross - config.costRoundtripPct / 100;
  return net * pos.sizeSol;
}

module.exports = { shouldExit, computePnl };
