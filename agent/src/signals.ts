/**
 * Live signal fetching for the risk engine (risk.ts holds the pure scoring;
 * this module gathers the facts). Every signal names its source:
 *
 *   blocklisted / reportCount — the Gatekeeper contract's `get_block_entry`
 *                               view. Authoritative and on-chain.
 *   isContract                — NEAR RPC `view_account` (code_hash present).
 *   accountAgeDays            — nearblocks testnet indexer's earliest
 *                               transaction for the account when reachable;
 *                               otherwise the operator-witnessed registry
 *                               (accounts this operator created itself);
 *                               otherwise null (unknown). This sandbox's
 *                               egress is Cloudflare-blocked by nearblocks,
 *                               so the fallback matters in practice.
 *   priorInteractions         — the agent's own payment journal (its record
 *                               of payments it has actually made).
 *   codeChangedDaysAgo        — not observable without an indexer history;
 *                               reported as null (unknown), never invented.
 */

import type { Account } from "near-api-js";
import type { ReceiverSignals } from "./risk.ts";
import { countPriorPayments, witnessedAgeDays } from "./journal.ts";

const EMPTY_CODE_HASH = "11111111111111111111111111111111";
export const NEARBLOCKS_API =
  process.env.NEARBLOCKS_API_URL ?? "https://testnet.nearblocks.io/api/v1";

/** Whole days between a nanosecond chain timestamp and now. */
export function ageDaysFromNsTimestamp(ns: string, nowMs: number): number {
  const ms = Number(BigInt(ns) / 1_000_000n);
  return Math.max(0, Math.floor((nowMs - ms) / 86_400_000));
}

/**
 * Extract the account's age in days from a nearblocks `/txns?order=asc`
 * response (earliest transaction first). Tolerant of the wrapper shapes
 * the API has used; returns null when nothing parseable is present.
 */
export function ageDaysFromNearblocksTxns(json: unknown, nowMs: number): number | null {
  const j = json as { txns?: unknown; data?: unknown };
  const list = Array.isArray(json) ? json : Array.isArray(j?.txns) ? j.txns : Array.isArray(j?.data) ? j.data : null;
  if (!list || list.length === 0) return null;
  const first = list[0] as { block_timestamp?: string };
  if (!first?.block_timestamp) return null;
  return ageDaysFromNsTimestamp(first.block_timestamp, nowMs);
}

async function nearblocksAgeDays(accountId: string, nowMs: number): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4_000);
    const res = await fetch(
      `${NEARBLOCKS_API}/account/${accountId}/txns?order=asc&per_page=1`,
      { signal: ctrl.signal, headers: { accept: "application/json" } },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    return ageDaysFromNearblocksTxns(await res.json(), nowMs);
  } catch {
    return null; // indexer unreachable -> caller's fallback decides
  }
}

export interface SignalDeps {
  /** Any account on the testnet connection; used for read-only view calls. */
  viewer: Account;
  contractId: string;
  agentId: string;
  stateDir?: string;
  nowMs?: number;
}

export async function fetchSignals(
  deps: SignalDeps,
  receiverId: string,
): Promise<ReceiverSignals> {
  const nowMs = deps.nowMs ?? Date.now();

  // The three sources are independent — fetch them in parallel.
  const [entry, accountView, nearblocksAge] = await Promise.all([
    deps.viewer.viewFunction({
      contractId: deps.contractId,
      methodName: "get_block_entry",
      args: { receiver: receiverId },
    }) as Promise<{ report_count: number; blocked: boolean } | null>,
    deps.viewer.connection.provider.query({
      request_type: "view_account",
      finality: "final",
      account_id: receiverId,
    }) as Promise<unknown>,
    nearblocksAgeDays(receiverId, nowMs),
  ]);
  const codeHash = (accountView as { code_hash: string }).code_hash;

  let accountAgeDays = nearblocksAge;
  if (accountAgeDays === null) {
    accountAgeDays = witnessedAgeDays(receiverId, nowMs, deps.stateDir);
  }

  return {
    accountAgeDays,
    isContract: codeHash !== EMPTY_CODE_HASH,
    codeChangedDaysAgo: null,
    priorInteractions: countPriorPayments(deps.agentId, receiverId, deps.stateDir),
    blocklisted: entry?.blocked ?? false,
    reportCount: entry?.report_count ?? 0,
  };
}
