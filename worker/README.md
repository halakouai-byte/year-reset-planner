# 2027 Year Reset Planner Pack store — Telegram bot + TON/USDT payments (Cloudflare Worker)

Seller: **halakouai-byte** · Product: 2027 Year Reset Planner Pack (14-page printable PDF planner) · Price: **$3.00 USDT on TON**
Stack: free Cloudflare Worker + KV + Telegram Bot API. No server, no AI at runtime, no secret in code or in this repo.

> **Read first:** `FLOW.md` (the exact payment + delivery flow, incl. the Telegram Stars risk).
> This README is setup, secrets, and testing only.

## 1. What this Worker does

| Step | How |
|---|---|
| Order | `/buy` in the bot, or `POST /api/order` from the landing page → unique memo `YR-XXXXXX`, 60-min expiry |
| Pay | Keeper / `ton://` deep link, USDT jetton (primary) or native TON (fallback). Price in USDT, never TON |
| Verify | TonAPI jetton history (primary) + TON Center v2 (native-TON fallback). Triggered by "✅ I paid" **and** a 2-min cron sweep (one batched API call per sweep) |
| Deliver | `sendDocument` with a cached Telegram `file_id` — the file lives on Telegram, zero hosting cost |
| Problems | Wrong amount / missing memo / ambiguous payment / late payment → `needs_review`, seller notified, never auto-delivered on ambiguity |

## 2. Prerequisites (seller does these once)

1. **Telegram bot** — message `@BotFather`, `/newbot`, copy the token. **Never paste the token in chat, in a file, or in the repo.**
2. **TON wallet** — Keeper (Tonkeeper) wallet address that will receive payments (starts `UQ…` or `EQ…`). This address is *public* (buyers send money to it) — it is still stored as a secret below so it lives in one place.
3. **Product file** — the finished 14-page planner PDF, under 50 MB (Telegram bot limit).
4. **Cloudflare account (free)** + `wrangler` CLI logged in (`npx wrangler login`).
5. **Your own Telegram user id** (for seller-only commands + alerts) — message `@userinfobot`, copy the numeric id.

## 3. Deploy

```bash
cd worker
npm i -g wrangler            # if wrangler is not installed

# KV namespace for orders + tx-hash dedup (free tier: 1,000 writes/day)
wrangler kv namespace create ORDERS_KV
wrangler kv namespace create ORDERS_KV --preview
# Paste the two ids into wrangler.toml (replace <YOUR_KV_NAMESPACE_ID> etc.)

# Deploy the Worker (no secrets in the deploy — they come next)
wrangler deploy
# Note the URL, e.g. https://year-reset-bot.<subdomain>.workers.dev
```

## 4. Secrets — run these AFTER you have the values (never before, never in chat)

Each command prompts you to paste the value; it is stored encrypted by Cloudflare and never appears in code, logs, or the repo.

```bash
wrangler secret put BOT_TOKEN
# paste the @BotFather token

wrangler secret put SELLER_TON_ADDRESS
# paste your Keeper wallet address (UQ… / EQ…)

wrangler secret put PRODUCT_FILE_ID
# paste the Telegram file_id of the product file — see §5 for how to get it

wrangler secret put SELLER_TELEGRAM_ID
# paste your numeric Telegram user id from @userinfobot (seller commands + alerts)

# Optional — only if you made a free TonAPI key at tonconsole.com:
# (without it: 1 request / 4 s; with it: 1 request / s. Either is enough here.)
wrangler secret put TONAPI_KEY

# Optional — webhook shared secret (recommended; must match the value sent to setWebhook):
wrangler secret put WEBHOOK_SECRET
```

Non-secret settings live in `wrangler.toml` under `[vars]` — edit there and redeploy:
`PRODUCT_PRICE_USDT` (default `"3.00"`), `ORDER_TTL_MINUTES` (`"60"`),
`SUPPORT_USERNAME`, `BOT_USERNAME`.

## 5. Getting PRODUCT_FILE_ID (do this once per product file)

1. After deploy + secrets (except `PRODUCT_FILE_ID`), set the webhook (see §6).
2. **From your own Telegram account, send the product PDF as a message to your bot.**
3. The bot replies with the `file_id`. Copy it.
4. Run `wrangler secret put PRODUCT_FILE_ID` and paste it.
5. If you ever replace the product file, repeat — a new upload means a new `file_id`.

