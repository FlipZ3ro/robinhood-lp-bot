# Robinhood LP Bot v2

LP di Uniswap v3 (Robinhood Chain) lewat Telegram. Paste CA → pilih pool → ketik jumlah ETH → posisi kebuka.

Plus scanner volume yang nyariin token lagi rame, ngetes honeypot-nya, dan notif ke lu.

**v2 = TypeScript + Uniswap SDK.** Semua math tick/harga lewat `@uniswap/v3-sdk` (nggak ada
lagi `Math.pow` hand-rolled → nggak ada drift presisi). Terstruktur modular di `src/`,
owner-only auth, slippage protection di semua swap, atomic write buat ledger, graceful
shutdown, dan single-instance lock. Jalan di laptop atau VPS.

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

# 2. Install (narik ethers v6 + @uniswap/v3-sdk + typescript)
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

### ⚠️ Kalau lu upgrade dari v1

- File runtime pindah ke folder `data/` (`positions.json`, `lp-ledger.json`,
  `watch-history.json`). Punya data lama di root? Pindahin ke `data/` biar riwayat
  PnL kebaca — atau biarin, ledger bisa di-rebuild dari on-chain (tombol Rebuild / `/ledger`).
- Kode `.js` lama ada di `legacy/` sebagai referensi. Boleh dihapus kalau v2 udah jalan.

---

## Cara pakai

### Buka posisi LP

1. **Paste CA token** (`0x…`) ke chat
2. Bot cariin pool-nya → pilih salah satu
3. Ketik jumlah ETH (contoh: `0.05`)
4. Pilih mode:

```
🛡 Single-side ETH — range $2.64M → $3.94M
   0% token. Fee jalan cuma kalau MCAP masuk range. Aman dari rug.

🎯 In-range — range $3.35M → $5.00M
   swap ~51% modal → token duluan. Fee LANGSUNG jalan,
   tapi lu langsung pegang token (rug = rugi 51% instan).
```

**Bedanya penting — baca ini:**

| | 🛡 Single-side | 🎯 In-range |
|---|---|---|
| Isi posisi awal | 100% ETH | ~49% ETH + ~51% token |
| Fee | nunggu harga masuk range | jalan dari detik 1 |
| Kalau token rug | rugi kecil (belum kekonversi) | **rugi ~51% instan** |

Uniswap v3 nggak bisa bikin range yang nyebrang harga cuma dengan satu token. Jadi "in-range" artinya bot **beliin tokennya duluan**. Pakai buat token yang pool-nya tebel. Token meragukan → tetep single-side.

### Cek posisi — `/list`

```
🐷 DATABEAR  ·  fee 1.00%  ·  #86566
   🟢 IN RANGE
   modal     0.060000Ξ    $108.66
   nilai     0.073289Ξ    $132.74
   fee       0.016264Ξ     $29.46
   umur            36m  $48.02/jam
   MCAP         $3.28M  entry $4.20M
   range   $2.69M → $4.02M
   PnL      +0.013289Ξ    +$24.07  +22.1%
```

**`$/jam` itu angka paling berguna di sini.** Umur doang nggak nolong. Yang lu butuh tau: posisi ini masih kerja apa udah nganggur?

- `3h 20m · $2.10/jam` → masih produktif, biarin
- `2d 5h · $0.04/jam` → udah mati, modal nyangkut percuma → tutup, puter ke pool lain

Ada tombol 🔄 **Refresh** (update di tempat) dan tombol **Close** per token.

### Tutup posisi

Pencet tombol close → pilih:
- **🔄 Swap token → ETH** — semuanya balik jadi ETH
- **🪙 Simpen token** — LP principal balik ke ETH, tokennya lu tahan

Bot otomatis: tarik likuiditas → klaim fee → burn NFT → (swap) → **isi gas balik ke 0.015 ETH**.

> ⚠️ **Catatan soal "Simpen token":** auto-swap pas close nyapu **seluruh saldo token di dompet**, bukan cuma dari posisi itu. Jadi token yang lu simpen bakal ikut kejual pas lu close posisi berikutnya di token yang sama.

### Riwayat — `/ledger`

Semua posisi yang udah ditutup, ada tombol Next/Back.

```
29 POSISI DITUTUP
menang   15W / 14L   52%
modal    1.09507Ξ
fee LP   0.02288Ξ

REALIZED -0.05403Ξ   -$96.95
  ETH yang beneran balik ke tangan

nyangkut +0.06046Ξ   +$108.48
  token blm dijual — pakai /sell buat cairin

NET      +0.00872Ξ   +$15.77
  kalau semua token nyangkut laku dijual
```

**REALIZED dan NYANGKUT sengaja dipisah.** Kalau digabung, posisi yang tokennya belum kejual bakal keliatan "impas" padahal duitnya belum balik. Angka yang enak dibaca tapi bohong lebih bahaya daripada nggak ada angka.

