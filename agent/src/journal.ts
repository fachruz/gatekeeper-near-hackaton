/**
 * The agent's local memory — two small append-only stores kept in
 * `agent/.gatekeeper/` (git-ignored; never committed):
 *
 * 1. Payment journal: every payment this agent has actually made. This is
 *    the authoritative source for the risk engine's "prior interactions
 *    between this agent and the receiver" signal — the agent's own records
 *    of its own behaviour.
 * 2. Witnessed-account registry: accounts the operator itself created,
 *    with the wall-clock time of creation (observed first-hand when the
 *    creation transaction was sent). Used as the account-age source for
 *    those accounts when no indexer is reachable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function stateDir(): string {
  return process.env.GK_STATE_DIR ?? join(process.cwd(), ".gatekeeper");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export interface PaymentRecord {
  agentId: string;
  receiverId: string;
  amountYocto: string;
  txHash: string;
  atMs: number;
}

export function recordPayment(rec: PaymentRecord, dir = stateDir()): void {
  ensureDir(dir);
  appendFileSync(join(dir, "payments.jsonl"), JSON.stringify(rec) + "\n");
}

export function countPriorPayments(
  agentId: string,
  receiverId: string,
  dir = stateDir(),
): number {
  const path = join(dir, "payments.jsonl");
  if (!existsSync(path)) return 0;
  let count = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as PaymentRecord;
      if (rec.agentId === agentId && rec.receiverId === receiverId) count++;
    } catch {
      /* skip malformed lines */
    }
  }
  return count;
}

export interface WitnessedAccount {
  accountId: string;
  createdAtMs: number;
  creationTx?: string;
}

export function registerWitnessedAccount(
  rec: WitnessedAccount,
  dir = stateDir(),
): void {
  ensureDir(dir);
  appendFileSync(join(dir, "accounts.jsonl"), JSON.stringify(rec) + "\n");
}

/** Age in whole days for an operator-created account, or null if unknown. */
export function witnessedAgeDays(
  accountId: string,
  nowMs: number,
  dir = stateDir(),
): number | null {
  const path = join(dir, "accounts.jsonl");
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as WitnessedAccount;
      if (rec.accountId === accountId) {
        return Math.max(0, Math.floor((nowMs - rec.createdAtMs) / 86_400_000));
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return null;
}
