import { resolveTickerInput } from "../data/ticker-search.js";

export async function resolveStockQuestion(question, options = {}) {
  const raw = String(question || "").trim();
  const direct = await resolveTickerInput(raw, options);
  const company = raw.replace(/\b(should|i|me|my|sell|buy|hold|stock|share|shares|today|right|now|the|a|an|is|it|to|do)\b/gi, " ")
    .replace(/[?!]/g, " ").replace(/\s+/g, " ").trim();
  const ticker = direct || await resolveTickerInput(company, options);
  return ticker ? { ticker, company: company || ticker, question: raw } : null;
}
