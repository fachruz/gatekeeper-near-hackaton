//! Gatekeeper — policy registry, shared blocklist and enforcing vault for
//! AI agent payments on NEAR (testnet).
//!
//! Layers enforced by this contract on every `pay` call, in order:
//!   1. receiver must not be on the shared blocklist
//!   2. amount must fit the agent's per-transaction cap
//!   3. amount must fit the agent's daily cap (rolling UTC-day window)
//!
//! The agent interacts with this contract through a function-call access key
//! scoped to `pay` only; the contract additionally requires the caller to be
//! a registered agent with a policy on file.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, NearToken, Promise};

/// Reports from this many distinct accounts put a receiver on the blocklist.
pub const BLOCK_THRESHOLD: u32 = 3;

const DAY_MS: u64 = 86_400_000;

/// Per-agent spending policy, set by the agent account's owner.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Policy {
    pub max_per_tx: U128,
    pub max_per_day: U128,
    /// Amounts strictly above this need a human in the loop (handled by the
    /// agent wrapper; the contract still records the verdict).
    pub warn_above: U128,
}

/// Blocklist state for one receiver account.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BlockEntry {
    pub report_count: u32,
    pub blocked: bool,
    pub evidence: Vec<String>,
}

/// How much one agent has spent inside the current UTC-day window.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct SpendWindow {
    pub day: u64,
    pub spent: U128,
}

/// Result of a pre-flight check, returned to the agent wrapper.
#[near(serializers = [json])]
pub struct CheckResult {
    /// "allow" | "warn" | "block"
    pub verdict: String,
    pub reasons: Vec<String>,
}

#[near(contract_state)]
pub struct Gatekeeper {
    pub owner_id: AccountId,
    pub policies: LookupMap<AccountId, Policy>,
    pub blocklist: LookupMap<AccountId, BlockEntry>,
    /// (reporter, receiver) -> already reported; one report per pair.
    pub reporters: LookupMap<(AccountId, AccountId), bool>,
    /// Agent account -> NEAR held in the vault.
    pub vault: LookupMap<AccountId, u128>,
    pub windows: LookupMap<AccountId, SpendWindow>,
}

impl Default for Gatekeeper {
    fn default() -> Self {
        env::panic_str("Gatekeeper must be initialised with new()")
    }
}

/// Pure policy evaluation — the heart of the enforcement, unit-tested below.
/// Returns ("allow" | "warn" | "block", reasons).
pub fn evaluate(
    blocked: bool,
    policy: &Policy,
    spent_today: u128,
    amount: u128,
) -> (String, Vec<String>) {
    let mut reasons = Vec::new();
    if blocked {
        reasons.push("receiver is on the shared blocklist".to_string());
        return ("block".to_string(), reasons);
    }
    if amount > policy.max_per_tx.0 {
        reasons.push(format!(
            "amount {} exceeds per-transaction cap {}",
            amount, policy.max_per_tx.0
        ));
        return ("block".to_string(), reasons);
    }
    if spent_today.saturating_add(amount) > policy.max_per_day.0 {
        reasons.push(format!(
            "amount {} would exceed daily cap {} (already spent {} today)",
            amount, policy.max_per_day.0, spent_today
        ));
        return ("block".to_string(), reasons);
    }
    if amount > policy.warn_above.0 {
        reasons.push(format!(
            "amount {} is above the human-approval threshold {}",
            amount, policy.warn_above.0
        ));
        return ("warn".to_string(), reasons);
    }
    reasons.push("within policy and not blocklisted".to_string());
    ("allow".to_string(), reasons)
}

/// Pure blocklist transition: apply one (deduplicated) report to an entry.
pub fn apply_report(entry: &mut BlockEntry, evidence_ref: String) {
    entry.report_count += 1;
    entry.evidence.push(evidence_ref);
    if entry.report_count >= BLOCK_THRESHOLD {
        entry.blocked = true;
    }
}

fn current_day() -> u64 {
    env::block_timestamp_ms() / DAY_MS
}

