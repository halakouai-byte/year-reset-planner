# BUILD-NOTE — 2027 Year Reset Planner Pack PDFs

## How to rebuild

From the repo root:

```bash
python3 tools/build-planner.py
```

The script writes both files in one run:

- `product/year-reset-planner-2027.pdf` — full product, 14 pages
- `site/sample.pdf` — free sample, 2 pages (product pages 7 and 12),
  each stamped with a diagonal watermark:
  "FREE SAMPLE — 2027 Year Reset Planner"

No secrets are read. No network access. The build is deterministic:
re-running produces byte-identical files (fixed creation date
2027-01-01 UTC, verified by matching SHA-256 across rebuilds).

## Fonts

- DejaVuSans (regular + bold), from
  `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` and
  `DejaVuSans-Bold.ttf`.
- If those files are absent, the script falls back to fpdf2's core
  Helvetica (same layout, different metrics).

## Page size and style

- A4 (210 × 297 mm), 15 mm margins.
- Black/gray text + ONE accent color, deep teal #0F766E.
- Print-friendly: no photos, light fills only.
- Every page has a footer: "2027 Year Reset Planner Pack | Page N of 14".
  Sample pages keep their product page numbers (7 and 12).

## Page order (product)

1. Cover — 2. How to use — 3. 2026 Wins (top 10) — 4. Lessons &
   Letting Go — 5. 2026 in Numbers — 6. 2027 Vision — 7. 2027 Goals by
   life area — 8. Top 3 Goals — 9. Q1 90-Day Plan — 10. Weekly Rhythm &
   Habit Anchors — 11. Monthly Check-In — 12. 365-Day Habit Tracker
   (3 habits × 12 months × 31 days) — 13. BONUS Year-End Money
   Close-Out — 14. Commitment + free notes.

## Verification done (2026-11-21)

- `pdfinfo`: product = 14 pages, A4 (595.28 × 841.89 pts),
  50,917 bytes (under 2 MB); sample = 2 pages, A4, 29,176 bytes.
- `pdftotext`: footer "Page N of 14" present on all 14 product pages;
  headings confirmed on pages 3–6 and 14.
- Rendered with `pdftoppm` and visually checked: cover (p.1), how-to
  (p.2), goals (p.7), top-3 (p.8), Q1 (p.9), rhythm (p.10), monthly
  (p.11), habit tracker (p.12), money close-out (p.13), commitment
  (p.14), plus both sample pages. No overflow, no clipped text.
  One fix applied during verification: habit-tracker labels overlapped
  month names in the first draft; labels now sit in a separate column
  ("Habit 1/2/3" beside "Jan/Feb/...") and re-rendered clean.
- Note: `pdftotext` fragments the rotated watermark text into single
  characters (a known extractor quirk with 45° text); the watermark is
  confirmed visually in the rendered sample pages, not by text search.

## Do not commit the product PDF

`product/year-reset-planner-2027.pdf` is generated and gitignored by
design — it is delivered to buyers only via the Telegram bot
(`file_id`). Only `site/sample.pdf` is public.
