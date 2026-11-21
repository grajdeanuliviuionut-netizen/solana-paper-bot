// Stock / stablecoin / wrapped-major block (shared by the 4 books AND the legacy strategies).
// Adapted from the rebuild's rugCheck.js (src/terminal), plus the existing denylist.staticCheck
// (known xStocks mints, issuer names, xStocks-style ticker + Xs... vanity mint).
const denylist = require('../denylist');

// Tokenised stocks / ETFs (symbols, case-insensitive, also with an x/X suffix or "-stock" style names).
const STOCK_SYMBOLS = new Set(['TTWO', 'NIO', 'SPCX', 'SQQQ', 'TQQQ', 'AMC', 'DJT', 'GME', 'TSLA', 'NVDA', 'AAPL', 'GOOGL', 'GOOG', 'AMZN',
  'META', 'MSFT', 'MSTR', 'COIN', 'HOOD', 'SPY', 'QQQ', 'BABA', 'AMD', 'MU', 'NKE', 'CRCL', 'AVGO', 'MCD', 'GLD', 'SLV', 'ANT', 'SKHY',
  'DRAM', 'STRC', 'PLTR', 'NFLX', 'INTC', 'ORCL', 'UBER', 'PYPL', 'SHOP', 'DIS', 'KO', 'PEP', 'WMT', 'JPM', 'BAC', 'V', 'MA', 'XOM',
  'CVX', 'LLY', 'UNH', 'JNJ', 'PFE', 'ABBV', 'CRM', 'ADBE', 'CSCO', 'IBM', 'QCOM', 'TXN', 'ARM', 'SMCI', 'TSM', 'ASML', 'RIVN', 'LCID',
  'GM', 'F', 'BA', 'CAT', 'GE', 'T', 'VZ', 'SBUX', 'RDDT', 'SNAP', 'RBLX', 'DKNG', 'MARA', 'RIOT', 'CLSK', 'IBIT', 'GBTC', 'ETHA', 'VTI',
  'VOO', 'IWM', 'DIA', 'XLK', 'ARKK', 'SOXL', 'BRK', 'BRKB', 'TLT', 'NIKE', 'BBBY', 'SPCE', 'NOK', 'BB', 'SIRI', 'SOFI', 'HIMS', 'CRWV']);
const STOCK_NAME_RE = /\b(x-?stocks?|tokeni[sz]ed (stock|equity|share)s?|backed finance|backpack securities|ondo global markets|robinhood stock|stock token|equity token)\b|\b(inc|corp|holdings|plc)\.?$/i;

// Stablecoins (symbols + known mints).
const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'PYUSD', 'USDS', 'USDE', 'SUSDE', 'USDY', 'DAI', 'FDUSD', 'USD1', 'EURC', 'USDG', 'UXD', 'USDH',
  'USDB', 'USDD', 'TUSD', 'BUSD', 'GUSD', 'FRAX', 'LUSD', 'USX', 'AUSD', 'USDP', 'EUROE', 'EURCV', 'USDV', 'HYUSD', 'SYRUPUSDC', 'USDSTAR', 'USD*', 'USDU', 'CASH', 'USDO']);
const STABLE_MINTS = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr', 'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM', 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB']);
// Wrapped majors and SOL LSTs (symbols + known mints).
const WRAPPED_SYMBOLS = new Set(['SOL', 'WSOL', 'WBTC', 'BTC', 'XBTC', 'CBBTC', 'TBTC', 'ZBTC', 'LBTC', 'WETH', 'ETH', 'WBETH', 'STETH', 'WSTETH',
  'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'INF', 'STSOL', 'HSOL', 'BONKSOL', 'JSOL', 'DSOL', 'VSOL', 'LAINESOL', 'BNSOL', 'PSOL', 'COMPASSSOL',
  'EDGESOL', 'HUBSOL', 'STRONGSOL', 'PICOSOL', 'LST', 'SSOL', 'BBSOL', 'BYUSOL', 'CGNTSOL', 'FPSOL', 'HAUSSOL', 'JUCYSOL', 'LANTERNSOL',
  'PATHSOL', 'PWRSOL', 'RKSOL', 'SPIKYSOL', 'XSOL', 'ZIPPYSOL', 'WBNB', 'BNB', 'WAVAX', 'WMATIC', 'WPOL', 'WSUI', 'WAPT']);
