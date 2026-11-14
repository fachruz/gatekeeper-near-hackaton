# Run the Gatekeeper demo

## The finished video (post this)

**`gatekeeper-demo.mp4`** — 1080p (1920×1080), 1m42s, H.264. A real,
complete live run of the attack demo against the NEAR testnet contract,
recorded in a terminal (asciinema) and rendered to video (agg → ffmpeg).
Nothing in the output was altered; only the network waits between steps
were trimmed (the live run takes ~4–5 minutes on a slow connection, ~2 on
a fast one). The matching full transcript is `demo-transcript.txt` /
`attack-log.txt`; the untouched source recording is `gatekeeper-demo.cast`
(the timing-edited cast used for rendering is `gatekeeper-demo-edited.cast`).

What the video shows, in order:

1. Fresh demo accounts created on testnet; policy registered (0.1 NEAR
   per-tx cap, 0.2 NEAR daily cap, human approval above 0.04 NEAR); vault
   funded; the agent receives a function-call key scoped to `pay` only.
2. Seed payment to a brand-new merchant → **WARN** (risk 35) → a human
   approves → paid (tx `BKLFaPB9…`).
3. **Attack 1** — poisoned invoice → blocklisted drainer: wrapper **BLOCK**;
   bypassing the wrapper, the contract still refuses on-chain (tx
   `57Rwgevf…`, `VERDICT BLOCK … shared blocklist`).
4. **Attack 2** — the 0.01 NEAR bill inflated to 0.5 NEAR: **BLOCK** before
   signing (per-tx cap); bypass fails on-chain too (tx `AmfD2Am9…`).
5. **Control** — the legitimate 0.03 NEAR bill → **ALLOW**, paid with the
   function-call key (tx `EF8W3PBv…`); merchant 0.04 → 0.07 NEAR, vault
   0.14 → 0.11 NEAR.
6. Key-scope proofs: the agent's key cannot transfer NEAR directly and
   cannot call `set_policy` — `pay` is all it can do.

## Re-run it live yourself

One command (needs one faucet-funded testnet account in `agent/.env`,
see the README's "Path C"):

```
cd agent && npm run demo:live
```

Expected ending:

```
■ RESULT
    ✓  seed payment: WARN gate → human approved → paid
    ✓  attack 1: wrapper BLOCK (blocklisted drainer), nothing signed
    ✓  attack 1: contract BLOCK on-chain even when the wrapper is bypassed
    ✓  attack 2: BLOCK before signing (per-transaction cap)
    ✓  attack 2: contract BLOCK on-chain when bypassed
    ✓  control: ALLOW — legitimate payment landed, balances moved exactly
    ✓  agent key cannot transfer NEAR directly
    ✓  agent key cannot call any method other than pay

  BLOCK · BLOCK · ALLOW — the injected agent could not move a single yocto outside policy.
```

Each run creates its own fresh accounts (a new random run suffix), so it
can be repeated any number of times; a run costs ≈0.35 testnet NEAR from
the operator account.
