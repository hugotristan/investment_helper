import assert from "node:assert/strict";
import test from "node:test";
import { parseDecimalInput } from "../js/shared/decimal.js";

test("decimal form values accept comma or dot without rounding fractional shares", () => {
  for (const [input, expected] of [["123,45", 123.45], ["123.45", 123.45], [",5", .5], [".5", .5],
    ["0,00000001", .00000001], ["12,", 12], [" 250,50 ", 250.5], ["-2,5", -2.5], [0, 0]]) {
    assert.equal(parseDecimalInput(input), expected, String(input));
  }
  assert.equal(parseDecimalInput("0,00000001", { min: .00000001 }), .00000001);
  assert.ok(Number.isNaN(parseDecimalInput("0,000000001", { min: .00000001 })));
});

test("ambiguous grouped, malformed, empty and non-finite amounts cannot become saved money", () => {
  for (const input of ["", " ", ",", ".", "-", "1,234.56", "1.234,56", "1,2,3", "1 234,56",
    "€12,50", "12,50 USD", "1e3", "0x10", "Infinity", "NaN", Infinity, NaN, null, true, {}]) {
    assert.ok(Number.isNaN(parseDecimalInput(input)), String(input));
  }
});
