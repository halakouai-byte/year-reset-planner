// Tests for src/ton.js — pure logic, no network, no secrets.
// Fixtures are MODELED ON the real TonAPI / TON Center responses captured in
// test/live-probe-output.json on 2026-11-20 (same envelope, same field names,
// same raw "0:<hex>" address form), with a successful commented transfer
// added per TonAPI's documented JettonTransfer.comment field.
// Run: node --test test/verify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USDT_MASTER,
  parseUsdtToUnits,
  formatUsdt,
  tonNanoForUsd,
  normalizeTonAddress,
  sameAddress,
  newOrderId,
  usdtPayLinks,
  tonPayLinks,
  parseTonApiJettonHistory,
  parseTonCenterTransactions,
  parseTonRate,
  matchOrder,
} from '../src/ton.js';

const SELLER_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'; // == USDT master addr (probe)
const SELLER_UF = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'; // user-friendly form of the same account
const BUYER_RAW = '0:5b1fa2e71938a32c0478101f8cd18fac600a475c0a9142f7911da8049ef6f940';
const NOW = Math.floor(Date.now() / 1000);
const ORDER = { id: 'YR-7K2Q9X', amount_usdt_units: '3000000', amount_ton_nano: '2970297030', created_at: NOW - 300 };

function tonApiHistoryFixture() {
  // Envelope exactly as observed in live-probe-output.json.
  return {
    events: [
      { // 1. the happy path: successful, commented, exact amount, to seller
        event_id: 'ev-ok-1',
        timestamp: NOW - 60,
        actions: [{
          type: 'JettonTransfer', status: 'success',
          JettonTransfer: {
            sender: { address: BUYER_RAW, is_wallet: true },
            recipient: { address: SELLER_RAW, is_wallet: false },
            amount: '3000000', comment: 'YR-7K2Q9X',
            jetton: { address: USDT_MASTER, symbol: 'USD₮', decimals: 6 },
          },
          base_transactions: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
        }],
      },
      { // 2. failed transfer (as in the probe: sends to the master) — must be ignored
        event_id: 'ev-failed-1',
        timestamp: NOW - 50,
        actions: [{
          type: 'JettonTransfer', status: 'failed',
          JettonTransfer: {
            sender: { address: BUYER_RAW, is_wallet: true },
            recipient: { address: SELLER_RAW },
            amount: '3000000', comment: 'YR-7K2Q9X',
            jetton: { address: USDT_MASTER, symbol: 'USD₮', decimals: 6 },
          },
          base_transactions: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'],
        }],
      },
      { // 3. wrong jetton (fake USDT) — must be ignored
        event_id: 'ev-scam-1',
        timestamp: NOW - 40,
        actions: [{
          type: 'JettonTransfer', status: 'success',
          JettonTransfer: {
            sender: { address: BUYER_RAW, is_wallet: true },
            recipient: { address: SELLER_RAW },
            amount: '3000000', comment: 'YR-7K2Q9X',
            jetton: { address: '0:0000000000000000000000000000000000000000000000000000000000000001', symbol: 'USDT', decimals: 6 },
          },
          base_transactions: ['cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'],
        }],
      },
      { // 4. exact amount, NO comment — Tier-2 candidate
        event_id: 'ev-nocomment-1',
        timestamp: NOW - 30,
        actions: [{
          type: 'JettonTransfer', status: 'success',
          JettonTransfer: {
            sender: { address: BUYER_RAW, is_wallet: true },
            recipient: { address: SELLER_RAW },
            amount: '3000000',
            jetton: { address: USDT_MASTER, symbol: 'USD₮', decimals: 6 },
          },
          base_transactions: ['dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'],
        }],
      },
    ],
  };
}

function tonCenterFixture() {
  return {
    ok: true,
    result: [
      { // native TON, plain-text comment, exact amount
        utime: NOW - 60,
        transaction_id: { lt: '1', hash: 'tonhashbase64==' },
        in_msg: {
          source: 'EQBuyerAddressXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          destination: SELLER_UF,
          value: '2970297030',
          msg_data: { '@type': 'msg.dataText', text: 'YR-7K2Q9X' },
        },
      },
      { // jetton notification (dataRaw) — must be skipped, no readable comment
        utime: NOW - 55,
        transaction_id: { lt: '2', hash: 'rawhashbase64==' },
        in_msg: {
          source: 'EQSomeJettonWalletXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          destination: SELLER_UF,
          value: '12591002',
          msg_data: { '@type': 'msg.dataRaw', body: 'te6cckEBAQEAMAAA...' },
        },
      },
    ],
  };
}

