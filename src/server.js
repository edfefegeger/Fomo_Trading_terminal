// Локальный сервер: терминал (UI) + кэш статистики из ончейна + очередь заданий + подпись.
//
// Принцип по запросам к Fomo: ФОНОВЫХ ЗАПРОСОВ К FOMO НЕТ ВООБЩЕ.
//   балансы, токены, подтверждение сделок -> ваш RPC (rpcUrl), не Fomo
//   к Fomo уходит только действие пользователя: 1x prepare + 1x sendTransaction на кошелёк
//
// node src/server.js  ->  http://127.0.0.1:8787

import fs from 'node:fs';
import http from 'node:http';
import { loadKeypair, signSwapTransaction, programIds } from './sign.js';
import { getPrices, portfolio, heldMints } from './portfolio.js';

const root = new URL('../', import.meta.url);
const cfg = JSON.parse(fs.readFileSync(new URL('accounts.config.json', root), 'utf8'));
if (!cfg.agentToken || String(cfg.agentToken).length < 16) {
  console.error('В accounts.config.json нужен agentToken: случайная строка от 16 символов');
  process.exit(1);
}

const CONFIG_PATH = new URL('accounts.config.json', root);
function saveConfig() {
  const tmp = CONFIG_PATH.pathname + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH.pathname);
}

const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const POLL_HOLD_MS = 5000;
const JOB_TIMEOUT_MS = 60000;
const CHAIN = '1399811149';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_USD = Math.round(Number(cfg.maxUsdPerTrade || 20) * 1e6); // потолок покупки на кошелёк
const MAX_PARALLEL = cfg.maxParallel || 5; // сколько кошельков торгуют одновременно, остальные ждут в очереди
const STATS_EVERY_MS = (cfg.statsEverySec || 30) * 1000;
const PANEL_ACTIVE_MS = 90000; // статистику обновляем, только пока открыт терминал

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ключ живёт только как Keypair, строка секрета дальше не хранится
const accs = new Map(
  cfg.accounts.map((a) => {
    const kp = loadKeypair(a.secret);
    return [a.name, { name: a.name, usd: a.usd, group: a.group, kp, address: kp.publicKey.toBase58() }];
  }),
);

const queue = new Map(); // name -> job, агент ещё не забрал
const pollers = new Map(); // name -> res, агент ждёт задание
const waiters = new Map(); // `${jobId}:${name}` -> resolve
const grants = new Map(); // name -> разрешение на ОДНУ подпись под текущее задание
const lastSeen = new Map();
const inflight = new Set(); // защита от двойного клика: одна и та же сделка не идёт дважды
let jobSeq = 0;
let panelSeen = 0;
const online = (name) => Date.now() - (lastSeen.get(name) || 0) < 8000;

// ---------- журнал сделок ----------
const JOURNAL = new URL('data/journal.jsonl', root);
fs.mkdirSync(new URL('data/', root), { recursive: true });
const journal = fs.existsSync(JOURNAL)
  ? fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
function record(row) {
  journal.push(row);
  fs.appendFile(JOURNAL, JSON.stringify(row) + '\n', () => {});
}

