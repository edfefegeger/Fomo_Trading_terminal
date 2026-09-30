// ==UserScript==
// @name         Fomo agent
// @namespace    fomo-poc
// @version      0.2.0
// @description  Опрашивает локальный сервер и выполняет сделки в этом профиле
// @match        https://fomo.family/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

// Ставится ВТОРЫМ юзерскриптом рядом с fomo-trade.user.js (тот даёт window.fomoTrade).
// Ключа здесь нет: подпись делает локальный сервер.

(() => {
  const SRV = 'http://127.0.0.1:8787';
  const AGENT_TOKEN = 'dfbf643cc1670928b6c974f659ef10c4';
  const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149';
  const HOSTS = [
    'https://solana-provider-1.prod-edge.fomo.family',
    'https://solana-provider-2.prod-edge.fomo.family',
    'https://solana-provider-3.prod-edge.fomo.family',
  ];

  let name = localStorage.getItem('fomo_agent_name');
  if (!name) {
    name = (prompt('Имя аккаунта для агента (как в accounts.config.json, например acc1):') || '').trim();
    if (!name) return;
    localStorage.setItem('fomo_agent_name', name);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[agent ' + name + ']', 'color:#16a34a;font-weight:bold', ...a);

  // запросы к локальному серверу идут через GM_xmlhttpRequest: CSP и CORS страницы не мешают
  const gm = (method, path, body) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: SRV + path,
        headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 15000,
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText || '{}')); } catch (e) { reject(new Error('ответ сервера не JSON: ' + r.status)); }
        },
        onerror: () => reject(new Error('сервер недоступен')),
        ontimeout: () => reject(new Error('таймаут')),
      });
    });

  async function rpc(method, params) {
    const access = (localStorage.getItem('privy:token') || '').replace(/^"|"$/g, '');
    for (const host of HOSTS) {
      try {
        const res = await unsafeWindow.fetch(host, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        const json = await res.json();
        if (json.result !== undefined) return json.result;
      } catch { /* следующий хост */ }
    }
    throw new Error('RPC не ответил: ' + method);
  }

  async function run(job) {
    const f = unsafeWindow.fomoTrade;
    const isBuy = job.direction === 'buy';
    const inId = isBuy ? USDC_SOL : job.tokenId;
    const outId = isBuy ? job.tokenId : USDC_SOL;
    const t0 = Date.now();

    const amount = isBuy ? job.amount : await f.rawBalance(job.tokenId);
    const prep = await f.prepare(inId, outId, amount, 0);
    const sw = prep.v1Swap || prep;

    const s = await gm('POST', '/sign', { name, tx: sw.swapTransaction });
    if (!s.signed) throw new Error('подпись не получена: ' + (s.error || '?'));

    const sig = await f.submitSigned(s.signed);

    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
      const st = r?.value?.[0];
      if (st?.confirmationStatus) {
        if (st.err) throw new Error('транзакция упала: ' + JSON.stringify(st.err));
        return { ok: true, sig, status: st.confirmationStatus, ms: Date.now() - t0 };
      }
    }
    return { ok: true, sig, status: 'pending', ms: Date.now() - t0 };
  }

  (async () => {
    while (!unsafeWindow.fomoTrade) await sleep(500);
    log('ищу сервер...');
    let lastErr = '';
    let connected = false;
    for (;;) {
      try {
        const job = await gm('GET', `/poll?name=${encodeURIComponent(name)}`);
        if (job.error) throw new Error(job.error);
        if (!connected) { connected = true; log('на связи с сервером'); }
        lastErr = '';
        if (job.id) {
          log('задание', job.direction, job.tokenId);
          let result;
          try { result = await run(job); } catch (e) { result = { ok: false, error: e.message }; }
          log('результат', result);
          await gm('POST', '/result', { jobId: job.id, name, result });
        }
      } catch (e) {
        connected = false;
        if (e.message !== lastErr) { lastErr = e.message; log('ошибка связи:', e.message); }
      }
      await sleep(500);
    }
  })();
})();
