# 2027 Year Reset Planner Pack — $3.00 USDT on TON

Printable PDF planner: review 2026, plan 2027, track every day. 14 pages,
A4. Includes the Year-End Money Close-Out as a bonus section.

## What it is

- **Product:** 2027 Year Reset Planner Pack — 14-page printable PDF (A4,
  also prints on US Letter via fit-to-page).
- **Price:** $3.00 USDT on TON mainnet (TON only at launch).
- **Delivery:** automatic, by Telegram bot, after the Worker verifies the
  payment on-chain. No AI at runtime. No account needed — just a TON
  wallet (Keeper / Tonkeeper).
- **Seasonal:** list by ~Nov 28, 2026. Peak Dec 26–Jan 15. Dead after
  Jan 31, 2027.

## What's inside (14 pages)

1. Cover
2. How to use this planner
3. 2026 Review — Wins
4. 2026 Review — Lessons & Letting Go
5. 2026 in Numbers
6. 2027 Vision — Word of the year
7. 2027 Goals — by life area
8. 2027 Top 3 Goals — breakdown
9. 90-Day Plan — Q1 focus
10. 90-Day Plan — Weekly rhythm
11. Monthly Check-In (12 months)
12. 365-Day Habit Tracker (3 habits)
13. BONUS: Year-End Money Close-Out
14. Commitment + notes

Free 2-page watermarked sample: `site/sample.pdf`.

## Layout

- `site/` — sales page + SEO/GEO files (deploy root for Cloudflare Pages)
- `worker/` — Cloudflare Worker (TON payment + delivery)
- `tools/build-planner.py` — builds the PDF (fpdf2, deterministic)
- `product/` — generated PDF, gitignored, NEVER committed
- `content/` — GEO/SEO article source
- `qa/` — QA evidence (100% bar)
- `docs/` — ops docs

## Build / test

```bash
python3 tools/build-planner.py          # rebuild the PDF + sample
cd worker && node --test test/verify.test.mjs test/e2e-dryrun.test.mjs
```

## Deploy

See `DEPLOYMENT.md` (ordered checklist) and `AGENTS.md` (full project
guide). Pages deploys via the native Cloudflare ↔ GitHub link on push to
`main`; the Worker deploys with `wrangler deploy` from `worker/`.

## Rules

- No token, secret, or wallet address anywhere in this repo. Ever.
- Never commit `product/*.pdf` — the product is delivered only via the
  bot's cached `file_id`.
- No fake testimonials, ratings, or sales numbers. No income promises.
