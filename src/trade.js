// Обёртка над апи Fomo и последовательность покупки и продажи.
//
// ВАЖНО ПРО ОКРУЖЕНИЕ.
// Их edge отдаёт HTTP 430, если у клиента нет браузерного TLS отпечатка и он пришёл
// не с домашнего IP. Значит из Node эти вызовы не пройдут. Код ниже написан так,
// чтобы работать и в Node, и в браузере: в Node он нужен для проверок и отладки,
// а боевые вызовы идут из вкладки через inpage/fomo-trade.user.js.

import { FOMO_BASE, SUPPORTED_CHAINS, getAccount, refreshSession } from './auth.js';

export class FomoBlocked extends Error {}
export class FomoApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function baseHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-Supported-Chains': SUPPORTED_CHAINS,
    'Content-Type': 'application/json',
    Origin: 'https://fomo.family',
    Referer: 'https://fomo.family/',
  };
}

// Универсальный запрос. Разворачивает их конверт и один раз повторяет при истёкшем токене.
export async function fomoRequest(name, path, { method = 'GET', body, token, retryOn401 = true } = {}) {
  const access = token || (await refreshSession(name));

  const res = await fetch(FOMO_BASE + path, {
    method,
    headers: baseHeaders(access),
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 430) {
    throw new FomoBlocked(
      'Fomo ответил 430. Нет браузерного TLS отпечатка или IP не домашний. ' +
        'Из Node так и будет. Делай вызов из вкладки через юзерскрипт.',
    );
  }
  if (res.status === 431) {
    throw new FomoApiError('нет токена, edge ответил unauthorized', { status: 431 });
  }
  if (res.status === 401 && retryOn401) {
    await refreshSession(name, { force: true });
    return fomoRequest(name, path, { method, body, retryOn401: false });
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new FomoApiError(`ответ не JSON, HTTP ${res.status}`, { status: res.status });
  }

  if (json.success === false || (res.status >= 400 && json.success !== true)) {
    throw new FomoApiError(json.message || `HTTP ${res.status}`, {
      status: json.statusCode || res.status,
      code: json.errorCode,
    });
  }
  return json.responseObject ?? json;
}

// ---------- чтение ----------

export const getMe = (name) => fomoRequest(name, '/v2/users/current');
export const getBalances = (name) => fomoRequest(name, `/v2/users/${getAccount(name).userId}/balances`);
export const getStatus = (name) => fomoRequest(name, '/status', { token: null }).catch(() => null);

// ---------- торговля ----------

// Шаг 1. Подготовка сделки. Их бэкенд собирает транзакцию и ставит свою подпись плательщика комиссии.
// inTokenId и outTokenId это строки вида "<адрес>:<номер сети>", например "<mint>:1399811149"
// amount в целых единицах, то есть 1 доллар это 1000000 для USDC с шестью нулями.
export async function prepareSwap(name, { inTokenId, outTokenId, amount, retry = 0 }) {
  return fomoRequest(name, '/swaps/v2', {
    method: 'POST',
    body: { inTokenId, outTokenId, amount: String(amount), retry },
  });
}

export async function refreshTx(name, body) {
  return fomoRequest(name, '/swaps/v2/refresh-tx', { method: 'POST', body });
}

export async function fastFill(name, relaySwapId) {
  return fomoRequest(name, '/swaps/v2/fast-fill', { method: 'POST', body: { relaySwapId } });
}

export async function swapStatus(name, relaySwapId) {
  return fomoRequest(name, `/swaps/v2/status?relaySwapId=${encodeURIComponent(relaySwapId)}`);
}

export async function authorizeSwap(name, { relaySwapId, signature, signatureChainId }) {
  return fomoRequest(name, '/swaps/v2/authorize', {
    method: 'POST',
    body: { relaySwapId, signature, signatureChainId },
  });
}

// Шаг 2. Подпись. Это единственная часть, которую нельзя написать вслепую:
// надо снять из DevTools, чем страница подписывает то, что вернул /swaps/v2.
// Функция ниже это заглушка, подставь свою реализацию.
export async function signPreparedTx(prepared) {
  // TODO: снять из живой покупки.
  // Вариант А: ключ кошелька выгружается, тогда подпись делается локально через @solana/web3.js
  // Вариант Б: подпись делает встроенный кошелёк Privy из вкладки
  throw new Error(
    'подпись не реализована: сначала снять из DevTools, чем страница подписывает ответ /swaps/v2',
  );
}

// Шаг 3. Полный цикл: подготовить, подписать, отправить, дождаться статуса.
export async function trade(name, { inTokenId, outTokenId, amount, maxWaitMs = 60000 }) {
  const prepared = await prepareSwap(name, { inTokenId, outTokenId, amount });

  const relaySwapId = prepared.relaySwapId || prepared.swapId;
  if (!relaySwapId) throw new FomoApiError('в ответе нет relaySwapId, смотри структуру ответа');

  const signed = await signPreparedTx(prepared); // TODO

  // Для Solana путь такой: транзакция уже с подписью их плательщика, добавляем подпись кошелька
  // и отправляем. Для EVM сначала authorize, потом fast-fill.
  await fastFill(name, relaySwapId);

  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const st = await swapStatus(name, relaySwapId);
    const state = String(st?.status || st?.state || '').toUpperCase();
    if (['SUCCESS', 'COMPLETED', 'FILLED'].includes(state)) return st;
    if (['FAILED', 'REFUNDED', 'CANCELLED'].includes(state)) throw new FomoApiError(`сделка не прошла: ${state}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new FomoApiError('не дождались статуса за отведённое время');
}

// ---------- CLI ----------

const isMain = process.argv[1] && process.argv[1].endsWith('trade.js');
if (isMain) {
  const [cmd, name, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'me') console.log(await getMe(name));
    else if (cmd === 'balances') console.log(JSON.stringify(await getBalances(name), null, 2));
    else if (cmd === 'buy' || cmd === 'sell') {
      const [inTokenId, outTokenId, amount] = rest;
      const r = await trade(name, { inTokenId, outTokenId, amount: Number(amount) });
      console.log('готово:', JSON.stringify(r, null, 2));
    } else console.log('команды: me <name> | balances <name> | buy <name> <inTokenId> <outTokenId> <amount>');
  } catch (e) {
    console.error(`${e.constructor.name}: ${e.message}`);
    process.exitCode = 1;
  }
}