// ---------- RPC (ваш, не Fomo) ----------
async function rpcBatch(calls) {
  if (!cfg.rpcUrl) throw new Error('rpcUrl не задан в accounts.config.json');
  const out = [];
  for (let i = 0; i < calls.length; i += 25) {
    const body = calls.slice(i, i + 25).map((c, j) => ({ jsonrpc: '2.0', id: j, method: c.method, params: c.params }));
    const res = await fetch(cfg.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error('RPC HTTP ' + res.status);
    const arr = await res.json();
    if (!Array.isArray(arr)) throw new Error(JSON.stringify(arr.error || arr).slice(0, 140));
    arr.sort((a, b) => a.id - b.id).forEach((r) => out.push(r));
  }
  return out;
}
async function rpc1(method, params) {
  const [r] = await rpcBatch([{ method, params }]);
  if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r.result;
}

// ---------- кэш статистики: один батч на все кошельки ----------
const stats = new Map(); // name -> { sol, usdc, tokens: {mint: ui}, at, error }
let statsRun = null;

function refreshStats() {
  if (statsRun) return statsRun; // single-flight: параллельные вызовы схлопываются в один
  statsRun = (async () => {
    const names = [...accs.keys()];
    try {
      const calls = names.flatMap((n) => {
        const addr = accs.get(n).address;
        return [
          { method: 'getBalance', params: [addr] },
          ...TOKEN_PROGRAMS.map((p) => ({ method: 'getTokenAccountsByOwner', params: [addr, { programId: p }, { encoding: 'jsonParsed' }] })),
        ];
      });
      const res = await rpcBatch(calls);
      names.forEach((n, i) => {
        const [bal, t1, t2] = res.slice(i * 3, i * 3 + 3);
        const bad = [bal, t1, t2].find((x) => x.error);
        if (bad) return stats.set(n, { ...(stats.get(n) || {}), error: bad.error.message });
        const tokens = {};
        for (const acc of [...t1.result.value, ...t2.result.value]) {
          const ta = acc.account.data.parsed.info;
          tokens[ta.mint] = (tokens[ta.mint] || 0) + Number(ta.tokenAmount.uiAmount || 0);
        }
        const usdc = tokens[USDC] || 0;
        delete tokens[USDC];
        stats.set(n, { sol: bal.result.value / 1e9, usdc, tokens, at: Date.now(), error: null });
      });

      // цены и стоимость позиций: публичный Dexscreener, Fomo не трогаем
      const mints = heldMints(stats);
      if (mints.length) {
        try {
          const priceMap = await getPrices(mints);
          for (const [name, pf] of portfolio(stats, journal, priceMap)) {
            stats.set(name, {
              ...(stats.get(name) || {}),
              valueUsd: pf.valueUsd, pnl: pf.pnl, pnlPercent: pf.percent, invested: pf.spent,
            });
          }
        } catch (e) {
          log('[prices] ошибка, оставляю прошлые цены:', e.message);
        }
      }
    } catch (e) {
      for (const n of names) stats.set(n, { ...(stats.get(n) || {}), error: e.message });
      log('[stats] ошибка:', e.message);
    } finally {
      statsRun = null;
    }
  })();
  return statsRun;
}
setInterval(() => { if (Date.now() - panelSeen < PANEL_ACTIVE_MS) refreshStats(); }, STATS_EVERY_MS);

const tokenCache = new Map();
async function tokenInfo(mint) {
  const c = tokenCache.get(mint);
  if (c && Date.now() - c.at < 600000) return c.v;
  const r = await rpc1('getTokenSupply', [mint]); // фейковый mint падает здесь, до Fomo
  const v = { supply: Number(r.value.uiAmount), decimals: r.value.decimals };
  tokenCache.set(mint, { at: Date.now(), v });
  return v;
}

async function tokenRaw(address, mint) {
  const r = await rpc1('getTokenAccountsByOwner', [address, { mint }, { encoding: 'jsonParsed' }]);
  return r.value.reduce((s, x) => s + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}

// подтверждение сделки через ваш RPC: ноль запросов к Fomo
async function confirm(r) {
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    try {
      const st = (await rpc1('getSignatureStatuses', [[r.sig], { searchTransactionHistory: true }])).value[0];
      if (st?.confirmationStatus) {
        if (st.err) { r.ok = false; r.error = 'транзакция упала: ' + JSON.stringify(st.err); }
        r.status = st.confirmationStatus;
        return;
      }
    } catch { /* следующая попытка */ }
  }
  r.status = 'pending';
}

// ---------- сделки ----------
let running = 0;
const waitq = [];
const acquire = () => (running < MAX_PARALLEL ? (running++, Promise.resolve()) : new Promise((r) => waitq.push(r)));
const release = () => { const n = waitq.shift(); if (n) n(); else running--; };

function dispatch(a, job) {
  return new Promise((resolve) => {
    const key = `${job.id}:${a.name}`;
    grants.set(a.name, { jobId: job.id, signed: false, until: Date.now() + JOB_TIMEOUT_MS });
    const t = setTimeout(() => {
      waiters.delete(key);
      grants.delete(a.name);
      if (queue.get(a.name)?.id === job.id) queue.delete(a.name); // просроченное задание не должно выполниться позже
      resolve({ name: a.name, ok: false, error: 'таймаут 60 с (проверь, не прошла ли сделка)' });
    }, JOB_TIMEOUT_MS);
    waiters.set(key, (r) => { clearTimeout(t); grants.delete(a.name); resolve(r); });
    const p = pollers.get(a.name);
    if (p) { pollers.delete(a.name); send(p, 200, job); } else queue.set(a.name, job);
  });
}

async function one(a, p) {
  const row = { ts: Date.now(), wallet: a.name, mint: p.mint, side: p.direction, amount: '—' };
  let r;
  try {
    if (!online(a.name)) throw new Error('агент не на связи (открыта ли вкладка fomo.family?)');
    let amount;
    if (p.direction === 'buy') {
      amount = BigInt(String(p.usd || a.usd || cfg.defaultUsd || '2000000'));
      if (amount <= 0n || amount > BigInt(MAX_USD)) throw new Error(`сумма вне лимита (maxUsdPerTrade = $${MAX_USD / 1e6})`);
      row.amount = '$' + Number(amount) / 1e6;
    } else {
      amount = ((await tokenRaw(a.address, p.mint)) * BigInt(Math.round(p.percent * 100))) / 10000n;
      if (amount <= 0n) throw new Error('нет баланса этого токена');
      row.amount = p.percent + '%';
    }
    const [lo, hi] = cfg.jitterMs || [0, 0];
    if (hi > 0) await sleep(lo + Math.random() * (hi - lo));
    r = await dispatch(a, { id: p.jobId, direction: p.direction, tokenId: p.tokenId, amount: String(amount) });
    if (r.ok && r.sig) await confirm(r);
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  Object.assign(row, { ok: !!r.ok, sig: r.sig, status: r.status, error: r.error });
  if (!r.ok) row.side = 'error';
  record(row);
  return { name: a.name, ...r, usdValue: p.direction === 'buy' && r.ok ? Number(row.amount.slice(1)) : undefined };
}

async function runAll({ direction, tokenId, usd, percent, accounts }) {
  if (!['buy', 'sell'].includes(direction)) throw new Error('direction: buy или sell');
  const [mint, chain] = String(tokenId || '').split(':');
  if (!MINT_RE.test(mint || '') || chain !== CHAIN) throw new Error(`tokenId должен быть <mint>:${CHAIN}`);
  if (mint === USDC) throw new Error('USDC торговать нельзя');
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('не выбраны кошельки');
  const unknown = accounts.filter((n) => !accs.has(n));
  if (unknown.length) throw new Error('неизвестные кошельки: ' + unknown.join(', '));
  const pct = Number(percent ?? 100);
  if (direction === 'sell' && !(pct > 0 && pct <= 100)) throw new Error('процент продажи 1-100');
  await tokenInfo(mint); // несуществующий mint отсекается до обращения к Fomo

  const lock = `${direction}:${mint}`;
  if (inflight.has(lock)) throw new Error('такая сделка уже выполняется');
  inflight.add(lock);
  try {
    const jobId = ++jobSeq;
    log(`[trade] ${direction} ${mint} на ${accounts.length} кошельках`);
    const out = await Promise.all(
      accounts.map(async (name) => {
        await acquire();
        try { return await one(accs.get(name), { jobId, direction, mint, tokenId, usd, percent: pct }); } finally { release(); }
      }),
    );
    setTimeout(() => refreshStats().catch(() => {}), 1500);
    return out;
  } finally {
    inflight.delete(lock);
  }
}

// ---------- http ----------
async function readJson(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 200000) throw new Error('слишком большое тело'); }
  return raw ? JSON.parse(raw) : {};
}
function send(res, code, obj, type = 'application/json') {
  if (res.writableEnded) return;
  res.statusCode = code;
  res.setHeader('Content-Type', type + '; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
}

http
  .createServer(async (req, res) => {
    try {
      // защита от DNS rebinding
      if (req.headers.host !== HOST && req.headers.host !== `localhost:${PORT}`) return send(res, 403, { error: 'host' });
      const url = new URL(req.url, `http://${HOST}`);
      const origin = req.headers.origin;

      // --- терминал ---
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, fs.readFileSync(new URL('public/terminal.html', root), 'utf8'), 'text/html');
      }
      if (req.method === 'GET' && url.pathname === '/wallets') {
        panelSeen = Date.now();
        if (!stats.size) refreshStats();
        const trades = {};
        for (const j of journal) if (j.ok) trades[j.wallet] = (trades[j.wallet] || 0) + 1;
        return send(res, 200, [...accs.values()].map((a, i) => {
          const s = stats.get(a.name) || {};
          return {
            id: i + 1, name: a.name, address: a.address, group: a.group || 'all', online: online(a.name),
            sol: s.sol ?? 0, usdc: s.usdc ?? 0, tokens: s.tokens || {}, trades: trades[a.name] || 0,
            pnl: s.pnl ?? 0, pnlPercent: s.pnlPercent ?? 0, valueUsd: s.valueUsd ?? 0, invested: s.invested ?? 0,
            statsAt: s.at || null, statsError: s.error || null,
          };
        }));
      }
      if (req.method === 'GET' && url.pathname === '/agents') {
        return send(res, 200, [...accs.keys()].map((name) => ({ name, online: online(name) })));
      }
      if (req.method === 'GET' && url.pathname === '/transactions') {
        return send(res, 200, journal.slice(-200).reverse());
      }
      if (req.method === 'GET' && url.pathname === '/token') {
        const mint = url.searchParams.get('mint') || '';
        if (!MINT_RE.test(mint)) return send(res, 400, { error: 'mint' });
        try { return send(res, 200, await tokenInfo(mint)); } catch (e) { return send(res, 404, { error: e.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/trade') {
        // только со своей страницы: свой заголовок и свой origin
        if (req.headers['x-panel'] !== '1' || (origin && origin !== `http://${HOST}`)) return send(res, 403, { error: 'forbidden' });
        try { return send(res, 200, await runAll(await readJson(req))); } catch (e) { return send(res, 400, { error: e.message }); }
      }

      // --- управление кошельками из интерфейса ---
      const panelOk = req.headers['x-panel'] === '1' && (!origin || origin === `http://${HOST}`);

      if (req.method === 'GET' && url.pathname === '/accounts') {
        return send(res, 200, [...accs.entries()].map(([name, a]) => ({
          name, address: a.address, group: a.group || 'all', hasSecret: true,
        })));
      }
      if (req.method === 'POST' && url.pathname === '/accounts') {
        if (!panelOk) return send(res, 403, { error: 'forbidden' });
        const { name, address, secret, group } = await readJson(req);
        if (!/^[a-zA-Z0-9_-]{2,24}$/.test(String(name || ''))) return send(res, 400, { error: 'имя: 2-24 символа, буквы, цифры, дефис' });
        if (accs.has(name)) return send(res, 400, { error: 'такое имя уже занято' });
        if (!MINT_RE.test(String(address || ''))) return send(res, 400, { error: 'адрес не похож на solana' });
        if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(String(secret || ''))) return send(res, 400, { error: 'ключ должен быть base58, 64 байта' });
        let kp;
        try { kp = loadKeypair(secret); } catch (e) { return send(res, 400, { error: 'ключ не разбирается: ' + e.message }); }
        if (kp.publicKey.toBase58() !== address) return send(res, 400, { error: 'ключ не от этого адреса' });
        cfg.accounts.push({ id: (cfg.accounts.at(-1)?.id || 0) + 1, name, address, group: group || 'all', secret, usd: cfg.defaultUsd });
        saveConfig();
        accs.set(name, { name, usd: cfg.defaultUsd, group: group || 'all', kp, address });
        log('[accounts] добавлен', name);
        return send(res, 200, { ok: true, name });
      }
      if (req.method === 'PATCH' && url.pathname === '/accounts') {
        if (!panelOk) return send(res, 403, { error: 'forbidden' });
        const { name, group, newName } = await readJson(req);
        const a = accs.get(name);
        if (!a) return send(res, 404, { error: 'нет такого кошелька' });
        const c = cfg.accounts.find((x) => x.name === name);
        if (group) { a.group = group; if (c) c.group = group; }
        if (newName && newName !== name && !accs.has(newName)) {
          if (c) c.name = newName;
          accs.delete(name);
          accs.set(newName, { ...a, name: newName });
        }
        saveConfig();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && url.pathname === '/accounts') {
        if (!panelOk) return send(res, 403, { error: 'forbidden' });
        const name = url.searchParams.get('name');
        const i = cfg.accounts.findIndex((x) => x.name === name);
        if (i < 0) return send(res, 404, { error: 'нет такого кошелька' });
        cfg.accounts.splice(i, 1);
        accs.delete(name);
        stats.delete(name);
        saveConfig();
        log('[accounts] удалён', name);
        return send(res, 200, { ok: true });
      }

      // --- агент: токен обязателен всегда. Origin fomo.family НЕ считается аутентификацией ---
      if (req.headers['x-agent-token'] !== cfg.agentToken) return send(res, 403, { error: 'token' });

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
        const { name, tx, jobId } = await readJson(req);
        const a = accs.get(name);
        const g = grants.get(name);
        // подпись только под активное задание, созданное из терминала, и только одна
        if (!a || !g || g.signed || g.jobId !== jobId || Date.now() > g.until) return send(res, 403, { error: 'нет активного задания для подписи' });
        const progs = programIds(tx);
        if (cfg.allowedPrograms?.length && !progs.every((p) => cfg.allowedPrograms.includes(p))) {
          return send(res, 403, { error: 'программа вне белого списка: ' + progs.join(',') });
        }
        log('[sign]', name, 'programs:', progs.join(','));
        g.signed = true;
        return send(res, 200, { signed: signSwapTransaction(tx, a.kp) });
      }
      if (req.method === 'POST' && url.pathname === '/result') {
        const { jobId, name, result } = await readJson(req);
        lastSeen.set(name, Date.now());
        const done = waiters.get(`${jobId}:${name}`);
        if (done) { waiters.delete(`${jobId}:${name}`); done({ name, ...result }); }
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    log(`терминал: http://${HOST}`);
    log('кошельки:', [...accs.values()].map((a) => `${a.name} ${a.address.slice(0, 4)}…`).join(', '));
  });
