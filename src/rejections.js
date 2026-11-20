// Hourly per-gate rejection counts + near-miss shadow log (signals that failed exactly one gate).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STATE_FILE ? path.dirname(process.env.STATE_FILE) : './data';
const NEARMISS_FILE = process.env.NEARMISS_FILE || path.join(DATA_DIR, 'nearmiss.jsonl');
const EVENTS_FILE = process.env.EVENTS_FILE || path.join(DATA_DIR, 'events.jsonl');

const hourly = {};       // hourKey -> strategyId -> gate -> count  (+ _evaluated)
const nearMisses = [];   // newest first, capped
const nearMissSeen = new Map(); // `${strategy}:${mint}:${gate}` -> ts
let lastLoggedHour = null;

function hourKey(t = Date.now()) {
  return new Date(t).toISOString().slice(0, 13) + ':00Z';
}

function append(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.error('append failed', file, e.message);
  }
}

function count(strategyId, gate, n = 1) {
  const h = hourKey();
  const bucket = (hourly[h] = hourly[h] || {});
  const s = (bucket[strategyId] = bucket[strategyId] || {});
  s[gate] = (s[gate] || 0) + n;
}

function nearMiss(rec) {
  const key = `${rec.strategyId}:${rec.mint}:${rec.gate}`;
  const last = nearMissSeen.get(key) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  nearMissSeen.set(key, Date.now());
  const row = { time: new Date().toISOString(), ...rec };
  nearMisses.unshift(row);
  if (nearMisses.length > 300) nearMisses.pop();
  append(NEARMISS_FILE, row);
}

function event(type, data) {
  const row = { time: new Date().toISOString(), type, ...data };
  append(EVENTS_FILE, row);
  console.log(`[event] ${type} ${JSON.stringify(data)}`);
}

// Call once per tick: prints the previous hour's counts when the hour rolls over.
function maybeLogHourly() {
  const h = hourKey();
  if (lastLoggedHour && lastLoggedHour !== h && hourly[lastLoggedHour]) {
    console.log(`[rejections-hourly] ${lastLoggedHour} ${JSON.stringify(hourly[lastLoggedHour])}`);
  }
  lastLoggedHour = h;
  const keys = Object.keys(hourly).sort();
  while (keys.length > 48) delete hourly[keys.shift()];
  if (nearMissSeen.size > 20000) nearMissSeen.clear();
}

function snapshot() {
  return { currentHour: hourKey(), hourly, nearMissFile: NEARMISS_FILE };
}

module.exports = { count, nearMiss, event, maybeLogHourly, snapshot, nearMisses, hourKey };
