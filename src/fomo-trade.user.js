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
  };

  window.fomoTrade = api;
  log('готово. Доступно: fomoTrade.me(), fomoTrade.balances(), fomoTrade.probeSigners()');
})();
