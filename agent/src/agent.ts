/**
 * Agent wrapper — the only path by which the AI agent can move money.
 *
 * Flow for every payment:
 *   1. fetchSignals(agent, receiver)                  (signals.ts)
 *   2. scoreReceiver(signals) + contract check(agent, receiver, amount)
 *      merged by strictest verdict (block > warn > allow)
 *   3. verdict "block" -> refuse to sign, log the reasons, done.
 *      verdict "warn"  -> require an explicit human approval.
 *      verdict "allow" -> sign `pay` on the Gatekeeper contract.
 *
 * The signing key is a NEAR function-call access key scoped to the single
 * method `pay` on the Gatekeeper contract, with a bounded allowance. The
 * agent process never holds a full-access key: it cannot transfer NEAR
 * directly, cannot call other contracts/methods, and cannot add keys.
 * The contract re-enforces blocklist + caps on-chain, so even a fully
 * prompt-injected agent cannot force a policy violation through this key —
 * payBypassingChecks() below exists so the demo can prove exactly that.
 */

import { createInterface } from "node:readline/promises";
import { transactions, type Account } from "near-api-js";
import { scoreReceiver, type RiskResult, type Verdict } from "./risk.ts";
import { fetchSignals } from "./signals.ts";
import { recordPayment } from "./journal.ts";
import { GAS_30T, summarizeOutcome, type OutcomeSummary } from "./near.ts";

export interface PaymentRequest {
  receiverId: string;
  /** Amount in yoctoNEAR, as a decimal string. */
  amountYocto: string;
  memo?: string;
}

export interface PaymentOutcome {
  verdict: Verdict;
  reasons: string[];
  /** Off-chain risk score (0-100) that fed the merged verdict. */
  score?: number;
  /** Set when the human gate was consulted for a "warn" verdict. */
  humanApproved?: boolean;
  /** Transaction hash when a payment was actually signed and sent. */
  txHash?: string;
  /** On-chain result when the contract was actually called. */
  onChain?: OutcomeSummary;
}

export interface ContractCheck {
  verdict: Verdict;
  reasons: string[];
}

const RANK: Record<Verdict, number> = { allow: 0, warn: 1, block: 2 };

/** Merge the off-chain risk verdict with the contract's check() verdict. */
export function mergeVerdicts(risk: RiskResult, check: ContractCheck): ContractCheck {
  const verdict = RANK[check.verdict] > RANK[risk.verdict] ? check.verdict : risk.verdict;
  // Reasons keep their layer label: when both layers fire on the same fact
  // (e.g. the blocklist), the reader can see each layer spoke for itself.
  const reasons = [
    ...risk.reasons.map((r) => `off-chain risk: ${r}`),
    ...check.reasons.map((r) => `contract check: ${r}`),
  ];
  return { verdict, reasons: [...new Set(reasons)] };
}

export type ApprovalCallback = (
  req: PaymentRequest,
  risk: RiskResult,
) => Promise<boolean>;

export interface GatekeeperAgentOptions {
  /** Account object whose keystore holds ONLY the function-call key. */
  account: Account;
  contractId: string;
  agentAccountId: string;
  /** Human gate for "warn". Default: TTY prompt; non-TTY defaults to NO. */
  approval?: ApprovalCallback;
  stateDir?: string;
  log?: (msg: string) => void;
}

export class GatekeeperAgent {
  private readonly account: Account;
  private readonly contractId: string;
  private readonly agentAccountId: string;
  private readonly approval?: ApprovalCallback;
  private readonly stateDir?: string;
  private readonly log: (msg: string) => void;

  constructor(opts: GatekeeperAgentOptions) {
    this.account = opts.account;
    this.contractId = opts.contractId;
    this.agentAccountId = opts.agentAccountId;
    this.approval = opts.approval;
    this.stateDir = opts.stateDir;
    this.log = opts.log ?? ((m) => console.log(m));
  }

  /** The contract's own pre-flight verdict (view call, no signing). */
  async contractCheck(req: PaymentRequest): Promise<ContractCheck> {
    const res = (await this.account.viewFunction({
      contractId: this.contractId,
      methodName: "check",
      args: {
        agent: this.agentAccountId,
        receiver: req.receiverId,
        amount: req.amountYocto,
      },
    })) as { verdict: Verdict; reasons: string[] };
    return res;
  }

  async pay(req: PaymentRequest): Promise<PaymentOutcome> {
    const signals = await fetchSignals(
      {
        viewer: this.account,
        contractId: this.contractId,
        agentId: this.agentAccountId,
        stateDir: this.stateDir,
      },
      req.receiverId,
    );
    const risk = scoreReceiver(signals);
    const check = await this.contractCheck(req);
    const merged = mergeVerdicts(risk, check);

    if (merged.verdict === "block") {
      this.log(`    >> BLOCK — refusing to sign.`);
      return { verdict: "block", reasons: merged.reasons, score: risk.score };
    }

    let humanApproved: boolean | undefined;
    if (merged.verdict === "warn") {
      humanApproved = await this.requestHumanApproval(req, risk);
      if (!humanApproved) {
        this.log(`    >> WARN — human did not approve; not signing.`);
        return {
          verdict: "warn",
          reasons: merged.reasons,
          score: risk.score,
          humanApproved,
        };
      }
      this.log(`    >> WARN — human approved; proceeding to sign.`);
    }

    const onChain = await this.submitPay(req);
    if (onChain.success) {
      recordPayment(
        {
          agentId: this.agentAccountId,
          receiverId: req.receiverId,
          amountYocto: req.amountYocto,
          txHash: onChain.txHash,
          atMs: Date.now(),
        },
        this.stateDir,
      );
    }
    return {
      verdict: merged.verdict,
      reasons: merged.reasons,
      score: risk.score,
      humanApproved,
      txHash: onChain.txHash,
      onChain,
    };
  }

  /**
   * Sign `pay` directly, skipping every off-chain check — what a
   * prompt-injected agent holding the function-call key would do. The
   * contract is the last line of defence; the demo uses this to prove the
   * refusal happens on-chain even when the wrapper is bypassed.
   */
  async payBypassingChecks(req: PaymentRequest): Promise<OutcomeSummary> {
    return this.submitPay(req);
  }

  private async submitPay(req: PaymentRequest): Promise<OutcomeSummary> {
    const args = new TextEncoder().encode(
      JSON.stringify({ receiver: req.receiverId, amount: req.amountYocto }),
    );
    const outcome = await this.account.signAndSendTransaction({
      receiverId: this.contractId,
      actions: [transactions.functionCall("pay", args, GAS_30T, 0n)],
      returnError: true,
    });
    return summarizeOutcome(outcome);
  }

  /** Human-in-the-loop gate for "warn" verdicts. */
  async requestHumanApproval(
    req: PaymentRequest,
    risk: RiskResult,
  ): Promise<boolean> {
    if (this.approval) return this.approval(req, risk);
    if (!process.stdin.isTTY) return false; // safe default: no human, no pay
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await rl.question(
        `!! WARN (risk ${risk.score}): pay ${req.amountYocto} yocto to ${req.receiverId}? [y/N] `,
      );
      return /^y(es)?$/i.test(answer.trim());
    } finally {
      rl.close();
    }
  }
}
