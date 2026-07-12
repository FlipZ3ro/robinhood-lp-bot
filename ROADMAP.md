# Robinhood LP Bot — Peta Lengkap & Roadmap

Bot LP Uniswap **v3 + v4** di Robinhood Chain (EVM, chainId 4663), dikendalikan lewat
Telegram. Deteksi token real-time dari sequencer feed, screening LLM+GMGN, dan (opsional)
buka posisi otomatis. TypeScript, ethers v6, `@uniswap/v3-sdk` + `@uniswap/v4-sdk`.

---

## 1. Arsitektur

```
src/
├── index.ts              entrypoint: validasi secret, lock, graceful shutdown
├── config.ts             load+validasi config.json (zod) + secret dari .env
├── types.ts              tipe domain bersama
│
├── chain/                — semua urusan blockchain —
│   ├── client.ts         provider (Alchemy read + SequencerRoutingProvider fast-submit), wallet
│   ├── sequencer.ts      broadcast eth_sendRawTransaction langsung ke sequencer (Ohio)
│   ├── abis.ts           ABI v3 minimal
│   ├── tokens.ts         metadata token + builder SDK Token
│   ├── pools.ts          findPools (v3), poolState, range math, pickLpPool (fee focus)
│   ├── positions.ts      open/list/close v3 (single-side + in-range)
│   ├── swaps.ts          quote + swap v3 (slippage-protected), ensureNativeEth (top-up gas)
│   ├── holdings.ts       saldo + jual-semua-token
│   ├── ledger.ts         ledger permanen + rebuild on-chain (bounded)
│   ├── analytics.ts      PnL seumur hidup (cached 2m, paralel)
│   ├── price.ts          ETH/USD multi-source
│   ├── blockscout.ts     helper REST Blockscout
│   └── v4/               — Uniswap v4 —
│       ├── poolkey.ts    PoolKey, poolId (keccak abi.encode), tickSpacing=fee/50
│       ├── abis.ts       StateView, V4Quoter, v4 PositionManager
│       ├── discover.ts   discoverV4Pools (probe StateView, no event-scan), pickV4Pool
│       ├── swap.ts       swap ETH↔token via UniversalRouter (V4_SWAP)
│       ├── mint.ts       openV4SingleSide + openV4InRange (swap→Permit2→mint both-sided)
│       ├── close.ts      closeV4Position (removeCallParameters + burn)
│       └── list.ts       listV4Positions (baca v4-positions.json + on-chain)
│
├── radar/                — layer konfirmasi kandidat —
│   ├── openrouter.ts     skoring LLM via OpenRouter
│   ├── gmgn.ts           enrichment via gmgn-cli (chain robinhood)
│   ├── radar.ts          orchestrator: on-chain + GMGN → verdict
│   └── autolp.ts         AUTO-LP: candidate → verdict → gate berlapis → open otomatis
│
├── feed/                 — monitor sequencer real-time (Nitro) —
│   ├── decode.ts         frame Nitro → signed tx
│   ├── listener.ts       WS reconnect + IP-pin (bypass DNS hijack)
│   ├── swapdecode.ts     extract swap Uniswap dari tx
│   ├── lpdecode.ts       extract mint/pool-baru dari tx (v3)
│   └── monitor.ts        new-token detector + position out-of-range monitor
│
├── telegram/
│   ├── tg.ts             transport + AUTH boundary (owner-only)
│   ├── bot.ts            long-poll loop + routing
│   ├── handlers.ts       semua command/tombol
│   ├── pipeline.ts       candidate → score → notify → auto-LP
│   ├── notify.ts         notif spike / token baru / out-of-range / auto-LP
│   ├── watchLoop.ts      timer scanner volume
│   ├── feedLoop.ts       lifecycle feed monitor
│   ├── menu.ts           reply keyboard bawah (menu tetap)
│   └── format.ts         escape, padding, emoji per-token
│
├── watch/scanner.ts      scan volume DexScreener + uji honeypot on-chain (v3 Quoter)
└── util/                 log, atomic file write + lock, formatter
```

---

## 2. Instalasi