If `sendDocument` later fails with "file not found", the `file_id` went stale: re-upload the file to the bot and update the secret.

## 6. Set the Telegram webhook

```bash
# Replace <BOT_TOKEN> with the token (in your terminal only, never in a file),
# <WORKER_URL> with your deployed Worker URL,
# and <WEBHOOK_SECRET> with the same value you stored in §4 (omit the header if you skipped it).
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "<WORKER_URL>/webhook", "secret_token": "<WEBHOOK_SECRET>", "allowed_updates": ["message", "callback_query"]}'
# Expected: {"ok":true,"result":true,"description":"Webhook was set"}
```

## 7. Live-test procedure (do this BEFORE announcing the store)

**Rule: test with real money, but the smallest real money — a second wallet you control.**

1. `wrangler tail` in one terminal (live logs).
2. In the bot, `/buy` → note the order id (e.g. `YR-XXXXXX`) and the Keeper link.
3. From a **second wallet** (not the seller wallet), pay **exactly $3.00 USDT on TON** with the memo untouched. Confirm in Keeper that the memo field still shows the order id.
4. Tap "✅ I paid" in the bot. Expected within ~1–2 min: "Payment confirmed!" + the file arrives.
5. Check the log line `order_delivered` with `via: "usdt-comment"`.
6. **Negative checks (same order flow, new orders):**
   - Pay with the memo deleted → "I paid" must say *no payment found*; then `/tx <hash>` with the real tx hash, or wait for the cron sweep — Tier-2 (unique exact amount + time) should deliver it. If it doesn't, the seller delivers manually with `/deliver`.
   - Pay $1.00 instead of $3.00 → bot must say *partial* and ask for the $2.00 top-up with the same memo; pay the top-up → delivered.
   - Pay in native TON via the fallback link → delivered with `via: "ton-comment"`.
   - Tap "I paid" twice after delivery → file sent **once** only.
7. **Test the failure you hope never happens:** send $0.10 USDT on **Tron** to a Tron address you control (NOT to the TON address) — confirm you understand the bot cannot see it. This is a process test, not a code test: the buyer would need `/support` + tx hash, and you would check Tronscan manually.
8. Only after steps 3–6 pass, announce the store. Keep the first week to the $3.00 price; do not change the price mid-order (orders store the price at creation).

**The two things this live test must prove (they cannot be proven in the dry run):**
1. Keeper actually forwards the `text=` memo on a **jetton (USDT)** payment — the comment must appear in TonAPI's jetton history. If it does not, Tier-2 matching + manual `/deliver` carry the store until the TON Connect upgrade (see FLOW.md §7).
2. A real successful transfer shows `status: "success"` in TonAPI (the dry run only ever observed `status: "failed"` transfers in the wild).

## 8. Operating the store (seller commands)

All seller commands work only from the `SELLER_TELEGRAM_ID` account.

| Command | Use |
|---|---|
| `/orders` | List open (unpaid / needs-review) orders |
| `/deliver YR-XXXXXX` | Manually deliver after you verified a payment yourself (e.g. Tron payment checked in Tronscan, or a memo-less payment you matched by hand) |
| `/refund YR-XXXXXX` | Marks refunded + tells you the exact manual step: send the USDT back from Keeper to the buyer's wallet address (shown by the bot). **The bot never moves money.** |
| (send the product file to the bot) | Bot replies with the `file_id` for `PRODUCT_FILE_ID` |

Buyer commands: `/start`, `/buy`, `/claim YR-XXXXXX` (link a landing-page order to a chat), `/status [YR-XXXXXX]`, `/support`, `/tx <64-hex-hash>` (check one specific transaction).

## 9. DRY-RUN TEST PLAN (no real money)

What was actually run here, and how to re-run it:

```bash
node --test test/verify.test.mjs    # 21 unit tests: money math, addresses, links, parsers, matcher
node --test test/e2e-dryrun.test.mjs # 5 end-to-end tests of the real Worker with stubbed network
```
Do NOT use the directory form `node --test test/` — Node 24 treats it as a module path and fails with `MODULE_NOT_FOUND`. Run the two files explicitly, as above (26 tests total: 21 unit + 5 e2e).

