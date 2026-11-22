// src/ton.js — PURE payment logic for the 2027 Year Reset Planner Pack store.
// No Cloudflare APIs, no fetch, no secrets. Runs in Node (tests) and in the
// Worker (imported by worker.js). All money math is BigInt / integer strings.
//
// Verified against live API responses on 2026-11-20 (see test/live-probe-output.json):
//  - TonAPI  GET /v2/accounts/{seller}/jettons/{USDT_MASTER}/history
//      -> { events: [ { event_id, timestamp, actions: [
//           { type: "JettonTransfer", status: "failed"|..., JettonTransfer:
//             { sender: {address:"0:<hex>"}, recipient: {address},
//               amount: "<elementary units>", comment?: "<text>",
//               jetton: { address, symbol:"USD₮", decimals:6 } },
//             base_transactions: ["<hex hash>", ...] } ] } ], next_from }
//    NOTE: the probe only ever observed `status:"failed"` transfers (people
//    sending USDT *to the master contract itself*) and none of them carried a
//    `comment`. TonAPI's schema includes `comment` on JettonTransfer, but its
//    presence on a real successful payment is UNPROVEN until the live test.
//    The matcher therefore has a Tier-2 fallback (exact amount + time window,
//    unique candidate only) — see matchOrder().
//  - TonAPI  GET /v2/rates?tokens=ton&currencies=usd
//      -> { rates: { TON: { prices: { USD: 1.01007... } } } }
//  - TON Center v2 getTransactions returns RAW transactions; a USDT jetton
//    payment arrives as msg.dataRaw (op 0x7362d09c notification from the
//    seller's jetton wallet) whose comment needs BOC/cell decoding. That is
//    why TON Center is NOT the USDT primary — only the native-TON fallback,
//    where msg.dataText carries the comment in plain text.

export const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
export const USDT_DECIMALS = 6;
export const USDT_SYMBOL = 'USD₮';

// Order memo alphabet: no 0/O, 1/I/L — readable when typed by hand.
export const ORDER_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ORDER_ID_RE = /^YR-[A-Z0-9]{6}$/;

/** "3.00" (USD) -> "3000000" (USDT elementary units, 6 decimals). Throws on bad input. */
export function parseUsdtToUnits(priceStr) {
  if (typeof priceStr !== 'string' || !/^\d+(\.\d{1,6})?$/.test(priceStr.trim())) {
    throw new Error(`Invalid USDT price: ${JSON.stringify(priceStr)} (need e.g. "3.00")`);
  }
  const [whole, frac = ''] = priceStr.trim().split('.');
  return (BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6))).toString();
}

/** USDT elementary units -> "3.00" for display. */
export function formatUsdt(units) {
  const n = BigInt(units);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac.length === 1 ? frac + '0' : frac}`;
}

/**
 * Native TON (GRAM) nanotons for the same USD price at a given TON/USD rate.
 * Rounded UP so the seller never loses a fraction of a cent to rounding.
 */
export function tonNanoForUsd(priceUsdStr, tonUsdRate) {
  const rate = Number(tonUsdRate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid TON/USD rate: ${tonUsdRate}`);
  const priceMilli = BigInt(Math.round(parseFloat(priceUsdStr) * 1000)); // $3.00 -> 3000 milli-USD
  const rateMilli = BigInt(Math.round(rate * 1000));
  // nanotons = ceil(priceUsd / rate * 1e9) = ceil(priceMilli * 1e9 / rateMilli)
  return ((priceMilli * 1_000_000_000n + rateMilli - 1n) / rateMilli).toString();
}

/**
 * Normalize any TON address form to "workchain:lowercase-hex-hash".
 * Accepts raw "0:<64 hex>" (what TonAPI returns) and user-friendly base64url
 * "EQ..."/"UQ..." (what Keeper shows). Returns null if unparseable.
 */
export function normalizeTonAddress(addr) {
  if (!addr || typeof addr !== 'string') return null;
  const s = addr.trim();
  const raw = s.match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (raw) return `${parseInt(raw[1], 10)}:${raw[2].toLowerCase()}`;
  if (/^[A-Za-z0-9_-]{48}$/.test(s)) {
    try {
      const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
      if (bin.length !== 36) return null;
      const bytes = [...bin].map((c) => c.charCodeAt(0));
      let workchain = bytes[1];
      if (workchain >= 128) workchain -= 256;
      const hash = bytes.slice(2, 34).map((b) => b.toString(16).padStart(2, '0')).join('');
      return `${workchain}:${hash}`;
    } catch {
      return null;
    }
  }
  return null;
}