#[near]
impl Gatekeeper {
    #[init]
    pub fn new() -> Self {
        Self {
            owner_id: env::predecessor_account_id(),
            policies: LookupMap::new(b"p"),
            blocklist: LookupMap::new(b"b"),
            reporters: LookupMap::new(b"r"),
            vault: LookupMap::new(b"v"),
            windows: LookupMap::new(b"w"),
        }
    }

    /// Register or update the caller's own spending policy. A policy only
    /// ever applies to the predecessor account, so an account can never
    /// rewrite another agent's policy.
    pub fn set_policy(&mut self, max_per_tx: U128, max_per_day: U128, warn_above: U128) {
        let agent = env::predecessor_account_id();
        assert!(
            max_per_tx.0 > 0,
            "per-transaction cap must be greater than zero"
        );
        assert!(
            max_per_day.0 >= max_per_tx.0,
            "daily cap must be at least the per-transaction cap"
        );
        assert!(
            warn_above.0 <= max_per_tx.0,
            "warn threshold must not exceed the per-transaction cap"
        );
        self.policies.insert(
            agent,
            Policy {
                max_per_tx,
                max_per_day,
                warn_above,
            },
        );
    }

    pub fn get_policy(&self, agent: AccountId) -> Option<Policy> {
        self.policies.get(&agent).cloned()
    }

    /// Report a bad actor, with an evidence reference (e.g. an explorer or
    /// IPFS link). One report per (reporter, receiver) pair; BLOCK_THRESHOLD
    /// distinct reporters block the receiver for everyone.
    pub fn report(&mut self, receiver: AccountId, evidence_ref: String) {
        let reporter = env::predecessor_account_id();
        let key = (reporter, receiver.clone());
        if self.reporters.get(&key).copied().unwrap_or(false) {
            env::panic_str("this account has already reported this receiver");
        }
        self.reporters.insert(key, true);
        let mut entry = self.blocklist.get(&receiver).cloned().unwrap_or(BlockEntry {
            report_count: 0,
            blocked: false,
            evidence: Vec::new(),
        });
        apply_report(&mut entry, evidence_ref);
        self.blocklist.insert(receiver, entry);
    }

    pub fn get_block_entry(&self, receiver: AccountId) -> Option<BlockEntry> {
        self.blocklist.get(&receiver).cloned()
    }

    /// Pre-flight check used by the agent wrapper before it even tries to pay.
    pub fn check(&self, agent: AccountId, receiver: AccountId, amount: U128) -> CheckResult {
        let blocked = self
            .blocklist
            .get(&receiver)
            .map(|e| e.blocked)
            .unwrap_or(false);
        let policy = match self.policies.get(&agent) {
            Some(p) => p.clone(),
            None => {
                return CheckResult {
                    verdict: "block".to_string(),
                    reasons: vec!["agent has no policy registered".to_string()],
                }
            }
        };
        let spent = self.spent_today(&agent);
        let (verdict, reasons) = evaluate(blocked, &policy, spent, amount.0);
        CheckResult { verdict, reasons }
    }

    fn spent_today(&self, agent: &AccountId) -> u128 {
        match self.windows.get(agent) {
            Some(w) if w.day == current_day() => w.spent.0,
            _ => 0,
        }
    }

    /// Deposit NEAR into the caller's vault balance.
    #[payable]
    pub fn deposit(&mut self) {
        let agent = env::predecessor_account_id();
        let amount = env::attached_deposit().as_yoctonear();
        let balance = self.vault.get(&agent).copied().unwrap_or(0);
        self.vault.insert(agent, balance + amount);
    }

    pub fn vault_balance(&self, agent: AccountId) -> U128 {
        U128(self.vault.get(&agent).copied().unwrap_or(0))
    }