Ledger direkonstruksi dari **event on-chain** (`IncreaseLiquidity`, `Collect − DecreaseLiquidity`), jadi posisi lama tetep kebaca walau baru install bot-nya.

### Scanner volume — `/watch`

Jalan otomatis tiap 2 menit. Nggak perlu command apa-apa.

Yang dicari: volume 5-menit yang **NANJAK**, bukan sekadar tinggi. (Kalau cuma pakai ambang "> $X", token yang emang rame terus bakal di-spam tiap scan.)

Sebelum notif, tiap token diuji honeypot **on-chain**:

```
DATABEAR  simulasi beli 0.01Ξ → jual balik 0.00980Ξ = 98.0%  ✅ sehat
          (rugi 2% itu cuma fee pool 1% × 2 arah)

honeypot  simulasi beli 0.01Ξ → REVERT                       🚨 ditolak
```

Nggak ada API honeypot yang support chain ini, jadi bot **nyoba sendiri** lewat Quoter. Nggak percaya sama reputasi siapa pun.

Notifnya bawa CA, link DexScreener, dan tombol **🎯 LP** langsung.

### Monitor sequencer real-time — `/feed`

Opt-in (default off). Nyalain: `/feed on`. Ini dengerin **feed sequencer Nitro** (`wss://feed.mainnet.chain.robinhood.com/feed`) — mempool real-time, sub-detik, **sebelum** tx masuk block atau ke-index DexScreener.

Dua sinyal:

1. **🆕 Token baru** — deteksi pool WETH baru / mint likuiditas pertama lewat factory+NPM (fully decodable). Langsung diuji honeypot, terus notif + tombol 1-tap LP. DexScreener nggak bisa alert token yang belum dia index — ini bisa.
2. **🔴 Out-of-range** — pas ada swap ngenain pool yang lu LP-in, counter naik; begitu lewat ambang, bot baca `slot0()` sekali buat konfirmasi tick. Kalau posisi keluar range → alert (opsional **auto-close**, default off). Feed = trigger murah, RPC cuma disentuh pas beneran gerak.

> ⚠️ **DNS hijack:** kalau lu di jaringan yang hijack DNS domain feed (mis. Telkomsel "Internet Baik"), set `RH_FEED_IP=172.66.147.70` di `.env` biar tembus (pin IP Cloudflare asli, SNI tetep bener). Di VPS US nggak perlu. Sequencer-nya sendiri di AWS Ohio (`us-east-2`) — makanya submit dari VPS Ohio ~8ms.

Toggle: `/set newtoken 1` · `/set posmon 1` · `/set autoclose 0` · `/set minseed 0.02`

**Catatan akurasi:** mayoritas volume chain ini lewat router non-Uniswap yang unverified, jadi deteksi berbasis-swap dari feed = *lower bound* (bagus buat trigger, bukan angka volume absolut). Deteksi token-baru & out-of-range **akurat** karena pakai factory/NPM yang ABI-nya kita tau.

### Fast-submit — broadcast langsung ke sequencer

Set `RH_FAST_SUBMIT=1`. Tx (`eth_sendRawTransaction`) dikirim langsung ke sequencer Robinhood (**AWS us-east-2 / Ohio**), skip hop relay Alchemy. Baca (nonce, gas, staticCall, logs) tetep via Alchemy; kalau sequencer error, otomatis fallback ke RPC utama (tx nggak ilang). **Paling ngefek kalau bot di VPS US.** Lokal + DNS hijack → set `RH_SEQUENCER_IP=3.136.74.196`.

### Radar LLM + GMGN — layer konfirmasi kandidat