const WRAPPED_MINTS = new Set(['So11111111111111111111111111111111111111112', '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', '5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm',
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', 'he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A', 'BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85',
  'zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg', 'LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY']);

// PR13 (Liviu t70u): stocks are matched by MINT or by full NAME, never by ticker alone (the pump.fun
// memecoin "Max coin" / MAX, mint 5qaP...pump, was blocked as Mastercard "MA" + x). Stock rules:
//   1. denylist.staticCheck: known tokenised-stock mints (Backpack, xStocks), issuer names, and an
//      xStocks-style ticker ON an Xs... vanity mint (mint-based);
//   2. EXTRA_STOCK_MINTS below (mint-based);
//   3. issuer vanity mint: a stock ticker whose (non-pump.fun) mint starts with that ticker, e.g.
//      TTWofw... for TTWO (mint-based);
//   4. full-name rules: STOCK_NAME_RE (xStock / tokenized stock / issuer / "... Inc." style names) and
//      STOCK_COMPANY_RE (company / fund names such as "Take-Two Interactive", "NIO Inc").
// Stablecoin / wrapped-major / LST rules are unchanged.
const EXTRA_STOCK_MINTS = {};
const STOCK_COMPANY_RE = /\b(take[- ]?two interactive|nio inc|proshares|ultrapro short|amc entertainment|trump media|gamestop corp|tesla,? inc|nvidia corp|apple inc|alphabet inc|amazon\.com|meta platforms|microsoft corp|microstrategy|coinbase global|robinhood markets|spdr s&p|invesco qqq)\b/i;

function stockReason({ mint, symbol, name }) {
  const sym = String(symbol || '').trim().toUpperCase().replace(/^\$/, '');
  const nm = String(name || '');
  const st = denylist.staticCheck({ mint, symbol, name });
  if (st) return st;
  if (mint && EXTRA_STOCK_MINTS[mint]) return 'mint ' + EXTRA_STOCK_MINTS[mint];
  const m = String(mint || '');
  const base = sym.endsWith('X') && /x$/.test(String(symbol || '').trim()) ? sym.slice(0, -1) : sym;
  for (const t of [sym, base]) {
    if (t.length >= 2 && STOCK_SYMBOLS.has(t) && !/pump$/i.test(m) && m.toUpperCase().startsWith(t)) return 'issuer vanity mint ' + m.slice(0, 8) + '... for ' + t;
  }
  if (STOCK_NAME_RE.test(nm)) return 'name "' + nm.slice(0, 40) + '"';
  if (STOCK_COMPANY_RE.test(nm)) return 'company name "' + nm.slice(0, 40) + '"';
  return null;
}

function classifyBlocked({ mint, symbol, name }) {
  const sym = String(symbol || '').trim().toUpperCase().replace(/^\$/, '');
  const st = stockReason({ mint, symbol, name });
  if (st) return 'tokenised-stock: ' + st;
  if (STABLE_MINTS.has(mint) || STABLE_SYMBOLS.has(sym)) return 'stablecoin: ' + sym;
  if (WRAPPED_MINTS.has(mint) || WRAPPED_SYMBOLS.has(sym)) return 'wrapped-major/LST: ' + sym;
  return null;
}

module.exports = { classifyBlocked, stockReason, EXTRA_STOCK_MINTS, STOCK_COMPANY_RE, STOCK_SYMBOLS, STABLE_SYMBOLS, WRAPPED_SYMBOLS };
