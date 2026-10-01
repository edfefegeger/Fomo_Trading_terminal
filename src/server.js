// Локальный сервер: панель с кнопками + очередь заданий + подпись.
// Изменения по сравнению с оригиналом:
//   - /wallets: отдаёт список аккаунтов со статусом и последними балансами
//   - /trade: принимает accounts[] для выбора кошельков, сохраняет usdValue из результата
//   - /result: обновляет кэш баланса после сделки
//   - HTML убран (отдаётся trading-terminal-ui.html как статика)
//
// node src/server.js  ->  http://127.0.0.1:8787

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKeypair, signSwapTransaction } from './sign.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const cfg = JSON.parse(fs.readFileSync(path.join(root, 'accounts.config.json'), 'utf8'));
const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const FOMO_ORIGIN = 'https://fomo.family';
const POLL_HOLD_MS = 5000;
const JOB_TIMEOUT_MS = 60000;

const accs = new Map(cfg.accounts.map((a) => [a.name, { ...a, kp: loadKeypair(a.secret) }]));
const queue    = new Map();   // name -> job
const pollers  = new Map();   // name -> res
const waiters  = new Map();   // `${jobId}:${name}` -> resolve
const lastSeen = new Map();   // name -> timestamp
const walletCache = new Map(); // name -> {usdc, pnl, address, updatedAt}
let jobSeq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const online = (name) => Date.now() - (lastSeen.get(name) || 0) < 8000;

async function readJson(req) {
  let raw = '';
  for await (const c of req) raw += c;
  return raw ? JSON.parse(raw) : {};
}

function send(res, code, obj, type = 'application/json') {
  if (res.writableEnded) return;
  res.statusCode = code;
  res.setHeader('Content-Type', type + '; charset=utf-8');
  res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
}

// ---------- запуск сделки ----------

async function runAll({ direction, tokenId, usd, accounts: selectedNames }) {
  const jobId = ++jobSeq;
  const [lo, hi] = cfg.jitterMs || [0, 0];

  // Фильтруем: если передан список имён, работаем только с ними
  const targets = selectedNames?.length
    ? [...accs.values()].filter((a) => selectedNames.includes(a.name))
    : [...accs.values()];

  const tasks = targets.map(async (a) => {
    if (!online(a.name)) return { name: a.name, ok: false, error: 'агент не на связи (открыта ли вкладка fomo.family?)' };

    const job = {
      id: jobId,
      direction,
      tokenId,
      amount: direction === 'buy' ? String(a.usd || usd || cfg.defaultUsd || '2000000') : null,
    };
    if (hi > 0) await sleep(lo + Math.random() * (hi - lo));

    const result = new Promise((resolve) => {
      const key = `${jobId}:${a.name}`;
      waiters.set(key, resolve);
      setTimeout(() => {
        if (!waiters.has(key)) return;
        waiters.delete(key);
        if (queue.get(a.name)?.id === jobId) queue.delete(a.name);
        resolve({ name: a.name, ok: false, error: 'таймаут 60 с' });
      }, JOB_TIMEOUT_MS);
    });

    const p = pollers.get(a.name);
    if (p) { pollers.delete(a.name); send(p, 200, job); }
    else queue.set(a.name, job);
    return result;
  });

  return Promise.all(tasks);
}

// ---------- HTTP ----------

http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== HOST && req.headers.host !== `localhost:${PORT}`) return send(res, 403, { error: 'host' });

    const origin = req.headers.origin;
    const fromFomo = origin === FOMO_ORIGIN;
    if (fromFomo) {
      res.setHeader('Access-Control-Allow-Origin', FOMO_ORIGIN);
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain');

    const url = new URL(req.url, `http://${HOST}`);

    // --- статика ---
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(root, 'trading-terminal-ui.html'), 'utf8');
      return send(res, 200, html, 'text/html');
    }

    // --- панель: /agents (статус), /wallets (для UI), /trade ---
    if (req.method === 'GET' && url.pathname === '/agents') {
      return send(res, 200, [...accs.keys()].map((name) => ({ name, online: online(name) })));
    }

    // /wallets — объединяет конфиг, онлайн-статус и последние известные балансы
    if (req.method === 'GET' && url.pathname === '/wallets') {
      const list = cfg.accounts.map((a, i) => ({
        id: i + 1,
        name: a.name,
        address: walletCache.get(a.name)?.address || a.address || '…',
        group: a.group || 'all',
        online: online(a.name),
        usdc: walletCache.get(a.name)?.usdc ?? null,
        pnl: walletCache.get(a.name)?.pnl ?? null,
        updatedAt: walletCache.get(a.name)?.updatedAt || null,
      }));
      return send(res, 200, list);
    }

    if (req.method === 'POST' && url.pathname === '/trade') {
      if (req.headers['x-panel'] !== '1' || (origin && origin !== `http://${HOST}`)) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, await runAll(await readJson(req)));
    }

    // --- агент ---
    const tokenOk = cfg.agentToken && req.headers['x-agent-token'] === cfg.agentToken;
    if (!fromFomo && !tokenOk) return send(res, 403, { error: 'origin/token' });

    if (req.method === 'GET' && url.pathname === '/poll') {
      const name = url.searchParams.get('name');
      if (!accs.has(name)) return send(res, 404, { error: 'неизвестный аккаунт ' + name });
      lastSeen.set(name, Date.now());

      const job = queue.get(name);
      if (job) { queue.delete(name); return send(res, 200, job); }

      const old = pollers.get(name);
      if (old) send(old, 200, {});
      pollers.set(name, res);
      const t = setTimeout(() => {
        if (pollers.get(name) === res) { pollers.delete(name); lastSeen.set(name, Date.now()); send(res, 200, {}); }
      }, POLL_HOLD_MS);
      req.on('close', () => { clearTimeout(t); if (pollers.get(name) === res) pollers.delete(name); });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/sign') {
      const { name, tx } = await readJson(req);
      const a = accs.get(name);
      if (!a) return send(res, 404, { error: 'неизвестный аккаунт' });
      return send(res, 200, { signed: signSwapTransaction(tx, a.kp) });
    }

    if (req.method === 'POST' && url.pathname === '/result') {
      const { jobId, name, result } = await readJson(req);
      lastSeen.set(name, Date.now());

      // Обновляем кэш баланса из результата агента
      if (result?.balances) {
        const prev = walletCache.get(name) || {};
        walletCache.set(name, { ...prev, ...result.balances, updatedAt: new Date().toISOString() });
      }

      const done = waiters.get(`${jobId}:${name}`);
      if (done) { waiters.delete(`${jobId}:${name}`); done({ name, ...result }); }
      return send(res, 200, { ok: true });
    }

    // /wallet-balance — агент может пушить свежие балансы вне сделки
    if (req.method === 'POST' && url.pathname === '/wallet-balance') {
      const { name, balances } = await readJson(req);
      if (accs.has(name)) {
        const prev = walletCache.get(name) || {};
        walletCache.set(name, { ...prev, ...balances, updatedAt: new Date().toISOString() });
      }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`панель: http://${HOST}`);
  console.log('аккаунты:', [...accs.keys()].join(', '));
});