**Results on 2026-11-21 (this machine, Node v24.22.1): 26/26 pass (21 unit + 5 e2e).**

- Unit tests: **21/21 pass.** Covers: USDT↔units math, TON-fallback rounding (up), EQ↔raw address equality, pay-link contents, TonAPI parser (drops failed + fake-jetton transfers), TON Center parser (skips `dataRaw`), matcher tiers (exact memo, top-up summing, Tier-2 unique, Tier-2 ambiguity → no delivery, replayed-tx rejection, overpayment).
- E2E dry run: **5/5 pass** against the real `src/worker.js` with a fake KV and stubbed `fetch` (runs at the real launch price **$3.00**; the harness sets a test `TONAPI_KEY` so the throttle is 1.1 s and the suite stays fast):
  1. `/buy` → mocked on-chain payment → "I paid" → exactly one `sendDocument` with the cached `file_id`; order `delivered`, tx hash claimed in KV; a second "I paid" does **not** re-deliver. (Runs at $3.00.)
  2. Same tx hash presented for a second order → second order goes to `needs_review`, no file sent (anti-replay).
  3. `POST /api/order` (landing page) → order + Keeper USDT link with memo + `t.me/<bot>?start=claim_<id>`. (Runs at $3.00.)
  4. **D7 retry:** payment confirmed but `sendDocument` fails (stale `file_id` stubbed) → order `paid`, tx claimed, buyer told the payment is safe; `/status` offers a "🔁 Retry delivery" button; buyer taps "I paid" again → file delivered, exactly two send attempts total, third tap does not re-deliver, and the retry never reports "No payment found".
  5. **D7 cron:** same failed-delivery setup, no buyer tap → the 2-minute cron sweep picks up the `paid` order and delivers it; a second sweep does not re-deliver.

**What the dry run CANNOT prove (only the §7 live test can):**
- That Keeper forwards the memo on jetton payments (Tier-1 depends on it).
- That TonAPI returns `comment` on a successful jetton transfer (only failed transfers were observable in the wild).
- That a real `sendDocument` with the real `file_id` succeeds (needs the real bot + file).
- Real-world latency / rate-limit behaviour under cron + buyer taps at the same time.

## 10. Limits (free tiers, verified 2026-11-20)

| Limit | Value | Effect here |
|---|---|---|
| Workers requests | 100,000/day | Bot updates + cron: negligible |
| Workers CPU | 10 ms/request (CPU only; network waits don't count) | Verification is network-bound; fine |
| KV writes | 1,000/day | ~5 writes per order → ~200 orders/day ceiling. Far above realistic volume |
| KV reads | 100,000/day | Negligible |
| Cron triggers (free) | 5 | Uses 1 (every 2 min) |
| TonAPI, no key | 1 req / 4 s | Enforced in code (KV timestamp throttle). Cron = 1 call / 2 min; "I paid" is human-paced |
| TonAPI, free key | 1 req / s | Same throttle, 1.1 s gap |
| TON Center, no key | 1 req / s | Fallback path only |
| Telegram `sendDocument` | files up to 50 MB | Product file must stay under 50 MB |
| D1 | not used | KV is enough at this volume; D1 is the upgrade path (FLOW.md §7) |

## 11. Catallaxy — parallel zero-code checkout (second option)

Same product, listed in parallel; see FLOW.md §9 for the full steps. In short: open `@ctlx_seller_bot`, list the file, set the price in USDT/GRAM, 2% fee per sale, 24-hour hold before withdrawal, minimum 0.1 GRAM to publish on-chain — all per Catallaxy's own how-to-sell blog, to be re-confirmed inside `@ctlx_seller_bot` at listing time (the marketplace front page does not display these terms). Treat it as a second checkout, not the business — its buyer traffic is unproven.

## 12. Files

```
worker/
├── src/worker.js          # the bot + verification + delivery (Cloudflare Worker)
├── src/ton.js             # pure payment logic (no Worker APIs; unit-tested)
├── wrangler.toml          # deploy config — NO secrets in here
├── README.md              # this file
├── FLOW.md                # exact flow, edge cases, Stars risk, upgrade paths
└── test/
    ├── verify.test.mjs    # 21 unit tests (node --test)
    └── e2e-dryrun.test.mjs# 5 end-to-end dry runs of the real Worker (stubbed network)
```