Pola dari [meridian](https://github.com/yunus-0x/meridian) (agent LP Solana). Tiap kandidat (token baru dari feed / spike dari watch) di-skor LLM lewat **OpenRouter** + di-enrich data **GMGN** (smart money, holders, rug ratio, tax, konsentrasi top-10). Verdict (`🟢 APE / 🟡 WATCH / 🔴 SKIP` + skor + alasan) nempel di notif, sebelum lu pencet LP.

```
# nyalain
RH_OPENROUTER_KEY=...        # openrouter.ai/keys
/set radar 1                 # di Telegram
```

GMGN (opsional, enrich): install `gmgn-cli` + config di mesin yang jalanin bot (key GMGN ke-bind ke keypair lokal — lihat `.env.example` §9). GMGN support chain `robinhood`. Kalau nggak dikonfig, radar tetep jalan pakai LLM + data on-chain aja (degrade mulus).

> Semua best-effort: fast-submit / radar / GMGN mati sendiri kalau env/tool-nya nggak ada — bot inti tetep jalan.

---

## Semua command

| Command | Fungsi |
|---|---|
| paste `0x…` | Buka posisi LP |
| `/list` | Posisi terbuka + PnL + tombol close |
| `/ledger` | Riwayat posisi ditutup (realized vs nyangkut) |
| `/pnl` | PnL seumur hidup level dompet (termasuk token rug) |
| `/watch` | Status scanner + volume tertinggi saat ini |
| `/feed` | Monitor sequencer real-time (token baru + out-of-range) · `/feed on`/`off` |
| `/scan` | Cek volume sekarang juga (manual) |
| `/closeall` | Tutup SEMUA posisi |
| `/sell` | Jual semua token nyangkut → ETH |
| `/wallet` | Saldo |
| `/settings` | Lihat setting |
| `/set <key> <angka>` | Ubah setting |

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

> ⚠️ **Jangan jalanin di 2 tempat sekaligus.** Dua proses yang polling token Telegram yang
> sama bakal rebutan (`409 Conflict`). v2 udah ada **single-instance lock** (`data/bot.lock`) —
> instance kedua nolak start selama yang pertama masih hidup. Tetep, matiin yang di laptop
> kalau udah jalan di VPS.

---

## Struktur kode (`src/`)

```
src/
├── index.ts              entrypoint — validasi secret, lock, graceful shutdown
├── config.ts             load + validasi config.json (zod) + secret dari .env
├── types.ts              tipe domain bersama
├── chain/                semua urusan blockchain
│   ├── client.ts         provider (LP + watch), wallet, gas override
│   ├── abis.ts           ABI minimal
│   ├── tokens.ts         metadata token + builder SDK Token
│   ├── pools.ts          findPools, poolState, range math (via SDK)
│   ├── positions.ts      open / list / close (Uniswap SDK math)
│   ├── swaps.ts          quote + swap (semua ada slippage floor)
│   ├── holdings.ts       saldo + jual-semua-token
│   ├── ledger.ts         ledger permanen + rebuild on-chain
│   ├── analytics.ts      PnL seumur hidup
│   ├── price.ts          ETH/USD multi-source
│   └── blockscout.ts     helper REST Blockscout
├── telegram/
│   ├── tg.ts             transport + AUTH boundary (owner-only)
│   ├── bot.ts            long-poll loop + routing
│   ├── handlers.ts       semua command/tombol
│   ├── notify.ts         notif spike / token baru / out-of-range
│   ├── watchLoop.ts      timer scanner
│   ├── feedLoop.ts       lifecycle feed monitor
│   └── format.ts         escape, padding, emoji per-token
├── feed/                 monitor sequencer real-time (Nitro)
│   ├── decode.ts         frame Nitro → signed tx
│   ├── listener.ts       WS reconnect + IP-pin (bypass DNS hijack)
│   ├── swapdecode.ts     extract swap Uniswap dari tx
│   ├── lpdecode.ts       extract mint/pool-baru dari tx
│   └── monitor.ts        new-token detector + position monitor
├── radar/                layer konfirmasi kandidat (LLM + GMGN)
│   ├── openrouter.ts     skoring LLM via OpenRouter
│   ├── gmgn.ts           enrichment via gmgn-cli (chain robinhood)
│   └── radar.ts          orchestrator: on-chain + GMGN → verdict
├── chain/sequencer.ts    fast-submit ke sequencer (dipakai client.ts)
├── watch/scanner.ts      scan volume + uji honeypot on-chain
└── util/                 log, atomic file write + lock, formatter
```

| File lain | Isinya apa |
|---|---|
| `config.json` | Setting (di-validasi zod pas start) |
| `.env` | **Kunci-kunci. Rahasia.** |
| `data/` | State runtime — `positions.json` (modal per posisi), `lp-ledger.json` (riwayat), `watch-history.json` (baseline volume), `bot.lock`. **Jangan dihapus** — di situ catatan PnL lu. |

Ditulis atomik (temp + rename), jadi crash di tengah nulis nggak bikin ledger korup.

---

## Yang perlu lu sadar

**Ini bot buat degen, bukan investasi.** LP di token meme = lu jadi pembeli otomatis pas harganya turun. Itu bukan bug, itu emang cara kerja LP.

**Tes honeypot nangkep honeypot & tax — BUKAN rug.** Dev yang tarik likuiditas besok tetep lolos tes hari ini. Nggak ada tes yang bisa liat masa depan.

**Single-side ETH itu rem alami lu.** Modal cuma kekonversi jadi token pelan-pelan saat harga gerak. Mode in-range ngelepas rem itu. Pilih sadar.

**Pakai burner wallet.** Private key-nya duduk di `.env` dalam bentuk teks biasa. Jangan taruh duit yang lu nggak siap ilang.

**Set `RH_TG_CHAT`.** Itu gerbang owner — cuma chat lu yang boleh nyuruh bot. Tanpa itu bot ngunci ke chat pertama yang `/start`, tapi mending diisi eksplisit. Bot megang private key; jangan biarin siapa pun bisa `/closeall` atau mint pakai duit lu.

---

MIT. Pakai risiko sendiri.
