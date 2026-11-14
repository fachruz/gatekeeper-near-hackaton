import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeVerdicts } from "../src/agent.ts";
import { ageDaysFromNearblocksTxns, ageDaysFromNsTimestamp } from "../src/signals.ts";
import {
  countPriorPayments,
  recordPayment,
  registerWitnessedAccount,
  witnessedAgeDays,
} from "../src/journal.ts";
import type { RiskResult } from "../src/risk.ts";

const risk = (verdict: RiskResult["verdict"], reasons: string[]): RiskResult => ({
  verdict,
  score: 0,
  reasons,
});

test("merge: contract block beats off-chain allow", () => {
  const m = mergeVerdicts(risk("allow", ["clean"]), { verdict: "block", reasons: ["over cap"] });
  assert.equal(m.verdict, "block");
  assert.deepEqual(m.reasons, ["off-chain risk: clean", "contract check: over cap"]);
});

test("merge: off-chain block beats contract warn", () => {
  const m = mergeVerdicts(risk("block", ["blocklisted"]), { verdict: "warn", reasons: ["above threshold"] });
  assert.equal(m.verdict, "block");
});

test("merge: warn beats allow, reasons carry their layer labels", () => {
  const m = mergeVerdicts(risk("warn", ["a"]), { verdict: "allow", reasons: ["b"] });
  assert.equal(m.verdict, "warn");
  assert.deepEqual(m.reasons, ["off-chain risk: a", "contract check: b"]);
});

test("age from nanosecond timestamp", () => {
  const nowMs = 100 * 86_400_000;
  assert.equal(ageDaysFromNsTimestamp(String(90 * 86_400_000 * 1_000_000), nowMs), 10);
  assert.equal(ageDaysFromNsTimestamp(String(nowMs * 1_000_000), nowMs), 0);
});

test("age from nearblocks txns shapes", () => {
  const nowMs = 100 * 86_400_000;
  const ts = String(95 * 86_400_000 * 1_000_000);
  assert.equal(ageDaysFromNearblocksTxns({ txns: [{ block_timestamp: ts }] }, nowMs), 5);
  assert.equal(ageDaysFromNearblocksTxns([{ block_timestamp: ts }], nowMs), 5);
  assert.equal(ageDaysFromNearblocksTxns({ txns: [] }, nowMs), null);
  assert.equal(ageDaysFromNearblocksTxns({ nope: true }, nowMs), null);
});

test("journal counts only this agent's payments to this receiver", () => {
  const dir = mkdtempSync(join(tmpdir(), "gk-journal-"));
  recordPayment({ agentId: "a.testnet", receiverId: "m.testnet", amountYocto: "1", txHash: "x", atMs: 1 }, dir);
  recordPayment({ agentId: "a.testnet", receiverId: "m.testnet", amountYocto: "2", txHash: "y", atMs: 2 }, dir);
  recordPayment({ agentId: "a.testnet", receiverId: "other.testnet", amountYocto: "3", txHash: "z", atMs: 3 }, dir);
  recordPayment({ agentId: "b.testnet", receiverId: "m.testnet", amountYocto: "4", txHash: "w", atMs: 4 }, dir);
  assert.equal(countPriorPayments("a.testnet", "m.testnet", dir), 2);
  assert.equal(countPriorPayments("a.testnet", "nobody.testnet", dir), 0);
});

test("witnessed registry returns whole-day age, null when unknown", () => {
  const dir = mkdtempSync(join(tmpdir(), "gk-witness-"));
  const t0 = 1_000_000_000_000;
  registerWitnessedAccount({ accountId: "new.testnet", createdAtMs: t0 }, dir);
  assert.equal(witnessedAgeDays("new.testnet", t0 + 3 * 86_400_000 + 5, dir), 3);
  assert.equal(witnessedAgeDays("new.testnet", t0, dir), 0);
  assert.equal(witnessedAgeDays("ghost.testnet", t0, dir), null);
});
