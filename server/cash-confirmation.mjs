import { cashConfirmationView, confirmCashOperation } from "./cash-operations.mjs";
import { ApiError, readBoundedText } from "./request-body.mjs";
import { parseDecimalInput } from "../js/shared/decimal.js";

const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
// Keep the same-origin Origin header on form POSTs. A no-referrer policy can
// turn it into "null", which must still fail the strict CSRF origin check.
const privateHeaders = { "Cache-Control": "private, no-store", "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
export async function cashConfirmation(request, env, userId, operationId, now) {
  if (request.method === "POST") {
    if (request.headers.get("origin") !== new URL(request.url).origin) throw new ApiError(403, "INVALID_CONFIRMATION_ORIGIN", "Confirm from this app's own review page.");
    if (!/^application\/x-www-form-urlencoded(?:;.*)?$/i.test(request.headers.get("content-type") || "")) throw new ApiError(415, "FORM_REQUIRED", "Use the confirmation form.");
    const form = new URLSearchParams(await readBoundedText(request, 2048));
    if ([...form.keys()].some(key => !["csrf", "action", "cash_amount"].includes(key) || form.getAll(key).length !== 1)
      || !["confirm", "cancel"].includes(form.get("action"))) throw new ApiError(400, "INVALID_CONFIRMATION", "Use a supported confirmation action.");
    await confirmCashOperation(env, userId, operationId, form.get("csrf"), { cancel: form.get("action") === "cancel", settledAmount: parseDecimalInput(form.get("cash_amount")), now });
    return new Response(null, { status: 303, headers: { "Cache-Control": "private, no-store", Location: `/cash-operations/${operationId}` } });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { ...privateHeaders, Allow: "GET, POST" } });
  const view = await cashConfirmationView(env, userId, operationId, now);
  const p = view.proposal, reversal = p.input.kind === "reversal", settlementNeeded = p.currency !== p.baseCurrency && p.settlement === null;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Review cash entry · Investment Helper</title><link rel="icon" href="/favicon.svg"><style>
  *{box-sizing:border-box}body{margin:0;padding:24px;background:#dedfdd;color:#222823;font:16px/1.6 system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}main{max-width:560px;width:100%;padding:32px;background:#eeefed;border:1px solid #bfc3be}h1{font-size:24px;line-height:1.3;margin:0 0 20px}dl{display:grid;grid-template-columns:1fr 1fr;gap:8px}dt{color:#50594f}dd{margin:0;text-align:right;overflow-wrap:anywhere}input,button{font:inherit;padding:12px;border:1px solid #9da79c;border-radius:0}input{width:100%;background:#f8f8f7}button{cursor:pointer;margin:16px 8px 0 0}button[value=confirm]{background:#234634;color:white}label{display:block;margin:20px 0 8px}.note{font-size:14px;color:#50594f}a{color:#234634}form{margin-top:24px}
  </style></head><body><main><h1>${reversal ? "Review deposit reversal" : "Review cash deposit"}</h1><dl><dt>Amount</dt><dd>${escape(p.amount)} ${escape(p.currency)}</dd><dt>Transaction date</dt><dd>${escape(p.date)}</dd><dt>Status</dt><dd>${escape(view.status)}</dd><dt>Operation</dt><dd>${escape(view.operationId)}</dd></dl>
  <p>This records a ${reversal ? "compensating withdrawal" : "deposit"} in your portfolio cash ledger. No bank transfer or trade is initiated.</p>
  ${reversal ? '<p>The original deposit remains in the transaction history. This correction cancels its recorded cash effect on the original transaction date.</p>' : ""}
  ${view.status === "confirmation_required" ? `<p class="note">Approval expires at ${escape(view.expiresAt)}. Confirm only if this accurately reflects your cash records.</p><form method="post" action="/cash-operations/${escape(operationId)}"><input type="hidden" name="csrf" value="${escape(view.csrf)}">
    ${settlementNeeded ? `<label for="cash_amount">Exact ${escape(p.baseCurrency)} amount credited to recorded cash</label><input id="cash_amount" name="cash_amount" type="text" inputmode="decimal" autocomplete="off" required><p class="note">Enter the actual converted amount. An exchange rate is not estimated.</p>` : `<p>Recorded ${escape(p.baseCurrency)} cash will ${reversal ? "decrease" : "increase"} by ${escape(p.settlement ?? p.amount)}.</p>`}
    <button type="submit" name="action" value="confirm">${reversal ? "Confirm reversal" : "Confirm deposit"}</button><button type="submit" name="action" value="cancel" formnovalidate>Cancel</button></form>`
    : `<p>${escape(view.message)}</p>${view.result ? `<p>Recorded ${escape(view.result.baseCurrency)} cash balance after this operation: ${escape(view.result.recordedCash ?? "incomplete funding history")}</p>` : ""}`}
  <p><a href="/#portfolio">Back to portfolio</a></p></main></body></html>`, { headers: privateHeaders });
}
