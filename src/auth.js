// Конфиг, хранилище аккаунтов и обновление токена Privy.
// Токен обновляется с сервера: это домен авторизации Privy, а не edge Fomo,
// поэтому барьера с TLS отпечатком тут нет.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const STORE_PATH = path.join(here, '..', 'accounts.json');

export const PRIVY_BASE = 'https://auth.privy.io';

// Публичные идентификаторы. Их отдаёт веб страница каждому посетителю. Это не секреты,
// но для запросов нужен точный набор, поэтому сверить с DevTools.
export const PRIVY_APP_ID = 'cm6h485o300n3zj9yl6vpedq7'; // из документации SDK
export const PRIVY_CLIENT_ID = process.env.PRIVY_CLIENT_ID || ''; // TODO: снять целиком из заголовка privy-client-id
export const PRIVY_CLIENT = process.env.PRIVY_CLIENT || 'react-auth:2.24.0'; // TODO: сверить версию
export const PRIVY_CA_ID = process.env.PRIVY_CA_ID || ''; // TODO: снять из заголовка privy-ca-id, если требуется

export const FOMO_BASE = 'https://prod-api.fomo.family';
export const SUPPORTED_CHAINS = '56,143,4663,8453,1399811149';

// ---------- хранилище ----------

function readStore() {
  if (!fs.existsSync(STORE_PATH)) return { accounts: {} };
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { accounts: {} };
  }
}

function writeStore(data) {
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH); // атомарная замена, чтобы не потерять токены при падении
}

export function saveAccount(name, patch) {
  const data = readStore();
  data.accounts[name] = { ...(data.accounts[name] || {}), ...patch, updatedAt: new Date().toISOString() };
  writeStore(data);
  return data.accounts[name];
}

export function getAccount(name) {
  const acc = readStore().accounts[name];
  if (!acc) throw new Error(`аккаунт ${name} не найден. Добавь его: node src/auth.js add ${name} <refresh_token>`);
  return acc;
}

export function listAccounts() {
  return Object.entries(readStore().accounts).map(([name, a]) => ({
    name,
    hasRefresh: Boolean(a.refreshToken),
    hasAccess: Boolean(a.accessToken),
    updatedAt: a.updatedAt,
  }));
}

export function isJwtFresh(token, skewSeconds = 60) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp) return false;
    return payload.exp * 1000 - skewSeconds * 1000 > Date.now();
  } catch {
    return false;
  }
}

// ---------- обновление сессии Privy ----------

function privyHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'privy-app-id': PRIVY_APP_ID,
    'privy-client': PRIVY_CLIENT,
    Origin: 'https://fomo.family',
    Referer: 'https://fomo.family/',
  };
  if (PRIVY_CLIENT_ID) h['privy-client-id'] = PRIVY_CLIENT_ID;
  if (PRIVY_CA_ID) h['privy-ca-id'] = PRIVY_CA_ID;
  return h;
}

// Обновляет access по refresh токену. Возвращает новый access.
// ВАЖНО: ответ содержит новый refresh_token, его надо сохранить, старый умирает.
export async function refreshSession(name, { force = false } = {}) {
  const acc = getAccount(name);
  if (!force && isJwtFresh(acc.accessToken)) return acc.accessToken;

  const res = await fetch(`${PRIVY_BASE}/api/v1/sessions`, {
    method: 'POST',
    headers: privyHeaders(),
    body: JSON.stringify({ refresh_token: acc.refreshToken }),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Privy ответил не JSON. HTTP ${res.status}. Начало ответа: ${text.slice(0, 200)}`);
  }

  if (!res.ok || !body.token) {
    throw new Error(
      `обновление не прошло. HTTP ${res.status}. ${body.message || body.error || ''}. ` +
        'Проверь, что refresh токен не использован повторно: он одноразовый.',
    );
  }

  saveAccount(name, {
    accessToken: body.token,
    refreshToken: body.refresh_token || acc.refreshToken, // сохраняем новый, он ротируется
    identityToken: body.identity_token,
    privyAccessToken: body.privy_access_token,
    sessionAction: body.session_update_action,
    userId: body.user?.id,
  });

  return body.token;
}

// Фоновый авторефреш. Держит токены живыми, чтобы сделка не сорвалась в момент отправки.
export function startAutoRefresh(names, { everySeconds = 600, log = console.log } = {}) {
  const tick = async () => {
    for (const name of names) {
      try {
        await refreshSession(name, { force: true });
        log(`[refresh] ${name}: ок`);
      } catch (e) {
        log(`[refresh] ${name}: ошибка, ${e.message}`);
      }
    }
  };
  tick();
  return setInterval(tick, everySeconds * 1000);
}

// ---------- CLI ----------

const isMain = process.argv[1] && process.argv[1].endsWith('auth.js');
if (isMain) {
  const [cmd, name, arg] = process.argv.slice(2);
  try {
    if (cmd === 'add') {
      if (!name || !arg) throw new Error('usage: node src/auth.js add <name> <refresh_token>');
      saveAccount(name, { refreshToken: arg });
      console.log(`аккаунт ${name} сохранён`);
    } else if (cmd === 'refresh') {
      const token = await refreshSession(name, { force: true });
      console.log(`токен обновлён, длина ${token.length}`);
    } else if (cmd === 'list') {
      console.table(listAccounts());
    } else {
      console.log('команды: add <name> <refresh_token> | refresh <name> | list');
    }
  } catch (e) {
    console.error('ошибка:', e.message);
    process.exitCode = 1;
  }
}
