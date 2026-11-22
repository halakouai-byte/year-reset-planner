# Launch notes — 2027 Year Reset Planner Pack

Status: **LAUNCH-READY** (QA verdict 2026-11-21, 0 defects). The package is
complete locally; nothing is published or sold yet. The manager does the
final go-live check.

## What is ready

- Product PDF: 14 pages, A4, 50,917 bytes — deterministic rebuild
  (`python3 tools/build-planner.py`, byte-identical). Free sample: 2
  watermarked pages, 29,176 bytes.
- Sales site: `site/` — index (title 53 chars, meta 155, one H1),
  article page, `_headers`, `robots.txt` (AI bots allowed), `sitemap.xml`,
  `llms.txt`. All 6 paths return 200 locally.
- Worker: `year-reset-bot`, $3.00 USDT on TON, memo prefix `YR-`,
  tests 26/26 pass (21 unit + 5 e2e dry runs).
- Article: 1,798 words, 8 sourced price comparisons (Etsy/Gumroad).
- Repo hygiene: AGENTS.md, secret-scan.yml (gitleaks v8.28.0), README,
  DEPLOYMENT.md, QA evidence in `qa/`.

## What the manager still does at deploy (see DEPLOYMENT.md)

1. Create repo `halakouai-byte/year-reset-planner` (public, browser) and
   push this package (browser route — connector writes return 403).
2. Create Pages project `year-reset-planner` (GitHub-sourced, root
   `site/`, no build command) and verify the live URL.
3. Create a NEW Telegram bot (BotFather), set its profile/commands via
   the Bot API, send it the product PDF and record the `file_id`.
4. Create a FRESH KV namespace for this product (never reuse the
   prompt-pack namespace ids) and paste the ids into
   `worker/wrangler.toml`.
5. Set Worker secrets via `wrangler secret put`: `BOT_TOKEN`,
   `SELLER_TON_ADDRESS` (EQ mainnet form), `PRODUCT_FILE_ID`,
   `WEBHOOK_SECRET`, optional `SELLER_TELEGRAM_ID`, optional
   `TONAPI_KEY`. Fill `BOT_USERNAME` / `SUPPORT_USERNAME` in
   `wrangler.toml`.
6. Deploy the Worker (`wrangler deploy`), wire its URL into the site,
   set the Telegram webhook, run the live $3.00 payment test from a
   second wallet. Only then is the product live.
7. Target: listed by ~Nov 28, 2026. Peak Dec 26–Jan 15. Dead after
   Jan 31, 2027.

## Decisions logged

- 2026-11-21 — Seasonal first: planner before the budget spreadsheet
  (trend scan #1: demand peaks converge in 6–10 weeks).
- 2026-11-21 — Year-End Money Close-Out is a BONUS section inside the
  planner, not a separate product.
- 2026-11-21 — Memo prefix YR- (all products share one seller TON
  address; the prefix separates their orders).
- 2026-11-21 — TON only at launch; no BNB/TRON modules yet.
- 2026-11-21 — QA fixed one defect during the build (habit-tracker
  label overlap) and one at assembly (planner wrangler.toml briefly
  carried the prompt-pack KV ids — replaced with placeholders; repo
  re-grepped clean).
