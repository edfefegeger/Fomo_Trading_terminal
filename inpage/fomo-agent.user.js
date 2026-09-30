// ==UserScript==
// @name         Fomo agent
// @namespace    fomo-poc
// @version      0.3.0
// @description  Держит long-poll к локальному серверу и выполняет сделки в этом профиле
// @match        https://fomo.family/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

// Ставится ВТОРЫМ юзерскриптом рядом с fomo-trade.user.js (тот даёт window.fomoTrade).
// Ключа здесь нет: подпись делает локальный сервер.
// Имя аккаунта и agentToken спрашиваются один раз и хранятся в localStorage профиля.

(() => {
  const SRV = 'http://127.0.0.1:8787';
  const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149';

  const ask = (key, text) => {
    let v = localStorage.getItem(key);
    if (!v) {
      v = (prompt(text) || '').trim();
      if (v) localStorage.setItem(key, v);
    }
    return v;
  };

  const name = ask('fomo_agent_name', 'Имя аккаунта для агента (как в accounts.config.json, например acc1):');
  if (!name) return;
  const AGENT_TOKEN = ask('fomo_agent_token', 'agentToken из accounts.config.json:');
  if (!AGENT_TOKEN) return;

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
        timeout: 15000, // больше, чем удержание long-poll на сервере (5 с)
        onload: (r) => {
          try { resolve(JSON.parse(r.responseText || '{}')); } catch (e) { reject(new Error('ответ сервера не JSON: ' + r.status)); }
        },
        onerror: () => reject(new Error('сервер недоступен')),
        ontimeout: () => reject(new Error('таймаут')),
      });
    });

  async function run(job) {
    const f = unsafeWindow.fomoTrade;
    const isBuy = job.direction === 'buy';
    const inId = isBuy ? USDC_SOL : job.tokenId;
    const outId = isBuy ? job.tokenId : USDC_SOL;
    const t0 = Date.now();
    const lap = (l) => log(l, Date.now() - t0, 'мс');

    const amount = isBuy ? job.amount : await f.rawBalance(job.tokenId);
    lap('balance');
    const prep = await f.prepare(inId, outId, amount, 0);
    lap('prepare');
    const sw = prep.v1Swap || prep;

    const s = await gm('POST', '/sign', { name, tx: sw.swapTransaction });
    if (!s.signed) throw new Error('подпись не получена: ' + (s.error || '?'));
    lap('sign');

    const sig = await f.submitSigned(s.signed);
    lap('sent');

    for (let i = 0; i < 60; i++) {
      await sleep(400);
      const r = await f.rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
      const st = r?.value?.[0];
      if (st?.confirmationStatus) {
        if (st.err) throw new Error('транзакция упала: ' + JSON.stringify(st.err));
        lap('confirmed');
        return { ok: true, sig, status: st.confirmationStatus, ms: Date.now() - t0 };
      }
    }
    return { ok: true, sig, status: 'pending', ms: Date.now() - t0 };
  }

  (async () => {
    log('агент запущен на', location.href);
    let waited = 0;
    while (!unsafeWindow.fomoTrade) {
      if (waited++ % 10 === 0) log('жду window.fomoTrade, первый юзерскрипт не запущен?');
      await sleep(500);
    }
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
      await sleep(lastErr ? 1000 : 30);
    }
  })();
})();
