import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreReceiver, type ReceiverSignals } from "../src/risk.ts";

const cleanMerchant: ReceiverSignals = {
  accountAgeDays: 400,
  isContract: false,
  codeChangedDaysAgo: null,
  priorInteractions: 12,
  blocklisted: false,
  reportCount: 0,
};

test("known merchant scores allow", () => {
  const r = scoreReceiver(cleanMerchant);
  assert.equal(r.verdict, "allow");
});

test("blocklisted receiver is always blocked at score 100", () => {
  const r = scoreReceiver({ ...cleanMerchant, blocklisted: true, reportCount: 4 });
  assert.equal(r.verdict, "block");
  assert.equal(r.score, 100);
});

test("brand-new contract with freshly changed code warns or blocks", () => {
  const r = scoreReceiver({
    accountAgeDays: 2,
    isContract: true,
    codeChangedDaysAgo: 1,
    priorInteractions: 0,
    blocklisted: false,
    reportCount: 0,
  });
  assert.notEqual(r.verdict, "allow");
});

test("unknown-age first-time receiver at least warns", () => {
  const r = scoreReceiver({
    accountAgeDays: null,
    isContract: false,
    codeChangedDaysAgo: null,
    priorInteractions: 0,
    blocklisted: false,
    reportCount: 0,
  });
  assert.equal(r.verdict, "warn");
});

test("reports below the block threshold raise the score", () => {
  const r = scoreReceiver({ ...cleanMerchant, reportCount: 2 });
  assert.ok(r.score > scoreReceiver(cleanMerchant).score);
});
