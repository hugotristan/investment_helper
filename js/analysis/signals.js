import { technicalReviewReasons, technicalSignalFor } from './technical-policy.js';
import { hasQualifiedSignal } from './data-quality.js';

// Export names/array keys remain compatible with existing callers. Labels are
// technical observations, never instructions to buy, sell or retain a position.
export function buildSellGuidance(results) {
  const sell = [], hold = [];
  for (const item of results) {
    const review = sellSignalFor(item), constructive = holdSignalFor(item);
    if (review) sell.push(review); else if (constructive) hold.push(constructive);
  }
  return {sell:sell.sort((a,b)=>b.urgency-a.urgency).slice(0,6),
    hold:hold.sort((a,b)=>b.conviction-a.conviction).slice(0,6)};
}
export function sellSignalFor(item) {
  if (!hasQualifiedSignal(item)) return null;
  const signal = technicalSignalFor(item);
  if (!['review','weak'].includes(signal.key)) return null;
  const reasons = technicalReviewReasons(item);
  return {ticker:item.ticker,label:signal.label,score:item.score,
    urgency:reasons.length*10+100-item.score,
    reason:reasons[0] || 'Completed daily prices show weak technical conditions.',
    detail:reasons.slice(1,3).join(' '),className:'sell-item-danger'};
}
export function holdSignalFor(item) {
  if (!hasQualifiedSignal(item)) return null;
  const signal = technicalSignalFor(item);
  if (!['favorable','constructive'].includes(signal.key)) return null;
  const reasons = (item.reasons || []).filter(reason=>!/^No major|^Broad ETF/.test(reason));
  return {ticker:item.ticker,label:signal.label,score:item.score,conviction:item.score,
    reason:reasons[0] || 'Completed daily price indicators show constructive conditions.',
    detail:'Technical strength does not establish business quality or undervaluation.',className:'sell-item-hold'};
}
