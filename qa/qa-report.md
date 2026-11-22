# QA Report — 2027 Year Reset Planner Pack

- **Repo root:** `~/workspace/income-engine/year-reset-planner/`
- **QA date:** 2026-11-21 (Asia/Tehran, ~02:55)
- **QA role:** independent tester. No product/site/worker/article file was modified. Only `qa/` was written.
- **Verdict: LAUNCH-READY** — all 6 test groups PASS. Defect list: **empty (0 defects)**. Two non-blocking observations are recorded at the end of §2 and §4 (article meta description is 191 chars; test fixtures reuse the public jetton-master address as a placeholder seller). Neither blocks launch.

---

## 1. PDF — PASS

### Commands run (from repo root)
```bash
sha256sum product/year-reset-planner-2027.pdf site/sample.pdf   # before rebuild
python3 tools/build-planner.py
sha256sum product/year-reset-planner-2027.pdf site/sample.pdf   # after rebuild
cmp product/year-reset-planner-2027.pdf /tmp/product-before.pdf
cmp site/sample.pdf /tmp/sample-before.pdf
pdfinfo product/year-reset-planner-2027.pdf
pdfinfo site/sample.pdf
pdftoppm -png -r 150 -f 1 -l 1  product/year-reset-planner-2027.pdf /tmp/qa-render/p1-cover
pdftoppm -png -r 150 -f 7 -l 7  product/year-reset-planner-2027.pdf /tmp/qa-render/p7-goals
pdftoppm -png -r 150 -f 12 -l 12 product/year-reset-planner-2027.pdf /tmp/qa-render/p12-habit
pdftoppm -png -r 150 -f 13 -l 13 product/year-reset-planner-2027.pdf /tmp/qa-render/p13-money
pdftoppm -png -r 150 site/sample.pdf /tmp/qa-render/sample
for n in $(seq 1 14); do pdftotext -f $n -l $n product/year-reset-planner-2027.pdf - | grep -o "Page $n of 14"; done
pdftotext site/sample.pdf - | grep -o "Page [0-9]* of 14"
```

### Evidence
| Check | Expected | Found |
|---|---|---|
| Rebuild deterministic (product SHA-256) | same as before | `5514b9bc89d5dbb6897009a13577a076e6b7a4d6e10b26e01f6346d7b1e0c2f4` — identical before/after; `cmp` → PRODUCT IDENTICAL |
| Rebuild deterministic (sample SHA-256) | same as before | `713e87390a5c1e2b1fa87010f634edc3b8d936603f1e67469d710d7adc3777ba` — identical; `cmp` → SAMPLE IDENTICAL |
| Build output | 14 pp / 2 pp | `product: … 50917 bytes`, `sample: … 29176 bytes` (exit 0) |
| Product `pdfinfo` | 14 pages, A4 | **14 pages**, 595.28 × 841.89 pts (A4), 50,917 bytes, PDF 1.3, CreationDate Fri Jan 1 00:00:00 2027 UTC |
| Sample `pdfinfo` | 2 pages, A4, 29,176 bytes | **2 pages**, 595.28 × 841.89 pts (A4), **29,176 bytes** — exact match |
| Footers, product | "Page N of 14" on all 14 | All 14 present, one per page: `2027 Year Reset Planner Pack | Page 1 of 14` … `Page 14 of 14` (`grep -c` = 14) |
| Footers, sample | pages 7 and 12 | `Page 7 of 14`, `Page 12 of 14` — sample pages are product pages 7 and 12, as documented |
| Visual render, cover (p.1) | no overflow/clipping/overlap | Clean: "2027 / Year Reset Planner", tagline, bonus box, footer. No clipped text. |
| Visual render, goals (p.7) | no overflow/clipping/overlap | Clean: 5 life areas (Health, Money, Work, Relationships, Growth) with ruled lines, all inside margins. |
| Visual render, habit tracker (p.12) | no overlap (known earlier fix) | Clean: day header 1–31, 3 habit blocks × 12 months, "Habit 1/2/3" labels in a separate teal column beside Jan–Dec — no overlap with month names. |
| Visual render, money close-out (p.13) | no overflow/clipping/overlap | Clean: Accounts / Debts / Subscriptions tables, checkboxes aligned, Net-worth snapshot, 2027 money goals. |
| Sample watermark (visual) | FREE SAMPLE on both pages | **Confirmed on both sample pages**: diagonal teal text "FREE SAMPLE — 2027 Year Reset Planner" across the page (renders: `sample-1.png`, `sample-2.png`). |

