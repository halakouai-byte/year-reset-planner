# DEPLOYMENT.md — 2027 Year Reset Planner Pack

Ordered checklist. Do the steps in order; verify each one before moving
on. The manager runs these steps (browser for GitHub, terminal for
Cloudflare). Nothing here takes money except the final live payment test
($3.00 from a second wallet).

## 0. Prerequisites

- [ ] Repo `halakouai-byte/year-reset-planner` created (public, via
      browser — API repo creation returns 403).
- [ ] All files pushed to `main` (browser route; the GitHub connector
      returns 403 on writes).
- [ ] `product/year-reset-planner-2027.pdf` built locally
      (`python3 tools/build-planner.py`, 14 pages, A4) — NOT in the repo.

## 1. Cloudflare Pages (sales site)

- [ ] Create Pages project `year-reset-planner`, GitHub-sourced:
      repo `halakouai-byte/year-reset-planner`, production branch `main`,
      framework preset None, build command EMPTY, deploy root `site/`,
      preview deployments OFF.
- [ ] Verify: https://year-reset-planner.pages.dev/ returns 200 and the
      page renders (title, buy section, FAQ, sample link).
- [ ] Verify SEO files: `/robots.txt`, `/sitemap.xml`, `/llms.txt`,
      `/article.html`, `/sample.pdf` all return 200.

## 2. Telegram bot (delivery + support)

- [ ] Create a NEW bot via BotFather (separate bot per product — do NOT
      reuse the prompt-pack bot). Save the token in the secure connection
      only — never in chat, code, or the repo.
- [ ] Set bot name / About / description / commands (`/start`, `/buy`,
      `/help`) via the Bot API.
- [ ] Send `product/year-reset-planner-2027.pdf` to the bot (as a
      document) and record the returned `file_id` — this becomes the
      `PRODUCT_FILE_ID` secret. Do NOT post the PDF anywhere public.
- [ ] Create/set up the product's Telegram presence per the manager's
      channel plan (hub discovery channel is marketing only).

## 3. Cloudflare Worker (payments)

- [ ] Create KV namespaces (once):
      `wrangler kv namespace create ORDERS_KV` (+ `--preview`), paste
      the ids into `worker/wrangler.toml` (`id` + `preview_id`).
- [ ] Set Worker secrets (`wrangler secret put <NAME>`, values never in
      the repo): `BOT_TOKEN`, `SELLER_TON_ADDRESS` (EQ mainnet form),
      `PRODUCT_FILE_ID` (from step 2), `WEBHOOK_SECRET`,
      `SELLER_TELEGRAM_ID` (optional, gates seller commands),
      `TONAPI_KEY` (optional).
- [ ] Fill `worker/wrangler.toml` `[vars]`: `BOT_USERNAME` (new bot's @,
      no @), `SUPPORT_USERNAME` (seller's public Telegram handle, no @),
      `PRODUCT_PRICE_USDT="3.00"`, `ORDER_TTL_MINUTES="60"`.
- [ ] Deploy: `cd worker && npx wrangler deploy`.
- [ ] Verify: `GET https://year-reset-bot.halakouai-byte.workers.dev/`
      returns `{"ok":true,"service":"year-reset-bot","price_usdt":"3.00"}`.
      If it 500s, a required secret is missing.
- [ ] Wire the Worker URL into `site/index.html` (buy flow
      `POST /api/order`), commit, push, verify the live page again.

## 4. Telegram webhook

- [ ] Set the webhook: Worker `POST /webhook` with `WEBHOOK_SECRET`
      (see `worker/README.md` for the exact call).
- [ ] Verify: send `/start` to the bot, get the welcome reply; send
      `/buy`, get an order + pay link.

## 5. Live payment test (final go-live check)

- [ ] From a SECOND wallet (not the seller's), pay $3.00 USDT on TON
      with the order memo `YR-XXXXXX` exactly as shown. Tap "I paid".
- [ ] Verify: Worker matches the payment on-chain, bot delivers the PDF
      automatically, order status becomes delivered, tx hash recorded
      (no double delivery on re-check).
- [ ] If the test fails, the order goes to manual review — resolve with
      `/deliver`, fix the cause, re-test. Do NOT list the product as live
      until this test passes.

## 6. Go-live

- [ ] Confirm the sales page, Worker, bot, and delivery all work.
- [ ] Announce in the hub discovery channel (marketing only).
- [ ] Target: listed by ~Nov 28, 2026. Peak Dec 26–Jan 15.

## Rollback

- Pages: revert one commit on `main`; the native link redeploys the
  previous `site/` automatically.
- Worker: `wrangler deploy` from the previous `worker/` checkout, or
  `wrangler rollback` (see `wrangler --help`).
- Never delete the Pages project or the Worker to "fix" a deploy — fix
  the code and redeploy.
