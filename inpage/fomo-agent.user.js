// ==UserScript==
// @name         Fomo agent
// @namespace    fomo-poc
// @version      0.4.0
// @description  Держит long-poll к локальному серверу и выполняет сделки в этом профиле
// @match        https://fomo.family/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

// Ставится ВТОРЫМ юзерскриптом рядом с fomo-trade.user.js (он даёт window.fomoTrade).
// Имя аккаунта и agentToken хранятся в GM_setValue: страница fomo.family их прочитать не может
// (в localStorage они были бы видны любому скрипту сайта).
// Сумму и баланс считает сервер, подтверждение тоже сервер через свой RPC.
// К Fomo отсюда уходит только prepare и отправка.

(() => {
  const SRV = 'http://127.0.0.1:8787';
  const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149';

  const ask = (key, text) => {
    let v = GM_getValue(key, '');
    if (!v) { v = (prompt(text) || '').trim(); if (v) GM_setValue(key, v); }
    return v;
  };
  const name = ask('fomo_agent_name', 'Имя аккаунта для агента (как в accounts.config.json, например acc1):');
  if (!name) return;
  const AGENT_TOKEN = ask('fomo_agent_token', 'agentToken из accounts.config.json:');
  if (!AGENT_TOKEN) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...a) => console.log('%c[agent ' + name + ']', 'color:#16a34a;font-weight:bold', ...a);

  const gm = (method, path, body) =>
    new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: SRV + path,
        headers: { 'Content-Type': 'application/json', 'X-Agent-Token': AGENT_TOKEN },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 15000,
        onload: (r) => { try { resolve(JSON.parse(r.responseText || '{}')); } catch { reject(new Error('ответ сервера не JSON: ' + r.status)); } },
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

    const prep = await f.prepare(inId, outId, job.amount, 0); // job.amount посчитал сервер
    const sw = prep.v1Swap || prep;

    const s = await gm('POST', '/sign', { name, jobId: job.id, tx: sw.swapTransaction });
    if (!s.signed) throw new Error('подпись не получена: ' + (s.error || '?'));

    const sig = await f.submitSigned(s.signed);
    log('отправлено', sig, Date.now() - t0, 'мс');
    return { ok: true, sig, status: 'sent' }; // подтверждает сервер
  }

  (async () => {
    log('агент запущен');
    while (!unsafeWindow.fomoTrade) await sleep(500);
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
