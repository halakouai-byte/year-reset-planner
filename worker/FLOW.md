# FLOW.md — Exact payment + auto-delivery flow (2027 Year Reset Planner Pack store)

Price: **$3.00 USDT on TON** (configurable via `PRODUCT_PRICE_USDT`). USDT jetton master:
`EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` (6 decimals). Native TON (GRAM) is a fallback only.

```
BUYER                          BOT / WORKER                     CHAIN / TELEGRAM
  │                                │                                  │
  │  /buy  (or landing-page Buy)   │                                  │
  │ ──────────────────────────────>│                                  │
  │                                │ create order YR-XXXXXX           │
  │                                │ price $3.00 -> 3,000,000 units   │
  │                                │ TON fallback: $3.00 / rate       │
  │                                │ store in KV, expiry = now + 60m  │
  │ <──────────────────────────────│                                  │
  │  order card + Keeper pay link  │                                  │
  │  (memo YR-XXXXXX pre-filled)   │                                  │
  │                                │                                  │
  │  tap Pay -> Keeper opens       │                                  │
  │ ────────────────────────────────────────────────────────────────>│
  │  USDT 3.00, memo YR-XXXXXX, to seller wallet                      │
  │                                │                                  │
  │  tap "✅ I paid"               │                                  │
  │ ──────────────────────────────>│  (a) TonAPI jetton history       │
  │                                │      (b) TON Center txs (TON)    │
  │                                │  match memo + amount             │
  │                                │  claim tx hash in KV             │
  │ <──────────────────────────────│                                  │
  │  "Payment confirmed!"          │  sendDocument(file_id) ────────>│
  │  + the PDF/ZIP file            │  mark delivered                  │
  │                                │                                  │
  │  (no tap? cron sweep every 2 min does the same check for ALL       │
  │   pending orders with ONE batched TonAPI call)                    │
```

## 1. Order creation

- **From the bot:** `/buy`, or `/start buy` (landing-page deep link). The bot creates the order and shows the pay card.
- **From the landing page:** `POST /api/order` (no auth, IP-capped at 20/day) returns the order id, both pay links, and a `t.me/<bot>?start=claim_<id>` link. The buyer opens the bot and the order is linked to their chat (`/claim YR-XXXXXX` also works). The landing page **never** handles money — it only displays the link the Worker minted.
- **Order id / memo:** `YR-` + 6 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L — typable by hand). The memo is the *only* link between a payment and an order, which is why the buyer is told not to edit it.
- **Amounts stored at creation:** `amount_usdt_units` (exact, integer) and `amount_ton_nano` (from TonAPI `/v2/rates`, rounded UP, cached 10 min; env `TON_PRICE_USD` fallback). The price never floats after the order is created.
- **Expiry:** 60 min (`ORDER_TTL_MINUTES`). Expiry never deletes money: a payment that arrives after expiry goes to `needs_review` for manual delivery/refund (see §4).

## 2. Payment links

| Link | Format | Notes |
|---|---|---|
| USDT (primary) | `https://app.tonkeeper.com/transfer/<SELLER>?jetton=<USDT_MASTER>&amount=3000000&text=YR-XXXXXX` | Universal link — works in Telegram + browsers. `ton://transfer/…` with the same query is shown as fallback for other wallets. Amount is in USDT elementary units (6 decimals). |
| TON (fallback) | `https://app.tonkeeper.com/transfer/<SELLER>?amount=<nanotons>&text=YR-XXXXXX` | Native TON at the rate locked at order creation. No `jetton=` param. |

**What the buyer is told on the order card (exact wording in the code):** USDT on the TON network only; do not send USDT on Tron/Ethereum; do not edit or delete the memo; after paying, tap "I paid".

## 3. Verification (the core)

**Primary — TonAPI jetton history** (`GET /v2/accounts/<seller>/jettons/<USDT_MASTER>/history?limit=100`):
parsed into normalized transfers; a transfer counts only if it is **not** `status:"failed"`, its jetton is the real USDT master, and its recipient is the seller. (TonAPI returns raw `0:<hex>` addresses; the code normalizes EQ/UQ/raw before comparing.)

