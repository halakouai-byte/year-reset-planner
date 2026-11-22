// End-to-end DRY RUN of the real Worker code — no real money, no real network.
// A fake KV + a stubbed global fetch stand in for Cloudflare and the internet:
//  - api.telegram.org calls are recorded (never sent)
//  - tonapi.io returns a canned jetton history containing ONE successful,
//    commented, exact-amount USDT transfer to the seller
//  - toncenter.com returns an empty transaction list
//  - api.telegram.org sendDocument returns { ok: true }, unless the test
//    arms a failure with h.failNextSendDocument() (stale file_id simulation)
//
// Flow exercised: /buy -> order + payment links -> "I paid" callback ->
// on-chain verification -> tx-hash claim -> sendDocument delivery.
// Also exercised: a second "I paid" for the same order does NOT re-deliver,
// and a fresh order with the SAME tx hash does NOT get the file (anti-replay).
// D7 regression: a `paid`-but-undelivered order (delivery failed) self-heals
// via buyer retry AND via the cron sweep, with no double delivery.
// The suite runs at the real launch price $3.00 (PRODUCT_PRICE_USDT).
//
// Run: node --test test/e2e-dryrun.test.mjs
// (Do NOT use the directory form `node --test test/` — Node 24 treats it as
// a module path and fails with MODULE_NOT_FOUND.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const SELLER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'; // placeholder-shaped, NOT a real seller wallet
const BUYER = '0:5b1fa2e71938a32c0478101f8cd18fac600a475c0a9142f7911da8049ef6f940';
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const NOW = Math.floor(Date.now() / 1000);
const TXHASH = 'a'.repeat(64);

// USDT elementary units (6 decimals) for a "$X.XX" price string.
const unitsForPrice = (priceUsdt) => String(Math.round(Number(priceUsdt) * 1_000_000));

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k, type) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(k, v) { this.m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); }
  async list({ prefix }) {
    return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  }
}

function makeHarness({ tonapiEvents, priceUsdt = '3.00' } = {}) {
  const kv = new FakeKV();
  const telegramCalls = [];
  let events = tonapiEvents;
  let sendDocumentFailures = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      const body = JSON.parse(opts.body || '{}');
      const method = u.split('/').pop();
      let ok = true;
      let description = null;
      if (method === 'sendDocument' && sendDocumentFailures > 0) {
        // Simulate a stale PRODUCT_FILE_ID: Telegram rejects the send.
        sendDocumentFailures -= 1;
        ok = false;
        description = 'Bad Request: wrong file identifier';
      }
      telegramCalls.push({ method, body, ok });
      return Response.json(ok
        ? { ok: true, result: { message_id: 1 } }
        : { ok: false, error_code: 400, description });
    }
    if (u.includes('tonapi.io/v2/accounts/')) {
      return Response.json({ events });
    }
    if (u.includes('tonapi.io/v2/rates')) {
      return Response.json({ rates: { TON: { prices: { USD: 1.01 } } } });
    }
    if (u.includes('toncenter.com')) {
      return Response.json({ ok: true, result: [] });
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  const env = {
    ORDERS_KV: kv,
    BOT_TOKEN: '<BOT_TOKEN>',
    SELLER_TON_ADDRESS: SELLER,
    PRODUCT_FILE_ID: '<PRODUCT_FILE_ID>',
    PRODUCT_PRICE_USDT: priceUsdt,
    // Test key: keeps the TonAPI throttle at 1.1 s instead of 4.2 s, so the
    // suite stays fast. The throttle logic itself is still exercised.
    TONAPI_KEY: 'test-key',
    SELLER_TELEGRAM_ID: '999',
    SUPPORT_USERNAME: 'seller_support',
    BOT_USERNAME: 'yearreset_test_bot',
  };
  return {
    env, kv, telegramCalls,
    restore() { globalThis.fetch = realFetch; },
    setTonapiEvents(e) { events = e; },
    failNextSendDocument() { sendDocumentFailures += 1; },
    successfulDeliveries() { return telegramCalls.filter((c) => c.method === 'sendDocument' && c.ok).length; },
    sendDocumentAttempts() { return telegramCalls.filter((c) => c.method === 'sendDocument').length; },
    async resetCheckThrottle(orderId) {
      const order = await kv.get(`order:${orderId}`, 'json');
      order.last_checked_at = 0;
      await kv.put(`order:${orderId}`, JSON.stringify(order));
    },
    async postUpdate(update) {
      const req = new Request('https://worker.test/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(update),
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 200, await res.text().catch(() => ''));
      return res;
    },
  };
}

