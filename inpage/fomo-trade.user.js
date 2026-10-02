// ==UserScript==
// @name         Fomo trade helper
// @namespace    fomo-poc
// @version      0.3.0
// @description  Вызовы апи Fomo из самой вкладки (их edge отдаёт 430 клиентам без браузерного отпечатка).
// @match        https://fomo.family/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Подписи здесь нет: ключи в страницу не попадают, подписывает локальный сервер.
// Запросов к Fomo только по действию: prepare и отправка. Никакого опроса.

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
    return { access: strip(localStorage.getItem('privy:token')), refresh: strip(localStorage.getItem('privy:refresh_token')) };
  }

  // Обновление сессии (домен Privy, не Fomo). Ответ содержит новый refresh, его надо сохранить.
  async function refreshSession() {
    const { refresh } = tokens();
    if (!refresh) throw new Error('нет privy:refresh_token в localStorage');
    const res = await fetch('https://auth.privy.io/api/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'privy-app-id': strip(localStorage.getItem('privy:app-id')) || 'cm6h485o300n3zj9yl6vpedq7' },
      body: JSON.stringify({ refresh_token: refresh }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json();
    if (!body.token) throw new Error(`обновление не прошло: ${JSON.stringify(body).slice(0, 200)}`);
    localStorage.setItem('privy:token', body.token);
    if (body.refresh_token) localStorage.setItem('privy:refresh_token', body.refresh_token);
    log('сессия обновлена');
    return body.token;
  }

  async function request(path, { method = 'GET', body, retry = true } = {}) {
    let { access } = tokens();
    if (!access) access = await refreshSession();
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Bearer ${access}`, 'X-Supported-Chains': CHAINS, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 430) throw new Error('430 от edge. Нужен обычный браузер и подходящий IP/прокси');
    if (res.status === 401 && retry) { await refreshSession(); return request(path, { method, body, retry: false }); }
    const json = await res.json().catch(() => ({}));
    if (json.success === false) throw new Error(`${json.message || 'ошибка'} (${json.errorCode || json.statusCode})`);
    return json.responseObject ?? json;
  }

  // Один запрос к одному хосту.
  async function rpcOne(host, access, method, params, id = 1) {
    const res = await fetch(host, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json();
    if (json.result !== undefined) return json.result;
    throw new Error(JSON.stringify(json.error || 'HTTP ' + res.status));
  }

  const api = {
    tokens,
    refreshSession,
    me: () => request('/v2/users/current'),

    // Подготовка сделки: транзакция с подписью их плательщика комиссии.
    // inTokenId и outTokenId: "<адрес>:<номер сети>"
    prepare: (inTokenId, outTokenId, amount, retry = 0) =>
      request('/swaps/v2', { method: 'POST', body: { inTokenId, outTokenId, amount: String(amount), retry } }),

    // Отправка подписанной транзакции. Хосты по очереди: следующий только если предыдущий не принял.
    // (раньше шло на все три параллельно)
    submitSigned: async (signedBase64) => {
      let { access } = tokens();
      if (!access) access = await refreshSession();
      const errs = [];
      for (const host of RPC_HOSTS) {
        try {
          return await rpcOne(host, access, 'sendTransaction', [signedBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 'fomo-poc');
        } catch (e) { errs.push(e.message); }
      }
      throw new Error('ни один хост не принял транзакцию: ' + errs.join(' | '));
    },
  };

  window.fomoTrade = api;
  log('готово. Доступно: me, prepare, submitSigned');
})();
