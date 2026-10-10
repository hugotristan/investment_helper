import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveStockQuestion } from "../js/shared/stock-input.js";

const catalog = [
  { ticker: "SNDK", label: "Sandisk Corporation", type: "stock", aliases: ["Sandisk"] },
  { ticker: "CSCO", label: "Cisco Systems", type: "stock", aliases: ["Cisco"] },
  { ticker: "ETN", label: "Eaton Corporation", type: "stock", aliases: ["Eaton"] },
  { ticker: "NOW", label: "ServiceNow", type: "stock", aliases: [] },
  { ticker: "ONE", label: "Shared name", type: "stock", aliases: [] },
  { ticker: "TWO", label: "Shared name", type: "stock", aliases: [] }
];

test("stock checks resolve short and long company names before assuming a ticker", async () => {
  for (const [input, expected] of [["Should I buy Cisco?", "CSCO"], ["Should I sell Sandisk?", "SNDK"],
    ["Eaton", "ETN"], ["NOW", "NOW"], ["Should I hold SNDK?", "SNDK"]]) {
    assert.equal((await resolveStockQuestion(input, { catalog })).ticker, expected);
  }
  for (const input of ["Shared name", "Should I buy Shared name?", "", "Cisco or Eaton?"]) {
    assert.equal(await resolveStockQuestion(input, { catalog }), null);
  }
});