function paidEvent(orderId, amountUnits = '3000000') {
  return {
    event_id: 'ev-dryrun-1',
    timestamp: NOW - 30,
    actions: [{
      type: 'JettonTransfer', status: 'success',
      JettonTransfer: {
        sender: { address: BUYER, is_wallet: true },
        recipient: { address: '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe', is_wallet: false },
        amount: amountUnits, comment: orderId,
        jetton: { address: USDT_MASTER, symbol: 'USD₮', decimals: 6 },
      },
      base_transactions: [TXHASH],
    }],
  };
}

async function buyOrder(h, chatId, username) {
  await h.postUpdate({ update_id: 1, message: { message_id: 1, from: { id: chatId, username }, chat: { id: chatId }, text: '/buy' } });
  const orderMsg = h.telegramCalls.filter((c) => c.method === 'sendMessage').at(-1);
  assert.ok(orderMsg, 'bot should send the order message');
  const orderId = (orderMsg.body.text.match(/YR-[A-Z0-9]{6}/) || [])[0];
  assert.ok(orderId, 'order message must contain an order id + memo');
  return { orderId, orderMsg };
}

for (const price of ['3.00']) {
  test(`dry run ($${price}): /buy -> pay (mocked) -> I paid -> file delivered, once`, async () => {
    const h = makeHarness({ tonapiEvents: [], priceUsdt: price });
    try {
      // 1. Buyer taps /buy
      const { orderId, orderMsg } = await buyOrder(h, 111, 'buyer1');
      assert.ok(orderMsg.body.text.includes(`$${price} USDT`), 'price shown in USDT');
      assert.ok(orderMsg.body.reply_markup.inline_keyboard[0][0].url.includes('app.tonkeeper.com/transfer/'), 'Keeper pay button present');
      assert.ok(orderMsg.body.reply_markup.inline_keyboard[0][0].url.includes(`text=${orderId}`), 'memo embedded in pay link');
      assert.ok(orderMsg.body.text.includes('TON network ONLY'), 'wrong-network warning present');

      // 2. "I paid" BEFORE any payment exists -> not_found, no delivery
      await h.postUpdate({ update_id: 2, callback_query: { id: 'cb1', from: { id: 111 }, message: { chat: { id: 111 } }, data: `check:${orderId}` } });
      assert.equal(h.successfulDeliveries(), 0, 'no delivery before payment');

      // 3. The mocked chain now shows the payment; buyer taps "I paid" again.
      h.setTonapiEvents([paidEvent(orderId, unitsForPrice(price))]);
      await h.resetCheckThrottle(orderId);
      await h.postUpdate({ update_id: 3, callback_query: { id: 'cb2', from: { id: 111 }, message: { chat: { id: 111 } }, data: `check:${orderId}` } });

      assert.equal(h.successfulDeliveries(), 1, 'exactly one delivery');
      const delivery = h.telegramCalls.find((c) => c.method === 'sendDocument');
      assert.equal(delivery.body.document, '<PRODUCT_FILE_ID>', 'delivered via cached file_id');
      assert.equal(delivery.body.chat_id, 111, 'delivered to the buyer chat');
      const saved = await h.kv.get(`order:${orderId}`, 'json');
      assert.equal(saved.status, 'delivered', 'order marked delivered');
      assert.equal(saved.matched_by, 'usdt-comment', 'matched by memo');
      assert.equal(await h.kv.get(`tx:usdt:${TXHASH}`), orderId, 'tx hash claimed in KV');

      // 4. Second "I paid" -> already delivered, NO second file
      await h.postUpdate({ update_id: 4, callback_query: { id: 'cb3', from: { id: 111 }, message: { chat: { id: 111 } }, data: `check:${orderId}` } });
      assert.equal(h.successfulDeliveries(), 1, 'no double delivery');
    } finally {
      h.restore();
    }
  });
}

