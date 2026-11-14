#!/usr/bin/env bash
# Gatekeeper — reproducible NEAR **testnet** deploy + smoke sequence.
#
# This is exactly the sequence used for the recorded deployment in
# the project's deploy notes. Testnet only. It assumes:
#   - near-cli-rs (`near`) on PATH
#   - a faucet-funded dev account whose key is in the legacy keychain
#     (~/.near-credentials/testnet/<dev>.json)
#   - these subaccounts of the dev account already created (e.g. via
#     `near account create-account fund-myself <sub> '<amt> NEAR' …`):
#     gatekeeper.<dev> (contract, ~5 NEAR), merchant.<dev>, r1/r2/r3.<dev>
#     (~0.1 NEAR each)
#   - the contract WASM already built (see "Build" below)
#
# Usage:
#   DEV=gatekeeper-dev-XXXX.testnet ./scripts/deploy-testnet.sh
#
# Build (from contract/):
#   cargo near build non-reproducible-wasm
#   # artifact: contract/target/near/gatekeeper.wasm
set -euo pipefail

DEV="${DEV:?set DEV to the faucet-funded dev account, e.g. gatekeeper-dev-XXXX.testnet}"
CONTRACT="gatekeeper.${DEV}"
MERCHANT="merchant.${DEV}"
WASM="${WASM:-contract/target/near/gatekeeper.wasm}"
NEAR_CLI="${NEAR_CLI:-near}"

call() { # call <contract> <method> <json-args> <signer> <attached-near> [gas]
  "$NEAR_CLI" contract call-function as-transaction "$1" "$2" json-args "$3" \
    prepaid-gas "${6:-100} TeraGas" attached-deposit "$5" NEAR \
    sign-as "$4" network-config testnet sign-with-legacy-keychain send
}

# 1. Deploy + initialise. A deploy signs as the contract account itself
#    (there is no sign-as step); `new` records the predecessor as owner_id.
"$NEAR_CLI" contract deploy "$CONTRACT" use-file "$WASM" \
  with-init-call new json-args '{}' \
  prepaid-gas '100 TeraGas' attached-deposit '0 NEAR' \
  network-config testnet sign-with-legacy-keychain send

# 2. Smoke: the dev account acts as the agent (policy is per-caller).
#    Policy: per-tx cap 1 NEAR, daily cap 2 NEAR, warn above 0.5 NEAR.
call "$CONTRACT" set_policy \
  '{"max_per_tx":"1000000000000000000000000","max_per_day":"2000000000000000000000000","warn_above":"500000000000000000000000"}' \
  "$DEV" 0

# 3. Fund the vault with 3 NEAR.
call "$CONTRACT" deposit '{}' "$DEV" 3

# 4. ALLOW: pay the merchant 0.1 NEAR (within every cap).
call "$CONTRACT" pay \
  "{\"receiver\":\"${MERCHANT}\",\"amount\":\"100000000000000000000000\"}" \
  "$DEV" 0

# 5. Three distinct reporters report the merchant -> blocklist threshold (3).
#    Reporters need >0.1 NEAR: at exactly 0.1 NEAR near-cli's worst-case gas
#    pre-check (100 TGas) rejects the call, so top each up first and report
#    at 30 TGas (what the recorded run did).
for r in r1 r2 r3; do
  "$NEAR_CLI" tokens "$DEV" send-near "${r}.${DEV}" '0.2 NEAR' \
    network-config testnet sign-with-legacy-keychain send
done
for r in r1 r2 r3; do
  call "$CONTRACT" report \
    "{\"receiver\":\"${MERCHANT}\",\"evidence_ref\":\"smoke-test seed report from ${r}.${DEV}\"}" \
    "${r}.${DEV}" 0 30
done

# 6. BLOCK: paying the now-blocklisted merchant must fail on-chain.
call "$CONTRACT" pay \
  "{\"receiver\":\"${MERCHANT}\",\"amount\":\"50000000000000000000000\"}" \
  "$DEV" 0 || echo "expected failure: payment blocked (blocklisted receiver)"

# 7. Over-cap: 1.5 NEAR to a fresh receiver exceeds the 1 NEAR per-tx cap.
call "$CONTRACT" pay \
  '{"receiver":"testnet","amount":"1500000000000000000000000"}' \
  "$DEV" 0 || echo "expected failure: payment blocked (per-transaction cap)"
