// src/worker.js — Telegram storefront bot + TON/USDT payment verification.
// Product: 2027 Year Reset Planner Pack — $3.00 USDT on TON.
// Plain JavaScript, no framework, no dependencies. Cloudflare Workers runtime.
//
// WHAT IT DOES
//  1. Creates orders with a unique memo (YR-XXXXXX) — from the bot (/buy) or
//     from the external landing page (POST /api/order).
//  2. Shows the buyer a Keeper / ton:// payment link (USDT jetton primary,
//     native TON fallback). Price is in USDT, never in TON.
//  3. Verifies payment on-chain: TonAPI jetton history (primary) + TON Center
//     v2 getTransactions (native-TON fallback only). Verification runs when the
//     buyer taps "I paid" AND on a 2-minute cron sweep (batched: ONE TonAPI
//     call per sweep, matched locally against all pending orders).
//  4. On a match, records every tx hash (anti-replay / anti-double-delivery)
//     and delivers the file via Telegram sendDocument with a cached file_id.
//  5. Everything else (wrong amount, missing memo, wrong network, refunds)
//     routes to manual review — it NEVER auto-delivers on an ambiguous match.
//
// SECURITY — read this before touching the code:
//  - No secret anywhere in this file or in wrangler.toml. Config comes ONLY
//    from Worker environment variables / secrets (see README.md).
//  - BOT_TOKEN is used only in the Authorization path of api.telegram.org
//    calls and is NEVER logged.
//  - Seller-only commands (/refund, /deliver, /orders) are gated on
//    SELLER_TELEGRAM_ID. If it is unset, they are disabled.
//  - The bot never moves money. Refunds are manual: the seller sends USDT
//    back from Keeper; the bot only records the decision and tells both sides.
//  - KV has no compare-and-swap, so tx-claiming is check-then-put. The race
//    window is tiny at this volume and the order-status check + tx: key check
//    before delivery make a double-delivery require two simultaneous
//    verifications of the same order — and even then the second sendDocument
//    is caught by the `delivered` status guard. If volume ever grows, move
//    orders to D1 (see FLOW.md §7).
//
// Telegram Stars policy (§6.2): payment NEVER happens inside Telegram —
// there is no Telegram invoice and no Stars code here; the money moves in
// the external Keeper wallet app. BUT the bot's /buy flow DOES show the
// price and a Keeper pay button in-chat, so the mitigation is partial: it
// reduces — but does NOT eliminate — the risk that Telegram hides/bans
// the bot (see FLOW.md §6). No Stars code is built here.

import {
  USDT_MASTER,
  ORDER_ID_RE,
  parseUsdtToUnits,
  formatUsdt,
  tonNanoForUsd,
  sameAddress,
  newOrderId,
  usdtPayLinks,
  tonPayLinks,
  parseTonApiJettonHistory,
  parseTonCenterTransactions,
  parseTonRate,
  matchOrder,
} from './ton.js';

// ------------------------------------------------------------------ config
const ORDER_TTL_DEFAULT_MIN = 60;
const RECORD_TTL_SECONDS = 7 * 24 * 3600; // order records kept 7 days
const TX_TTL_SECONDS = 30 * 24 * 3600; // tx-hash dedup records kept 30 days
const CHECK_THROTTLE_MS = 20_000; // min gap between two "I paid" checks per order
const IP_ORDER_LIMIT_PER_DAY = 20;

function cfg(env) {
  const missing = ['BOT_TOKEN', 'SELLER_TON_ADDRESS', 'PRODUCT_FILE_ID']
    .filter((k) => !env[k]);
  if (missing.length) throw new Error(`Missing required secrets: ${missing.join(', ')}`);
  return {
    botToken: env.BOT_TOKEN,
    seller: env.SELLER_TON_ADDRESS,
    fileId: env.PRODUCT_FILE_ID,
    tonapiKey: env.TONAPI_KEY || null,
    priceUsdt: env.PRODUCT_PRICE_USDT || '3.00',
    tonPriceFallback: env.TON_PRICE_USD || '1.00',
    sellerTgId: env.SELLER_TELEGRAM_ID || null,
    support: env.SUPPORT_USERNAME || null, // e.g. "seller_handle" (no @)
    botUsername: env.BOT_USERNAME || null,
    webhookSecret: env.WEBHOOK_SECRET || null,
    orderTtlMin: Number(env.ORDER_TTL_MINUTES || ORDER_TTL_DEFAULT_MIN),
  };
}

// ------------------------------------------------------------------ helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