test('dry run: same tx hash cannot pay a second order (anti-replay)', async () => {
  const h = makeHarness({ tonapiEvents: [] });
  try {
    // Order A buys and pays (mocked chain shows its payment).
    const { orderId: orderA } = await buyOrder(h, 111, 'buyer1');
    h.setTonapiEvents([paidEvent(orderA)]);
    await h.resetCheckThrottle(orderA);
    await h.postUpdate({ update_id: 2, callback_query: { id: 'cb1', from: { id: 111 }, message: { chat: { id: 111 } }, data: `check:${orderA}` } });
    assert.equal((await h.kv.get(`order:${orderA}`, 'json')).status, 'delivered');

    // Order B (different buyer, different memo) tries to claim the SAME tx.
    // The mocked chain now shows a transfer with B's memo but the SAME hash.
    const { orderId: orderB } = await buyOrder(h, 222, 'buyer2');
    assert.notEqual(orderB, orderA);
    h.setTonapiEvents([paidEvent(orderB)]); // same TXHASH, B's memo
    await h.resetCheckThrottle(orderB);
    await h.postUpdate({ update_id: 4, callback_query: { id: 'cb2', from: { id: 222 }, message: { chat: { id: 222 } }, data: `check:${orderB}` } });

    const savedB = await h.kv.get(`order:${orderB}`, 'json');
    assert.equal(savedB.status, 'needs_review', 'replayed tx routes to manual review, not delivery');
    assert.equal(h.successfulDeliveries(), 1, 'only order A got the file');
  } finally {
    h.restore();
  }
});

for (const price of ['3.00']) {
  test(`dry run ($${price}): landing-page POST /api/order creates an order with pay links`, async () => {
    const h = makeHarness({ tonapiEvents: [], priceUsdt: price });
    try {
      const req = new Request('https://worker.test/api/order', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify({ source: 'landing' }),
      });
      const res = await worker.fetch(req, h.env);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.match(data.order_id, /^YR-[A-Z0-9]{6}$/);
      assert.equal(data.price_usdt, price);
      assert.ok(data.pay_usdt_keeper.includes('jetton='));
      assert.ok(data.pay_usdt_keeper.includes(`text=${data.order_id}`));
      assert.ok(data.bot_url.includes(`start=claim_${data.order_id}`));
    } finally {
      h.restore();
    }
  });
}

