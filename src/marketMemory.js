// Per-pair liquidity history from our own polls (DEX Screener has no liquidity history).
// Gives liqChange60mPct and "liquidity down > X% vs previous poll".
const hist = new Map(); // pairAddress -> [{t, liq}]
const KEEP_MS = 75 * 60 * 1000;

function record(pairs, now = Date.now()) {
  for (const p of pairs) {
    if (!p.pairAddress) continue;
    const arr = hist.get(p.pairAddress) || [];
    const prev = arr.length ? arr[arr.length - 1] : null;
    p.prevLiquidityUsd = prev ? prev.liq : null;
    p.liqChangeVsPrevPct = prev && prev.liq > 0 ? ((p.liquidityUsd - prev.liq) / prev.liq) * 100 : null;
    const old = arr.find(x => now - x.t <= 60 * 60 * 1000);
    p.liqChange60mPct = old && old.liq > 0 && arr.length > 1 ? ((p.liquidityUsd - old.liq) / old.liq) * 100 : null;
    arr.push({ t: now, liq: p.liquidityUsd });
    while (arr.length && now - arr[0].t > KEEP_MS) arr.shift();
    hist.set(p.pairAddress, arr);
  }
  if (hist.size > 5000) {
    for (const [k, arr] of hist) if (!arr.length || now - arr[arr.length - 1].t > KEEP_MS) hist.delete(k);
  }
}

module.exports = { record };