**Backup — TON Center v2** (`getTransactions`, native TON only): only `msg.dataText` transfers count. Jetton notifications arrive as `msg.dataRaw` and are deliberately ignored here — see §7.

**Matching — two tiers, in order:**

- **Tier 1 — exact memo.** Transfers whose comment (trimmed) equals the order id, inside `[created_at − 120s, now + 300s]`, not already claimed. Amounts **sum**: a $1.00 + $1.50 top-up with the same memo delivers. Deliver when the sum ≥ expected (overpayment delivers; the seller keeps the excess and it is logged).
- **Tier 2 — exact amount + time, unique candidate only.** Used only if Tier 1 found nothing: transfers of exactly the expected amount, sent after the order was created, with no memo or a memo that is not another order's id. Delivers **only if there is exactly one candidate**. Two or more → `ambiguous`, never auto-delivered.
  - *Why Tier 2 exists:* the memo's visibility in TonAPI jetton history is unproven until the live test (see §7). Tier 2 is the safety net for a buyer who paid correctly but whose memo vanished.

**Double-delivery prevention (three layers):**
1. Every credited tx hash is written to KV as `tx:<kind>:<hash> → order id` (30-day TTL) *before* delivery, and checked before any delivery. A hash claimed by another order → `needs_review`, no file.
2. The order has a status machine (`awaiting_payment → paid → delivered`); `deliverFile()` refuses to run twice.
3. The matcher receives the set of already-used hashes for the order, so a re-check can never re-credit the same payment.

**Triggers:** (a) buyer taps "✅ I paid" (throttled: max once per 20 s per order); (b) cron sweep every 2 min — **one** TonAPI call + **one** TON Center call, matched locally against all pending orders; (c) buyer sends `/tx <hash>` to check one specific transaction; (d) a `paid` order (payment confirmed, delivery failed) is retried the same way — by the buyer's "🔁 Retry delivery" button on `/status` and by the cron sweep, which also covers `paid` orders (D7 fix, 2026-11-20).

**Rate limits respected in code:** TonAPI no-key 1 req/4 s, with free key 1 req/s — enforced with a KV timestamp + sleep before every call; a 429 returns a "try again in a minute" message instead of failing the order.

## 4. Every edge case, and what happens

| Case | Detection | Outcome |
|---|---|---|
| Correct USDT + memo | Tier 1 | Delivered automatically |
| Correct USDT, memo missing | Tier 2 (unique) or `/tx <hash>` | Delivered if unique; else `needs_review` |
| Underpayment (e.g. $1.00 of $3.00) | Tier 1 partial sum | **Not delivered.** Buyer is told the exact remaining amount; a top-up with the same memo completes it |
| Overpayment | Tier 1 sum > expected | Delivered; excess kept, logged |
| Wrong amount + memo present | Hint in `not_found` | `needs_review`, seller notified, buyer asked for tx hash |
| Two identical payments at once | Tier 2 ambiguity | `needs_review`, never auto-delivered |
| Paid after 60-min expiry | Match succeeds but `now > expires_at` | `needs_review` (money arrived; seller verifies and `/deliver`s manually) |
| Native TON fallback payment | TON Center `dataText` match | Delivered, `via: ton-comment` |
| USDT on **Tron / Ethereum** | **Invisible on TON — cannot be detected by any code here** | Buyer must send the tx hash via `/support`; seller checks Tronscan/Etherscan manually, then `/deliver` or `/refund`. Prevention is UX only: the warnings on the landing page + order card |
| Fake "USDT" (wrong jetton master) | Jetton-master check in the parser | Ignored entirely |
| Failed transfer (`status:"failed"`) | Status filter in the parser | Ignored entirely |
| Same tx hash reused for a 2nd order | KV `tx:` claim check | 2nd order → `needs_review`, no file (proven in the dry run) |
| `sendDocument` fails (stale `file_id`) | Telegram API error | Order stays `paid` (not `delivered`); buyer is told payment is safe; seller is alerted to refresh `PRODUCT_FILE_ID`. Buyer can tap "🔁 Retry delivery" on `/status` and the cron sweep retries it automatically (D7) — no re-payment needed |
| Buyer never pays | Cron expiry | `expired`; record kept 7 days for later manual matching |
| Buyer lost the file | `/status` → resend button | Up to 3 resends per delivered order |
| Abusive order creation | IP cap 20/day on `POST /api/order` | 429 `too_many_orders` |

