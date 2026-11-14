/**
 * Risk engine — scores a payment receiver from observable signals and merges
 * the on-chain verdict from the Gatekeeper contract into a final decision.
 *
 * Signals (v1, all from public NEAR RPC / nearblocks testnet):
 *   - account age and activity history
 *   - whether the receiver is a contract, and how recently its code changed
 *   - prior interactions between this agent and the receiver
 *   - shared blocklist status (read from the contract, not computed here)
 *
 * This module is pure and deterministic on purpose: the same signals always
 * produce the same score, so judges can reproduce every verdict offline.
 */

export interface ReceiverSignals {
  /** Days since the account was first seen on-chain; null = unknown brand-new. */
  accountAgeDays: number | null;
  /** True when the account holds contract code. */
  isContract: boolean;
  /** Days since the deployed code hash last changed; null = not a contract / unknown. */
  codeChangedDaysAgo: number | null;
  /** How many times this agent has already paid this receiver. */
  priorInteractions: number;
  /** On-chain blocklist status from the Gatekeeper contract. */
  blocklisted: boolean;
  /** Distinct reports filed against this receiver (below the block threshold). */
  reportCount: number;
}

export type Verdict = "allow" | "warn" | "block";

export interface RiskResult {
  verdict: Verdict;
  /** 0 = clean, 100 = certain bad. */
  score: number;
  reasons: string[];
}

export function scoreReceiver(s: ReceiverSignals): RiskResult {
  if (s.blocklisted) {
    return {
      verdict: "block",
      score: 100,
      reasons: ["receiver is on the shared on-chain blocklist"],
    };
  }

  let score = 0;
  const reasons: string[] = [];

  if (s.accountAgeDays === null) {
    score += 30;
    reasons.push("account age unknown (no on-chain history found)");
  } else if (s.accountAgeDays < 7) {
    score += 25;
    reasons.push(`account is only ${s.accountAgeDays} day(s) old`);
  }

  if (s.isContract) {
    score += 10;
    reasons.push("receiver is a contract account");
    if (s.codeChangedDaysAgo !== null && s.codeChangedDaysAgo < 7) {
      score += 25;
      reasons.push(
        `contract code changed ${s.codeChangedDaysAgo} day(s) ago (upgradeable / recently swapped code)`,
      );
    }
  }

  if (s.priorInteractions === 0) {
    score += 10;
    reasons.push("agent has never paid this receiver before");
  }

  if (s.reportCount > 0) {
    score += Math.min(30, s.reportCount * 15);
    reasons.push(
      `${s.reportCount} report(s) filed against this receiver (below block threshold)`,
    );
  }

  const verdict: Verdict = score >= 60 ? "block" : score >= 30 ? "warn" : "allow";
  if (reasons.length === 0) reasons.push("no risk signals raised");
  return { verdict, score, reasons };
}

/**
 * Live signal fetching lives in signals.ts (kept separate so this module
 * stays pure): it reads the blocklist from the contract, account facts from
 * NEAR RPC / nearblocks, and prior interactions from the agent's journal,
 * and returns the ReceiverSignals scored above.
 */
export { fetchSignals, type SignalDeps } from "./signals.ts";
