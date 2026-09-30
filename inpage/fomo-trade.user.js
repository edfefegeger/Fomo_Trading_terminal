// ==UserScript==
// @name         Fomo trade helper (PoC)
// @namespace    fomo-poc
// @version      0.1.0
// @description  Вызовы апи Fomo из самой вкладки. Нужен потому, что их edge отдаёт 430 любому клиенту без браузерного отпечатка и не с домашнего IP.
// @match        https://fomo.family/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Зачем скрипт в браузере, а не на сервере:
// запросы уходят из настоящей вкладки, значит отпечаток TLS браузерный, origin их,
// и edge пропускает. Из Node те же самые запросы получают 430.

(() => {
  const BASE = 'https://prod-api.fomo.family';
  const CHAINS = '56,143,4663,8453,1399811149';

  const log = (...a) => console.log('%c[fomo-trade]', 'color:#7c3aed;font-weight:bold', ...a);

  function tokens() {
    return {
      access: localStorage.getItem('privy:token')?.replace(/^"|"$/g, '') || null,
      refresh: localStorage.getItem('privy:refresh_token')?.replace(/^"|"$/g, '') || null,
    };
  }

  // Обновление сессии прямо в браузере. Ответ содержит новый refresh, его надо сохранить.
  async function refreshSession() {
    const { refresh } = tokens();
    if (!refresh) throw new Error('нет privy:refresh_token в localStorage');

    const res = await fetch('https://auth.privy.io/api/v1/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'privy-app-id': localStorage.getItem('privy:app-id')?.replace(/^"|"$/g, '') || 'cm6h485o300n3zj9yl6vpedq7',
      },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    const body = await res.json();
    if (!body.token) throw new Error(`обновление не прошло: ${JSON.stringify(body).slice(0, 200)}`);

    localStorage.setItem('privy:token', body.token);
    if (body.refresh_token) localStorage.setItem('privy:refresh_token', body.refresh_token);
    log('сессия обновлена, refresh сохранён новый');
    return body.token;
  }

  async function request(path, { method = 'GET', body, retry = true } = {}) {
    let { access } = tokens();
    if (!access) access = await refreshSession();

    const res = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        'X-Supported-Chains': CHAINS,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 430) {
      throw new Error('430 от edge. Значит вкладка не подходит: нужен обычный браузер и домашний IP');
    }
    if (res.status === 401 && retry) {
      await refreshSession();
      return request(path, { method, body, retry: false });
    }

    const json = await res.json().catch(() => ({}));
    if (json.success === false) {
      throw new Error(`${json.message || 'ошибка'} (${json.errorCode || json.statusCode})`);
    }
    return json.responseObject ?? json;
  }

  // ---------- подпись транзакции в браузере ----------
  // Транзакция от Fomo приходит в формате versioned v0 и уже подписана их плательщиком комиссии.
  // Мы добавляем подпись кошелька пользователя и отправляем.

  const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:1399811149';
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function b58decode(s) {
    let bytes = [0];
    for (const ch of s) {
      let carry = ALPH.indexOf(ch);
      if (carry < 0) throw new Error('недопустимый символ в ключе');
      for (let i = 0; i < bytes.length; i++) {
        carry += bytes[i] * 58;
        bytes[i] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }

  function shortvec(b, o) {
    let v = 0, sh = 0, i = o;
    for (;;) { const x = b[i++]; v |= (x & 0x7f) << sh; if (!(x & 0x80)) break; sh += 7; }
    return { v, i };
  }

  const b64url = (u8) =>
    btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function signTx(txBase64, secretB58) {
    const sec = b58decode(secretB58);
    if (sec.length !== 64) throw new Error('в ключе должно быть 64 байта, а есть ' + sec.length);
    const seed = sec.slice(0, 32), pub = sec.slice(32, 64);

    const bytes = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
    const sc = shortvec(bytes, 0);
    const sigsStart = sc.i;
    const msgStart = sigsStart + sc.v * 64;

    let p = msgStart;
    if (bytes[p] & 0x80) p += 1; // префикс версии у v0
    const need = bytes[p];
    const kc = shortvec(bytes, p + 3);

    let idx = -1;
    for (let i = 0; i < kc.v; i++) {
      const k = bytes.slice(kc.i + i * 32, kc.i + (i + 1) * 32);
      if (k.every((b, j) => b === pub[j])) { idx = i; break; }
    }
    if (idx < 0) throw new Error('наш ключ не среди подписантов');
    if (idx >= need) throw new Error('наша подпись не требуется');

    // ключ импортируем в формате jwk: raw для Ed25519 поддерживают не все браузеры
    const jwk = { kty: 'OKP', crv: 'Ed25519', d: b64url(seed), x: b64url(pub), key_ops: ['sign'], ext: true };
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'Ed25519' }, true, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, bytes.slice(msgStart)));

    const out = new Uint8Array(bytes);
    out.set(sig, sigsStart + idx * 64);
    let s = '';
    for (const b of out) s += String.fromCharCode(b);
    return btoa(s);
  }

  // ---------- чтение ----------

  const api = {
    tokens,
    refreshSession,

    me: () => request('/v2/users/current'),

    balances: async () => {
      const me = await api.me();
      return request(`/v2/users/${me.id}/balances`);
    },

    swaps: async (userId) => request(`/v2/users/${userId}/swaps`),

    // ---------- торговля ----------

    // Подготовка сделки. Отдаёт транзакцию и подпись их плательщика комиссии.
    // inTokenId и outTokenId это "<адрес>:<номер сети>", например "<mint>:1399811149"
    prepare: (inTokenId, outTokenId, amount, retry = 0) =>
      request('/swaps/v2', { method: 'POST', body: { inTokenId, outTokenId, amount: String(amount), retry } }),

    // Отправка уже подписанной транзакции. Подпись ставим вне браузера, тут только доставка.
    // Идём в их прокси к RPC Solana, потому что обычный публичный RPC по таким транзакциям молчит.
    async submitSigned(signedBase64) {
      let { access } = tokens();
      if (!access) access = await refreshSession();

      const hosts = [
        'https://solana-provider-1.prod-edge.fomo.family',
        'https://solana-provider-2.prod-edge.fomo.family',
        'https://solana-provider-3.prod-edge.fomo.family',
      ];

      const errors = [];
      for (const host of hosts) {
        try {
          const res = await fetch(host, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${access}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'fomo-poc',
              method: 'sendTransaction',
              params: [signedBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }],
            }),
          });
          const json = await res.json().catch(() => ({}));
          if (json.result) return json.result; // подпись транзакции
          if (json.error) throw new Error(JSON.stringify(json.error));
          throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          errors.push(`${host}: ${e.message}`);
        }
      }
      throw new Error('ни один хост не принял транзакцию. ' + errors.join(' | '));
    },

    status: (relaySwapId) => request(`/swaps/v2/status?relaySwapId=${encodeURIComponent(relaySwapId)}`),
    fastFill: (relaySwapId) => request('/swaps/v2/fast-fill', { method: 'POST', body: { relaySwapId } }),
    refreshTx: (body) => request('/swaps/v2/refresh-tx', { method: 'POST', body }),
    authorize: (relaySwapId, signature, signatureChainId) =>
      request('/swaps/v2/authorize', { method: 'POST', body: { relaySwapId, signature, signatureChainId } }),

    // Смотрим, что вообще доступно на странице для подписи. Первый шаг разведки.
    probeSigners() {
      const keys = Object.keys(window).filter((k) =>
        /privy|wallet|solana|sol|web3|phantom|signer/i.test(k),
      );
      log('объекты на window, похожие на кошелёк:', keys);
      console.table(
        keys.map((k) => ({ name: k, type: typeof window[k], has: typeof window[k] === 'object' ? Object.keys(window[k] || {}).slice(0, 12).join(',') : '-' })),
      );
      return keys;
    },

    // ---------- подпись прямо в браузере ----------
    // Транзакция от Fomo уже подписана их плательщиком комиссии. Мы добавляем только подпись
    // кошелька пользователя. Ключ импортируется в формате jwk, так работает во всех Chromium.

    signTx,

    // ---------- их прокси к RPC Solana ----------
    rpc: async (method, params) => {
      let { access } = tokens();
      if (!access) access = await refreshSession();
      const hosts = [
        'https://solana-provider-1.prod-edge.fomo.family',
        'https://solana-provider-2.prod-edge.fomo.family',
        'https://solana-provider-3.prod-edge.fomo.family',
      ];
      for (const host of hosts) {
        try {
          const res = await fetch(host, {
            method: 'POST',
            headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '1.88', id: 1, method, params }),
          });
          const json = await res.json();
          if (json.result !== undefined) return json.result;
        } catch { /* пробуем следующий хост */ }
      }
      throw new Error('ни один RPC хост не ответил на ' + method);
    },

    // Сколько токена на балансе, в целых единицах
    rawBalance: async (tokenId) => {
      const bals = await api.balances();
      const row = (bals.balances || []).find((b) => b.tokenId === tokenId);
      if (!row) throw new Error('нет баланса по ' + tokenId);
      return String(row.balance);
    },

    // Полный цикл: подготовка, подпись, проверка окна по блокам, отправка, ожидание статуса.
    // direction: 'buy' или 'sell'. Для покупки сумма в usdc, для продажи берём весь баланс токена.
    trade: async ({ direction, tokenId, secret, usd = '2000000', waitSeconds = 30 }) => {
      const isBuy = direction === 'buy';
      const inTokenId = isBuy ? USDC_SOL : tokenId;
      const outTokenId = isBuy ? tokenId : USDC_SOL;
      const amount = isBuy ? String(usd) : await api.rawBalance(tokenId);

      const t0 = Date.now();
      const prep = await api.prepare(inTokenId, outTokenId, amount, 0);
      const sw = prep.v1Swap || prep;
      const signed = await signTx(sw.swapTransaction, secret);
      const ms = Date.now() - t0;

      const height = await api.rpc('getBlockHeight', []);
      const left = sw.lastValidBlockHeight - height;

      const sig = await api.submitSigned(signed);
      log(`${direction}: подпись и сборка ${ms} мс, блоков до истечения ${left}, отправлено ${sig}`);

      const started = Date.now();
      while (Date.now() - started < waitSeconds * 1000) {
        await new Promise((r) => setTimeout(r, 1500));
        const st = (await api.rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]))?.[0];
        if (st && st.confirmationStatus) {
          if (st.err) throw new Error('транзакция упала: ' + JSON.stringify(st.err));
          log(`${direction}: статус ${st.confirmationStatus}`);
          return { sig, swap: sw, ms };
        }
      }
      log(`${direction}: статуса нет за ${waitSeconds} секунд`);
      return { sig, swap: sw, ms, pending: true };
    },

    buy: (opts) => api.trade({ ...opts, direction: 'buy' }),
    sell: (opts) => api.trade({ ...opts, direction: 'sell' }),
  };

  window.fomoTrade = api;
  log('готово. Доступно: me, balances, probeSigners, buy, sell, trade, rawBalance');
})();