/** Address equality that survives EQ-vs-UQ-vs-raw formatting differences. */
export function sameAddress(a, b) {
  const na = normalizeTonAddress(a);
  const nb = normalizeTonAddress(b);
  if (na && nb) return na === nb;
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** "YR-" + 6 unambiguous chars. Pass crypto.getRandomValues(new Uint8Array(6)). */
export function newOrderId(randomBytes) {
  let id = 'YR-';
  for (let i = 0; i < 6; i++) id += ORDER_ID_ALPHABET[randomBytes[i] % ORDER_ID_ALPHABET.length];
  return id;
}

// ---------------------------------------------------------------- payment links
// Keeper universal link first (works inside Telegram + browsers); ton://
// deep link second (other wallets). `text=` is the order memo — the buyer
// MUST NOT edit or delete it. Amount for jetton links is in elementary units
// (USDT 6 decimals: $3.00 -> 3000000). Amount for native links is nanotons.

export function usdtPayLinks(sellerAddress, orderId, amountUnits) {
  const q = `jetton=${USDT_MASTER}&amount=${amountUnits}&text=${encodeURIComponent(orderId)}`;
  return {
    keeper: `https://app.tonkeeper.com/transfer/${sellerAddress}?${q}`,
    ton: `ton://transfer/${sellerAddress}?${q}`,
  };
}

export function tonPayLinks(sellerAddress, orderId, amountNano) {
  const q = `amount=${amountNano}&text=${encodeURIComponent(orderId)}`;
  return {
    keeper: `https://app.tonkeeper.com/transfer/${sellerAddress}?${q}`,
    ton: `ton://transfer/${sellerAddress}?${q}`,
  };
}

// ---------------------------------------------------------------- API parsing
// Every parser is defensive: unknown extra fields are ignored, missing fields
// degrade to null, and NOTHING throws on a weird-but-valid API response.

/**
 * TonAPI jetton history -> normalized incoming USDT transfers to the seller.
 * Drops: failed actions, other jettons, outgoing transfers (recipient != seller).
 * txHash is base_transactions[0] (hex) — the hash that identifies the payment.
 */
export function parseTonApiJettonHistory(json, { seller, jettonMaster = USDT_MASTER }) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const out = [];
  for (const ev of events) {
    for (const a of ev?.actions ?? []) {
      if (a?.type !== 'JettonTransfer') continue;
      const jt = a.JettonTransfer ?? {};
      if ((a.status ?? '').toLowerCase() === 'failed') continue; // never credit failures
      if (jt.jetton?.address && !sameAddress(jt.jetton.address, jettonMaster)) continue;
      if (!sameAddress(jt.recipient?.address, seller)) continue;
      out.push({
        kind: 'usdt',
        txHash: a.base_transactions?.[0] ?? ev.event_id ?? null,
        sender: jt.sender?.address ?? null,
        recipient: jt.recipient?.address ?? null,
        amountUnits: String(jt.amount ?? '0'),
        comment: typeof jt.comment === 'string' ? jt.comment : null,
        timestamp: Number(ev.timestamp ?? 0),
        status: a.status ?? 'unknown',
      });
    }
  }
  return out;
}

/**
 * TON Center v2 getTransactions -> normalized incoming NATIVE TON transfers
 * with a plain-text comment. msg.dataRaw entries (jetton notifications, NFT
 * moves, ...) are skipped — they carry no readable comment without a BOC parser.
 */
export function parseTonCenterTransactions(json, { seller }) {
  const txs = Array.isArray(json?.result) ? json.result : [];
  const out = [];
  for (const tx of txs) {
    const msg = tx?.in_msg;
    if (!msg || !sameAddress(msg.destination, seller)) continue;
    const md = msg.msg_data;
    if (md?.['@type'] !== 'msg.dataText' || typeof md.text !== 'string') continue;
    out.push({
      kind: 'ton',
      txHash: tx.transaction_id?.hash ?? msg.hash ?? null,
      sender: msg.source ?? null,
      amountNano: String(msg.value ?? '0'),
      comment: md.text,
      timestamp: Number(tx.utime ?? 0),
    });
  }
  return out;
}

/** TonAPI /v2/rates -> TON price in USD (number) or null. */
export function parseTonRate(json) {
  const p = json?.rates?.TON?.prices?.USD;
  return typeof p === 'number' && Number.isFinite(p) && p > 0 ? p : null;
}