## 5. Manual refund process (seller does this — the bot cannot move money)

1. Seller runs `/refund YR-XXXXXX` (seller-only command, gated on `SELLER_TELEGRAM_ID`).
2. The bot replies with: the exact amount to return, and the buyer's wallet address (taken from the matched on-chain transfer — never guessed). If the address is unknown, the bot says so and the seller must ask the buyer first.
3. Seller sends that USDT amount **on TON** from Keeper to the buyer's address, and keeps the tx hash as receipt.
4. The bot marks the order `refunded` and notifies the buyer in chat.
5. **Tron/Ethereum payments:** a refund goes back on the *same network the buyer used* — the seller needs a wallet on that network (e.g. TronLink for TRC-20). If the seller cannot refund on that network, the honest fallback is manual delivery (`/deliver`) instead.
6. Crypto is irreversible: there are no chargebacks, and the seller keeps every confirmed payment unless they choose to refund.

## 6. Telegram Stars policy risk — Bot Platform Terms §6.2 (read this carefully)

Telegram's Bot Platform Developer Terms (§6.2) say digital goods sold in bots / Mini Apps must be sold **exclusively in Telegram Stars**, and Telegram may refuse to display a bot to mobile users if it sells via other currencies or third-party providers — **even if the sale also happens on the seller's own website**. That wording is why this design does the following:

- **Payment happens on the external landing page** (Cloudflare Pages): the pay link is minted by the Worker and shown on the landing page; the buyer pays in Keeper, outside Telegram.
- **The bot shows the price and a Keeper pay link, but never issues a Telegram invoice and never takes payment inside Telegram:** `/buy` presents the $3.00 price and a Keeper deep link in-chat, and the money moves in the external wallet app. The bot also delivers the file after on-chain verification, answers `/status`, and handles `/support`. The mitigation therefore rests on *"payment executes in an external wallet, no Telegram invoice"* — **not** on "the bot never presents a price".
- **No Stars code is built in this delivery.** This is a deliberate scope decision, not an oversight.

**Honest limits of this mitigation:** the research (§3.4) notes the rule applies "even if you also sell on your own website", and Kasa98 warns an external TON checkout "may not be treated as compliant". So this design **reduces** the risk — it does not eliminate it. The bot could still be hidden from mobile users or restricted if Telegram enforces §6.2 against it.

