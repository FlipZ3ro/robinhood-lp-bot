<div align="center">

# 🐷 Robinhood LP Bot v2

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-20+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![ethers](https://img.shields.io/badge/ethers-v6-2535A0?style=for-the-badge&logo=ethereum&logoColor=white)
![Robinhood Chain](https://img.shields.io/badge/Robinhood_Chain-MAINNET-00C805?style=for-the-badge)
<br>
![Uniswap](https://img.shields.io/badge/Uniswap-v2_·_v3_·_v4-FF007A?style=for-the-badge&logo=uniswap&logoColor=white)
![Kyber](https://img.shields.io/badge/Kyber-AGGREGATOR-31CB9E?style=for-the-badge)
![Control](https://img.shields.io/badge/Control-TELEGRAM-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-EAB308?style=for-the-badge)

**LP otomatis di Uniswap v2 · v3 · v4 (Robinhood Chain) — full kontrol dari Telegram.**

Paste CA → pilih pool → ketik jumlah ETH → posisi kebuka. Sekarang juga.

</div>

---

## About

**Robinhood LP Bot v2** adalah bot liquidity-provider buat **Robinhood Chain** yang dijalanin sepenuhnya dari Telegram. Paste contract address → bot cariin pool paling likuid di **Uniswap v2 / v3 / v4** (termasuk pair **USDG**), beliin token lewat **KyberSwap aggregator** (rute terbaik lintas semua DEX/fee-tier, anti price-impact), terus buka posisi LP. Semua math tick/harga lewat **Uniswap SDK resmi** — nol drift presisi, nggak ada `Math.pow` hand-rolled.

Di atas LP-nya ada layer intelligence:

- **Scanner volume on-chain** — nyari token yang volumenya lagi *nanjak* (bukan sekadar tinggi).
- **Feed sequencer Nitro real-time** — deteksi token baru sub-detik, sebelum ke-index DexScreener.
- **Uji honeypot mandiri** — simulasi beli→jual lewat Quoter, nggak percaya reputasi siapa pun.
- **Screening GMGN 24 jam** (`/screen`) — filter thesis: mcap > $500k, vol > $1M, no flap.fun, util > meme.
- **Skoring LLM** (OpenRouter) — verdict `🟢 APE / 🟡 WATCH / 🔴 SKIP` nempel di tiap notif kandidat.
- **Kartu profit shareable** — tiap close auto-generate PNG flex (STRIX aesthetic).

Ditulis TypeScript modular, **owner-only auth**, slippage floor di semua swap, atomic ledger write, graceful shutdown, single-instance lock. Jalan di laptop atau VPS 24 jam.

---

## 📸 Kartu profit (auto tiap close)

Tiap posisi ditutup, bot langsung kirim kartu PNG siap-share ke Telegram. Ada juga kartu **portfolio** (`/card`) buat rekap semua, dan kartu **per-posisi** dari `/ledger`.

**Per-close — PROFIT**

![kartu profit](docs/cards/close-profit.png)

**Per-close — LOSS**

![kartu loss](docs/cards/close-loss.png)

**Portfolio — ALL-TIME** (`/card`)

![kartu portfolio](docs/cards/portfolio.png)

> Background bisa lu ganti: kirim foto ke bot (langsung di-set jadi bg kartu) atau taruh `assets/card-bg.jpg`. Brand default `0xRapzz` — ubah via `RH_CARD_BRAND`, tagline via `RH_CARD_TAG`. Font monospace (DejaVu Sans Mono) di-bundle di VPS.

---

## Menu Telegram

Kirim `/start` → muncul menu tombol (reply keyboard) yang persisten, semua fungsi sekali tap:

|  |  |  |
|:--|:--|:--|
| 📋 **Posisi** — `/list` | 📒 **Ledger** — `/ledger` | 💰 **PnL** — `/pnl` |
| 🧪 **Screen** — `/screen` | 🔍 **Scan** — `/scan` | 📸 **Kartu** — `/card` |
| 🔄 **Swap** — `/swap` | 📡 **Feed** — `/feed` | 👁 **Watch** — `/watch` |
| 🤖 **Auto** — `/auto` | 👛 **Wallet** — `/wallet` | ⚙️ **Setting** — `/settings` |
| 🗑 **Close All** — `/closeall` | 💸 **Sell** — `/sell` | ❔ **Help** — `/help` |

---

## Tampilan log

Bersih, timestamped, per-modul. Contoh boot + runtime:

```
[10:01:45] INFO  client   · fast-submit ON → sequencer.mainnet.chain.robinhood.com
[10:01:45] INFO  bot      · Robinhood LP Bot v2 jalan — chain 4663, wallet 0xc017…469e
[10:01:45] INFO  watch    · ON — scan tiap 120s (vol5m ≥ $200k, naik 1.4×)
[10:01:45] INFO  feed     · connect feed.mainnet.chain.robinhood.com
[10:01:45] INFO  feedmon  · ON — newToken=true positionMonitor=true autoClose=false
[10:01:45] INFO  feed     · connected (101)
[10:02:02] INFO  feedmon  · new token NUG ditolak: TIDAK BISA DIJUAL (simulasi revert) — honeypot
[10:14:07] INFO  v4close  · close v4 #177922 WOLVES/USDG — +$0.35 (fee $1.08)
[10:14:08] INFO  card     · close card terkirim
```

Ke VPS: `pm2 logs robinhood-lp`.

---

## Kenapa ada bot ini

Tiga hal yang bikin LP manual nyebelin:

1. **Web Uniswap ngelag** — connect, approve, set range, mint. Tiap langkah loading.
2. **Range-nya bahasa alien** — Uniswap kasih `tick 130400–134400`. Itu artinya apa?
3. **Udah open, untung nggak?** — cuma keliatan "unclaimed fees". Modal awal berapa? Nilainya sekarang berapa? Nggak jelas.

Bot ini jawab ketiganya. Range ditampilin dalam **MCAP** (`$2.64M → $3.94M`), PnL dihitung dari **harga jual asli**, dan semuanya dari Telegram.

---

## Setup (5 menit)

**Butuh:** Node.js 20+ ([download](https://nodejs.org))

```bash
# 1. Masuk foldernya
cd Robinhood-LP-Bot

# 2. Install (narik ethers v6 + @uniswap/{v3,v4}-sdk + @napi-rs/canvas + typescript)
npm install

# 3. Siapin config
cp .env.example .env
```

Sekarang buka `.env`, isi:

| Isi apa | Dapetnya dari mana |
|---|---|
| `RH_RPC_URL` | [alchemy.com](https://alchemy.com) → bikin app → pilih chain **Robinhood** → copy HTTPS URL |
| `RH_WALLET_KEY` | Private key wallet EVM lu. **Pakai wallet baru/burner**, jangan wallet utama |
| `RH_TG_TOKEN` | Chat [@BotFather](https://t.me/BotFather) di Telegram → `/newbot` → copy token |
| `RH_TG_CHAT` | **Owner chat id — GERBANG KEAMANAN.** Chat [@userinfobot](https://t.me/userinfobot) buat dapet id lu. Cuma chat ini yang boleh nyuruh bot |
| `RH_WATCH_RPC_URL` | (opsional) app Alchemy kedua, buat scanner. Kosongin juga nggak apa-apa |
| `RH_OPENROUTER_KEY` | (opsional) [openrouter.ai/keys](https://openrouter.ai/keys) — nyalain radar LLM |
| `KYBERSWAP_*` | (opsional) endpoint aggregator KyberSwap — buat swap rute-terbaik (lihat `.env.example`) |

Bikin wallet baru cepat:
```bash
node -e "const w=require('ethers').Wallet.createRandom();console.log('Address:',w.address);console.log('Key    :',w.privateKey)"
```

Isi wallet itu pakai ETH di **Robinhood Chain** (bridge dari mainnet). Sisain minimal `0.015 ETH` buat gas.

**Jalanin:**
```bash
npm start        # = node --env-file-if-exists=.env --import tsx src/index.ts
```

Buka bot lu di Telegram, kirim `/start`. Kalau dia jawab, beres.

> Pengecekan tipe: `npm run typecheck` · dev auto-reload: `npm run dev`

---

## Cara pakai

### Buka posisi LP

1. **Paste CA token** (`0x…`) ke chat
2. Bot cariin pool-nya di **v2 / v3 / v4** (label `ETH ✅` / `USDG ✅`) → pilih salah satu
3. Ketik jumlah ETH (contoh: `0.05`)
4. Pilih mode:

```
🛡 Single-side ETH — range $2.64M → $3.94M
   0% token. Fee jalan cuma kalau MCAP masuk range. Aman dari rug.

🎯 In-range — range $3.35M → $5.00M
   beliin ~51% modal → token duluan (via Kyber, rute terbaik).
   Fee LANGSUNG jalan, tapi lu langsung pegang token (rug = rugi 51% instan).
```

**Bedanya penting — baca ini:**

| | 🛡 Single-side | 🎯 In-range |
|---|---|---|
| Isi posisi awal | 100% ETH | ~49% ETH + ~51% token |
| Fee | nunggu harga masuk range | jalan dari detik 1 |
| Kalau token rug | rugi kecil (belum kekonversi) | **rugi ~51% instan** |

Uniswap nggak bisa bikin range yang nyebrang harga cuma dengan satu token. Jadi "in-range" artinya bot **beliin tokennya duluan** (lewat KyberSwap aggregator → rute termurah, bukan di pool fee-tinggi yang lu pilih). Pakai buat token yang pool-nya tebel. Token meragukan → tetep single-side.

### Cek posisi — `/list`

```
📋 Posisi LP · ETH $1844 · 09.44.49

🐷 DATABEAR  ·  fee 1.00%  ·  #86566
   🟢 IN RANGE
   modal     0.060000Ξ    $108.66
   nilai     0.073289Ξ    $132.74
   fee       0.016264Ξ     $29.46
   umur            36m  $48.02/jam
   MCAP         $3.28M  entry $4.20M
   range   $2.69M → $4.02M
   PnL      +0.013289Ξ    +$24.07  +22.1%

🦄 UNISWAP v4 · 2 posisi
   ...
💧 UNISWAP v2 · 1 posisi
   ...

TOTAL 4 posisi  ·  v3 1 · v4 2 · v2 1
modal   0.128000Ξ    $236.03
nilai   0.141813Ξ    $261.50
fee     0.017640Ξ     $32.53
PnL    +0.013813Ξ     +$25.47
```

**`$/jam` itu angka paling berguna di sini.** Umur doang nggak nolong. Yang lu butuh tau: posisi ini masih kerja apa udah nganggur?

- `3h 20m · $2.10/jam` → masih produktif, biarin
- `2d 5h · $0.04/jam` → udah mati, modal nyangkut percuma → tutup, puter ke pool lain

TOTAL (gabung v3+v4+v2) selalu di baris paling bawah. Tombol 🔄 **Refresh** ambil data fresh; `/list` biasa dilayanin dari cache 20 detik (biar instan). Tiap token ada tombol **Close** / **💰 Claim**.

### Tutup posisi

Pencet tombol close → pilih:
- **🔄 Swap token → ETH** — semuanya balik jadi ETH
- **🪙 Simpen token** — LP principal balik ke ETH, tokennya lu tahan

Bot otomatis: tarik likuiditas → klaim fee → burn NFT → (swap) → **isi gas balik ke 0.015 ETH** → kirim **kartu profit**.

Buat token honeypot yang nggak bisa ditarik (transfer revert), bot **force-close**: relakan sisi token yang keblokir, **selametin ETH-nya**.

> ⚠️ **Catatan "Simpen token":** auto-swap pas close nyapu **seluruh saldo token di dompet**, bukan cuma dari posisi itu.

### Riwayat — `/ledger`

Semua posisi ditutup (v3 + v4 + v2, urut terbaru dulu), tombol Next/Back + 📸 kartu per-posisi. Stats gabungan: win rate, modal, fee LP, realized vs nyangkut.

Ledger direkonstruksi dari **event on-chain** — posisi lama tetep kebaca walau baru install bot-nya. Pair USDG dihitung **LP-vs-HODL** (fee + IL, exclude gerakan harga token) biar konsisten dan jujur.

### Swap — `/swap`

`/swap <jumlah> <dari> <ke>` — swap token apa aja lewat **KyberSwap aggregator** (rute terbaik lintas DEX). `dari`/`ke` = `eth` atau CA. Tampil quote + breakdown rute + slippage → tombol ✅ konfirmasi.

### Screening thesis — `/screen`

Filter GMGN 24 jam pakai playbook operator: mcap > $500k, vol > $1M, **buang flap.fun**, **util diprioritas, meme dipenalti**, cek komunitas + FOMO. Top-10 di-skor LLM. `/screen fast` = tanpa LLM.

### Scanner volume — `/watch`

Jalan otomatis tiap 2 menit. Nyari volume 5-menit yang **NANJAK**, bukan sekadar tinggi. Tiap token diuji honeypot on-chain:

```
DATABEAR  simulasi beli 0.01Ξ → jual balik 0.00980Ξ = 98.0%  ✅ sehat
honeypot  simulasi beli 0.01Ξ → REVERT                       🚨 ditolak
```

Notifnya bawa CA, link DexScreener, dan tombol **🎯 LP** langsung.

### Monitor sequencer real-time — `/feed`

Opt-in (default off): `/feed on`. Dengerin **feed sequencer Nitro** (`wss://feed.mainnet.chain.robinhood.com/feed`) — mempool sub-detik, **sebelum** tx masuk block.

1. **🆕 Token baru** — deteksi pool WETH baru / mint likuiditas pertama, langsung uji honeypot + tombol 1-tap LP.
2. **🔴 Out-of-range** — swap ngenain pool yang lu LP-in → cek tick → alert (opsional auto-close, default off).

> ⚠️ **DNS hijack:** kalau jaringan lu hijack DNS domain feed (mis. Telkomsel "Internet Baik"), set `RH_FEED_IP=172.66.147.70` di `.env`. Di VPS US nggak perlu. Sequencer di AWS Ohio (`us-east-2`).

Toggle: `/set newtoken 1` · `/set posmon 1` · `/set autoclose 0` · `/set minseed 0.02`

### Fast-submit — broadcast langsung ke sequencer

Set `RH_FAST_SUBMIT=1`. Tx dikirim langsung ke sequencer Robinhood (**AWS us-east-2 / Ohio**), skip hop relay. Baca tetep via RPC utama; sequencer error → auto fallback (tx nggak ilang). **Paling ngefek di VPS US.** Lokal + DNS hijack → set `RH_SEQUENCER_IP=3.136.74.196`.

### Radar LLM + GMGN — layer konfirmasi kandidat

Tiap kandidat (token baru dari feed / spike dari watch) di-skor **LLM lewat OpenRouter** + di-enrich data **GMGN** (smart money, holders, rug ratio, tax, konsentrasi top-10). Verdict (`🟢 APE / 🟡 WATCH / 🔴 SKIP` + skor + alasan) nempel di notif, sebelum lu pencet LP.

```
# nyalain
RH_OPENROUTER_KEY=...        # openrouter.ai/keys
/set radar 1                 # di Telegram
```

GMGN (opsional, enrich): install `gmgn-cli` + config di mesin yang jalanin bot (key GMGN ke-bind ke keypair lokal — lihat `.env.example` §9). GMGN support chain `robinhood`. Nggak dikonfig → radar tetep jalan pakai LLM + data on-chain aja (degrade mulus).

> Semua best-effort: fast-submit / radar / GMGN / Kyber mati sendiri kalau env/tool-nya nggak ada — bot inti tetep jalan.

---

## Semua command

| Command | Fungsi |
|---|---|
| paste `0x…` | Buka posisi LP (v2/v3/v4, auto detect pool) |
| `/list` | Posisi terbuka (v3+v4+v2) + PnL + TOTAL + tombol close |
| `/ledger` | Riwayat posisi ditutup (realized vs nyangkut) + kartu per-posisi |
| `/pnl` | PnL seumur hidup level dompet |
| `/card` | Kartu profit portfolio (PNG shareable) |
| `/swap` | Swap token via KyberSwap aggregator (rute terbaik) |
| `/screen` | Screening GMGN 24h (mcap>500k, vol>1M, no flap, util>meme) · `/screen fast` |
| `/watch` | Status scanner + volume tertinggi saat ini |
| `/feed` | Monitor sequencer real-time · `/feed on`/`off` |
| `/scan` | Cek volume sekarang juga (manual) |
| `/auto` | Auto-LP (radar → buka posisi otomatis) |
| `/v4` | Cek pool Uniswap v4 sebuah token CA |
| `/closeall` | Tutup SEMUA posisi |
| `/sell` | Jual semua token nyangkut → ETH |
| `/wallet` | Saldo hot wallet |
| `/settings` · `/set <key> <angka>` | Lihat / ubah setting |

**Setting yang bisa diubah:**
```
LP     : /set width 50        lebar range (%)
         /set slippage 5      toleransi slippage (%)
         /set gastarget 0.015 gas native yang dijaga tiap close

Scanner: /set vol5m 500000    volume 5m minimal (USD)
         /set rise 1.4        harus naik berapa kali lipat
         /set liq 50000       likuiditas pool minimal
         /set tax 6           tolak token dengan tax > sekian %
         /set cooldown 60     jeda notif per token (menit)
         /set interval 120    scan tiap berapa detik

Feed   : /set newtoken 1 · /set posmon 1 · /set autoclose 0 · /set minseed 0.02
Radar  : /set radar 1 · /set gmgn 1
```

---

## Jalan 24 jam di VPS

```bash
npm install -g pm2
pm2 start npm --name robinhood-lp -- start   # npm start udah baca .env sendiri
pm2 save
pm2 startup        # ikutin instruksi yang keluar → auto-start abis reboot
```

Cek: `pm2 logs robinhood-lp`

> Kartu profit butuh font: `sudo apt install -y fonts-dejavu-core fonts-dejavu-extra` (canvas render blank text tanpa ini).

> ⚠️ **Jangan jalanin di 2 tempat sekaligus.** Dua proses polling token Telegram yang sama → rebutan (`409 Conflict`). v2 udah ada **single-instance lock** (`data/bot.lock`). Kalau share wallet sama bot lain → **jangan jalan bareng** (nonce tabrakan).

---

## Struktur kode (`src/`)

```
src/
├── index.ts              entrypoint — validasi secret, lock, graceful shutdown
├── config.ts             load + validasi config (zod) + secret dari .env
├── types.ts              tipe domain bersama
├── chain/                semua urusan blockchain
│   ├── client.ts         provider (LP + watch), wallet, gas, fast-submit routing
│   ├── kyber.ts          KyberSwap aggregator (quote + build, 4 security gate)
│   ├── positions.ts      v3 open / list / close (Uniswap SDK math)
│   ├── pools.ts          findPools, poolState, range math (SDK)
│   ├── swaps.ts          quote + swap v3 (slippage floor)
│   ├── ledger.ts         ledger permanen + rebuild on-chain
│   ├── analytics.ts      PnL seumur hidup
│   ├── tokens.ts         metadata token (cached) + SDK Token
│   ├── price.ts          ETH/USD multi-source
│   ├── blockscout.ts     helper REST Blockscout + mapLimit
│   ├── v2/               Uniswap v2 — pair.ts · mint.ts (zap) · list.ts · close.ts
│   └── v4/               Uniswap v4 — discover · mint · list · close · backfill (archive PnL)
├── telegram/
│   ├── tg.ts             transport + AUTH boundary (owner-only)
│   ├── bot.ts            long-poll loop + routing + setMyCommands
│   ├── handlers.ts       semua command/tombol (+ cache /list)
│   ├── menu.ts           reply keyboard persisten
│   ├── card.ts           kartu profit PNG (@napi-rs/canvas, STRIX style)
│   ├── notify.ts         notif spike / token baru / out-of-range
│   ├── watchLoop.ts      timer scanner
│   ├── feedLoop.ts       lifecycle feed monitor
│   └── format.ts         escape, padding, emoji per-token
├── feed/                 monitor sequencer real-time (Nitro)
│   ├── decode · listener (WS + IP-pin) · swapdecode · lpdecode · monitor
├── radar/                konfirmasi kandidat (LLM + GMGN)
│   ├── openrouter.ts · gmgn.ts · screen.ts (/screen thesis) · radar.ts
├── watch/scanner.ts      scan volume + uji honeypot on-chain
└── util/                 log, atomic file write + lock, formatter
```

| File lain | Isinya apa |
|---|---|
| `config.json` | Setting (di-validasi zod pas start) |
| `.env` | **Kunci-kunci. Rahasia.** (gitignored) |
| `assets/card-bg.jpg` | Background kartu profit (opsional) |
| `data/` | State runtime — `positions.json`, `v4-positions.json`, `lp-ledger.json`, `v2-skip.json`, `bot.lock`. **Jangan dihapus** — catatan PnL lu di situ. (gitignored) |

Ditulis atomik (temp + rename), jadi crash di tengah nulis nggak bikin ledger korup.

---

## Yang perlu lu sadar

**Ini bot buat degen, bukan investasi.** LP di token meme = lu jadi pembeli otomatis pas harganya turun. Itu bukan bug, itu emang cara kerja LP.

**Tes honeypot nangkep honeypot & tax — BUKAN rug.** Dev yang tarik likuiditas besok tetep lolos tes hari ini. Nggak ada tes yang bisa liat masa depan.

**Single-side ETH itu rem alami lu.** Mode in-range ngelepas rem itu. Pilih sadar.

**Pakai burner wallet.** Private key-nya duduk di `.env` dalam bentuk teks biasa. Jangan taruh duit yang lu nggak siap ilang.

**Set `RH_TG_CHAT`.** Itu gerbang owner — cuma chat lu yang boleh nyuruh bot. Bot megang private key; jangan biarin siapa pun bisa `/closeall` atau mint pakai duit lu.

---

MIT. Pakai risiko sendiri.