---

## 2. Site — PASS (with 1 non-blocking observation)

### Commands run
```bash
cd site && python3 -m http.server 8765 &
for p in / /article.html /robots.txt /sitemap.xml /llms.txt /sample.pdf; do
  curl -s -o /dev/null -w "%{http_code} %{size_download} bytes\n" "http://127.0.0.1:8765$p"
done
# title/description lengths, h1 counts, viewport, media queries — python re-parsing of both HTML files
# JSON-LD extraction + python json.loads
grep -nE '(src|href)="https?://' index.html article.html
grep -nE '<script|<link|@import|url\(http' index.html article.html
grep -n "@media" index.html article.html
cat robots.txt; cat sitemap.xml
```

### Evidence
| Check | Expected | Found |
|---|---|---|
| HTTP status, all 6 paths | 200 | `/` 200 (33,645 B) · `/article.html` 200 (17,539 B) · `/robots.txt` 200 (224 B) · `/sitemap.xml` 200 (641 B) · `/llms.txt` 200 (2,689 B) · `/sample.pdf` 200 (29,176 B) |
| `index.html` `<title>` | 50–60 chars | **53 chars**: `2027 Year Reset Planner Pack — Review 2026, Plan 2027` |
| `index.html` meta description | 145–160 chars | **155 chars**: `2027 Year Reset Planner Pack: a 14-page printable planner to review 2026, set goals, plan Q1 and track habits all year. $3 USDT on TON, free 2-page sample.` |
| `<h1>` count | exactly 1 each | `index.html`: 1 · `article.html`: 1 (`Best Year Reset Planner 2027: What to Check Before You Buy`, title 58 chars) |
| JSON-LD `index.html` | valid JSON, Offer price "3.00", no aggregateRating | Parses OK (`@graph`: Product + FAQPage). `offers.price` = **"3.00"**, `priceCurrency` USD. `aggregateRating` count in file: **0**. |
| JSON-LD `article.html` | valid JSON, no aggregateRating | Parses OK (Article, headline matches, datePublished 2026-11-21, mainEntityOfPage = canonical article URL). `aggregateRating` count: **0**. |
| `robots.txt` AI bots | 4 named + sitemap line | OAI-SearchBot, PerplexityBot, Google-Extended, ClaudeBot — all `Allow: /` — plus `Sitemap: https://year-reset-planner.pages.dev/sitemap.xml` |
| `sitemap.xml` | index + article + sample.pdf, canonical URLs | 3 `<loc>` entries, all `https://year-reset-planner.pages.dev/…` (`/`, `/article.html`, `/sample.pdf`), lastmod 2026-11-21 |
| External scripts/styles/fonts/trackers | none loaded | **Zero** external loaded resources: no `<script src>`, no external `<link rel=stylesheet>`, no `@import`, no external `<img>`, no webfont. Only inline `<style>` + inline `<script>` + one inline JSON-LD block per file, and a `data:` SVG favicon. `site/_headers` CSP confirms: `default-src 'self'`, `connect-src https://year-reset-bot.halakouai-byte.workers.dev` only. |
| Meta viewport | present | Both files line 5: `<meta name="viewport" content="width=device-width, initial-scale=1">` |
| Mobile CSS rules | max-width query or equivalent | `index.html`: `@media(max-width:719px)` (line 130) + two min-width queries. `article.html`: no `@media`, but fluid layout via `clamp()` headings (`clamp(1.9rem,7.5vw,2.8rem)` etc.) and `.wrap{max-width:760px; padding:0 20px}` — accepted as the "or equivalent" the test allows. |