**Stars fallback (thinking only — do NOT build unless the bot is ever restricted):**
- Price the same pack in Stars inside the bot (Telegram's own `sendInvoice` with Stars as the currency). Economics are bad at this price: the seller withdraws ~$0.013/Star via Fragment after an up-to-21-day hold, min. 1,000 Stars (~$13 net); to net ~$3 the buyer must pay roughly 230 Stars (~$4.60). Whether Fragment requires KYC to withdraw Stars is **unconfirmed**.
- Fallback plan if restricted: (1) keep the landing-page TON checkout as the primary sale; (2) add a Stars-priced in-bot option as the compliant path; (3) move discovery to the public channel + landing page (searchable surfaces that don't depend on the bot being listed). Do not rebuild the store around Stars pre-emptively — the TON route is what the mission requires, and Stars would nearly halve the net per sale.

## 7. Design decisions the brief got wrong (or that changed after live probing)

1. **Verification primary is TonAPI, not TON Center** (brief said TON Center primary). Reason, proven by the live probe (`test/live-probe-output.json`): TON Center v2 returns *raw* transactions — a USDT jetton payment arrives as a `msg.dataRaw` notification from the seller's jetton wallet, and reading its memo needs a BOC/cell decoder, which is fragile in dependency-free Workers code. TonAPI's jetton history returns *decoded* transfers with sender, amount, and (per schema) comment. TON Center stays as the backup, but only for the native-TON fallback, where the memo is plain `msg.dataText`.
2. **The memo on jetton payments is the single riskiest assumption.** Keeper's deep-link parser accepts `text=` alongside `jetton=`, and TonAPI's schema has a `comment` field — but the live probe could only observe *failed* transfers (people sending USDT to the master contract), none of which carried a comment. So a real successful commented transfer has **not** been observed yet. Mitigations built in: Tier-2 matching, `/tx <hash>` lookup, manual `/deliver`, and the live-test checklist (README §7). If the memo turns out to be dropped by wallets, the correct upgrade is TON Connect (the wallet returns the signed transaction), not more polling.
3. **KV, not D1, for the order store.** The brief said "D1/KV". KV is the right call at this volume (a handful of orders/day; 1,000 writes/day = ~200 orders/day at ~5 writes/order) and needs no migrations. D1 becomes right if: orders exceed ~200/day, the seller wants SQL reporting, or the check-then-put tx-claim race ever matters. The code is structured so the store is only `getOrder`/`putOrder`/tx-claim — a D1 swap is a small, contained change.
4. **The landing page does not sell by itself.** A static page cannot mint order ids; it calls `POST /api/order`. The bot remains the delivery endpoint because only Telegram can `sendDocument` a `file_id`. Any "buy without Telegram" variant would need an R2 signed link instead — deliberately not built (it would leak the file to anyone with the link).
5. **"Payment on the external landing page" does not fully satisfy §6.2** — see §6. The brief's phrasing understates the residual risk; this document states it plainly.
6. **USDT can be frozen by Tether** at specific addresses; TON/GRAM cannot. If the seller's wallet were ever frozen, payments would fail at the wallet level, not in this code — the seller would need a fresh wallet and a `SELLER_TON_ADDRESS` secret rotation (no code change).

## 8. Support contact path

- In-bot: `/support` (buyer sends order id + what happened + tx hash). If `SUPPORT_USERNAME` is set, the bot also shows the seller's personal `@`.
- Seller alerts: any `needs_review` order, delivery failure, or ambiguous payment sends a Telegram message to `SELLER_TELEGRAM_ID` immediately. If that secret is unset, alerts are only in the Worker logs (`wrangler tail`) — set it.
- What the buyer is always asked for: order id, what happened, tx hash from Keeper (transaction → details). With those three, every failure mode above is resolvable by hand.

## 9. Catallaxy — parallel zero-code listing (second checkout)

Same file, same price, listed in parallel. Steps (verify inside the bot at listing time — the marketplace is new/small and its UI may change; its traffic is unproven, so treat it as a second checkout, not the business):

1. Open Telegram and start `@ctlx_seller_bot` (Catallaxy seller bot, marketplace at `ctlx.cc`).
2. Follow the bot to create a listing: upload the same PDF (or link the file), set the title, description, and price in USDT (or GRAM — prefer USDT so the price stays $3.00).
3. Publish: Catallaxy requires a minimum of **0.1 GRAM** to publish the listing on-chain (a one-time publishing cost, not a fee on the buyer) — per Catallaxy's own how-to-sell blog, to be re-confirmed inside `@ctlx_seller_bot` at listing time.
4. The bot/marketplace handles payment + auto-delivery for that listing. Fee: **2% per sale**. There is a **24-hour hold** before the seller can withdraw. (Same qualifier: per Catallaxy's how-to-sell blog, to be re-confirmed inside `@ctlx_seller_bot` at listing time — the marketplace front page does not display fee/hold/minimum terms.)
5. Withdrawal goes to the seller's own TON wallet.
6. Put the Catallaxy listing link on the landing page as "Also available on Catallaxy" — a buyer who finds the marketplace first can buy there; a buyer who finds the landing page first uses the bot flow above. (do not mark done until the link is live on the page.)
7. Keep prices identical in both places. If the file is updated, update **both** listings the same day.
