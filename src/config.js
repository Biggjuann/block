import 'dotenv/config';

const bool = (v, def = false) => {
  if (v === undefined || v === null || v === '') return def;
  return String(v).toLowerCase() === 'true' || v === '1';
};

const num = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

export const config = {
  port: num(process.env.PORT, 3000),
  dbPath: process.env.DB_PATH || './data/blocktrades.sqlite',
  schwab: {
    token: process.env.SCHWAB_TOKEN || '',
    symbols: (process.env.SCHWAB_SYMBOLS ||
      'SPY,QQQ,TSLA,IWM,AAPL,NVDA,MSFT,GLD,HYG,ORCL,AMZN,PFE,NIO,HIVE,BITF')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  },
  blockMinSize: num(process.env.BLOCK_MIN_SIZE, 50000),
  printMinSize: num(process.env.PRINT_MIN_SIZE, 400000),
  forceSimulator: bool(process.env.FORCE_SIMULATOR, false),
  // Size thresholds that drive the columns in the Block Trade Viewer.
  columns: [50000, 400000, 500000, 800000],
};

export const useSimulator = config.forceSimulator || !config.schwab.token;
