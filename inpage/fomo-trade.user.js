  // ==UserScript==
  // @name         Fomo trade helper (PoC)
  // @namespace    fomo-poc
  // @version      0.2.0
  // @description  Вызовы апи Fomo из самой вкладки (их edge отдаёт 430 клиентам без браузерного отпечатка).
  // @match        https://fomo.family/*
  // @grant        none
  // @run-at       document-idle
  // ==/UserScript==

  // Подпись здесь НЕ делается: приватные ключи в страницу не попадают.
  // Подписывает локальный сервер, а этот скрипт только готовит сделку и отправляет подписанную транзакцию.

  (() => {
    const BASE = 'https://prod-api.fomo.family';
    const CHAINS = '56,143,4663,8453,1399811149';
    const TIMEOUT_MS = 15000;
    const RPC_HOSTS = [
      'https://solana-provider-1.prod-edge.fomo.family',
      'https://solana-provider-2.prod-edge.fomo.family',
      'https://solana-provider-3.prod-edge.fomo.family',
    ];

    const log = (...a) => console.log('%c[fomo-trade]', 'color:#7c3aed;font-weight:bold', ...a);
    const strip = (v) => v?.replace(/^"|"$/g, '') || null;

    function tokens() {
      return {
        access: strip(localStorage.getItem('privy:token')),
        refresh: strip(localStorage.getItem('privy:refresh_token')),
      };
    }

    // Обновление сессии в браузере. Ответ содержит новый refresh, его надо сохранить.
    async function refreshSession() {
      const { refresh } = tokens();
      if (!refresh) throw new Error('нет privy:refresh_token в localStorage');

      const res = await fetch('https://auth.privy.io/api/v1/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'privy-app-id': strip(localStorage.getItem('privy:app-id')) || 'cm6h485o300n3zj9yl6vpedq7',
        },
        body: JSON.stringify({ refresh_token: refresh }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 430) {
        throw new Error('430 от edge. Нужен обычный браузер и подходящий IP/прокси');
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

    // Запрос к прокси Solana RPC: все хосты параллельно, берём первый успешный ответ.
    async function rpcCall(method, params, id = 1) {
      let { access } = tokens();
      if (!access) access = await refreshSession();

      const attempt = async (host) => {
        const res = await fetch(host, {
          method: 'POST',
          headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const json = await res.json();
        if (json.result !== undefined) return json.result;
        throw new Error(JSON.stringify(json.error || 'HTTP ' + res.status));
      };

      try {
        return await Promise.any(RPC_HOSTS.map(attempt));
      } catch (e) {
        throw new Error(`RPC ${method} не ответил: ` + (e.errors || [e]).map((x) => x.message).join(' | '));
      }
    }

    const api = {
      tokens,
      refreshSession,

      me: () => request('/v2/users/current'),

      balances: async () => {
        api._uid ??= (await api.me()).id; // id кэшируем: меньше запросов при продаже
        return request(`/v2/users/${api._uid}/balances`);
      },

      swaps: (userId) => request(`/v2/users/${userId}/swaps`),

      // Подготовка сделки: отдаёт транзакцию с подписью их плательщика комиссии.
      // inTokenId и outTokenId: "<адрес>:<номер сети>"
      prepare: (inTokenId, outTokenId, amount, retry = 0) =>
        request('/swaps/v2', { method: 'POST', body: { inTokenId, outTokenId, amount: String(amount), retry } }),

      // Отправка уже подписанной транзакции (подписал локальный сервер).
      // Одна и та же подписанная транзакция, отправленная на все хосты сразу, безвредна.
      submitSigned: (signedBase64) =>
        rpcCall('sendTransaction', [signedBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 'fomo-poc'),

      rpc: rpcCall,

      // Сколько токена на балансе, в целых единицах
      rawBalance: async (tokenId) => {
        const bals = await api.balances();
        const row = (bals.balances || []).find((b) => b.balance?.tokenId === tokenId);
        if (!row) throw new Error('нет баланса по ' + tokenId);
        return String(row.balance.balance);
      },

      status: (relaySwapId) => request(`/swaps/v2/status?relaySwapId=${encodeURIComponent(relaySwapId)}`),
      fastFill: (relaySwapId) => request('/swaps/v2/fast-fill', { method: 'POST', body: { relaySwapId } }),
      refreshTx: (body) => request('/swaps/v2/refresh-tx', { method: 'POST', body }),
      authorize: (relaySwapId, signature, signatureChainId) =>
        request('/swaps/v2/authorize', { method: 'POST', body: { relaySwapId, signature, signatureChainId } }),
    };

    window.fomoTrade = api;
    log('готово. Доступно: me, balances, prepare, submitSigned, rpc, rawBalance');
  })();
