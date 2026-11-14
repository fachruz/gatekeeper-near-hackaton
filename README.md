# Gatekeeper — a pre-flight security firewall for AI agent payments on NEAR

**Track:** NEAR HACKATHON — AI Security & Defense (`security`) · also entered in Agent Economy (`agents`)
**Status:** Complete and verified live on NEAR testnet (Wed 11 Nov 2026): contract deployed, agent wrapper wired to it, the full attack demo runs end-to-end on-chain, and a rendered demo video ships in `demo/`. Submission Sat 14 Nov.
**Contract (testnet):** `gatekeeper.gatekeeper-dev-1e0e16a9.testnet` — deploy tx [`4vcyHQK31y2EmTQhrm9MQ6XCkHWp3aCKphmTpDCsh9i8`](https://testnet.nearblocks.io/txns/4vcyHQK31y2EmTQhrm9MQ6XCkHWp3aCKphmTpDCsh9i8). Build: `cd contract && cargo near build non-reproducible-wasm` (artifact SHA-256 `ef0ee239c872b4b257e4c73bf746c9ffd7b4bb2607478222e90ab31968a574f0`, matches the on-chain code hash).
**Demo video:** [`demo/gatekeeper-demo.mp4`](demo/gatekeeper-demo.mp4) (1m42s, 1080p) — a real recorded live run; only the network waits were trimmed, no output was altered. Source recording: `demo/gatekeeper-demo.cast`; full transcript: `demo/demo-transcript.txt`.

## The problem

AI agents are starting to hold and move real money. The moment an agent has a
signing key, a single prompt injection, a poisoned invoice, or a hallucinated
address can drain it — the agent itself cannot be trusted to police its own
payments, because the thing being attacked *is* the decision-maker.

## What Gatekeeper does

Gatekeeper puts the enforcement **outside the agent's head and inside a NEAR
smart contract**, in two layers:

1. **Pre-flight counterparty check.** Before paying, the agent asks about the
   receiver: account age and activity, whether it is a contract and whether its
   code changed recently, prior interactions with this agent, and its status on
   a **shared on-chain blocklist** that any agent can report bad actors to, with
   evidence attached. The answer is `allow`, `warn`, or `block` — with reasons.
2. **On-chain policy vault.** The agent's funds sit in the Gatekeeper contract
   on NEAR testnet. Every `pay` call is enforced *by the contract*: blocklist
   first, then a per-transaction cap, then a daily cap. Even a fully
   prompt-injected agent cannot force a payment that violates policy. The
   agent signs with a **function-call access key scoped to the single `pay`
   method**, never a full-access key (limits explained under
   [Security model](#security-model)).

An **attack demo** ships with the repo: a prompt-injected agent is instructed
by a poisoned "invoice" to pay a blocklisted drainer and to overspend its cap.
Both are stopped — first by the agent wrapper, and again on-chain when the
wrapper is bypassed; a legitimate payment goes through. Full log included.

## How NEAR fits

- **Smart contract (Rust, near-sdk)** — policy registry, shared blocklist and
  the enforcing vault are one contract on NEAR testnet. This is the product,
  not a wrapper around someone else's chain.
- **Function-call access keys** — the agent's key can call exactly one method
  on exactly one contract, with a bounded gas allowance. This is NEAR's native
  least-privilege primitive for agent wallets.
- **On-chain event log** — every verdict (`BLOCK`/`WARN`/`ALLOW`) is emitted by
  the contract, giving an audit trail no off-chain guard can forge.
- **NEAR AI Cloud (optional layer)** — invoice/memo text can be screened for
  injection patterns. It sits behind an env flag with a deterministic fallback,
  so the whole demo runs with **no API key**.

## Architecture

```
                ┌──────────────────── agent (TypeScript) ───────────────────┐
 poisoned       │  pay(receiver, amount, memo)                              │
 invoice ─────► │    1. risk.ts ──► signals (RPC / nearblocks) + contract   │
                │                   check()  ──► allow | warn | block       │
                │    2. block → refuse & log   warn → human approves (CLI)  │
                │    3. allow → sign with function-call key (pay only)      │
                └────────────────────────┬──────────────────────────────────┘
                                         │ pay()
                ┌────────────────────────▼──────────────────────────────────┐
                │  gatekeeper contract (NEAR testnet, Rust)                 │
                │  policy registry · shared blocklist · vault               │
                │  enforces: blocklist → per-tx cap → daily cap → transfer  │
                └───────────────────────────────────────────────────────────┘
```

### Where each risk signal comes from (stated plainly)

| Signal | Source |
|---|---|
| blocklisted / report count | the contract's `get_block_entry` view — on-chain, authoritative |
| is a contract | NEAR RPC `view_account` (`code_hash`) |
| account age | nearblocks testnet indexer's earliest transaction when reachable; otherwise the operator-witnessed registry (accounts the operator created itself, with creation time); otherwise *unknown* — never invented |
| prior interactions | the agent's own payment journal (its record of payments it actually made) |
| code-changed recency | not observable without indexer history → reported as unknown (`null`) |

## Try it (do X — see Y)

### Path A — offline, no accounts, no keys

1. Contract logic tests:
   `cd contract && cargo test`
   → See Y: **22 unit tests pass** — policy evaluation order, cap edges
   (exactly-at-cap vs one unit over), the daily-cap window and its next-day
   reset, the 3-report blocklist threshold, duplicate-report and
   no-policy rejections.
2. Agent-side tests (risk scoring, verdict merging, signal parsing, journal):
   `cd agent && npm install && npm test`
   → See Y: **12 tests pass**.
3. Offline attack demo (canned signals, real scoring code):
   `cd agent && npm run demo:attack`
   → See Y: a three-attempt log — `BLOCK` (blocklisted drainer), `BLOCK`
   (over the per-tx cap), `ALLOW` (legitimate payment).

### Path B — inspect the live contract, read-only, no keys

The contract from the recorded demo run is live; these are plain RPC view
calls (paste into a terminal):

4. See the blocklist entry the demo created (3 reports, blocked):
   `curl -s https://rpc.testnet.near.org -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"q","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"gatekeeper.gatekeeper-dev-1e0e16a9.testnet","method_name":"get_block_entry","args_base64":"eyJyZWNlaXZlciI6ImRyYWluZXItYnpzbjV2LmdhdGVrZWVwZXItZGV2LTFlMGUxNmE5LnRlc3RuZXQifQo="}}'`
   → See Y: `"blocked":true,"report_count":3` with three evidence strings.
5. Ask the contract for a pre-flight verdict:
   same call with `"method_name":"check"` and
   `"args_base64":"eyJhZ2VudCI6ImFnZW50LWJ6c241di5nYXRla2VlcGVyLWRldi0xZTBlMTZhOS50ZXN0bmV0IiwicmVjZWl2ZXIiOiJzaG9wLWJ6c241di5nYXRla2VlcGVyLWRldi0xZTBlMTZhOS50ZXN0bmV0IiwiYW1vdW50IjoiMzAwMDAwMDAwMDAwMDAwMDAwMDAwMDAifQo="`
   → See Y: `"verdict":"allow"` for the demo agent paying its merchant 0.03 NEAR.
6. Or open the recorded run's key transactions in the explorer:
   seed payment (WARN → human → paid) [`BKLFaPB9…XiXCPm`](https://testnet.nearblocks.io/txns/BKLFaPB96mq2BhaqRSS2N3gVNYxPkG8xFhiMccKiXCPm) ·
   attack 1 refused on-chain [`57Rwgevf…MoQXUBE`](https://testnet.nearblocks.io/txns/57RwgevfYtiEaRESx1SDuu39JEMt4aiysGHTAMoQXUBE) ·
   attack 2 refused on-chain [`AmfD2Am9…GFxxMTg5Dq`](https://testnet.nearblocks.io/txns/AmfD2Am9S56vkkzZSTBmiLQ3Es4vHGbLm9GFxxMTg5Dq) ·
   legitimate payment [`EF8W3PBv…EinQbkCGkq`](https://testnet.nearblocks.io/txns/EF8W3PBvKMrEvEy82Zmv8QrWdipatwA891EinQbkCGkq).

### Path C — run the full live demo yourself (needs one testnet account)

7. Get a free testnet account (e.g. via near-cli's faucet flow) and fund it
   with ~1 NEAR of testnet play money. Copy `agent/.env.example` to
   `agent/.env` and set `OPERATOR_ACCOUNT_ID` + `OPERATOR_PRIVATE_KEY`
   (or point `GK_CREDS_FILE` at a near-cli-format credentials file).
8. Run: `cd agent && npm run demo:live`
   → See Y: the script creates **fresh** agent/merchant/drainer accounts
   under your operator (nothing is reused between runs), registers the
   policy (0.1 NEAR per-tx cap, 0.2 daily, human approval above 0.04),
   funds the vault, issues the function-call key, blocklists the drainer
   with 3 reports — then plays the scenario: a WARN seed payment approved
   by a human, both attacks BLOCKed at the wrapper **and** on-chain, the
   legitimate bill ALLOWed and paid, and two proofs that the agent's key
   can neither transfer NEAR nor call any method other than `pay`.
   A run costs ≈0.35 testnet NEAR and writes its transcript to
   `demo/attack-log.txt`. Expected final line: `BLOCK · BLOCK · ALLOW`.
   (On a fast connection a run takes ~2 minutes; the transcript of the
   recorded run — same code — is in `demo/demo-transcript.txt`, and the
   rendered video is `demo/gatekeeper-demo.mp4`.)

## Security model

- **Function-call key limits (read this):** the agent's key can *only* call
  `pay` on the Gatekeeper contract, and only while its gas allowance lasts.
  It cannot transfer NEAR directly, cannot add or delete keys, and cannot call
  any other contract or method. An attacker who extracts the key can at most
  attempt payments the contract will still vet — and the contract's caps bound
  the damage. If the allowance runs out the agent locks itself out of paying
  (the owner re-issues a key); this is the documented trade-off of
  function-call-only accounts.
- **Blocklist trust model (prototype, stated honestly):** a receiver is
  blocked after reports from 3 distinct accounts, each with an evidence
  reference. This is Sybil-naive by design for a hackathon prototype; the
  production direction (reporter stake / reputation weighting) is sketched in
  the roadmap below.
- **What Gatekeeper does not claim:** it bounds and audits agent spending; it
  does not make a compromised *owner* account safe, and `warn` still relies on
  a human actually reading the reasons.

## Roadmap

- Reporter stake / reputation weighting for the blocklist (Sybil resistance).
- NEAR AI Cloud memo screening enabled by default (already behind a flag).
- Multi-agent policies (per-agent keys, shared treasuries) and mainnet pilot
  with real, small caps.

## Layout

- `contract/` — Rust contract (policy, blocklist, vault) + unit tests
- `agent/` — TypeScript: risk engine (`risk.ts` scoring, `signals.ts`
  fetching), agent wrapper (`agent.ts`), demo setup (`setup-demo.ts`),
  live attack demo (`live-demo.ts`), offline demo (`attack-demo.ts`)
- `demo/` — rendered video (`gatekeeper-demo.mp4`), source recording
  (`gatekeeper-demo.cast`), edited cast, transcripts
- `scripts/` — reproducible testnet deploy + smoke script
- `TODO.md` — the day-by-day build checklist for this hackathon

## License

MIT — see `LICENSE`.

Built for [NEAR HACKATHON](https://nearhackathon.com) (Nov 1–14, 2026).