// --- money math ------------------------------------------------------------
test('parseUsdtToUnits: 3.00 -> 3000000, 2.50 -> 2500000, rejects bad input', () => {
  assert.equal(parseUsdtToUnits('3.00'), '3000000');
  assert.equal(parseUsdtToUnits('3'), '3000000');
  assert.equal(parseUsdtToUnits('2.5'), '2500000');
  assert.equal(formatUsdt('3000000'), '3.00');
  assert.throws(() => parseUsdtToUnits('2.5555555')); // 7 decimals
  assert.throws(() => parseUsdtToUnits('abc'));
  assert.throws(() => parseUsdtToUnits(''));
});

test('tonNanoForUsd: $3.00 at $1.01/TON rounds UP', () => {
  // 3.00 / 1.01 * 1e9 = 2970297029.70... -> ceil 2970297030
  assert.equal(tonNanoForUsd('3.00', 1.01), '2970297030');
  assert.throws(() => tonNanoForUsd('2.50', 0));
});

// --- addresses -------------------------------------------------------------
test('normalizeTonAddress: raw hex == user-friendly form (real pair from probe)', () => {
  assert.equal(normalizeTonAddress(SELLER_UF), SELLER_RAW);
  assert.equal(normalizeTonAddress(SELLER_RAW), SELLER_RAW);
  assert.equal(normalizeTonAddress('garbage'), null);
  assert.equal(normalizeTonAddress(''), null);
});

test('sameAddress survives formatting differences', () => {
  assert.equal(sameAddress(SELLER_UF, SELLER_RAW), true);
  assert.equal(sameAddress(SELLER_RAW, BUYER_RAW), false);
});

test('newOrderId: YR- + 6 chars from the unambiguous alphabet', () => {
  const id = newOrderId(new Uint8Array([0, 1, 2, 3, 4, 5]));
  assert.match(id, /^YR-[A-Z0-9]{6}$/);
  assert.equal(/[01IL O]/.test(id), false);
});

// --- payment links ---------------------------------------------------------
test('USDT pay links carry jetton master, elementary amount and memo', () => {
  const links = usdtPayLinks(SELLER_UF, 'YR-7K2Q9X', '3000000');
  assert.ok(links.keeper.startsWith('https://app.tonkeeper.com/transfer/'));
  assert.ok(links.keeper.includes(`jetton=${USDT_MASTER}`));
  assert.ok(links.keeper.includes('amount=3000000'));
  assert.ok(links.keeper.includes('text=YR-7K2Q9X'));
  assert.ok(links.ton.startsWith('ton://transfer/'));
});

test('TON fallback link carries nanotons and memo, no jetton param', () => {
  const links = tonPayLinks(SELLER_UF, 'YR-7K2Q9X', '2970297030');
  assert.ok(links.keeper.includes('amount=2970297030'));
  assert.ok(!links.keeper.includes('jetton='));
});