### Prasyarat
- Node.js **20+**
- Wallet EVM (burner) berisi ETH di Robinhood Chain
- Bot Telegram (dari [@BotFather](https://t.me/BotFather)) + chat id kamu (dari [@userinfobot](https://t.me/userinfobot))

### Lokal (dev)
```bash
npm install
cp .env.example .env    # isi secret (lihat §3)
npm run typecheck       # cek tipe
npm start               # jalanin
```
Buka bot di Telegram → `/start`.

### VPS (produksi 24/7) — disaranin us-east-2 (Ohio, sekota sequencer)
```bash
# di server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo npm install -g pm2
# transfer repo, lalu:
cd ~/Robinhood-LP-Bot && npm install
nano .env               # isi secret
pm2 start ecosystem.config.cjs && pm2 save
sudo env PATH=$PATH pm2 startup systemd -u $USER --hp $HOME   # auto-boot on reboot
pm2 logs robinhood-lp
```

### GMGN (opsional, buat radar enrichment)
```bash
sudo npm install -g gmgn-cli
gmgn-cli config                 # generate keypair + kasih URL
# buka URL → bikin API key buat public key yg ditampilin, lalu:
gmgn-cli config --apply <API_KEY>
```
> ⚠️ API key GMGN ke-bind ke keypair **per-mesin**. Key dari mesin lain nggak cocok.

---

## 3. Konfigurasi & Secret

### `.env` (RAHASIA — di-gitignore, jangan commit)
| Var | Wajib | Isi |
|---|---|---|
| `RH_WALLET_KEY` | ✅ | Private key wallet burner (0x + 64 hex) |
| `RH_TG_TOKEN` | ✅ | Token bot dari @BotFather |
| `RH_TG_CHAT` | ✅ | Chat id owner — **gerbang keamanan**, cuma chat ini yg bisa nyuruh bot |
| `RH_RPC_URL` | — | RPC Alchemy (kosong = public RPC) |
| `RH_WATCH_RPC_URL` | — | RPC kedua khusus scanner |
| `RH_FAST_SUBMIT` | — | `1` = broadcast langsung ke sequencer Ohio |
| `RH_SEQUENCER_IP` | — | IP-pin sequencer (kalau DNS di-hijack lokal) |
| `RH_FEED_IP` | — | IP-pin feed (Telkomsel dll) — `172.66.147.70` |
| `RH_OPENROUTER_KEY` | — | Key OpenRouter buat radar LLM |
| `RH_OPENROUTER_MODEL` | — | Model (default `openai/gpt-oss-20b:free`) |

**Secret yang DIJAMIN di-gitignore:** `.env`, `*.pem` (SSH key), `*.key`, keypair GMGN
(`~/.config/gmgn/`, di luar repo), `data/` (posisi + PnL history). Key GMGN & OpenRouter &
private key **tidak pernah** masuk repo.

### `config.json` (aman di-commit — tunable, bukan secret)
Contracts (v3+v4), `lp` (width, slippage, minFeePpm, feeTiers), `watch`, `feed`, `radar`,
`autoLp`. Diubah lewat `/set` di Telegram.

---

## 4. Fitur & Command

| Command | Fungsi |
|---|---|
| paste `0x…` | Cari pool **v3+v4** → pilih → LP |
| `/list` | Posisi terbuka v3+v4 + PnL + close |
| `/ledger` | Riwayat LP ditutup (realized) |
| `/pnl` | PnL seumur hidup (cached) |
| `/watch` `/scan` | Scanner volume + honeypot |
| `/feed on` | Monitor sequencer real-time (token baru + out-of-range) |
| `/auto on` | Auto-LP (radar → buka otomatis, guardrail ketat) |
| `/v4 <ca>` | Cek pool v4 fee-tinggi sebuah token |
| `/v4lp <ca> <eth>` `/v4close <id>` | LP v4 manual |
| `/closeall` `/sell` `/wallet` `/settings` `/set` | Aksi & setting |

Menu cepat ada di **reply keyboard bawah** (tap, nggak perlu ketik).

**Layer keamanan/otomasi:** owner-only auth · slippage di semua swap · atomic file write ·
single-instance lock · graceful shutdown · fast-submit ke sequencer · honeypot sim on-chain ·
radar LLM+GMGN · auto-LP dengan cap (ukuran/jumlah/harian) + hard-filter.

---

## 5. Roadmap (status)

### ✅ Selesai
- Rebuild TS + Uniswap SDK, struktur modular, security hardening
- LP **v3** (single-side + in-range), /list, /ledger, /pnl, close, auto top-up gas
- **Feed monitor** real-time (token baru + out-of-range), IP-pin bypass DNS hijack
- **Radar** LLM (OpenRouter) + **GMGN** enrichment
- **Auto-LP** dengan guardrail berlapis (default OFF)
- **Fast-submit** ke sequencer Ohio
- **v4**: discovery, mint single-side + in-range (farming), close, /list, unified pick v3+v4
- Menu bawah, /pnl cache, deploy VPS + pm2

### ⏳ In progress / Next
- **v4 auto-scan** — watch scanner deteksi spike pool v4 otomatis (safetyCheck fallback ke V4Quoter)
- **Wire auto-LP ke v4** — auto-buka pool v4 fee-tinggi (inti strategi farming)
- **Tes in-range v4 real** end-to-end (komponen sudah verified via staticCall)

### 📋 Backlog
- v4 di ledger/PnL (fee tracking presisi v4)
- Auto-rebalance / auto-compound
- Multi-wallet
- Impermanent loss display
- Test suite

---

## 6. Catatan operasional
- **Fee tier**: v3 mentok 1%; farming fee-tinggi (3-25%) ada di **v4** (pair native ETH).
- **Wallet**: pakai burner. Kalau share sama bot lain yang jalan bareng → risiko nonce-conflict.
- **`/pnl`**: berat kalau wallet punya banyak history tx (di-cache 2 menit).
- **DNS hijack**: sebagian ISP (Telkomsel) hijack domain feed/sequencer — pakai `RH_FEED_IP`/`RH_SEQUENCER_IP`. Di VPS US nggak perlu.

MIT. Pakai risiko sendiri — ini bot degen, bukan nasihat finansial.
