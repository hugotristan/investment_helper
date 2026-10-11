import test from "node:test";
import assert from "node:assert/strict";
import { reportCsv } from "../js/shared/report-export.js";

test("CSV preserves numeric losses, quotes, line breaks, and missing values while neutralizing text formulas", () => {
  const csv = reportCsv(["Name", "Value", "Note"], [["Microsoft, Inc", -12.5, 'He said "buy"\nLater'], ["=HYPERLINK(1)", null, "  +SUM(1)"], ["@data", Infinity, "-text"]]);
  assert(csv.startsWith("\uFEFF\"Name\""));
  assert(csv.includes('"Microsoft, Inc","-12.5","He said ""buy""\nLater"'));
  assert(csv.includes('"\'=HYPERLINK(1)","","\'  +SUM(1)"'));
  assert(csv.includes('"\'@data","","\'-text"'));
});
