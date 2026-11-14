# Gatekeeper — draft postingan demo X + teks submission (siap pakai Sabtu 14 Nov)

Disusun Kamis 12 Nov 2026 malam, supaya Sabtu tinggal copy-paste.
Video sudah jadi: `demo/gatekeeper-demo.mp4` (1m42s, 1080p, 4,2 MB) — lampirkan video ini ke postingan.
Pengingat + panduan submit sudah terjadwal Sabtu 14 Nov 18:07 WIB.

## 1. Teks postingan X (draft utama)

> AI agents now hold real money — one poisoned invoice can drain it.
>
> I built Gatekeeper at the NEAR HACKATHON: it checks every payment before signing, and a NEAR contract enforces the blocklist + spending caps on-chain.
>
> Repo 👇
>
> [tempel link repo publik di sini]
>
> @NEARProtocol #NEARHackathon

(Teks 256 karakter; link X dihitung 23 karakter, total 279 — masih dalam batas 280.)

Aturan yang sudah dipenuhi draft ini: menyatakan dibangun di NEAR HACKATHON,
tag @NEARProtocol + #NEARHackathon, video demo terlampir, baris pertama = masalah
user, satu momen utuh (aksi → hasil), peran NEAR konkret (bukan "powered by NEAR").

Catatan: link repo belum bisa ditulis sekarang — repo belum dibuat/dipush ke GitHub
(no remote di repo lokal per 12 Nov). Isi placeholder itu dengan URL repo publik
setelah Sabtu dibuat. Opsional, kalau mau amplifikasi lebih: tambah @NearLegion
dan @NearBuilders di baris tag.

## 2. Teks `idea` untuk payload submission (20–2000 karakter)

> AI agents are starting to hold and move real money, but a single prompt injection,
> poisoned invoice or hallucinated address can drain them — the agent itself cannot
> be trusted to police its own payments. Gatekeeper is a pre-flight security firewall
> for AI agent payments on NEAR: before paying, the agent checks the receiver
> (account age, contract status, shared on-chain blocklist) and gets allow, warn or
> block; funds sit in a NEAR smart contract that enforces the blocklist, a
> per-transaction cap and a daily cap on every pay call, and the agent signs only
> with a function-call key scoped to the pay method. The demo shows a poisoned
> invoice trying to pay a blocklisted drainer and to overspend the cap — both
> blocked twice, first by the agent wrapper and again on-chain — while a legitimate
> payment goes through.

(~816 karakter — di dalam batas 20–2000.)

## 3. Field payload yang sudah pasti (tinggal konfirmasi Sabtu)

- projectName: Gatekeeper
- size: `1`
- tracks: `["security", "agents"]`
- nearAddress: `namaku307.near` (mainnet, terverifikasi on-chain 11 Nov)
- Kontrak testnet: `gatekeeper.gatekeeper-dev-1e0e16a9.testnet`
- projectUrl: URL repo publik (diisi Sabtu setelah push)
- demoUrl: URL postingan X (diisi Sabtu setelah posting)
- leadName + email: diisi Fachruz sendiri saat submit (tidak ditebak)
- consent: `true` hanya setelah Fachruz menyetujui contact notice yang dibacakan verbatim

## 4. Checklist Sabtu 14 Nov (tenggat Minggu 15 Nov 06:59 WIB)

1. [ ] Buat repo GitHub, push `near-build`, jadikan publik
2. [ ] Posting X pakai draft §1 + lampirkan `gatekeeper-demo.mp4`
3. [ ] Konfirmasi payload lengkap (Muse tampilkan JSON dulu)
4. [ ] Submit SATU KALI (form atau API) — kalau salah, perbaiki lewat
       https://nearhackathon.com/request-changes, jangan submit ulang
5. [ ] Jangan isi field `website` — itu spam trap, submission ditolak