// --- parsers ---------------------------------------------------------------
test('parseTonApiJettonHistory: keeps the good one, drops failed/fake-jetton', () => {
  const txs = parseTonApiJettonHistory(tonApiHistoryFixture(), { seller: SELLER_UF });
  assert.equal(txs.length, 2); // #1 commented + #4 no-comment; #2 failed, #3 fake jetton
  assert.equal(txs[0].amountUnits, '3000000');
  assert.equal(txs[0].comment, 'YR-7K2Q9X');
  assert.equal(txs[0].txHash, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(txs[1].comment, null);
  assert.equal(txs[0].sender, BUYER_RAW);
});

test('parseTonCenterTransactions: dataText parsed, dataRaw skipped', () => {
  const txs = parseTonCenterTransactions(tonCenterFixture(), { seller: SELLER_RAW });
  assert.equal(txs.length, 1);
  assert.equal(txs[0].kind, 'ton');
  assert.equal(txs[0].comment, 'YR-7K2Q9X');
  assert.equal(txs[0].amountNano, '2970297030');
});

test('parseTonRate reads the live shape', () => {
  assert.equal(parseTonRate({ rates: { TON: { prices: { USD: 1.01007073492387 } } } }), 1.01007073492387);
  assert.equal(parseTonRate({}), null);
});

// --- matcher ---------------------------------------------------------------
test('matchOrder Tier 1: exact USDT memo delivers', () => {
  const usdt = parseTonApiJettonHistory(tonApiHistoryFixture(), { seller: SELLER_UF });
  const r = matchOrder(ORDER, usdt, [], new Set());
  assert.equal(r.decision, 'deliver');
  assert.equal(r.via, 'usdt-comment');
  assert.equal(r.totalUnits, '3000000');
});

test('matchOrder: already-used tx hash is never credited twice', () => {
  const usdt = parseTonApiJettonHistory(tonApiHistoryFixture(), { seller: SELLER_UF });
  const used = new Set(['usdt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  const r = matchOrder(ORDER, usdt, [], used);
  // Tier 1 is now empty; Tier 2 sees the no-comment exact-amount transfer -> still delivers,
  // but via Tier 2 and with the OTHER tx hash. That is correct: a different payment.
  assert.equal(r.decision, 'deliver');
  assert.equal(r.via, 'usdt-amount-time-unique');
  assert.equal(r.txs[0].txHash, 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
});

test('matchOrder: double-delivery blocked when the SAME tx is the only candidate', () => {
  const usdt = parseTonApiJettonHistory(tonApiHistoryFixture(), { seller: SELLER_UF })
    .filter((t) => t.comment === 'YR-7K2Q9X'); // only the commented one
  const used = new Set(['usdt:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
  const r = matchOrder(ORDER, usdt, [], used);
  assert.equal(r.decision, 'not_found');
});

test('matchOrder: underpayment is partial, with the remaining amount', () => {
  const usdt = [{
    kind: 'usdt', txHash: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    sender: BUYER_RAW, amountUnits: '1000000', comment: 'YR-7K2Q9X', timestamp: NOW - 60, status: 'success',
  }];
  const r = matchOrder(ORDER, usdt, [], new Set());
  assert.equal(r.decision, 'partial');
  assert.equal(r.totalUnits, '1000000');
  assert.equal(r.remainingUnits, '2000000');
});

test('matchOrder: two underpayments with the same memo sum to delivery (top-up)', () => {
  const usdt = [1000000, 2000000].map((amt, i) => ({
    kind: 'usdt', txHash: `topup${i}`.padEnd(64, '0'),
    sender: BUYER_RAW, amountUnits: String(amt), comment: 'YR-7K2Q9X', timestamp: NOW - 60 + i, status: 'success',
  }));
  const r = matchOrder(ORDER, usdt, [], new Set());
  assert.equal(r.decision, 'deliver');
  assert.equal(r.totalUnits, '3000000');
});

test('matchOrder Tier 2: unique exact-amount no-comment payment delivers', () => {
  const usdt = parseTonApiJettonHistory(tonApiHistoryFixture(), { seller: SELLER_UF })
    .filter((t) => t.comment === null);
  const r = matchOrder(ORDER, usdt, [], new Set());
  assert.equal(r.decision, 'deliver');
  assert.equal(r.via, 'usdt-amount-time-unique');
  assert.equal(r.tier2, true);
});

test('matchOrder Tier 2: two identical-amount candidates -> ambiguous, never auto-delivers', () => {
  const usdt = [0, 1].map((i) => ({
    kind: 'usdt', txHash: `ambig${i}`.padEnd(64, '0'),
    sender: BUYER_RAW, amountUnits: '3000000', comment: null, timestamp: NOW - 60 + i, status: 'success',
  }));
  const r = matchOrder(ORDER, usdt, [], new Set());
  assert.equal(r.decision, 'ambiguous');
});

test('matchOrder: native TON fallback delivers when USDT is absent', () => {
  const ton = parseTonCenterTransactions(tonCenterFixture(), { seller: SELLER_RAW });
  const r = matchOrder(ORDER, [], ton, new Set());
  assert.equal(r.decision, 'deliver');
  assert.equal(r.via, 'ton-comment');
});

test('matchOrder: nothing found -> not_found with hints', () => {
  const r = matchOrder(ORDER, [], [], new Set());
  assert.equal(r.decision, 'not_found');
  assert.equal(r.hint.sameCommentWrongAmount, false);
});

test('matchOrder: same memo but wrong amount -> not_found + hint flag', () => {
  const usdt = [{
    kind: 'usdt', txHash: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    sender: BUYER_RAW, amountUnits: '2000000', comment: 'YR-7K2Q9X', timestamp: NOW - 60, status: 'success',
  }];
  const r = matchOrder(ORDER, usdt, [], new Set());
  // 2.00 of 3.00 is a partial, not "not_found" — the matcher reports partial first.
  assert.equal(r.decision, 'partial');
  assert.equal(r.remainingUnits, '1000000');
});

test('matchOrder: overpayment delivers (seller keeps the excess)', () => {
  const usdt = [{
    kind: 'usdt', txHash: '9999999999999999999999999999999999999999999999999999999999999999',
    sender: BUYER_RAW, amountUnits: '3500000', comment: 'YR-7K2Q9X', timestamp: NOW - 60, status: 'success',
  }];
  const r = matchOrder(ORDER, usdt, [], new Set());
  assert.equal(r.decision, 'deliver');
  assert.equal(r.totalUnits, '3500000');
});