**Outbound links (not loaded resources — noted, not a failure):** plain `<a href>` links only: `github.com/halakouai-byte/year-reset-planner` (both files) and, in the article's sources paragraph, 6× etsy.com + 2× gumroad.com listing links. None of these load a script, style, font, image or tracker.

**Observation O1 (non-blocking):** `article.html` meta description is **191 chars** — longer than the ~155–160 display limit (the 145–160 bar in this test applies to `index.html` only, which passes at 155). Recommend trimming the article description to ≤160 chars at the next edit; it does not block launch.

---

## 3. Worker — PASS

### Commands run
```bash
cd worker && node --test test/verify.test.mjs test/e2e-dryrun.test.mjs   # run twice
cat worker/wrangler.toml
grep -n "YR-\|ORDER_ID_RE\|newOrderId" worker/src/ton.js
grep -n "workerUrl\|api/order" site/index.html
```

### Evidence
- **Test run (run 1):** `tests 26 · pass 26 · fail 0 · cancelled 0 · skipped 0` (duration ~9.0 s)
- **Test run (run 2, re-run for this report):** `tests 26 · pass 26 · fail 0` — identical. **26/26 required, 26/26 achieved.**
- Test split: 5 e2e dry-run tests + 21 verify tests, all ✔ (no ✖).
  - e2e: `/buy -> pay (mocked) -> I paid -> file delivered, once` · `same tx hash cannot pay a second order (anti-replay)` · `landing-page POST /api/order creates an order with pay links` · `paid-but-undelivered order self-heals on buyer retry, no double delivery` (D7) · `cron sweep retries a paid-but-undelivered order` (D7)
  - verify: `parseUsdtToUnits: 3.00 -> 3000000`, `tonNanoForUsd`, address normalisation, `newOrderId: YR- + 6 chars`, pay-link shapes, TonAPI/TonCenter parsers, Tier 1/Tier 2 matching, underpayment/top-up, overpayment, wrong-amount, nothing-found.
- `wrangler.toml`: `name = "year-reset-bot"` · `[vars] PRODUCT_PRICE_USDT = "3.00"` · `ORDER_TTL_MINUTES = "60"` · KV ids are placeholders `id = "<YOUR_KV_NAMESPACE_ID>"`, `preview_id = "<YOUR_KV_PREVIEW_NAMESPACE_ID>"` — **not** the prompt-pack real ids `<redacted-prompt-pack-kv-id>` / `<redacted-prompt-pack-kv-preview-id>` (grep for both: 0 hits anywhere in the repo). Cron: `crons = ["*/2 * * * *"]`.
- Buy flow in `site/index.html`: line 310 `workerUrl: "https://year-reset-bot.halakouai-byte.workers.dev"`, line 333 `fetch(CONFIG.workerUrl + "/api/order", {method: "POST"})`. Memo prefix: Worker generates the order id as the memo — `worker/src/ton.js:33 ORDER_ID_RE = /^YR-[A-Z0-9]{6}$/`, `newOrderId()` returns `'YR-' + 6 unambiguous chars`; the page displays `d.memo` as the order code and the FAQ/steps show the `YR-XXXXXX` example. `worker.js:714` returns `memo: order.id` from `/api/order`.

---

## 4. Secrets sweep — PASS (0 real findings)

### Commands run (repo root, excluding nothing except `node_modules`, which does not exist)
```bash
grep -rEn "(EQ|UQ)[A-Za-z0-9_-]{46}" .
grep -rEn "[0-9]{8,10}:[A-Za-z0-9_-]{35}" .
grep -rEn "sk-[A-Za-z0-9]{8,}" .
grep -rn "ghp_" . ; grep -rn "AKIA[0-9A-Z]{16}" . ; grep -rn "xox[baprs]-" .
grep -rn "<redacted-prompt-pack-kv-id>\|<redacted-prompt-pack-kv-preview-id>" .
grep -rn "year-reset-planner-2027.pdf\|product/" site/
cat .gitignore
```