test('dry run (D7): paid-but-undelivered order self-heals on buyer retry, no double delivery', async () => {
  const h = makeHarness({ tonapiEvents: [] }); // launch price $3.00
  try {
    const { orderId } = await buyOrder(h, 111, 'buyer1');

    // Payment exists on-chain, but the first delivery fails (stale file_id).
    h.setTonapiEvents([paidEvent(orderId)]);
    h.failNextSendDocument();
    await h.resetCheckThrottle(orderId);
    await h.postUpdate({ update_id: 2, callback_query: { id: 'cb1', from: { id: 111 }, message: { chat: { id: 111 } }, data: `check:${orderId}` } });

    assert.equal(h.sendDocumentAttempts(), 1, 'delivery was attempted once');
    assert.equal(h.successfulDeliveries(), 0, 'that attempt failed');
    const paid = await h.kv.get(`order:${orderId}`, 'json');
    assert.equal(paid.status, 'paid', 'order is paid, not delivered');
    assert.deepEqual(paid.tx_hashes, [`usdt:${TXHASH}`], 'tx hash was claimed before delivery');
    // The buyer must have been told the payment is safe, not that it is lost.
    assert.ok(h.telegramCalls.some((c) => c.method === 'sendMessage' && String(c.body.text).includes('Your payment is safe')));

    // /status must offer a recovery action for a `paid` order (D7).
    await h.postUpdate({ update_id: 3, message: { message_id: 2, from: { id: 111 }, chat: { id: 111 }, text: `/status ${orderId}` } });
    const statusMsg = h.telegramCalls.filter((c) => c.method === 'sendMessage').at(-1);
    assert.ok(JSON.stringify(statusMsg.body.reply_markup).includes('Retry delivery'), '/status offers a retry-delivery button for paid orders');

    // Buyer taps "I paid" again — the order's OWN tx must match this time
    // (pre-fix it was excluded and the buyer was told "No payment found").
    await h.resetCheckThrottle(orderId);
    const callsBeforeRetry = h.telegramCalls.length;
    await h.postUpdate({ update_id: 4, callback_query: { id: 'cb2', from: { id: 111 }, message: { chat: { id: 111 } }, data: `check:${orderId}` } });
    assert.equal(h.successfulDeliveries(), 1, 'retry delivers the file');
    assert.equal(h.sendDocumentAttempts(), 2, 'exactly two send attempts total (1 failed + 1 ok)');
    const retried = await h.kv.get(`order:${orderId}`, 'json');
    assert.equal(retried.status, 'delivered', 'order marked delivered after retry');
    const retryMessages = h.telegramCalls.slice(callsBeforeRetry).filter((c) => c.method === 'sendMessage');
    assert.ok(retryMessages.some((c) => String(c.body.text).includes('Payment confirmed')), 'buyer is told the payment is confirmed');
    assert.ok(!retryMessages.some((c) => String(c.body.text).includes('No payment found yet')), 'retry must NOT claim no payment was found');

    // Third "I paid" after delivery -> no second file.
    await h.postUpdate({ update_id: 5, callback_query: { id: 'cb3', from: { id: 111 }, message: { chat: { id: 111 } }, data: `check:${orderId}` } });
    assert.equal(h.successfulDeliveries(), 1, 'no double delivery');
    assert.equal(h.sendDocumentAttempts(), 2, 'no further send attempts');
  } finally {
    h.restore();
  }
});

test('dry run (D7): cron sweep retries a paid-but-undelivered order', async () => {
  const h = makeHarness({ tonapiEvents: [] }); // launch price $3.00
  try {
    const { orderId } = await buyOrder(h, 111, 'buyer1');

    // Payment exists on-chain, first delivery fails (stale file_id).
    h.setTonapiEvents([paidEvent(orderId)]);
    h.failNextSendDocument();
    await h.resetCheckThrottle(orderId);
    await h.postUpdate({ update_id: 2, callback_query: { id: 'cb1', from: { id: 111 }, message: { chat: { id: 111 } }, data: `check:${orderId}` } });
    assert.equal((await h.kv.get(`order:${orderId}`, 'json')).status, 'paid');
    assert.equal(h.successfulDeliveries(), 0);

    // No buyer tap: the 2-minute cron sweep must pick the `paid` order up
    // (pre-fix it only swept `awaiting_payment`) and deliver it.
    await worker.scheduled({}, h.env);
    assert.equal(h.successfulDeliveries(), 1, 'cron sweep delivers the paid order');
    assert.equal((await h.kv.get(`order:${orderId}`, 'json')).status, 'delivered');

    // A second sweep must not re-deliver.
    await worker.scheduled({}, h.env);
    assert.equal(h.successfulDeliveries(), 1, 'second sweep does not re-deliver');
  } finally {
    h.restore();
  }
});
