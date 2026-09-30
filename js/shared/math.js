export function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function returnOver(values, days) {
  if (values.length <= days) return values[0] ? values.at(-1) / values[0] - 1 : 0;
  const start = values[values.length - 1 - days];
  return start ? values.at(-1) / start - 1 : 0;
}

export function dailyReturns(values) {
  const returns = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1]) returns.push(values[i] / values[i - 1] - 1);
  }
  return returns;
}

export function relativeStrengthIndex(values, period = 14) {
  if (values.length <= period) return 50;
  const changes = [];
  for (let i = values.length - period; i < values.length; i += 1) {
    changes.push(values[i] - values[i - 1]);
  }
  const gains = changes.map((change) => Math.max(change, 0));
  const losses = changes.map((change) => Math.abs(Math.min(change, 0)));
  const avgLoss = average(losses);
  if (!avgLoss) return 100;
  const rs = average(gains) / avgLoss;
  return 100 - (100 / (1 + rs));
}

function ema(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const output = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    output.push(values[i] * multiplier + output[i - 1] * (1 - multiplier));
  }
  return output;
}

export function macdSignal(values) {
  if (values.length < 35) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = ema(values, 12);
  const ema26 = ema(values, 26);
  const macdLine = values.map((_, index) => ema12[index] - ema26[index]);
  const signalLine = ema(macdLine, 9);
  const macd = macdLine.at(-1) || 0;
  const signal = signalLine.at(-1) || 0;
  return { macd, signal, histogram: macd - signal };
}

export function bollingerBands(values, period = 20) {
  const slice = values.slice(-period);
  const middle = average(slice);
  const deviation = stdev(slice);
  const upper = middle + deviation * 2;
  const lower = middle - deviation * 2;
  const latest = values.at(-1);
  return {
    upper,
    middle,
    lower,
    position: upper === lower ? 0.5 : (latest - lower) / (upper - lower)
  };
}

export function averageTrueRange(prices, period = 14) {
  if (prices.length < 2) return 0;
  const ranges = [];
  for (let i = Math.max(1, prices.length - period); i < prices.length; i += 1) {
    const high = Number.isFinite(prices[i].high) ? prices[i].high : prices[i].close;
    const low = Number.isFinite(prices[i].low) ? prices[i].low : prices[i].close;
    const previousClose = prices[i - 1].close;
    ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return average(ranges);
}

export function average(values) {
  const clean = values.filter((value) => Number.isFinite(value));
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

export function stdev(values) {
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

export function roundPercent(value) {
  return Math.round(value * 10) / 10;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
