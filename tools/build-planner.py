#!/usr/bin/env python3
"""Build the 2027 Year Reset Planner Pack PDFs.

Deterministic build: same input -> same output bytes (fixed creation date,
no timestamps, no secrets read). Writes:
  product/year-reset-planner-2027.pdf  (14 pages, full product)
  site/sample.pdf                     (2 pages, watermarked free sample:
                                       product pages 7 and 12)

Tech: fpdf2 2.9.0, DejaVuSans TTF, A4, black/gray + one accent (deep teal
#0F766E), print-friendly, no photos.
"""
import os
import sys
from datetime import datetime, timezone

from fpdf import FPDF

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRODUCT_PATH = os.path.join(ROOT, "product", "year-reset-planner-2027.pdf")
SAMPLE_PATH = os.path.join(ROOT, "site", "sample.pdf")

FONT_DIR = "/usr/share/fonts/truetype/dejavu/"
FONT_REG = os.path.join(FONT_DIR, "DejaVuSans.ttf")
FONT_BOLD = os.path.join(FONT_DIR, "DejaVuSans-Bold.ttf")

TEAL = (15, 118, 110)          # #0F766E accent
TEAL_LIGHT = (204, 251, 241)   # light teal fill
INK = (31, 41, 55)             # near-black text
GRAY = (107, 114, 128)         # mid gray
LINE = (209, 213, 219)         # light rule gray
FAINT = (243, 244, 246)        # faint fill

MARGIN = 15
USABLE_W = 210 - 2 * MARGIN    # 180 mm
BOTTOM = 282                   # footer baseline zone starts


class PlannerPDF(FPDF):
    """A4 planner PDF with a fixed footer on every page.

    page_labels: list of label strings shown in the footer, one per page
    (sample PDF reuses product page numbers, e.g. ["7", "12"]).
    total: total pages of the full product (always 14).
    watermark: if True, stamp a diagonal FREE SAMPLE watermark on each page.
    """

    def __init__(self, page_labels, total=14, watermark=False):
        super().__init__("P", "mm", "A4")
        self.page_labels = page_labels
        self.total = total
        self.watermark = watermark
        self.set_auto_page_break(auto=True, margin=18)
        if os.path.exists(FONT_REG):
            self.add_font("DejaVu", "", FONT_REG)
            self.add_font("DejaVu", "B", FONT_BOLD)
            self.font_family = "DejaVu"
        else:  # fallback to core Helvetica
            self.font_family = "Helvetica"
        self.set_title("2027 Year Reset Planner Pack")
        self.set_author("2027 Year Reset Planner Pack")
        try:
            self.set_creation_date(datetime(2027, 1, 1, tzinfo=timezone.utc))
        except Exception:
            pass

    def font(self, style="", size=11):
        self.set_font(self.font_family, style, size)

    def footer(self):
        if self.page_no() == 0:
            return
        label = self.page_labels[self.page_no() - 1]
        self.set_y(-13)
        self.set_draw_color(*LINE)
        self.line(MARGIN, self.get_y(), 210 - MARGIN, self.get_y())
        self.set_y(-11)
        self.set_text_color(*GRAY)
        self.font("", 8)
        self.cell(0, 5, "2027 Year Reset Planner Pack  |  Page %s of %d"
                 % (label, self.total), align="C")

    def stamp_watermark(self):
        if not self.watermark:
            return
        self.set_text_color(15, 118, 110)
        self.set_font(self.font_family, "B", 22)
        with self.rotation(45, 105, 148):
            tw = self.get_string_width("FREE SAMPLE \u2014 2027 Year Reset Planner")
            self.text(105 - tw / 2, 148,
                      "FREE SAMPLE \u2014 2027 Year Reset Planner")
        self.set_text_color(*INK)