// ---------------------------------------------------------------- matching
const sumBig = (xs) => xs.reduce((a, b) => a + b, 0n);

/**
 * Match one order against recent on-chain transfers.
 *
 * order: { id, amount_usdt_units, amount_ton_nano, created_at (unix s) }
 * usedTx: Set of "kind:txHash" already credited to ANY order (anti-replay).
 *
 * Tier 1 — exact memo: transfers whose comment == order id (trimmed), in the
 *   window [created_at - 120s, now + 300s], not already used. Amounts SUM, so
 *   a buyer can top up an underpayment with a second transfer using the same memo.
 * Tier 2 — exact amount + time, unique candidate only: transfers of exactly
 *   the expected USDT amount, sent after the order was created, with NO memo
 *   or a memo that is not another order's id. Used ONLY when Tier 1 found
 *   nothing, and ONLY when there is exactly one candidate — ambiguity never
 *   auto-delivers, it goes to manual review. (Tier 2 exists because the
 *   comment's visibility in TonAPI jetton history is unproven until live test.)
 *
 * Returns { decision, via, txs, ... } where decision is one of:
 *   deliver | partial | ambiguous | not_found
 */
export function matchOrder(order, usdtTransfers, tonTransfers, usedTx = new Set()) {
  const now = Math.floor(Date.now() / 1000);
  const inWindow = (t) => t.timestamp >= order.created_at - 120 && t.timestamp <= now + 300;
  const afterCreation = (t) => t.timestamp >= order.created_at && t.timestamp <= now + 300;
  const unused = (t) => !t.txHash || !usedTx.has(`${t.kind}:${t.txHash}`);
  const memoIs = (t) => typeof t.comment === 'string' && t.comment.trim() === order.id;

  const usdtHits = usdtTransfers.filter((t) => memoIs(t) && inWindow(t) && unused(t));
  const usdtTotal = sumBig(usdtHits.map((t) => BigInt(t.amountUnits || '0')));
  if (usdtTotal >= BigInt(order.amount_usdt_units)) {
    return { decision: 'deliver', via: 'usdt-comment', txs: usdtHits, totalUnits: usdtTotal.toString() };
  }
  const tonHits = tonTransfers.filter((t) => memoIs(t) && inWindow(t) && unused(t));
  const tonTotal = sumBig(tonHits.map((t) => BigInt(t.amountNano || '0')));
  if (tonTotal >= BigInt(order.amount_ton_nano)) {
    return { decision: 'deliver', via: 'ton-comment', txs: tonHits, totalNano: tonTotal.toString() };
  }
  if (usdtHits.length > 0 || tonHits.length > 0) {
    return {
      decision: 'partial',
      via: usdtHits.length > 0 ? 'usdt-comment' : 'ton-comment',
      txs: [...usdtHits, ...tonHits],
      totalUnits: usdtTotal.toString(),
      totalNano: tonTotal.toString(),
      remainingUnits: (BigInt(order.amount_usdt_units) - usdtTotal > 0n
        ? BigInt(order.amount_usdt_units) - usdtTotal : 0n).toString(),
      remainingNano: (BigInt(order.amount_ton_nano) - tonTotal > 0n
        ? BigInt(order.amount_ton_nano) - tonTotal : 0n).toString(),
    };
  }

  // Tier 2: exact-amount, no other order's memo, unique candidate only.
  const expected = BigInt(order.amount_usdt_units);
  const cands = usdtTransfers.filter((t) => {
    if (BigInt(t.amountUnits || '0') !== expected) return false;
    if (!afterCreation(t) || !unused(t)) return false;
    if (typeof t.comment === 'string' && ORDER_ID_RE.test(t.comment.trim())) return false; // another order's memo
    return true;
  });
  if (cands.length === 1) {
    return { decision: 'deliver', via: 'usdt-amount-time-unique', txs: cands, totalUnits: cands[0].amountUnits, tier2: true };
  }
  if (cands.length > 1) return { decision: 'ambiguous', via: 'usdt-amount-time', candidates: cands };

  const sameCommentWrongAmount = [...usdtTransfers, ...tonTransfers]
    .some((t) => memoIs(t) && inWindow(t));
  return {
    decision: 'not_found',
    hint: {
      sameCommentWrongAmount,
      exactAmountNoComment: cands.length,
      recentIncoming: usdtTransfers.length + tonTransfers.length,
    },
  };
}
