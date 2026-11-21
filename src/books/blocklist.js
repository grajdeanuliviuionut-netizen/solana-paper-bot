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

function classifyBlocked({ mint, symbol, name }) {
  const sym = String(symbol || '').trim().toUpperCase().replace(/^\$/, '');
  const nm = String(name || '');
  const st = denylist.staticCheck({ mint, symbol, name });
  if (st) return 'tokenised-stock: ' + st;
  if (STOCK_SYMBOLS.has(sym) || (sym.endsWith('X') && STOCK_SYMBOLS.has(sym.slice(0, -1)) && /x$/.test(String(symbol || '').trim()))) return 'tokenised-stock: symbol ' + sym;
  if (STOCK_NAME_RE.test(nm)) return 'tokenised-stock: name "' + nm.slice(0, 40) + '"';
  if (STABLE_MINTS.has(mint) || STABLE_SYMBOLS.has(sym)) return 'stablecoin: ' + sym;
  if (WRAPPED_MINTS.has(mint) || WRAPPED_SYMBOLS.has(sym)) return 'wrapped-major/LST: ' + sym;
  return null;
}

module.exports = { classifyBlocked, STOCK_SYMBOLS, STABLE_SYMBOLS, WRAPPED_SYMBOLS };