# ---------------------------------------------------------------- helpers
def header(pdf, kicker, title):
    pdf.font("B", 11)
    pdf.set_text_color(*TEAL)
    pdf.cell(0, 6, kicker.upper(), new_x="LMARGIN", new_y="NEXT")
    pdf.font("B", 22)
    pdf.set_text_color(*INK)
    pdf.cell(0, 11, title, new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(*TEAL)
    pdf.set_line_width(0.8)
    pdf.line(MARGIN, pdf.get_y() + 1, MARGIN + 42, pdf.get_y() + 1)
    pdf.set_line_width(0.2)
    pdf.ln(6)


def section(pdf, title, size=12):
    pdf.font("B", size)
    pdf.set_text_color(*TEAL)
    pdf.cell(0, 7, title, new_x="LMARGIN", new_y="NEXT")
    pdf.set_draw_color(*LINE)
    pdf.line(MARGIN, pdf.get_y(), 210 - MARGIN, pdf.get_y())
    pdf.ln(3)


def para(pdf, text, size=10.5, color=INK, h=5.5):
    pdf.font("", size)
    pdf.set_text_color(*color)
    pdf.multi_cell(0, h, text)
    pdf.ln(1)


def bullet(pdf, text, size=10.5, h=5.5):
    x = pdf.get_x()
    pdf.font("B", size)
    pdf.set_text_color(*TEAL)
    pdf.cell(6, h, chr(8226))
    pdf.font("", size)
    pdf.set_text_color(*INK)
    pdf.multi_cell(0, h, text)
    pdf.ln(0.5)


def ruled_lines(pdf, n, h=8.0, numbered=False, num_w=7):
    """n ruled writing lines; optional numbers at the left."""
    for i in range(1, n + 1):
        y = pdf.get_y()
        if numbered:
            pdf.font("B", 10)
            pdf.set_text_color(*TEAL)
            pdf.set_xy(MARGIN, y)
            pdf.cell(num_w, h, str(i))
        pdf.set_draw_color(*LINE)
        pdf.line(MARGIN + (num_w if numbered else 0), y + h - 1.5,
                 210 - MARGIN, y + h - 1.5)
        pdf.set_y(y + h)
    pdf.ln(2)


def labeled_line(pdf, label, label_w=42, h=8.0):
    """A 'Label: ______' fill-in line."""
    y = pdf.get_y()
    pdf.font("B", 10)
    pdf.set_text_color(*INK)
    pdf.set_xy(MARGIN, y)
    pdf.cell(label_w, h, label)
    pdf.set_draw_color(*LINE)
    pdf.line(MARGIN + label_w, y + h - 1.5, 210 - MARGIN, y + h - 1.5)
    pdf.set_y(y + h)


def checkbox(pdf, x, y, s=4.0):
    pdf.set_draw_color(*GRAY)
    pdf.rect(x, y, s, s)


def table_header(pdf, cols, widths, fill=TEAL):
    pdf.set_fill_color(*fill)
    pdf.set_text_color(255, 255, 255)
    pdf.font("B", 9.5)
    for c, w in zip(cols, widths):
        pdf.cell(w, 7, " " + c, border=0, fill=True)
    pdf.ln(7)
    pdf.set_text_color(*INK)


def table_row(pdf, cells, widths, h=7.5, bold_first=False, fill=False):
    if fill:
        pdf.set_fill_color(*FAINT)
    pdf.font("B" if bold_first else "", 9.5)
    pdf.set_text_color(*INK)
    for c, w in zip(cells, widths):
        pdf.cell(w, h, " " + c, border=0, fill=fill)
    pdf.ln(h)
    pdf.set_draw_color(*LINE)
    pdf.line(MARGIN, pdf.get_y(), 210 - MARGIN, pdf.get_y())


# ---------------------------------------------------------------- pages
def page_cover(pdf):
    pdf.add_page()
    pdf.ln(38)
    pdf.font("B", 64)
    pdf.set_text_color(*TEAL)
    pdf.cell(0, 26, "2027", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.font("B", 30)
    pdf.set_text_color(*INK)
    pdf.cell(0, 14, "Year Reset Planner", align="C",
             new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    pdf.set_draw_color(*TEAL)
    pdf.set_line_width(0.8)
    pdf.line(75, pdf.get_y(), 135, pdf.get_y())
    pdf.set_line_width(0.2)
    pdf.ln(7)
    pdf.font("", 13)
    pdf.set_text_color(*GRAY)
    pdf.cell(0, 8, "Review 2026.  Plan 2027.  Track every day.",
             align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(14)
    # bonus badge
    pdf.set_fill_color(*TEAL_LIGHT)
    pdf.set_draw_color(*TEAL)
    y = pdf.get_y()
    pdf.set_xy(45, y)
    pdf.cell(120, 11, "Includes Year-End Money Close-Out (bonus)",
             align="C", border=1, fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(20)
    pdf.font("", 10)
    pdf.set_text_color(*GRAY)
    pdf.cell(0, 6, "Printable  |  A4  |  14 pages  |  Print-friendly",
             align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, "Print at home. No photos, no ink wasted.",
             align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.stamp_watermark()


def page_how_to(pdf):
    pdf.add_page()
    header(pdf, "Start here", "How to use this planner")
    section(pdf, "Print guide")
    bullet(pdf, "Print on A4 paper, single-sided, at 100% scale "
                "(fit-to-page also works on US Letter).")
    bullet(pdf, "Black-and-white printing is fine: the planner uses "
                "black and gray plus one teal accent.")
    bullet(pdf, "Print pages 3-14 once, and reprint the Monthly Check-In "
                "(p. 11) and Habit Tracker (p. 12) as often as you like.")
    bullet(pdf, "Use a pen you enjoy writing with. This planner is "
                "designed to be filled in by hand.")
    pdf.ln(2)
    section(pdf, "15-minute setup")
    steps = [
        ("1.", "Review 2026 first (pages 3-5). Be honest, not harsh."),
        ("2.", "Write your word of the year and your 2027 vision (p. 6)."),
        ("3.", "Set your goals by life area, then pick your Top 3 (pp. 7-8)."),
        ("4.", "Plan Quarter 1 and your weekly rhythm (pp. 9-10)."),
        ("5.", "Start the habit tracker (p. 12) today - a small tick counts."),
    ]
    for num, text in steps:
        y = pdf.get_y()
        pdf.font("B", 10.5)
        pdf.set_text_color(*TEAL)
        pdf.set_xy(MARGIN, y)
        pdf.cell(8, 5.5, num)
        pdf.font("", 10.5)
        pdf.set_text_color(*INK)
        pdf.multi_cell(0, 5.5, text)
        pdf.ln(1)
    pdf.ln(2)
    section(pdf, "What you need")
    bullet(pdf, "A pen, 15 quiet minutes, and your 2026 numbers "
                "(bank statements help for page 5).")
    bullet(pdf, "Optional: a folder or binder to keep the printed pages "
                "together all year.")
    pdf.ln(2)
    section(pdf, "A note before you start")
    para(pdf, "A reset is not a punishment for 2026. Keep what worked, "
              "drop what did not, and give 2027 one clear direction. "
              "Small daily ticks beat big yearly promises.")
    pdf.stamp_watermark()


def page_wins(pdf):
    pdf.add_page()
    header(pdf, "2026 Review", "Wins - Top 10 wins of 2026")
    para(pdf, "Write down your ten biggest wins of 2026 - big or small. "
              "A win is anything you are proud of, finished, started, "
              "or survived.")
    ruled_lines(pdf, 10, h=17.5, numbered=True)
    para(pdf, "My proudest win of 2026 was:", size=10.5)
    ruled_lines(pdf, 2, h=8.0)
    pdf.stamp_watermark()


def page_lessons(pdf):
    pdf.add_page()
    header(pdf, "2026 Review", "Lessons & Letting Go")
    for title, prompt in [
        ("What worked", "Habits, routines and choices that helped in 2026."),
        ("What didn't work", "What drained time, money or energy."),
        ("What to stop", "What I am letting go of before 2027 starts."),
    ]:
        section(pdf, title)
        para(pdf, prompt, size=9.5, color=GRAY)
        ruled_lines(pdf, 5, h=8.0)
    pdf.stamp_watermark()


def page_numbers(pdf):
    pdf.add_page()
    header(pdf, "2026 Review", "2026 in Numbers")
    para(pdf, "Fill in your real 2026 numbers. Estimates are fine - "
              "the point is to see the year clearly before planning 2027.")
    widths = [62, 52, 66]
    table_header(pdf, ["Measure", "2026 result", "Notes"], widths)
    rows = [
        ("Total income", "", ""),
        ("Total savings", "", ""),
        ("Debt at start of 2026", "", ""),
        ("Debt at end of 2026", "", ""),
        ("Books read", "", ""),
        ("Workouts completed", "", ""),
        ("New skills learned", "", ""),
        ("Trips taken", "", ""),
        ("New people met", "", ""),
        ("Days I felt proud", "", ""),
        ("Money spent on fun", "", ""),
        ("Biggest expense", "", ""),
    ]
    for i, (a, b, c) in enumerate(rows):
        table_row(pdf, [a, b, c], widths, h=9.5, bold_first=True,
                  fill=(i % 2 == 1))
    pdf.ln(4)
    section(pdf, "2026 in one sentence")
    ruled_lines(pdf, 3, h=8.0)
    pdf.stamp_watermark()


def page_vision(pdf):
    pdf.add_page()
    header(pdf, "2027 Vision", "2027 Vision")
    section(pdf, "My word of the year")
    pdf.set_fill_color(*TEAL_LIGHT)
    pdf.set_draw_color(*TEAL)
    y = pdf.get_y()
    pdf.set_xy(MARGIN, y)
    pdf.cell(USABLE_W, 16, "", border=1, fill=True)
    pdf.set_xy(MARGIN + 3, y + 4)
    pdf.font("", 10)
    pdf.set_text_color(*GRAY)
    pdf.cell(USABLE_W - 6, 8, "One word that will guide my 2027:")
    pdf.set_y(y + 19)
    pdf.ln(2)
    prompts = [
        "By December 2027, my life looks like...",
        "The person I want to become in 2027 is...",
        "What I want more of in 2027:",
        "What I want less of in 2027:",
        "One thing I will do differently from 2026:",
        "If 2027 goes well, I will feel...",
    ]
    for p in prompts:
        pdf.font("B", 10.5)
        pdf.set_text_color(*INK)
        pdf.cell(0, 6, p, new_x="LMARGIN", new_y="NEXT")
        ruled_lines(pdf, 3, h=8.0)
    pdf.stamp_watermark()


def page_goals(pdf):
    pdf.add_page()
    header(pdf, "2027 Goals", "2027 Goals - by life area")
    para(pdf, "Set one or two goals per area. Keep them specific enough "
              "that you will know in December whether you did them.")
    for area in ["Health", "Money", "Work", "Relationships", "Growth"]:
        section(pdf, area, size=11)
        ruled_lines(pdf, 2, h=8.0)
    pdf.stamp_watermark()


def page_top3(pdf):
    pdf.add_page()
    header(pdf, "2027 Goals", "My Top 3 Goals for 2027")
    para(pdf, "From page 7, pick the three goals that matter most. "
              "These three get your best time and energy.")
    for n in (1, 2, 3):
        section(pdf, "Goal %d" % n, size=11)
        labeled_line(pdf, "Goal:", 22)
        labeled_line(pdf, "Why it matters:", 38)
        pdf.font("B", 10)
        pdf.set_text_color(*INK)
        pdf.cell(0, 6, "3 milestones:", new_x="LMARGIN", new_y="NEXT")
        ruled_lines(pdf, 3, h=7.0)
        labeled_line(pdf, "First step:", 30)
        labeled_line(pdf, "Deadline:", 28)
        pdf.ln(3)
    pdf.stamp_watermark()


def page_q1(pdf):
    pdf.add_page()
    header(pdf, "90-Day Plan", "Quarter 1 - 90-Day Plan")
    para(pdf, "Break the first 90 days into focus, milestones and weekly "
              "actions. Ninety days is long enough to matter and short "
              "enough to stay real.")
    labeled_line(pdf, "Q1 focus:", 30)
    labeled_line(pdf, "Goal:", 22)
    pdf.ln(2)
    section(pdf, "3 milestones for Q1")
    ruled_lines(pdf, 3, h=8.0)
    section(pdf, "Weekly actions")
    widths = [16, 82, 42, 40]
    table_header(pdf, ["Week", "Action", "Done?", "Result"], widths)
    for i in range(1, 13):
        y = pdf.get_y()
        fill = (i % 2 == 0)
        if fill:
            pdf.set_fill_color(*FAINT)
        pdf.font("", 9.5)
        pdf.set_text_color(*INK)
        pdf.cell(widths[0], 7.5, " %d" % i, fill=fill)
        pdf.cell(widths[1], 7.5, "", fill=fill)
        pdf.cell(widths[2], 7.5, "", fill=fill)
        pdf.cell(widths[3], 7.5, "", fill=fill)
        pdf.ln(7.5)
        pdf.set_draw_color(*LINE)
        pdf.line(MARGIN, pdf.get_y(), 210 - MARGIN, pdf.get_y())
        checkbox(pdf, MARGIN + widths[0] + widths[1] + 16, y + 1.8)
    pdf.ln(3)
    para(pdf, "Review at the end of Q1: what worked, what to change "
              "for Q2.", size=9.5, color=GRAY)
    pdf.stamp_watermark()


def page_rhythm(pdf):
    pdf.add_page()
    header(pdf, "90-Day Plan", "Weekly Rhythm & Habit Anchors")
    section(pdf, "My weekly rhythm")
    widths = [26, 52, 52, 50]
    table_header(pdf, ["Day", "Morning anchor", "Main focus", "Evening anchor"],
                 widths)
    for i, day in enumerate(["Monday", "Tuesday", "Wednesday", "Thursday",
                             "Friday", "Saturday", "Sunday"]):
        table_row(pdf, [day, "", "", ""], widths, h=10.5,
                  bold_first=True, fill=(i % 2 == 1))
    pdf.ln(4)
    section(pdf, "Habit anchors")
    para(pdf, "Attach a new habit to something you already do every day. "
              "Example: \"After I make coffee, I write for 10 minutes.\"",
              size=9.5, color=GRAY)
    for label in ["After I...", "I will...", "After I...", "I will...",
                  "After I...", "I will..."]:
        labeled_line(pdf, label, 28)
    pdf.stamp_watermark()


def page_monthly(pdf):
    pdf.add_page()
    header(pdf, "Track", "Monthly Check-In")
    para(pdf, "At the end of each month, score the month and write one "
              "line about it. Twelve honest lines tell the story of 2027.")
    widths = [30, 62, 22, 66]
    table_header(pdf, ["Month", "Focus", "Score /10", "Note"], widths)
    months = ["January", "February", "March", "April", "May", "June",
              "July", "August", "September", "October", "November",
              "December"]
    for i, m in enumerate(months):
        table_row(pdf, [m, "", "", ""], widths, h=11.5, bold_first=True,
                  fill=(i % 2 == 1))
    pdf.ln(3)
    para(pdf, "Best month of 2027 (so far):", size=10.5)
    ruled_lines(pdf, 2, h=8.0)
    pdf.stamp_watermark()


def page_habits(pdf):
    pdf.add_page()
    header(pdf, "Track", "365-Day Habit Tracker")
    para(pdf, "Pick 3 habits. Tick one box per day you do the habit. "
              "A tick a day is the whole system.", size=10)
    # grid geometry
    label_w = 34.0
    day_w = (USABLE_W - label_w) / 31.0
    row_h = 6.0
    # day-number header
    x0 = MARGIN + label_w
    pdf.font("B", 6.5)
    pdf.set_text_color(*GRAY)
    for d in range(1, 32):
        pdf.set_xy(x0 + (d - 1) * day_w, pdf.get_y())
        pdf.cell(day_w, 5, str(d), align="C")
    pdf.ln(5)
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    pdf.font("", 8)
    for h in (1, 2, 3):
        for mi, m in enumerate(months):
            y = pdf.get_y()
            # light teal fill behind the whole 12-row habit block
            if mi == 0:
                pdf.set_fill_color(*TEAL_LIGHT)
                pdf.rect(MARGIN, y, label_w - 1, row_h * 12, style="F")
            # month abbrev in the left of the label column...
            pdf.font("", 8)
            pdf.set_text_color(*INK)
            pdf.set_xy(MARGIN + 1, y)
            pdf.cell(12, row_h, m)
            # ...and the habit number in the right of the label column,
            # first row of each block only (no overlap with month names)
            if mi == 0:
                pdf.font("B", 8)
                pdf.set_text_color(*TEAL)
                pdf.set_xy(MARGIN + 13, y)
                pdf.cell(label_w - 14, row_h, "Habit %d" % h)
            # day cells
            pdf.set_draw_color(*LINE)
            for d in range(31):
                pdf.rect(x0 + d * day_w, y, day_w, row_h)
            pdf.set_y(y + row_h)
    pdf.ln(4)
    para(pdf, "Habit 1: ______________________    Habit 2: ______________________"
              "    Habit 3: ______________________", size=9.5)
    para(pdf, "Tip: never miss twice. One missed day is an accident; "
              "two in a row is a new habit.", size=9.5, color=GRAY)
    pdf.stamp_watermark()


def page_money(pdf):
    pdf.add_page()
    header(pdf, "Bonus", "Year-End Money Close-Out")
    para(pdf, "Close out 2026 money in one place, then set your 2027 "
              "money goals. Use your latest statements.", size=10)
    section(pdf, "Accounts snapshot", size=11)
    widths = [70, 55, 55]
    table_header(pdf, ["Account", "Balance", "Notes"], widths)
    for i, a in enumerate(["Bank account 1", "Bank account 2",
                           "Savings / emergency fund", "Cash",
                           "Investments"]):
        table_row(pdf, [a, "", ""], widths, h=8.5, bold_first=True,
                  fill=(i % 2 == 1))
    pdf.ln(3)
    section(pdf, "Debts", size=11)
    widths = [70, 55, 55]
    table_header(pdf, ["Debt", "Amount owed", "Monthly payment"], widths)
    for i, a in enumerate(["Debt 1", "Debt 2", "Debt 3"]):
        table_row(pdf, [a, "", ""], widths, h=8.5, bold_first=True,
                  fill=(i % 2 == 1))
    pdf.ln(3)
    section(pdf, "Subscriptions audit", size=11)
    widths = [70, 45, 32, 33]
    table_header(pdf, ["Subscription", "Cost / month", "Keep", "Cancel"],
                 widths)
    for i in range(1, 6):
        y = pdf.get_y()
        fill = (i % 2 == 0)
        if fill:
            pdf.set_fill_color(*FAINT)
        pdf.font("B", 9.5)
        pdf.set_text_color(*INK)
        pdf.cell(widths[0], 8.5, " Subscription %d" % i, fill=fill)
        pdf.font("", 9.5)
        pdf.cell(widths[1], 8.5, "", fill=fill)
        pdf.cell(widths[2], 8.5, "", fill=fill)
        pdf.cell(widths[3], 8.5, "", fill=fill)
        pdf.ln(8.5)
        pdf.set_draw_color(*LINE)
        pdf.line(MARGIN, pdf.get_y(), 210 - MARGIN, pdf.get_y())
        checkbox(pdf, MARGIN + widths[0] + widths[1] + 13, y + 2.3)
        checkbox(pdf, MARGIN + widths[0] + widths[1] + widths[2] + 13,
                 y + 2.3)
    pdf.ln(3)
    section(pdf, "Net-worth snapshot", size=11)
    labeled_line(pdf, "Total assets:", 42)
    labeled_line(pdf, "Total debts:", 42)
    labeled_line(pdf, "Net worth (assets - debts):", 62)
    pdf.ln(2)
    section(pdf, "2027 money goals", size=11)
    ruled_lines(pdf, 3, h=8.0)
    pdf.stamp_watermark()


def page_commitment(pdf):
    pdf.add_page()
    header(pdf, "Commit", "My 2027 Commitment")
    pdf.set_fill_color(*TEAL_LIGHT)
    pdf.set_draw_color(*TEAL)
    y = pdf.get_y()
    pdf.set_xy(MARGIN, y)
    pdf.multi_cell(USABLE_W, 6.5,
                   "I commit to my Top 3 goals for 2027. I will show up "
                   "every day, track my habits, review each month, and "
                   "finish the year knowing I gave it my best.",
                   border=1, fill=True, align="C")
    pdf.set_y(y + 24)
    pdf.ln(6)
    labeled_line(pdf, "Signed:", 28, h=10.0)
    labeled_line(pdf, "Date:", 28, h=10.0)
    pdf.ln(4)
    section(pdf, "Free notes")
    ruled_lines(pdf, 12, h=8.0)
    pdf.stamp_watermark()


PAGES = [
    page_cover, page_how_to, page_wins, page_lessons, page_numbers,
    page_vision, page_goals, page_top3, page_q1, page_rhythm,
    page_monthly, page_habits, page_money, page_commitment,
]


def build_product():
    labels = [str(i) for i in range(1, 15)]
    pdf = PlannerPDF(labels, total=14, watermark=False)
    for fn in PAGES:
        fn(pdf)
    os.makedirs(os.path.dirname(PRODUCT_PATH), exist_ok=True)
    pdf.output(PRODUCT_PATH)
    return PRODUCT_PATH


def build_sample():
    # free sample: product pages 7 (Goals) and 12 (Habit Tracker)
    labels = ["7", "12"]
    pdf = PlannerPDF(labels, total=14, watermark=True)
    page_goals(pdf)
    page_habits(pdf)
    os.makedirs(os.path.dirname(SAMPLE_PATH), exist_ok=True)
    pdf.output(SAMPLE_PATH)
    return SAMPLE_PATH


def main():
    p = build_product()
    s = build_sample()
    print("product:", p, os.path.getsize(p), "bytes")
    print("sample: ", s, os.path.getsize(s), "bytes")


if __name__ == "__main__":
    main()