    /// Pay `receiver` from the caller's vault balance, enforcing policy.
    /// Intended to be called by the agent account holding a function-call
    /// access key scoped to this method only. Panics (no funds move) when
    /// the verdict is "block".
    pub fn pay(&mut self, receiver: AccountId, amount: U128) -> String {
        let agent = env::predecessor_account_id();
        let policy = self
            .policies
            .get(&agent)
            .cloned()
            .unwrap_or_else(|| env::panic_str("agent has no policy registered"));
        let blocked = self
            .blocklist
            .get(&receiver)
            .map(|e| e.blocked)
            .unwrap_or(false);
        let spent = self.spent_today(&agent);
        let (verdict, reasons) = evaluate(blocked, &policy, spent, amount.0);
        env::log_str(&format!(
            "VERDICT {} agent={} receiver={} amount={} reasons={}",
            verdict.to_uppercase(),
            agent,
            receiver,
            amount.0,
            reasons.join("; ")
        ));
        if verdict == "block" {
            env::panic_str(&format!("payment blocked: {}", reasons.join("; ")));
        }
        let balance = self.vault.get(&agent).copied().unwrap_or(0);
        if balance < amount.0 {
            env::panic_str("insufficient vault balance");
        }
        self.vault.insert(agent.clone(), balance - amount.0);
        let mut window = self.windows.get(&agent).cloned().unwrap_or_default();
        if window.day != current_day() {
            window.day = current_day();
            window.spent = U128(0);
        }
        window.spent = U128(window.spent.0 + amount.0);
        self.windows.insert(agent, window);
        let _promise = Promise::new(receiver).transfer(NearToken::from_yoctonear(amount.0));
        verdict
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const DAY_NS: u64 = DAY_MS * 1_000_000;
    /// Arbitrary fixed "today" for the stateful tests.
    const DAY: u64 = 20_000;

    fn policy() -> Policy {
        Policy {
            max_per_tx: U128(100),
            max_per_day: U128(250),
            warn_above: U128(50),
        }
    }

    // Test accounts: accounts(0) is the contract account itself.
    fn agent() -> AccountId {
        accounts(1) // alice — the agent / policy owner
    }
    fn bob() -> AccountId {
        accounts(2)
    }
    fn charlie() -> AccountId {
        accounts(3)
    }
    fn danny() -> AccountId {
        accounts(4)
    }
    fn merchant() -> AccountId {
        accounts(5) // eugene — a payment receiver
    }

    /// Point the mocked chain at (predecessor, day, attached deposit).
    fn set_context(predecessor: &AccountId, day: u64, attached_yocto: u128) {
        let mut builder = VMContextBuilder::new();
        builder.current_account_id(accounts(0));
        builder.predecessor_account_id(predecessor.clone());
        builder.signer_account_id(predecessor.clone());
        builder.block_timestamp(day * DAY_NS + 5_000_000_000);
        builder.attached_deposit(NearToken::from_yoctonear(attached_yocto));
        testing_env!(builder.build());
    }

    /// A contract whose agent has policy (100 / 250 / 50) and 1_000 in vault.
    fn funded_contract() -> Gatekeeper {
        set_context(&agent(), DAY, 0);
        let mut contract = Gatekeeper::new();
        contract.set_policy(U128(100), U128(250), U128(50));
        set_context(&agent(), DAY, 1_000);
        contract.deposit();
        set_context(&agent(), DAY, 0);
        contract
    }

    // ---- pure evaluate() ----

    #[test]
    fn blocklisted_receiver_is_blocked() {
        let (v, _) = evaluate(true, &policy(), 0, 10);
        assert_eq!(v, "block");
    }

    #[test]
    fn over_per_tx_cap_is_blocked() {
        let (v, _) = evaluate(false, &policy(), 0, 101);
        assert_eq!(v, "block");
    }

    #[test]
    fn over_daily_cap_is_blocked() {
        let (v, _) = evaluate(false, &policy(), 200, 51);
        assert_eq!(v, "block");
    }

    #[test]
    fn above_warn_threshold_warns() {
        let (v, _) = evaluate(false, &policy(), 0, 75);
        assert_eq!(v, "warn");
    }

    #[test]
    fn ordinary_payment_is_allowed() {
        let (v, _) = evaluate(false, &policy(), 0, 25);
        assert_eq!(v, "allow");
    }

    #[test]
    fn blocklist_threshold_needs_three_distinct_reports() {
        let mut e = BlockEntry {
            report_count: 0,
            blocked: false,
            evidence: Vec::new(),
        };
        apply_report(&mut e, "evidence-1".to_string());
        apply_report(&mut e, "evidence-2".to_string());
        assert!(!e.blocked);
        apply_report(&mut e, "evidence-3".to_string());
        assert!(e.blocked);
        assert_eq!(e.evidence.len(), 3);
    }

    // ---- blocklist via report() ----

    #[test]
    fn reports_below_threshold_do_not_block() {
        let mut contract = funded_contract();
        set_context(&bob(), DAY, 0);
        contract.report(merchant(), "evidence-a".to_string());
        set_context(&charlie(), DAY, 0);
        contract.report(merchant(), "evidence-b".to_string());

        let entry = contract.get_block_entry(merchant()).unwrap();
        assert_eq!(entry.report_count, 2);
        assert!(!entry.blocked, "two reports must stay below the threshold");
        assert_eq!(entry.evidence.len(), 2);

        // …and the receiver can still be paid.
        let result = contract.check(agent(), merchant(), U128(10));
        assert_eq!(result.verdict, "allow");
    }

    #[test]
    fn third_distinct_report_blocks() {
        let mut contract = funded_contract();
        for (reporter, ev) in [
            (bob(), "evidence-a"),
            (charlie(), "evidence-b"),
            (danny(), "evidence-c"),
        ] {
            set_context(&reporter, DAY, 0);
            contract.report(merchant(), ev.to_string());
        }
        let entry = contract.get_block_entry(merchant()).unwrap();
        assert_eq!(entry.report_count, 3);
        assert!(entry.blocked);
        let result = contract.check(agent(), merchant(), U128(10));
        assert_eq!(result.verdict, "block");
    }

    #[test]
    #[should_panic(expected = "payment blocked: receiver is on the shared blocklist")]
    fn pay_to_blocked_receiver_panics() {
        let mut contract = funded_contract();
        for reporter in [bob(), charlie(), danny()] {
            set_context(&reporter, DAY, 0);
            contract.report(merchant(), "evidence".to_string());
        }
        set_context(&agent(), DAY, 0);
        contract.pay(merchant(), U128(10));
    }

    #[test]
    #[should_panic(expected = "already reported this receiver")]
    fn duplicate_report_from_same_account_panics() {
        let mut contract = funded_contract();
        set_context(&bob(), DAY, 0);
        contract.report(merchant(), "evidence".to_string());
        contract.report(merchant(), "evidence-again".to_string());
    }

    // ---- policy registry ----

    #[test]
    fn policy_is_scoped_to_its_owner() {
        set_context(&agent(), DAY, 0);
        let mut contract = Gatekeeper::new();
        contract.set_policy(U128(100), U128(250), U128(50));

        // Bob registering his own policy must not touch the agent's.
        set_context(&bob(), DAY, 0);
        contract.set_policy(U128(1), U128(2), U128(1));

        let agents = contract.get_policy(agent()).unwrap();
        assert_eq!(agents.max_per_tx, U128(100));
        assert_eq!(agents.max_per_day, U128(250));
        assert_eq!(agents.warn_above, U128(50));
        let bobs = contract.get_policy(bob()).unwrap();
        assert_eq!(bobs.max_per_tx, U128(1));
    }

    #[test]
    #[should_panic(expected = "daily cap must be at least the per-transaction cap")]
    fn policy_with_daily_below_per_tx_is_rejected() {
        set_context(&agent(), DAY, 0);
        let mut contract = Gatekeeper::new();
        contract.set_policy(U128(100), U128(50), U128(10));
    }

    #[test]
    #[should_panic(expected = "warn threshold must not exceed the per-transaction cap")]
    fn policy_with_warn_above_per_tx_is_rejected() {
        set_context(&agent(), DAY, 0);
        let mut contract = Gatekeeper::new();
        contract.set_policy(U128(100), U128(250), U128(101));
    }

    // ---- pay(): caps, windows, balances ----

    #[test]
    #[should_panic(expected = "agent has no policy registered")]
    fn pay_without_policy_is_rejected() {
        set_context(&agent(), DAY, 0);
        let mut contract = Gatekeeper::new();
        set_context(&bob(), DAY, 1_000);
        contract.deposit();
        set_context(&bob(), DAY, 0);
        contract.pay(merchant(), U128(10));
    }

    #[test]
    fn pay_exactly_at_per_tx_cap_succeeds() {
        let mut contract = funded_contract();
        let verdict = contract.pay(merchant(), U128(100));
        // 100 == per-tx cap: allowed through (above warn_above, so "warn").
        assert_eq!(verdict, "warn");
        assert_eq!(contract.vault_balance(agent()), U128(900));
    }

    #[test]
    #[should_panic(expected = "exceeds per-transaction cap")]
    fn pay_one_unit_over_per_tx_cap_panics() {
        let mut contract = funded_contract();
        contract.pay(merchant(), U128(101));
    }

    #[test]
    fn pay_up_to_daily_cap_exactly_then_blocked_by_check() {
        let mut contract = funded_contract();
        contract.pay(merchant(), U128(100));
        contract.pay(merchant(), U128(100));
        contract.pay(merchant(), U128(50)); // spent == 250 == daily cap
        assert_eq!(contract.vault_balance(agent()), U128(750));
        // One more unit today must be refused by the daily cap.
        let result = contract.check(agent(), merchant(), U128(1));
        assert_eq!(result.verdict, "block");
        assert!(result.reasons[0].contains("daily cap"));
    }

    #[test]
    #[should_panic(expected = "would exceed daily cap")]
    fn pay_over_daily_cap_panics() {
        let mut contract = funded_contract();
        contract.pay(merchant(), U128(100));
        contract.pay(merchant(), U128(100));
        contract.pay(merchant(), U128(51)); // 251 > 250, within per-tx cap
    }

    #[test]
    fn daily_cap_resets_on_the_next_day() {
        let mut contract = funded_contract();
        contract.pay(merchant(), U128(100));
        contract.pay(merchant(), U128(100));
        contract.pay(merchant(), U128(50)); // day fully spent (250)

        set_context(&agent(), DAY + 1, 0);
        let verdict = contract.pay(merchant(), U128(100));
        assert_eq!(verdict, "warn"); // fresh window: 100 <= daily cap again
        assert_eq!(contract.vault_balance(agent()), U128(650));
    }

    #[test]
    #[should_panic(expected = "insufficient vault balance")]
    fn pay_above_vault_balance_panics() {
        set_context(&agent(), DAY, 0);
        let mut contract = Gatekeeper::new();
        contract.set_policy(U128(100), U128(250), U128(50));
        set_context(&agent(), DAY, 10);
        contract.deposit();
        set_context(&agent(), DAY, 0);
        contract.pay(merchant(), U128(25)); // within caps, above balance
    }

    #[test]
    fn warn_verdict_payment_still_executes() {
        let mut contract = funded_contract();
        let verdict = contract.pay(merchant(), U128(75));
        assert_eq!(verdict, "warn");
        assert_eq!(contract.vault_balance(agent()), U128(925));
    }

    #[test]
    fn allowed_payment_moves_exact_amount() {
        let mut contract = funded_contract();
        let verdict = contract.pay(merchant(), U128(25));
        assert_eq!(verdict, "allow");
        assert_eq!(contract.vault_balance(agent()), U128(975));
        // …and the spend is visible to the next pre-flight check.
        let result = contract.check(agent(), merchant(), U128(226));
        assert_eq!(result.verdict, "block"); // 25 + 226 > 250 daily cap
    }
}
