import { blockedAssetSet, blockedTickerShortcuts, companyAliases } from "../config/settings.js";
import { titleCase, unique } from "./text.js";

export function parseTickers(value) {
  return unique(String(value || "")
    .split(/[\s,;]+/)
    .map((ticker) => ticker.trim().toUpperCase().replace(/[^A-Z0-9.^-]/g, ""))
    .filter(Boolean))
    .slice(0, 90);
}

export function parseDetailTicker(value) {
  const parsed = parseQuestionTarget(value);
  const fallbackTicker = parseTickers(value)[0] || "";
  const ticker = String(parsed.ticker || fallbackTicker).toUpperCase();
  return { ticker, company: parsed.company || ticker };
}

export function isBlockedAssetTicker(ticker) {
  const normalized = String(ticker || "").trim().toUpperCase();
  return blockedAssetSet.has(normalized) || blockedTickerShortcuts.has(normalized) || normalized.endsWith("-USD");
}

export function parseQuestionTarget(question) {
  const raw = String(question || "").trim();
  const normalized = raw.toLowerCase()
    .replace(/[^a-z0-9.^\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const tickerStopWords = new Set(["I", "ME", "MY", "A", "AN", "THE", "DO", "IS", "IT", "TO", "SHOULD", "SELL", "BUY", "HOLD", "TODAY", "NOW"]);
  const directTicker = Array.from(raw.matchAll(/\b[A-Z]{1,5}\b/g))
    .map((match) => match[0])
    .find((token) => !tickerStopWords.has(token));
  if (directTicker) {
    return { ticker: directTicker, question: raw, company: directTicker };
  }

  const alias = Object.keys(companyAliases)
    .sort((a, b) => b.length - a.length)
    .find((name) => normalized.includes(name));
  if (alias) return { ticker: companyAliases[alias], question: raw, company: titleCase(alias.replace(/\s+stock$/, "")) };

  const cleaned = normalized
    .replace(/\b(should|i|me|my|sell|buy|hold|stock|srock|share|shares|today|right|now|the|a|an|is|it|to|do)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const maybeTicker = cleaned.toUpperCase().replace(/[^A-Z0-9.^-]/g, "");
  if (maybeTicker && maybeTicker.length <= 5) return { ticker: maybeTicker, question: raw, company: maybeTicker };

  return { ticker: "", question: raw, company: "" };
}