### Evidence
| Pattern | Hits | Verdict |
|---|---|---|
| Wallet addresses `EQ/UQ + 48 chars` | 6 hits, all one address | **Not a secret** — see below |
| Bot tokens `[0-9]{8,10}:[A-Za-z0-9_-]{35}` | 0 | clean |
| `sk-` | 0 | clean |
| `ghp_` | 0 | clean |
| `AKIA…` | 0 | clean |
| `xox-` | 0 | clean |
| Prompt-pack KV ids | 0 | clean |
| Product PDF referenced in `site/` | 0 | clean — no public URL for the product PDF |

**The one address found:** `EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` — the **public USDT jetton-master contract address** (also in the reference implementation). Locations:
- `worker/src/ton.js:27` — `export const USDT_MASTER = 'EQCxE6…'` (the public constant; used to build pay links)
- `worker/FLOW.md:4` — documented as the USDT jetton master
- `worker/test/verify.test.mjs:26,103,113` and `worker/test/e2e-dryrun.test.mjs:25,27` — test fixtures. Note: the tests also reuse this same public address as a placeholder-shaped `SELLER`/`SELLER_UF` (comments state "placeholder-shaped, NOT a real seller wallet"). No real seller wallet address exists anywhere in the repo; the real `SELLER_TON_ADDRESS` is a Worker secret set at deploy time. The other two test strings (`EQBuyerAddressXXXX…`, `EQSomeJettonWalletXXXX…`) are synthetic X-padded placeholders.
- Secret *names* appear only as `env.*` references in `worker/src/worker.js` (`BOT_TOKEN`, `SELLER_TON_ADDRESS`, `PRODUCT_FILE_ID`, `TONAPI_KEY`, `WEBHOOK_SECRET` — lines 66–79, 122); no values are present.

**`.gitignore`:** contains `product/` (line 3, with the comment "NEVER commit the product file… it must never be at a public URL"), plus `__pycache__/`, `*.pyc`, `node_modules/`, `.wrangler/`, `.DS_Store`. **Caveat:** this directory is not yet a git repository (`git status` → "fatal: not a git repository"), because the GitHub repo is created as a manual step in DEPLOYMENT.md §0. So gitignore *enforcement* could not be verified by `git check-ignore`; the file *content* is verified and correct. Re-verify with `git check-ignore -v product/year-reset-planner-2027.pdf` after the repo is created and pushed.

---

## 5. Article — PASS

### Commands run
```bash
wc -w content/best-year-reset-planner-2027.md
grep -n "^#" content/best-year-reset-planner-2027.md
grep -n "<h[123]" site/article.html
grep -rniE "testimonial|5 star|★★★★★|sold|customers love" content/ site/
```

### Evidence
- **Word count:** `wc -w` = **1,798** — exact match to the expected ~1,798.
- **Headings md ↔ html — identical, all 15:** H1 `Best Year Reset Planner 2027: What to Check Before You Buy`; H2s: `What Is a Year Reset Planner?` · `What to Check Before You Buy` · `How Much Should a Year Reset Planner Cost?` · `When to Buy a Year Reset Planner` · `How to Use a Year Reset Planner in 15 Minutes` · `One Option to Compare: 2027 Year Reset Planner Pack`; H3s 1–8: `1. Page Count…` · `2. A Real Review Section…` · `3. Goals Broken Down…` · `4. A 90-Day Plan…` · `5. A Habit Tracker…` · `6. A Money Close-Out…` · `7. Print Size…` · `8. Price…` (article.html lines 70–91, same text and order).
- **Price-comparison list — identical in both, all 8 items:** $2.99+ (Gumroad, 52 pp) · $3.45 (Etsy, 18 pp) · $5.00 (Etsy, 444 pp) · $6.99 (Etsy, 24 pp) · $7.99 (Etsy) · $9.99 (Etsy) · $14.99 (Etsy, 36 pp) · $32.89 (Gumroad, 230+ pp), each with its source link (article.html lines 97–104, 125; md lines 51–58, 82).
- **No invented testimonials/ratings/sales numbers:** grep hits are only (a) the allowed honest-note sentence in `site/index.html:289` — "There are no testimonials, ratings or sales numbers on this page — the pack is new, and inventing them would be dishonest." — and the matching line in `site/llms.txt:54`; (b) the benign phrase "nothing is sold separately" (`site/index.html:207`, about the 14 pages, not a sales claim). Zero hits for `5 star`, `★★★★★`, `customers love`. No `aggregateRating` in either JSON-LD block (§2).

