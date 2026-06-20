// Curated universe of liquid US equities + ETFs to monitor for block trades.
// Override at runtime with the SCHWAB_SYMBOLS env var (comma-separated).
// The Schwab streamer subscribes to every symbol here and we filter the
// resulting prints into the tape's size-range columns.

export const UNIVERSE = [
  // Broad-market & sector ETFs
  'SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'VEA', 'VWO', 'EEM', 'EFA',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE',
  'XLC', 'SMH', 'SOXX', 'XBI', 'IBB', 'KWEB', 'ARKK', 'GLD', 'SLV', 'GDX',
  'USO', 'TLT', 'HYG', 'LQD', 'AGG', 'VXX', 'UVXY', 'SQQQ', 'TQQQ', 'SOXL',
  'SOXS', 'TSLL', 'TNA', 'SPXL', 'JETS', 'MUB', 'USHY', 'ILF', 'GDXD',

  // Mega-cap tech
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'TSLA', 'AVGO',
  'ORCL', 'ADBE', 'CRM', 'AMD', 'INTC', 'CSCO', 'QCOM', 'TXN', 'IBM',
  'NOW', 'PANW', 'SNOW', 'PLTR', 'MU', 'AMAT', 'LRCX', 'ARM', 'SMCI',

  // Financials
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'SCHW', 'BLK', 'AXP', 'V', 'MA',
  'PYPL', 'SOFI', 'COIN', 'HOOD', 'SQ', 'AFRM',

  // Healthcare / pharma / biotech
  'UNH', 'JNJ', 'LLY', 'PFE', 'MRK', 'ABBV', 'TMO', 'ABT', 'BMY', 'GILD',
  'AMGN', 'CVS', 'MRNA', 'RARE', 'CHEK', 'ATYR', 'ADAP',

  // Consumer / industrials / energy
  'WMT', 'COST', 'HD', 'NKE', 'MCD', 'SBUX', 'DIS', 'KO', 'PEP', 'PG',
  'XOM', 'CVX', 'COP', 'OXY', 'SLB', 'RIG', 'BA', 'CAT', 'GE', 'F', 'GM',
  'UBER', 'LYFT', 'ABNB', 'GRAB', 'T', 'VZ', 'TMUS', 'FYBR', 'HBI', 'TGNA',

  // High-volume growth / momentum / meme names
  'NIO', 'LCID', 'RIVN', 'ACHR', 'OPEN', 'SNAP', 'NU', 'BBAI', 'IONQ',
  'QBTS', 'RGTI', 'QUBT', 'WULF', 'CORZ', 'CIFR', 'HIVE', 'BITF', 'MARA',
  'RIOT', 'CLSK', 'MSTR', 'SMR', 'OKLO', 'CCJ', 'NAKA', 'NXTT', 'BTG',
  'ZETA', 'WOLF', 'LDI', 'OPI', 'CAN', 'UE', 'PLTD', 'YAAS', 'RAYA',
  'ATCH', 'SOXS', 'ABEV', 'RIG',
];
