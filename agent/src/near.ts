/**
 * NEAR plumbing for the Gatekeeper agent side: env loading, credentials,
 * connections, and transaction-outcome summaries.
 *
 * Everything here is testnet-only for the hackathon build. Secrets are read
 * from `.env` or from the operator's credentials file (GK_CREDS_FILE); they
 * are never printed and never committed (see agent/.gitignore rules).
 */

import { readFileSync } from "node:fs";
import { Account, Connection, KeyPair, keyStores } from "near-api-js";

export const TESTNET_RPC =
  process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
export const NETWORK_ID = "testnet";

export function explorerTx(txHash: string): string {
  return `https://testnet.nearblocks.io/txns/${txHash}`;
}

export function explorerAccount(accountId: string): string {
  return `https://testnet.nearblocks.io/address/${accountId}`;
}

/** Parse a `.env` file into process.env (without overriding real env vars). */
export function loadDotEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env file is fine; env vars may come from the shell
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export interface CredEntry {
  accountId: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Parse the operator credentials file used by this project: sections headed
 * `## <account-id>` followed by a one-line JSON blob with public_key /
 * private_key fields (the format near-cli seed-phrase export produces).
 */
export function parseCredentialsFile(path: string): Map<string, CredEntry> {
  const text = readFileSync(path, "utf8");
  const out = new Map<string, CredEntry>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^##\s+(\S+)\s*$/);
    if (head) {
      current = head[1];
      continue;
    }
    const trimmed = line.trim();
    if (current && trimmed.startsWith("{")) {
      try {
        const j = JSON.parse(trimmed);
        if (j.public_key && j.private_key) {
          out.set(current, {
            accountId: current,
            publicKey: j.public_key,
            privateKey: j.private_key,
          });
        }
      } catch {
        /* not a credential line */
      }
      current = null;
    }
  }
  return out;
}

/** Build a testnet connection whose keystore holds exactly the given keys. */
export function makeConnection(entries: CredEntry[]): Connection {
  const store = new keyStores.InMemoryKeyStore();
  for (const e of entries) {
    void store.setKey(NETWORK_ID, e.accountId, KeyPair.fromString(e.privateKey as never));
  }
  return Connection.fromConfig({
    networkId: NETWORK_ID,
    provider: { type: "JsonRpcProvider", args: { url: TESTNET_RPC } },
    signer: { type: "InMemorySigner", keyStore: store },
  });
}

export function getAccount(connection: Connection, accountId: string): Account {
  return new Account(connection, accountId);
}

export interface OutcomeSummary {
  txHash: string;
  success: boolean;
  /** Contract log lines containing VERDICT, in order. */
  verdictLogs: string[];
  /** Human-readable failure reason when the transaction failed on-chain. */
  failureReason?: string;
}

/** Reduce a FinalExecutionOutcome to what the demo / wrapper reports. */
export function summarizeOutcome(outcome: unknown): OutcomeSummary {
  const o = outcome as {
    transaction: { hash: string };
    status: unknown;
    receipts_outcome?: Array<{
      outcome: { logs?: string[]; status?: unknown };
    }>;
  };
  const verdictLogs: string[] = [];
  let failureReason: string | undefined;
  const harvest = (status: unknown, logs?: string[]) => {
    for (const log of logs ?? []) {
      if (log.includes("VERDICT")) verdictLogs.push(log);
    }
    if (status && typeof status === "object" && "Failure" in (status as object)) {
      const failure = (status as { Failure: unknown }).Failure;
      const text = JSON.stringify(failure);
      const panic = text.match(/"([^"]*(?:payment blocked|panicked)[^"]*)"/);
      failureReason = panic ? panic[1] : text.slice(0, 300);
    }
  };
  harvest(o.status, undefined);
  for (const r of o.receipts_outcome ?? []) {
    harvest(r.outcome?.status, r.outcome?.logs);
  }
  const success =
    !!o.status && typeof o.status === "object" && "SuccessValue" in (o.status as object);
  return { txHash: o.transaction.hash, success, verdictLogs, failureReason };
}

/** YoctoNEAR (bigint) -> short human string, e.g. 0.05 NEAR. */
export function fmtNear(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const frac = (yocto % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac} NEAR` : `${whole} NEAR`;
}

export const NEAR = (whole: string): bigint => {
  // parse "0.05" style amounts without floating point
  const [w, f = ""] = whole.split(".");
  const frac = (f + "0".repeat(24)).slice(0, 24);
  return BigInt(w) * 10n ** 24n + BigInt(frac || "0");
};

export const GAS_30T = 30_000_000_000_000n;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
