// Оркестратор: один клик -> сделка во всех профилях Dolphin Anty.
// npm i puppeteer-core @solana/web3.js bs58
// node src/multi.js  ->  открыть http://127.0.0.1:8787
//
// accounts.config.json (в корне проекта, в .gitignore):
// {
//   "dolphinApi": "http://localhost:3001",
//   "dolphinToken": "токен из Dolphin (Settings -> API)",
//   "defaultUsd": "2000000",
//   "jitterMs": [0, 1500],
//   "accounts": [
//     { "name": "acc1", "profileId": "123456", "secret": "приватный ключ" },
//     { "name": "acc2", "profileId": "123457", "secret": "приватный ключ", "usd": "3000000" }
//   ]
// }
// Конфиг с ключами хранить только локально, не отправлять в чат и не выкладывать в git.

import fs from 'node:fs';
import http from 'node:http';
import puppeteer from 'puppeteer-core';
import { loadKeypair, signSwapTransaction } from './sign.js';

const root = new URL('../', import.meta.url);
const cfg = JSON.parse(fs.readFileSync(new URL('accounts.config.json', root), 'utf8'));
const USERSCRIPT = fs
  .readFileSync(new URL('inpage/fomo-trade.user.js', root), 'utf8')
  .replace("jsonrpc: '1.88'", "jsonrpc: '2.0'"); // известный баг в юзерскрипте
const API = cfg.dolphinApi || 'http://localhost:3001';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pages = new Map(); // name -> page
const keypairs = new Map(); // name -> Keypair

for (const a of cfg.accounts) {
  keypairs.set(a.name, loadKeypair(a.secret));
}

async function dolphinLogin() {
  if (!cfg.dolphinToken) return;
  await fetch(`${API}/v1.0/auth/login-with-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: cfg.dolphinToken }),
  });
}

async function openProfile(acc) {
  if (pages.has(acc.name)) return pages.get(acc.name);

  const r = await fetch(`${API}/v1.0/browser_profiles/${acc.profileId}/start?automation=1`);
  const j = await r.json();
  if (!j.success) throw new Error(`Dolphin не запустил профиль ${acc.profileId}: ${JSON.stringify(j)}`);

  const { port, wsEndpoint } = j.automation;
  const browser = await puppeteer.connect({
    browserWSEndpoint: `ws://127.0.0.1:${port}${wsEndpoint}`,
    defaultViewport: null,
  });

  let page = (await browser.pages()).find((p) => p.url().startsWith('https://fomo.family'));
  if (!page) {
    page = await browser.newPage();
    await page.goto('https://fomo.family/', { waitUntil: 'networkidle2' });
  }
  if (!(await page.evaluate(() => Boolean(window.fomoTrade)))) {
    await page.evaluate(USERSCRIPT);
  }
  pages.set(acc.name, page);
  return page;
}

async function tradeOne(acc, { direction, tokenId, usd }) {
  const page = await openProfile(acc);
  const kp = keypairs.get(acc.name);
  const isBuy = direction === 'buy';
  const inTokenId = isBuy ? USDC_SOL : tokenId;
  const outTokenId = isBuy ? tokenId : USDC_SOL;

  const [lo, hi] = cfg.jitterMs || [0, 0];
  await sleep(lo + Math.random() * (hi - lo));

  const t0 = Date.now();
  const amount = isBuy
    ? String(acc.usd || usd || cfg.defaultUsd || '2000000')
    : await page.evaluate((t) => window.fomoTrade.rawBalance(t), tokenId);

  const prep = await page.evaluate(
    (a, b, c) => window.fomoTrade.prepare(a, b, c, 0),
    inTokenId, outTokenId, amount,
  );
  const sw = prep.v1Swap || prep;

  // подпись в Node, ключ в страницу не уходит
  const signed = signSwapTransaction(sw.swapTransaction, kp);

  const sig = await page.evaluate((s) => window.fomoTrade.submitSigned(s), signed);

  // ждём подтверждения
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const res = await page.evaluate(
      (s) => window.fomoTrade.rpc('getSignatureStatuses', [[s], { searchTransactionHistory: true }]),
      sig,
    );
    const st = res?.value?.[0];
    if (st?.confirmationStatus) {
      if (st.err) throw new Error('транзакция упала: ' + JSON.stringify(st.err));
      return { name: acc.name, ok: true, sig, status: st.confirmationStatus, ms: Date.now() - t0 };
    }
  }
  return { name: acc.name, ok: true, sig, status: 'pending', ms: Date.now() - t0 };
}

async function tradeAll(params) {
  const results = await Promise.allSettled(cfg.accounts.map((a) => tradeOne(a, params)));
  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { name: cfg.accounts[i].name, ok: false, error: r.reason.message },
  );
}

// ---------- локальная панель ----------
const HTML = `<!doctype html><meta charset=utf-8><title>Fomo multi</title>
<body style="font-family:system-ui;max-width:640px;margin:30px auto;background:#111;color:#eee">
<h3>Fomo multi</h3>
<input id=t placeholder="mint:1399811149" style="width:100%;padding:8px;margin-bottom:8px">
<input id=u placeholder="usdc, целые единицы (2000000 = $2)" style="width:100%;padding:8px;margin-bottom:8px">
<button onclick="go('buy')" style="padding:12px 30px;background:#16a34a;color:#fff;border:0">BUY ALL</button>
<button onclick="go('sell')" style="padding:12px 30px;background:#dc2626;color:#fff;border:0">SELL ALL</button>
<pre id=o></pre>
<script>
async function go(direction){
  const tokenId=document.getElementById('t').value.trim();
  if(!tokenId.includes(':')) return alert('tokenId вида mint:1399811149');
  if(!confirm(direction.toUpperCase()+' на всех аккаунтах?')) return;
  o.textContent='...';
  const r=await fetch('/trade',{method:'POST',body:JSON.stringify({direction,tokenId,usd:u.value.trim()||undefined})});
  o.textContent=JSON.stringify(await r.json(),null,2);
}
</script>`;

http
  .createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(HTML);
    }
    if (req.method === 'POST' && req.url === '/trade') {
      let raw = '';
      for await (const c of req) raw += c;
      const out = await tradeAll(JSON.parse(raw));
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(out));
    }
    res.statusCode = 404;
    res.end();
  })
  .listen(8787, '127.0.0.1', async () => {
    await dolphinLogin();
    console.log('панель: http://127.0.0.1:8787, прогреваю профили...');
    for (const a of cfg.accounts) {
      try { await openProfile(a); console.log('готов', a.name); }
      catch (e) { console.log('ошибка', a.name, e.message); }
    }
  });
