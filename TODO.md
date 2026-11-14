# Gatekeeper — build checklist (NEAR HACKATHON, deadline 14 Nov 23:59 UTC = 15 Nov 06:59 WIB)

## Wed 11 Nov — kickoff (today)
- [x] Rules lock from official sources (HACKATHON.md, blog, track prompt)
- [x] Concept chosen: Gatekeeper (counterparty check + on-chain policy vault)
- [x] Repo scaffold: README, contract skeleton, agent skeleton
- [x] Toolchain smoke: Rust (rustup, wasm32 target) + Node 24 verified
- [x] Contract skeleton unit tests green (`cargo test` — 6/6 pass, 2026-11-11)

## Thu 12 Nov — contract + risk engine
- [x] Contract: policy registry (`set_policy`), blocklist (`report`, threshold → blocked, `check` view)
- [x] Contract: vault (`deposit`, `pay` with enforcement order blocklist → per-tx cap → daily cap, verdict events)
- [x] Contract unit tests cover: cap edges, daily window rollover, block threshold, non-agent caller rejected (`cargo test` — **22/22 pass**, done early Wed 11 Nov)
- [x] Deploy script (`scripts/deploy-testnet.sh`, near-cli-rs) + testnet dev account from faucet (testnet only)
- [x] Deploy to NEAR testnet; record contract id in README — `gatekeeper.gatekeeper-dev-1e0e16a9.testnet`, deploy tx `4vcyHQK31y2EmTQhrm9MQ6XCkHWp3aCKphmTpDCsh9i8` (done early Wed 11 Nov; live smoke: ALLOW pay, BLOCK pay after 3 reports, over-cap refusal — all verified on-chain)
- Build (recorded): `cd contract && cargo near build non-reproducible-wasm` → `contract/target/near/gatekeeper.wasm` (146,104 bytes; SHA-256 hex `ef0ee239c872b4b257e4c73bf746c9ffd7b4bb2607478222e90ab31968a574f0`). cargo-near 0.23.0 via the official prebuilt binary (`cargo install cargo-near` OOM-fails on this VM's C compiler).
- [x] Risk engine v1: blocklist/report count from the contract's `get_block_entry`, is-contract + code hash via RPC `view_account`, account age via nearblocks (operator-witnessed registry fallback), prior interactions from the agent's own payment journal (`agent/src/signals.ts`; `codeChangedDaysAgo` honestly reported unknown without an indexer)
- [x] Risk engine tests green (`npm test` — 12/12 incl. verdict-merge, signal-parsing and journal tests, 2026-11-11)

## Fri 13 Nov — agent + attack demo (all done early, Wed 11 Nov)
- [x] Agent wrapper: fresh agent account per demo run, function-call key scoped to `pay` only (setup in `agent/src/setup-demo.ts`; the runtime holds ONLY the function-call key)
- [x] `pay()` flow: block → refuse + log; warn → human approval gate; allow → sign
- [x] Attack demo script: poisoned invoice → blocklisted pay BLOCK, over-cap pay BLOCK, legit pay ALLOW (`agent/src/live-demo.ts`; each also proven on-chain via a wrapper-bypass attempt)
- [x] Run demo end-to-end on testnet; save full log into repo (`demo/attack-log.txt` + `demo/demo-transcript.txt`; two full runs verified 8/8 checks, 2026-11-11)
- [x] README: final "do X — see Y" judge steps (offline / read-only live / full live paths) with the real contract id; signal sources stated; threat model; roadmap
- [x] **Demo video RENDERED for Fachruz to post** (he does not record anything): `demo/gatekeeper-demo.mp4` — 1080p, 1m42s, H.264, from the real recorded run (asciinema cast → gap-trimmed edit → agg → ffmpeg; only network waits trimmed, output unaltered). Source cast + edited cast kept in `demo/`; see `demo/RUN-DEMO.md`.
- [ ] Optional if time: NEAR AI Cloud memo screening behind env flag; hosted read-only demo page

## Sat 14 Nov — submission day (hard deadline Sun 15 Nov 06:59 WIB)
- [x] Final full test pass (cargo + npm) from a clean checkout (done early Wed 11 Nov: clone → cargo 22/22, npm 12/12, offline demo OK, read-only live view calls OK)
- [ ] **Fachruz:** create NEAR **mainnet** account for prize payout (any NEAR wallet)
- [ ] **Fachruz confirms:** repo made public + pushed to GitHub
- [ ] **Fachruz:** post the demo on X — attach the ready-made **`demo/gatekeeper-demo.mp4`** (no recording needed from him), text must say built at NEAR HACKATHON, tag @NEARProtocol, #NEARHackathon
- [ ] **Fachruz confirms the exact submission payload** (projectName, leadName, email, size `1`, tracks `["security","agents"]`, nearAddress, projectUrl, demoUrl, idea 20–2000 chars, consent) — agent shows full JSON first
- [ ] Submit ONCE via API (POST nearhackathon.com/api/applications) → expect 201
- [ ] If anything in the saved submission is wrong: request-changes page, never resubmit

## Never without Fachruz's explicit confirmation
- Sending the submission · posting on X · making the repo public / pushing · signing mainnet transactions or spending tokens · committing any secret (keys live in `.env` only)