function log(event, data = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ------------------------------------------------------------------ KV store
const orderKey = (id) => `order:${id}`;
const txKey = (kind, hash) => `tx:${kind}:${hash}`;

async function getOrder(env, id) {
  if (!ORDER_ID_RE.test(id)) return null;
  return env.ORDERS_KV.get(orderKey(id), 'json');
}

async function putOrder(env, order) {
  await env.ORDERS_KV.put(orderKey(order.id), JSON.stringify(order), {
    expirationTtl: RECORD_TTL_SECONDS,
  });
}

function pushEvent(order, type, detail = {}) {
  order.events = order.events || [];
  order.events.push({ t: nowSec(), e: type, ...detail });
  if (order.events.length > 40) order.events = order.events.slice(-40);
}

// ------------------------------------------------------------------ Telegram API
async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) log('telegram_api_error', { method, description: data.description || 'unknown' });
  return data;
}

const sendMessage = (env, chatId, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

const answerCallback = (env, cbId, text) =>
  tg(env, 'answerCallbackQuery', { callback_query_id: cbId, text, show_alert: false });

function supportLine(c) {
  return c.support
    ? `\n\nNeed help? Message the seller: @${c.support}`
    : `\n\nNeed help? Use /support and describe your payment (order id + tx hash if you have it).`;
}

// ------------------------------------------------------------------ TON APIs
// Rate limits (free tiers, verified 2026-11-20): TonAPI no key = 1 req / 4 s,
// with free key = 1 rps. TON Center no key = 1 rps. One batched call per cron
// sweep + human-paced "I paid" taps stay far under both. A KV timestamp
// enforces the gap even when two Worker invocations run close together.
async function throttleTonApi(env, c) {
  const minGap = c.tonapiKey ? 1100 : 4200;
  const last = Number((await env.ORDERS_KV.get('rl:tonapi')) || 0);
  const wait = minGap - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  await env.ORDERS_KV.put('rl:tonapi', String(Date.now()), { expirationTtl: 3600 });
}

async function fetchTonRate(env, c) {
  const cached = await env.ORDERS_KV.get('rate:ton_usd', 'json');
  if (cached && nowSec() - cached.at < 600 && cached.rate > 0) return cached.rate;
  try {
    await throttleTonApi(env, c);
    const res = await fetch('https://tonapi.io/v2/rates?tokens=ton&currencies=usd', {
      headers: c.tonapiKey ? { Authorization: `Bearer ${c.tonapiKey}` } : {},
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) { log('tonapi_rate_limited', { where: 'rates' }); return Number(c.tonPriceFallback); }
    const rate = parseTonRate(await res.json());
    if (rate) {
      await env.ORDERS_KV.put('rate:ton_usd', JSON.stringify({ rate, at: nowSec() }), { expirationTtl: 3600 });
      return rate;
    }
  } catch (e) { log('ton_rate_fetch_failed', { error: String(e).slice(0, 200) }); }
  return Number(c.tonPriceFallback);
}

async function fetchJettonHistory(env, c, limit = 100) {
  await throttleTonApi(env, c);
  const url = `https://tonapi.io/v2/accounts/${c.seller}/jettons/${USDT_MASTER}/history?limit=${limit}`;
  const res = await fetch(url, {
    headers: c.tonapiKey ? { Authorization: `Bearer ${c.tonapiKey}` } : {},
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429) { log('tonapi_rate_limited', { where: 'jetton_history' }); return null; }
  if (!res.ok) { log('tonapi_error', { status: res.status }); return null; }
  return parseTonApiJettonHistory(await res.json(), { seller: c.seller });
}

async function fetchTonTransactions(env, c, limit = 50) {
  // TON Center, no key (1 rps). Native-TON fallback only — USDT jetton
  // payments are dataRaw here and unreadable without a BOC parser.
  const url = `https://toncenter.com/api/v2/getTransactions?address=${c.seller}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) { log('toncenter_error', { status: res.status }); return []; }
  return parseTonCenterTransactions(await res.json(), { seller: c.seller });
}

// ------------------------------------------------------------------ orders
async function createOrder(env, c, { chatId = null, username = null, source = 'bot', ip = null }) {
  const rate = await fetchTonRate(env, c);
  const priceUnits = parseUsdtToUnits(c.priceUsdt);
  const order = {
    id: newOrderId(crypto.getRandomValues(new Uint8Array(6))),
    chat_id: chatId,
    username,
    source,
    status: 'awaiting_payment',
    price_usdt: c.priceUsdt,
    amount_usdt_units: priceUnits,
    amount_ton_nano: tonNanoForUsd(c.priceUsdt, rate),
    ton_usd_rate: rate,
    created_at: nowSec(),
    expires_at: nowSec() + c.orderTtlMin * 60,
    paid_usdt_units: '0',
    paid_ton_nano: '0',
    tx_hashes: [],
    matched_by: null,
    sender_address: null,
    delivered_at: null,
    resends: 0,
    last_checked_at: 0,
    events: [{ t: nowSec(), e: 'created', source, ip: ip ? 'yes' : 'no' }],
  };
  await putOrder(env, order);
  log('order_created', { order: order.id, source, price: c.priceUsdt, rate });
  return order;
}

function payMessage(c, order) {
  const usdt = usdtPayLinks(c.seller, order.id, order.amount_usdt_units);
  const ton = tonPayLinks(c.seller, order.id, order.amount_ton_nano);
  const tonAmount = (BigInt(order.amount_ton_nano) / 1_000_000_000n).toString()
    + '.' + (BigInt(order.amount_ton_nano) % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  const text =
    `🧾 <b>Order ${order.id}</b>\n` +
    `Price: <b>$${c.priceUsdt} USDT</b> (on TON)\n` +
    `Expires in ${c.orderTtlMin} minutes.\n\n` +
    `<b>1. Pay with USDT on TON</b> — tap the button below (opens Keeper).\n` +
    `Amount is pre-filled: ${formatUsdt(order.amount_usdt_units)} USDT.\n\n` +
    `⚠️ <b>USDT on the TON network ONLY.</b> Do NOT send USDT on Tron (TRC-20), ` +
    `Ethereum (ERC-20) or any other network — we cannot see or recover it automatically.\n` +
    `⚠️ <b>Do NOT edit or delete the comment/memo: ${order.id}</b> — it is how we find your payment.\n\n` +
    `<b>2. No USDT? Pay in TON instead:</b> ${tonAmount} TON — ${ton.keeper}\n\n` +
    `After paying, tap “✅ I paid” below and the file is delivered here automatically.`;
  const keyboard = {
    inline_keyboard: [
      [{ text: `💳 Pay $${c.priceUsdt} USDT (Keeper)`, url: usdt.keeper }],
      [{ text: '✅ I paid — check my payment', callback_data: `check:${order.id}` }],
      [{ text: '🔁 Pay in TON instead', url: ton.keeper }],
      [{ text: '❓ Help / support', callback_data: `support:${order.id}` }],
    ],
  };
  return { text, reply_markup: keyboard };
}

async function sendOrderMessage(env, c, order) {
  const { text, reply_markup } = payMessage(c, order);
  await sendMessage(env, order.chat_id, text, { reply_markup });
}

// ------------------------------------------------------------------ verification + delivery
async function verifyOrder(env, c, order, preFetched = null) {
  // Returns { outcome, message } and MUTATES + saves the order as needed.
  // outcome: delivered | partial | not_found | ambiguous | needs_review | error | throttled
  if (order.status === 'delivered') return { outcome: 'delivered', message: 'This order is already delivered. Use /status to resend the file.' };
  if (order.status === 'refunded') return { outcome: 'needs_review', message: 'This order was refunded. Contact support if you think this is wrong.' };

  const usdt = preFetched?.usdt ?? (await fetchJettonHistory(env, c));
  if (usdt === null) {
    return { outcome: 'error', message: 'Payment check is temporarily unavailable (rate limit). Please tap “I paid” again in a minute.' };
  }
  const ton = preFetched?.ton ?? (await fetchTonTransactions(env, c));
  // D7: a `paid` order already owns its tx hashes (claimed before the
  // failed delivery). Excluding them would make a retry report "no payment
  // found" for a payment that is already this order's. So for `paid`
  // orders the own hashes stay matchable; a hash claimed by ANOTHER order
  // is still rejected by the KV claim check in the deliver branch below.
  const used = new Set(order.status === 'paid' ? [] : order.tx_hashes.map((h) => h));
  // Also exclude tx hashes already claimed by OTHER orders.
  const result = matchOrder(order, usdt, ton, used);
  order.last_checked_at = nowSec();
  pushEvent(order, 'checked', { decision: result.decision, via: result.via || null });

  if (result.decision === 'deliver') {
    // Claim every tx hash BEFORE delivering. If a hash already belongs to
    // another order, do NOT deliver — manual review instead.
    for (const t of result.txs) {
      if (!t.txHash) continue;
      const owner = await env.ORDERS_KV.get(txKey(t.kind, t.txHash));
      if (owner && owner !== order.id) {
        order.status = 'needs_review';
        pushEvent(order, 'needs_review', { reason: 'tx_claimed_by_other_order', tx: t.txHash, owner });
        await putOrder(env, order);
        await notifySeller(env, c, `⚠️ Order ${order.id}: payment tx ${t.txHash} is already claimed by ${owner}. Manual review needed.`);
        return { outcome: 'needs_review', message: 'Your payment matches another order — the seller will check it manually. Please contact support with your order id.' };
      }
    }
    // D7: a `paid` order was already verified once before expiry — its
    // payment is not "late" just because the delivery retry happens later.
    const isLate = order.status !== 'paid' && nowSec() > order.expires_at;
    if (isLate) {
      // Paid after expiry: money arrived, but do not auto-deliver blindly.
      order.status = 'needs_review';
      order.paid_usdt_units = result.totalUnits ?? order.paid_usdt_units;
      pushEvent(order, 'needs_review', { reason: 'paid_after_expiry', via: result.via });
      await putOrder(env, order);
      await notifySeller(env, c, `⏰ Order ${order.id}: paid AFTER expiry (${result.via}). Check and /deliver manually if valid.`);
      return { outcome: 'needs_review', message: 'Your payment arrived after the order expired. The seller will verify and deliver it manually — usually within a few hours.' };
    }
    for (const t of result.txs) {
      if (t.txHash) await env.ORDERS_KV.put(txKey(t.kind, t.txHash), order.id, { expirationTtl: TX_TTL_SECONDS });
    }
    order.tx_hashes = [...new Set([...order.tx_hashes, ...result.txs.map((t) => `${t.kind}:${t.txHash}`)])];
    order.paid_usdt_units = result.totalUnits ?? order.paid_usdt_units;
    order.paid_ton_nano = result.totalNano ?? order.paid_ton_nano;
    order.matched_by = result.via;
    order.sender_address = result.txs[0]?.sender ?? null;
    if (result.tier2) pushEvent(order, 'tier2_match', { note: 'no memo; unique amount+time candidate' });
    await deliverFile(env, c, order);
    return { outcome: 'delivered', message: 'delivered' };
  }

  if (result.decision === 'partial') {
    order.paid_usdt_units = result.totalUnits;
    order.paid_ton_nano = result.totalNano;
    await putOrder(env, order);
    const remaining = formatUsdt(result.remainingUnits);
    return {
      outcome: 'partial',
      message: `We found a payment of $${formatUsdt(result.totalUnits)} USDT for order ${order.id}, but the price is $${c.priceUsdt}. ` +
        `Please send the remaining $${remaining} USDT with the SAME comment ${order.id}, then tap “I paid” again. ` +
        `If you already sent the rest, wait 2 minutes and check again.`,
    };
  }

  if (result.decision === 'ambiguous') {
    order.status = 'needs_review';
    pushEvent(order, 'needs_review', { reason: 'ambiguous_amount_time', candidates: result.candidates.length });
    await putOrder(env, order);
    await notifySeller(env, c, `⚠️ Order ${order.id}: ${result.candidates.length} identical-amount payments found, cannot tell which is yours. Manual review needed.`);
    return {
      outcome: 'ambiguous',
      message: `We found several payments of exactly $${c.priceUsdt} at the same time and cannot tell which one is yours. ` +
        `The seller will check manually — please send your transaction hash (from Keeper → transaction details) via /support.`,
    };
  }

  // not_found — use hints to give a useful answer instead of a bare "no".
  await putOrder(env, order);
  if (result.hint?.sameCommentWrongAmount) {
    order.status = 'needs_review';
    pushEvent(order, 'needs_review', { reason: 'memo_seen_wrong_amount' });
    await putOrder(env, order);
    await notifySeller(env, c, `⚠️ Order ${order.id}: a payment WITH the memo arrived but for the wrong amount. Manual review needed.`);
    return {
      outcome: 'needs_review',
      message: `We see a payment with your memo ${order.id}, but the amount does not match $${c.priceUsdt}. ` +
        `The seller will check it manually — please also send your transaction hash via /support.`,
    };
  }
  return {
    outcome: 'not_found',
    message: `No payment found yet for order ${order.id}.\n\n` +
      `• Did you send <b>USDT on the TON network</b> (not Tron/Ethereum)?\n` +
      `• Did you keep the comment/memo <b>${order.id}</b>?\n` +
      `• Did you send exactly <b>$${c.priceUsdt} USDT</b>?\n\n` +
      `TON confirmations take 1–2 minutes. If you just paid, wait a bit and tap “I paid” again. ` +
      `If you paid more than 10 minutes ago, use /support with your transaction hash.`,
  };
}

async function deliverFile(env, c, order) {
  if (order.status === 'delivered') return; // idempotency guard
  // D7/D11: re-read from KV — a concurrent retry or cron sweep may have
  // delivered already while this invocation held a stale copy.
  const fresh = await getOrder(env, order.id);
  if (fresh && fresh.status === 'delivered') return;
  order.status = 'delivered';
  order.delivered_at = nowSec();
  pushEvent(order, 'delivered', { via: order.matched_by });
  await putOrder(env, order);
  if (!order.chat_id) {
    log('delivered_no_chat', { order: order.id });
    return;
  }
  const res = await tg(env, 'sendDocument', {
    chat_id: order.chat_id,
    document: c.fileId,
    caption: `✅ Payment confirmed — order ${order.id}\n\nHere is your 2027 Year Reset Planner Pack. Thank you! 🙏\n\nLost the file? Use /status ${order.id} to resend it (up to 3 times).\nQuestions? /support`,
  });
  if (!res.ok) {
    // Payment is confirmed and recorded; only the send failed (e.g. stale file_id).
    order.status = 'paid';
    pushEvent(order, 'delivery_failed', { description: res.description || 'unknown' });
    await putOrder(env, order);
    log('delivery_failed', { order: order.id, description: res.description || 'unknown' });
    await sendMessage(env, order.chat_id,
      `✅ Payment confirmed for order ${order.id}, but sending the file failed. The seller has been notified and will fix it shortly. ` +
      `Your payment is safe and recorded — nothing to re-pay.`);
    await notifySeller(env, c, `🚨 Order ${order.id}: payment confirmed but sendDocument FAILED (${res.description || 'unknown'}). ` +
      `Check PRODUCT_FILE_ID — the file may need re-uploading. Buyer was told to wait.`);
  } else {
    log('order_delivered', { order: order.id, via: order.matched_by, tier2: !!order.matched_by?.includes('unique') });
  }
}

async function notifySeller(env, c, text) {
  if (!c.sellerTgId) { log('seller_notify_skipped', { reason: 'no SELLER_TELEGRAM_ID' }); return; }
  await sendMessage(env, Number(c.sellerTgId), text);
}

// ------------------------------------------------------------------ bot commands
const isSeller = (c, chatId) => !!c.sellerTgId && String(chatId) === String(c.sellerTgId);

async function findOpenOrderForChat(env, chatId) {
  const list = await env.ORDERS_KV.list({ prefix: 'order:' });
  let latest = null;
  for (const k of list.keys) {
    const o = await env.ORDERS_KV.get(k.name, 'json');
    if (o && o.chat_id === chatId && (o.status === 'awaiting_payment' || o.status === 'paid')) {
      if (!latest || o.created_at > latest.created_at) latest = o;
    }
  }
  return latest;
}

async function handleMessage(env, c, msg) {
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId) return;

  // Seller uploads the product file to the bot once -> bot replies with file_id.
  if (msg.document && isSeller(c, chatId)) {
    await sendMessage(env, chatId,
      `📄 File received.\n\nFile ID (set as PRODUCT_FILE_ID secret):\n<code>${msg.document.file_id}</code>\n\n` +
      `Run:\n<code>wrangler secret put PRODUCT_FILE_ID</code>\nand paste this value. ` +
      `Keep this message — the file_id is the only copy of the delivery file.`);
    return;
  }

  if (!text.startsWith('/')) {
    await sendMessage(env, chatId, `Hi! Use /buy to order the 2027 Year Reset Planner Pack ($${c.priceUsdt} USDT on TON), /status to check an order, or /support for help.`);
    return;
  }
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0];
  const arg = args.join(' ').trim();

  if (cmd === '/start') {
    const payload = (msg.text.split(' ')[1] || '').trim();
    if (payload === 'buy' || payload.startsWith('buy')) {
      const order = await createOrder(env, c, { chatId, username: msg.from?.username || null, source: 'bot' });
      await sendOrderMessage(env, c, order);
      return;
    }
    if (payload.startsWith('claim_')) {
      const order = await getOrder(env, payload.slice(6).toUpperCase());
      if (!order) { await sendMessage(env, chatId, 'Order not found. Check the order id and try again.'); return; }
      order.chat_id = chatId;
      order.username = msg.from?.username || null;
      pushEvent(order, 'claimed', {});
      await putOrder(env, order);
      await sendMessage(env, chatId, `✅ Order ${order.id} is now linked to this chat. Tap “I paid” after paying, or use /status ${order.id}.`);
      if (order.status === 'awaiting_payment') await sendOrderMessage(env, c, order);
      return;
    }
    await sendMessage(env, chatId,
      `👋 Welcome!\n\nThis bot sells the 2027 Year Reset Planner Pack (PDF) for <b>$${c.priceUsdt} USDT on TON</b>.\n\n` +
      `• /buy — create an order and get the payment link\n` +
      `• /status &lt;order id&gt; — check an order / resend the file\n` +
      `• /support — help with a payment\n\nPayment happens with USDT on the TON network (Keeper / Tonkeeper). No card, no account needed.`);
    return;
  }

  if (cmd === '/buy') {
    const order = await createOrder(env, c, { chatId, username: msg.from?.username || null, source: 'bot' });
    await sendOrderMessage(env, c, order);
    return;
  }

  if (cmd === '/claim') {
    const order = await getOrder(env, arg.toUpperCase());
    if (!order) { await sendMessage(env, chatId, 'Order not found. Format: /claim YR-XXXXXX'); return; }
    order.chat_id = chatId;
    order.username = msg.from?.username || null;
    pushEvent(order, 'claimed', {});
    await putOrder(env, order);
    await sendMessage(env, chatId, `✅ Order ${order.id} linked to this chat.`);
    if (order.status === 'awaiting_payment') await sendOrderMessage(env, c, order);
    return;
  }

  if (cmd === '/status') {
    const id = (arg || '').toUpperCase();
    const order = id ? await getOrder(env, id) : await findOpenOrderForChat(env, chatId);
    if (!order) { await sendMessage(env, chatId, 'No order found. Use /buy to create one, or /status YR-XXXXXX.'); return; }
    const lines = [
      `🧾 <b>Order ${order.id}</b>`,
      `Status: <b>${order.status}</b>`,
      `Price: $${order.price_usdt} USDT`,
      `Paid so far: $${formatUsdt(order.paid_usdt_units)} USDT`,
      `Created: ${new Date(order.created_at * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`,
      order.status === 'awaiting_payment' ? `Expires: ${new Date(order.expires_at * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC` : '',
    ].filter(Boolean).join('\n');
    const extra = {};
    if (order.status === 'delivered' && order.resends < 3) {
      extra.reply_markup = { inline_keyboard: [[{ text: '📄 Resend the file', callback_data: `resend:${order.id}` }]] };
    }
    if (order.status === 'awaiting_payment') {
      extra.reply_markup = { inline_keyboard: [[{ text: '✅ I paid — check my payment', callback_data: `check:${order.id}` }]] };
    }
    if (order.status === 'paid') {
      // D7: payment confirmed but the file never arrived — offer recovery,
      // not a dead end. The `check:` callback re-runs verification, which
      // re-matches this order's own tx hashes and retries delivery.
      extra.reply_markup = { inline_keyboard: [[{ text: '🔁 Retry delivery — I paid, no file yet', callback_data: `check:${order.id}` }]] };
    }
    await sendMessage(env, chatId, lines, extra);
    return;
  }

  if (cmd === '/support') {
    const hint = arg ? `\n\nYour message: ${arg}` : '';
    await sendMessage(env, chatId,
      `🆘 <b>Support</b>\n\n` +
      `If a payment went wrong, send:\n` +
      `1. Your order id (e.g. YR-XXXXXX)\n` +
      `2. What happened (wrong amount / no memo / sent on Tron or Ethereum / paid but no file)\n` +
      `3. The transaction hash from your wallet (Keeper → transaction → details)${hint}\n\n` +
      `Common cases:\n` +
      `• <b>Sent USDT on Tron/Ethereum:</b> we cannot see it on TON. Send the tx hash here — the seller checks it manually and either delivers or refunds.\n` +
      `• <b>Forgot the memo:</b> send the tx hash here; the seller matches it by amount + time.\n` +
      `• <b>Wrong amount:</b> top up the difference with the same memo, then tap “I paid”.${supportLine(c)}`);
    if (c.sellerTgId && arg) await notifySeller(env, c, `🆘 Support from @${msg.from?.username || chatId} (order?): ${arg}`);
    return;
  }

  if (cmd === '/tx') {
    const hash = arg.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      await sendMessage(env, chatId, 'Send a full transaction hash (64 hex characters) from Keeper: /tx &lt;hash&gt;');
      return;
    }
    const order = await findOpenOrderForChat(env, chatId);
    if (!order) { await sendMessage(env, chatId, 'No open order in this chat. Create one with /buy first, then send /tx &lt;hash&gt;.'); return; }
    try {
      await throttleTonApi(env, c);
      const res = await fetch(`https://tonapi.io/v2/events/${hash}`, {
        headers: c.tonapiKey ? { Authorization: `Bearer ${c.tonapiKey}` } : {},
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) { await sendMessage(env, chatId, 'Could not look up that transaction yet — it may be too fresh, or the hash may be wrong. Try again in a minute.'); return; }
      const ev = await res.json();
      const usdt = parseTonApiJettonHistory({ events: [ev] }, { seller: c.seller });
      const result = matchOrder(order, usdt, [], new Set(order.tx_hashes.map((h) => h)));
      if (result.decision === 'deliver') {
        await verifyOrder(env, c, order); // re-run the full check so claiming + delivery go through one path
        await sendMessage(env, chatId, 'That transaction matches your order — checking and delivering now…');
      } else {
        await sendMessage(env, chatId, `That transaction does not match order ${order.id} (decision: ${result.decision}). ` +
          `Check the hash, the amount ($${c.priceUsdt} USDT) and the memo, or use /support.`);
      }
    } catch (e) {
      log('tx_lookup_failed', { order: order.id, error: String(e).slice(0, 200) });
      await sendMessage(env, chatId, 'Lookup failed — please try again in a minute.');
    }
    return;
  }

  // ---- seller-only commands --------------------------------------------
  if (cmd === '/orders' || cmd === '/refund' || cmd === '/deliver') {
    if (!isSeller(c, chatId)) { await sendMessage(env, chatId, 'This command is for the seller only.'); return; }
  }
  if (cmd === '/orders') {
    const list = await env.ORDERS_KV.list({ prefix: 'order:' });
    const rows = [];
    for (const k of list.keys.slice(0, 100)) {
      const o = await env.ORDERS_KV.get(k.name, 'json');
      if (o && o.status !== 'delivered') rows.push(o);
    }
    // Paid-but-undelivered first: that is the manual-recovery queue (D7).
    const rank = { paid: 0, needs_review: 1, awaiting_payment: 2, expired: 3 };
    rows.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.created_at - a.created_at);
    const lines = rows.map((o) => `${o.id} — ${o.status} — $${o.price_usdt} — @${o.username || '?'} — ${new Date(o.created_at * 1000).toISOString().slice(0, 16)}`);
    await sendMessage(env, chatId, lines.length ? `📋 Open orders (paid-but-undelivered first):\n${lines.slice(0, 20).join('\n')}` : 'No open orders. 🎉');
    return;
  }
  if (cmd === '/deliver') {
    const order = await getOrder(env, arg.toUpperCase());
    if (!order) { await sendMessage(env, chatId, 'Order not found. Format: /deliver YR-XXXXXX'); return; }
    if (order.status === 'delivered') { await sendMessage(env, chatId, `${order.id} is already delivered.`); return; }
    order.matched_by = 'manual-seller';
    pushEvent(order, 'manual_deliver', {});
    await deliverFile(env, c, order);
    await sendMessage(env, chatId, `✅ ${order.id} delivered manually to @${order.username || order.chat_id || '?'}.`);
    return;
  }
  if (cmd === '/refund') {
    const order = await getOrder(env, arg.toUpperCase());
    if (!order) { await sendMessage(env, chatId, 'Order not found. Format: /refund YR-XXXXXX'); return; }
    if (order.status !== 'paid' && order.status !== 'delivered' && order.status !== 'needs_review') {
      await sendMessage(env, chatId, `${order.id} is ${order.status} — nothing to refund.`);
      return;
    }
    const amount = order.paid_usdt_units !== '0' ? formatUsdt(order.paid_usdt_units) : order.price_usdt;
    const buyerAddr = order.sender_address || '(unknown — ask the buyer for their wallet address)';
    order.status = 'refunded';
    pushEvent(order, 'refunded', { amount_usdt: amount });
    await putOrder(env, order);
    await sendMessage(env, chatId,
      `💸 <b>Refund for ${order.id} — MANUAL STEP (the bot cannot move money):</b>\n\n` +
      `1. Open Keeper and send <b>${amount} USDT (TON network)</b> to:\n<code>${buyerAddr}</code>\n` +
      `2. Keep the tx hash as your receipt.\n` +
      `3. The buyer has been notified below.\n\n` +
      `If the buyer address is unknown, ask them for their TON wallet address first — do NOT guess.`);
    if (order.chat_id) {
      await sendMessage(env, order.chat_id,
        `💸 Your order ${order.id} was refunded (${amount} USDT on TON). ` +
        `The refund was sent manually by the seller — please allow a few minutes for it to arrive, then check your wallet.`);
    }
    log('order_refunded', { order: order.id, amount });
    return;
  }

  await sendMessage(env, chatId, 'Unknown command. Try /buy, /status, /support — or /start for the menu.');
}

async function handleCallback(env, c, cb) {
  const chatId = cb.message?.chat?.id;
  const [action, orderId] = (cb.data || '').split(':');
  if (!chatId || !orderId) return;
  const order = await getOrder(env, orderId.toUpperCase());
  if (!order) { await answerCallback(env, cb.id, 'Order not found.'); return; }

  if (action === 'check') {
    if (Date.now() - (order.last_checked_at || 0) * 1000 < CHECK_THROTTLE_MS) {
      await answerCallback(env, cb.id, 'Checked a moment ago — wait a few seconds and try again.');
      return;
    }
    await answerCallback(env, cb.id, 'Checking the blockchain…');
    const result = await verifyOrder(env, c, order);
    if (result.outcome === 'delivered') {
      await sendMessage(env, chatId, '✅ Payment confirmed! Your file is on its way. 🎉');
    } else {
      await sendMessage(env, chatId, result.message + supportLine(c));
    }
    return;
  }
  if (action === 'resend') {
    if (order.status !== 'delivered') { await answerCallback(env, cb.id, 'This order is not delivered yet.'); return; }
    if (order.resends >= 3) { await answerCallback(env, cb.id, 'Resend limit reached (3). Contact support.'); return; }
    order.resends += 1;
    pushEvent(order, 'resent', { n: order.resends });
    await putOrder(env, order);
    const res = await tg(env, 'sendDocument', {
      chat_id: chatId, document: c.fileId,
      caption: `📄 Your 2027 Year Reset Planner Pack (order ${order.id}, resend ${order.resends}/3)`,
    });
    await answerCallback(env, cb.id, res.ok ? 'File resent. 📄' : 'Resend failed — contact support.');
    return;
  }
  if (action === 'support') {
    await answerCallback(env, cb.id, 'Opening support…');
    await sendMessage(env, chatId,
      `🆘 <b>Support for order ${order.id}</b>\n\n` +
      `Reply here with what happened + your transaction hash from Keeper if you have it.\n\n` +
      `Common cases: wrong amount (top up the difference with the same memo), ` +
      `forgot the memo (send the tx hash), sent USDT on Tron/Ethereum (send the tx hash — manual check).${supportLine(c)}`);
  }
}

// ------------------------------------------------------------------ landing-page API
// POST /api/order  { "source": "landing" } -> { order_id, price_usdt, links, bot_url, expires_at }
//   Creates an order WITHOUT a chat. The landing page shows the payment links,
//   then asks the buyer to open the bot (t.me/<bot>?start=claim_<id>) so the
//   file can be delivered in chat after payment.
// GET  /api/order?id=YR-XXXXXX -> public status (no chat id, no tx hashes).
async function handleApiOrder(env, c, req) {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const order = await getOrder(env, (url.searchParams.get('id') || '').toUpperCase());
    if (!order) return jsonResponse({ ok: false, error: 'order_not_found' }, 404);
    return jsonResponse({
      ok: true,
      order_id: order.id,
      status: order.status,
      price_usdt: order.price_usdt,
      paid_usdt: formatUsdt(order.paid_usdt_units),
      expires_at: order.expires_at,
    });
  }
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const counterKey = `ip:${ip}:${day}`;
  const count = Number((await env.ORDERS_KV.get(counterKey)) || 0);
  if (count >= IP_ORDER_LIMIT_PER_DAY) {
    return jsonResponse({ ok: false, error: 'too_many_orders' }, 429);
  }
  await env.ORDERS_KV.put(counterKey, String(count + 1), { expirationTtl: 86400 });
  const order = await createOrder(env, c, { source: 'landing', ip });
  const usdt = usdtPayLinks(c.seller, order.id, order.amount_usdt_units);
  const ton = tonPayLinks(c.seller, order.id, order.amount_ton_nano);
  return jsonResponse({
    ok: true,
    order_id: order.id,
    price_usdt: order.price_usdt,
    amount_usdt_units: order.amount_usdt_units,
    amount_ton_nano: order.amount_ton_nano,
    pay_usdt_keeper: usdt.keeper,
    pay_usdt_ton: usdt.ton,
    pay_ton_keeper: ton.keeper,
    bot_url: c.botUsername ? `https://t.me/${c.botUsername}?start=claim_${order.id}` : null,
    expires_at: order.expires_at,
    memo: order.id,
    warning: 'Send USDT on the TON network ONLY, with the memo exactly as shown. Do not edit the memo.',
  });
}

// ------------------------------------------------------------------ cron sweep
// Every 2 minutes: ONE TonAPI call + ONE TON Center call, matched locally
// against ALL pending orders. Never one API call per order.
// Pending = `awaiting_payment` + `paid`: a `paid` order is a payment whose
// delivery failed (e.g. stale file_id) — the sweep retries it (D7).
async function handleCron(env, c) {
  const list = await env.ORDERS_KV.list({ prefix: 'order:' });
  const pending = [];
  for (const k of list.keys) {
    const o = await env.ORDERS_KV.get(k.name, 'json');
    if (o && (o.status === 'awaiting_payment' || o.status === 'paid')) pending.push(o);
  }
  if (!pending.length) { log('cron_sweep', { pending: 0 }); return; }
  const usdt = await fetchJettonHistory(env, c);
  const ton = usdt === null ? [] : await fetchTonTransactions(env, c);
  let delivered = 0, reviewed = 0, expired = 0;
  for (const order of pending) {
    if (usdt === null) break; // rate-limited: try again next sweep, do not expire anything
    const result = await verifyOrder(env, c, order, { usdt, ton });
    if (result.outcome === 'delivered') delivered++;
    else if (result.outcome === 'needs_review' || result.outcome === 'ambiguous') reviewed++;
    if (order.status === 'awaiting_payment' && nowSec() > order.expires_at) {
      order.status = 'expired';
      pushEvent(order, 'expired', {});
      await putOrder(env, order);
      expired++;
    }
  }
  log('cron_sweep', { pending: pending.length, delivered, reviewed, expired });
}

// ------------------------------------------------------------------ entry points
export default {
  async fetch(req, env) {
    try {
      const c = cfg(env);
      const url = new URL(req.url);
      if (url.pathname === '/api/order') return handleApiOrder(env, c, req);
      if (url.pathname === '/webhook' && req.method === 'POST') {
        if (c.webhookSecret) {
          const got = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
          if (got !== c.webhookSecret) return jsonResponse({ ok: false }, 403);
        }
        const update = await req.json().catch(() => null);
        if (!update) return jsonResponse({ ok: false, error: 'bad_update' }, 400);
        if (update.message) await handleMessage(env, c, update.message);
        else if (update.callback_query) await handleCallback(env, c, update.callback_query);
        return jsonResponse({ ok: true });
      }
      if (url.pathname === '/' || url.pathname === '/health') {
        return jsonResponse({ ok: true, service: 'year-reset-bot', price_usdt: c.priceUsdt });
      }
      return jsonResponse({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      log('fetch_error', { error: String(e).slice(0, 300) });
      return jsonResponse({ ok: false, error: 'internal' }, 500);
    }
  },

  async scheduled(_event, env) {
    try {
      const c = cfg(env);
      await handleCron(env, c);
    } catch (e) {
      log('cron_error', { error: String(e).slice(0, 300) });
    }
  },
};