---

## 6. Payment flow (dry-run only) — PASS

No real money was spent and no network calls to TON were made by this QA run. Verified by reading `worker/test/e2e-dryrun.test.mjs` (305 lines) and by the passing run in §3.

- **How the dry run works (file header, lines 1–19):** fake KV + stubbed `globalThis.fetch`. `api.telegram.org` calls are recorded, never sent; `tonapi.io` returns a canned jetton history with ONE successful, commented, exact-amount USDT transfer; `toncenter.com` returns an empty list; `sendDocument` returns `{ok:true}` unless the test arms a failure (`failNextSendDocument()`, stale-file_id simulation). Suite runs at the real launch price `$3.00`.
- **Coverage confirmed present in the file and passing:**
  - Buy → mocked payment → "I paid" → exactly one delivery: test at line 147. Assertions (lines ~160–180): `successfulDeliveries() == 1` ("exactly one delivery"), `sendDocument` delivered via cached `<PRODUCT_FILE_ID>` to buyer chat 111, order status `delivered`, `matched_by: 'usdt-comment'`, tx hash claimed in KV (`tx:usdt:<hash>` → order id). A second "I paid" for the same order asserts `successfulDeliveries()` still 1 ("no double delivery").
  - Anti-replay: test at line 184 — a fresh order with the SAME tx hash does NOT get the file; order B status `needs_review` ("replayed tx routes to manual review, not delivery"), `successfulDeliveries()` still 1 ("only order A got the file").
  - Paid-but-undelivered self-heal (D7): test at line 234 (buyer retry) and line 280 (cron sweep) — both assert recovery with no double delivery.
  - Landing-page flow: test at line 211 — `POST /api/order` returns 200, `order_id` matches `/^YR-[A-Z0-9]{6}$/`, `price_usdt` = "3.00", Keeper pay link contains `jetton=` and `text=<order_id>`, `bot_url` contains `start=claim_<order_id>`.
- All 5 e2e tests pass in both runs (§3). The live $3 payment test is still an open go-live step (see `qa/checklist.md`) — it cannot be done by QA without real money and a deployed Worker.

---

## Defect list

**None. 0 defects.**

## Observations (non-blocking, no action required before launch)

1. **O1 — article meta description 191 chars** (§2). `article.html` description exceeds the ~155–160 display limit. The test bar applies the 145–160 range to `index.html` only (155 ✓). Suggested later trim to ≤160 chars.
2. **O2 — test fixtures reuse the public jetton-master address as placeholder seller** (§4). `worker/test/*.mjs` use `EQCxE6…` as `SELLER`/`SELLER_UF` with an explicit "placeholder-shaped, NOT a real seller wallet" comment. Not a leak, but the real seller address must come from the `SELLER_TON_ADDRESS` secret at deploy time — see checklist.
3. **O3 — repo not yet created.** `.gitignore` content is correct, but git enforcement is unverified until the GitHub repo exists (DEPLOYMENT.md §0). Re-run `git check-ignore -v product/year-reset-planner-2027.pdf` after push.

## Verdict

**LAUNCH-READY.** All six test groups pass with evidence above; the PDF rebuild is byte-identical, the site serves all six paths with correct SEO/structured data and no external trackers, the Worker tests are 26/26, the secrets sweep finds zero real secrets, the article matches its source exactly with no invented claims, and the payment flow is covered end-to-end in dry-run. Remaining work is deployment only (see `qa/checklist.md`), not product fixes.
