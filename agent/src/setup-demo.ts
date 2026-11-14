/**
 * Demo setup — creates a FRESH, self-contained Gatekeeper demo state on
 * NEAR testnet. Nothing here depends on earlier runs: every run makes its
 * own agent / merchant / drainer accounts under the operator account,
 * registers a policy, funds the vault, issues the agent's function-call
 * key, and gets the drainer onto the shared blocklist with 3 reports.
 *
 * The operator is the only pre-existing account needed: one faucet-funded
 * testnet account with a full-access key (env OPERATOR_PRIVATE_KEY, or the
 * project credentials file via GK_CREDS_FILE). Reporters r1/r2/r3 under the
 * operator are reused when their keys are available (their (reporter,
 * receiver) pairs are fresh because the drainer is new); otherwise three
 * fresh reporter accounts are created.
 *
 * Budget per run (testnet play money): ~0.35 NEAR.
 *   agent 0.25 (0.15 goes into its vault) · merchant 0.03 · drainer 0.03
 *   function-call key allowance 0.05 · reporter top-ups only if created.
 *
 * New keys are appended to the credentials file when GK_CREDS_FILE is set;
 * the agent's function-call key is labelled as such and stored under its
 * own heading so it can never be mistaken for a full-access key.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KeyPair, type Account } from "near-api-js";
import {
  GAS_30T,
  NEAR,
  fmtNear,
  getAccount,
  loadDotEnv,
  makeConnection,
  parseCredentialsFile,
  summarizeOutcome,
  type CredEntry,
} from "./near.ts";
import { registerWitnessedAccount, stateDir } from "./journal.ts";

export const POLICY = {
  maxPerTx: NEAR("0.1"),
  maxPerDay: NEAR("0.2"),
  warnAbove: NEAR("0.04"),
};
export const VAULT_DEPOSIT = NEAR("0.15");
export const FC_KEY_ALLOWANCE = NEAR("0.05");

const FUND = { agent: NEAR("0.25"), merchant: NEAR("0.03"), drainer: NEAR("0.03"), reporter: NEAR("0.03") };

export interface DemoSetup {
  runId: string;
  contractId: string;
  agentId: string;
  merchantId: string;
  drainerId: string;
  reporterIds: string[];
  agentFullKey: CredEntry;
  agentFcKey: CredEntry;
  txs: Record<string, string>;
}

function resolveOperator(): CredEntry {
  loadDotEnv(join(process.cwd(), ".env"));
  const id = process.env.OPERATOR_ACCOUNT_ID;
  const key = process.env.OPERATOR_PRIVATE_KEY;
  if (id && key) {
    return { accountId: id, publicKey: "", privateKey: key };
  }
  const credsFile = process.env.GK_CREDS_FILE;
  if (credsFile) {
    const creds = parseCredentialsFile(credsFile);
    const wanted = process.env.GK_OPERATOR_ACCOUNT ?? "gatekeeper-dev-1e0e16a9.testnet";
    const entry = creds.get(wanted);
    if (entry) return entry;
  }
  throw new Error(
    "No operator credentials: set OPERATOR_ACCOUNT_ID + OPERATOR_PRIVATE_KEY, or GK_CREDS_FILE.",
  );
}

function loadCredsIfAny(): Map<string, CredEntry> {
  const credsFile = process.env.GK_CREDS_FILE;
  if (!credsFile) return new Map();
  try {
    return parseCredentialsFile(credsFile);
  } catch {
    return new Map();
  }
}

function freshKey(accountId: string): CredEntry {
  const kp = KeyPair.fromRandom("ed25519");
  return { accountId, publicKey: kp.getPublicKey().toString(), privateKey: kp.toString() };
}

export async function setupDemo(log: (m: string) => void = console.log): Promise<DemoSetup> {
  const contractId =
    process.env.CONTRACT_ID ?? "gatekeeper.gatekeeper-dev-1e0e16a9.testnet";
  const operator = resolveOperator();
  const creds = loadCredsIfAny();
  const runId = Date.now().toString(36).slice(-6);
  const parent = operator.accountId;
  const agentId = `agent-${runId}.${parent}`;
  const merchantId = `shop-${runId}.${parent}`;
  const drainerId = `drainer-${runId}.${parent}`;

  const agentFullKey = freshKey(agentId);
  const merchantKey = freshKey(merchantId);
  const drainerKey = freshKey(drainerId);
  const agentFcKey = freshKey(agentId);

  const connection = makeConnection([
    operator,
    agentFullKey,
    merchantKey,
    drainerKey,
    ...creds.values(),
  ]);
  const operatorAccount = getAccount(connection, parent);
  const txs: Record<string, string> = {};

  const createSub = async (key: CredEntry, amount: bigint, label: string) => {
    const outcome = await operatorAccount.createAccount(key.accountId, key.publicKey, amount);
    const s = summarizeOutcome(outcome);
    txs[`create_${label}`] = s.txHash;
    registerWitnessedAccount({ accountId: key.accountId, createdAtMs: Date.now(), creationTx: s.txHash });
    log(`    created ${key.accountId} (funded ${fmtNear(amount)}) — tx ${s.txHash}`);
  };

  log(`  · creating fresh demo accounts under ${parent} (run ${runId})`);
  await createSub(agentFullKey, FUND.agent, "agent");
  await createSub(merchantKey, FUND.merchant, "merchant");
  await createSub(drainerKey, FUND.drainer, "drainer");

  // Reporters: reuse r1/r2/r3 under the operator when we hold their keys.
  const reporterIds: string[] = [];
  const reporterEntries: CredEntry[] = [];
  for (const name of ["r1", "r2", "r3"]) {
    const id = `${name}.${parent}`;
    const entry = creds.get(id);
    if (entry) {
      reporterIds.push(id);
      reporterEntries.push(entry);
    }
  }
  if (reporterIds.length < 3) {
    reporterIds.length = 0;
    reporterEntries.length = 0;
    for (const name of ["rep1", "rep2", "rep3"]) {
      const key = freshKey(`${name}-${runId}.${parent}`);
      await createSub(key, FUND.reporter, name);
      reporterIds.push(key.accountId);
      reporterEntries.push(key);
    }
  }

  const agentFull = getAccount(connection, agentId);

  // The agent's function-call key: `pay` on the Gatekeeper contract ONLY.
  const addKeyOutcome = await agentFull.addKey(
    agentFcKey.publicKey,
    contractId,
    ["pay"],
    FC_KEY_ALLOWANCE,
  );
  txs.add_fc_key = summarizeOutcome(addKeyOutcome).txHash;
  log(`    function-call key issued to the agent (pay on ${contractId} only, ${fmtNear(FC_KEY_ALLOWANCE)} allowance) — tx ${txs.add_fc_key}`);

  // Policy + vault funding are operator setup steps, signed with the
  // agent account's full key. The agent runtime never sees that key.
  const policyOutcome = await agentFull.functionCall({
    contractId,
    methodName: "set_policy",
    args: {
      max_per_tx: POLICY.maxPerTx.toString(),
      max_per_day: POLICY.maxPerDay.toString(),
      warn_above: POLICY.warnAbove.toString(),
    },
    gas: GAS_30T,
    attachedDeposit: 0n,
  });
  txs.set_policy = summarizeOutcome(policyOutcome).txHash;
  log(`    policy registered: per-tx cap ${fmtNear(POLICY.maxPerTx)}, daily cap ${fmtNear(POLICY.maxPerDay)}, human approval above ${fmtNear(POLICY.warnAbove)} — tx ${txs.set_policy}`);

  const depositOutcome = await agentFull.functionCall({
    contractId,
    methodName: "deposit",
    args: {},
    gas: GAS_30T,
    attachedDeposit: VAULT_DEPOSIT,
  });
  txs.deposit = summarizeOutcome(depositOutcome).txHash;
  log(`    vault funded with ${fmtNear(VAULT_DEPOSIT)} — tx ${txs.deposit}`);

  // Community reports push the fresh drainer over the block threshold (3).
  for (const [i, entry] of reporterEntries.entries()) {
    const reporter = getAccount(connection, entry.accountId);
    const outcome = await reporter.functionCall({
      contractId,
      methodName: "report",
      args: {
        receiver: drainerId,
        evidence_ref: `live-demo run ${runId}: drainer soliciting via poisoned invoice (report ${i + 1}/3)`,
      },
      gas: GAS_30T,
      attachedDeposit: 0n,
    });
    txs[`report_${i + 1}`] = summarizeOutcome(outcome).txHash;
  }
  const entry = (await operatorAccount.viewFunction({
    contractId,
    methodName: "get_block_entry",
    args: { receiver: drainerId },
  })) as { report_count: number; blocked: boolean } | null;
  if (!entry?.blocked) {
    throw new Error(`setup failed: drainer not blocked after 3 reports (${JSON.stringify(entry)})`);
  }
  log(`    drainer blocklisted by 3 independent reports — tx ${txs.report_1}, ${txs.report_2}, ${txs.report_3}`);

  const setup: DemoSetup = {
    runId,
    contractId,
    agentId,
    merchantId,
    drainerId,
    reporterIds,
    agentFullKey,
    agentFcKey,
    txs,
  };

  // Persist the manifest + keys. Keys go ONLY to the credentials file
  // (chmod 600, outside the repo) and to the git-ignored state dir.
  writeFileSync(join(stateDir(), `run-${runId}.json`), JSON.stringify(setup, null, 2));
  const credsFile = process.env.GK_CREDS_FILE;
  if (credsFile) {
    const blob = (e: CredEntry) =>
      JSON.stringify({ public_key: e.publicKey, private_key: e.privateKey });
    appendFileSync(
      credsFile,
      `\n## ${agentId}\n${blob(agentFullKey)}\n### function-call key (pay only on ${contractId}) for ${agentId}\n${blob(agentFcKey)}\n## ${merchantId}\n${blob(merchantKey)}\n## ${drainerId}\n${blob(drainerKey)}\n`,
    );
  }
  return setup;
}

// Standalone: `node src/setup-demo.ts` prints the manifest JSON.
if (import.meta.url === `file://${process.argv[1]}`) {
  const setup = await setupDemo();
  console.log(JSON.stringify(setup, null, 2));
}
