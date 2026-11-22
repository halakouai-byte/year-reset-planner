# Go-Live Checklist — 2027 Year Reset Planner Pack

Derived from `DEPLOYMENT.md` (ordered; do the steps in order and verify each one before moving on). QA status at time of writing (2026-11-21): **LAUNCH-READY** — see `qa/qa-report.md`. Nothing below is a product fix; it is deployment only. Target: listed by ~Nov 28, 2026. Peak Dec 26–Jan 15.

## 0. Prerequisites
- [ ] GitHub repo `halakouai-byte/year-reset-planner` created (public, via browser — API repo creation returns 403).
- [ ] All files pushed to `main` (browser route; the GitHub connector returns 403 on writes).
- [ ] `product/year-reset-planner-2027.pdf` built locally (`python3 tools/build-planner.py`, 14 pages, A4) — **NOT in the repo**. It is gitignored (`product/` in `.gitignore`); after push, verify with `git check-ignore -v product/year-reset-planner-2027.pdf` and confirm the gitleaks secret-scan workflow stays green (it fails on any finding — never silence it).
- [ ] QA report read: `qa/qa-report.md` — verdict LAUNCH-READY, 0 defects.

## 1. Cloudflare Pages (sales site)
- [ ] Create Pages project `year-reset-planner`, GitHub-sourced: repo `halakouai-byte/year-reset-planner`, production branch `main`, framework preset None, build command EMPTY, deploy root `site/`, preview deployments OFF. (Native GitHub link only — never `wrangler pages deploy`, never an Actions-based Pages deploy.)
- [ ] Verify: `https://year-reset-planner.pages.dev/` returns 200 and renders (title, buy section, FAQ, sample link).
- [ ] Verify SEO files all return 200: `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/article.html`, `/sample.pdf`.

## 2. Telegram bot (delivery + support)
- [ ] Create a **NEW bot via BotFather** — separate bot per product; do NOT reuse the prompt-pack bot. Save the token in the secure connection only — never in chat, code, or the repo.
- [ ] Set bot name / About / description / commands (`/start`, `/buy`, `/help`) via the Bot API.
- [ ] Send `product/year-reset-planner-2027.pdf` to the bot (as a document) and record the returned **`file_id`** — this becomes the `PRODUCT_FILE_ID` secret. Do NOT post the PDF anywhere public.
- [ ] Create/set up the product's Telegram presence per the manager's channel plan (hub discovery channel is marketing only).

## 3. Cloudflare Worker (payments)
- [ ] Create KV namespaces (once): `wrangler kv namespace create ORDERS_KV` (+ `--preview`), paste the ids into `worker/wrangler.toml` (`id` + `preview_id`). Current file has placeholders `<YOUR_KV_NAMESPACE_ID>` — do NOT paste the prompt-pack ids.
- [ ] Set Worker secrets (`wrangler secret put <NAME>`, values never in the repo): `BOT_TOKEN`, `SELLER_TON_ADDRESS` (EQ mainnet form), `PRODUCT_FILE_ID` (from step 2), `WEBHOOK_SECRET`, `SELLER_TELEGRAM_ID` (optional, gates seller commands), `TONAPI_KEY` (optional).
- [ ] Fill `worker/wrangler.toml` `[vars]`: `BOT_USERNAME` (new bot's @, no @), `SUPPORT_USERNAME` (seller's public Telegram handle, no @), `PRODUCT_PRICE_USDT="3.00"`, `ORDER_TTL_MINUTES="60"`.
- [ ] Deploy: `cd worker && npx wrangler deploy` (this also sets the `*/2 * * * *` cron sweep from `wrangler.toml`).
- [ ] Verify: `GET https://year-reset-bot.halakouai-byte.workers.dev/` (or `/health`) returns `{"ok":true,"service":"year-reset-bot","price_usdt":"3.00"}`. If it 500s, a required secret is missing.
- [ ] Wire the Worker URL into `site/index.html` (buy flow `POST /api/order`), commit, push, verify the live page again. (The URL is already in the file: `https://year-reset-bot.halakouai-byte.workers.dev`.)

## 4. Telegram webhook
- [ ] Set the webhook: Worker `POST /webhook` with `WEBHOOK_SECRET` (see `worker/README.md` for the exact call).
- [ ] Verify: send `/start` to the bot, get the welcome reply; send `/buy`, get an order + pay link.

## 5. Live payment test (final go-live check — do NOT list the product as live until this passes)
- [ ] From a **SECOND wallet** (not the seller's), pay **$3.00 USDT on TON** with the order memo `YR-XXXXXX` exactly as shown. Tap "I paid".
- [ ] Verify: Worker matches the payment on-chain, bot delivers the PDF automatically, order status becomes delivered, tx hash recorded (no double delivery on re-check).
- [ ] If the test fails, the order goes to manual review — resolve with `/deliver`, fix the cause, re-test.

## 6. Go-live
- [ ] Confirm the sales page, Worker, bot, and delivery all work.
- [ ] Announce in the hub discovery channel (marketing only).

## Rollback
- Pages: revert one commit on `main`; the native link redeploys the previous `site/` automatically.
- Worker: `wrangler deploy` from the previous `worker/` checkout, or `wrangler rollback`.
- Never delete the Pages project or the Worker to "fix" a deploy — fix the code and redeploy.

## Standing rules (from AGENTS.md — do not break during go-live)
- Never put a token, secret, key, seed phrase, password, or wallet address in the repo, in chat, or in code. Secret names are fine; values are never written.
- Never commit the product PDF. Never invent testimonials, ratings, sales numbers, or reviews. Never promise income.
- Payment happens on the external landing page only; the bot is delivery/support only (Telegram Stars mitigation — partial, state it honestly).
