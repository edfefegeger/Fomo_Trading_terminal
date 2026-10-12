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
import { getPrices, portfolio, heldMints, tokenMeta, cachedPrice } from './portfolio.js';

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

cfg.groups = Array.isArray(cfg.groups) ? cfg.groups : [];
const GROUP_RE = /^[a-zA-Z0-9_-]{1,24}$/;

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
      // PnL считаем всегда: реализованная прибыль есть и когда токенов уже нет
      const mints = heldMints(stats);
      try {
        const priceMap = mints.length ? await getPrices(mints) : new Map();
        for (const [name, pf] of portfolio(stats, journal, priceMap)) {
          stats.set(name, {
            ...(stats.get(name) || {}),
            valueUsd: pf.valueUsd, pnl: pf.pnl, pnlPercent: pf.percent, invested: pf.spent, winrate: pf.winrate,
          });
        }
      } catch (e) {
        log('[prices] ошибка, оставляю прошлые цены:', e.message);
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

// Реальная дельта USDC и токена по подписи: честный PnL, supply и сумма продажи берутся отсюда
async function fillDeltas(r, row, address, mint) {
  for (let i = 0; i < 4; i++) {
    try {
      const t = await rpc1('getTransaction', [r.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
      if (!t?.meta) { await sleep(1200); continue; }
      const sum = (arr, m) => (arr || []).filter((b) => b.owner === address && b.mint === m)
        .reduce((acc, b) => ({ amt: acc.amt + Number(b.uiTokenAmount.amount), dec: b.uiTokenAmount.decimals }), { amt: 0, dec: 0 });
      const dUsdc = sum(t.meta.postTokenBalances, USDC).amt - sum(t.meta.preTokenBalances, USDC).amt;
      const post = sum(t.meta.postTokenBalances, mint);
      const dTok = post.amt - sum(t.meta.preTokenBalances, mint).amt;
      row.usd = +(Math.abs(dUsdc) / 1e6).toFixed(4);
      row.qty = +(Math.abs(dTok) / 10 ** (post.dec || (await tokenInfo(mint)).decimals)).toFixed(6);
      return;
    } catch { await sleep(1200); }
  }
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
    const [lo, hiCfg] = cfg.jitterMs || [0, 0];
    const hi = p.jitterMax != null ? Math.min(Math.max(Number(p.jitterMax) || 0, 0), 10000) : hiCfg;
    if (hi > 0) await sleep(Math.min(lo, hi) + Math.random() * (hi - Math.min(lo, hi)));
    r = await dispatch(a, { id: p.jobId, direction: p.direction, tokenId: p.tokenId, amount: String(amount) });
    if (r.ok && r.sig) {
      await confirm(r);
      if (r.ok && r.status !== 'pending') await fillDeltas(r, row, a.address, p.mint);
    }
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  Object.assign(row, { ok: !!r.ok, sig: r.sig, status: r.status, error: r.error });
  if (!r.ok) row.side = 'error';
  record(row);
  return { name: a.name, ...r, usdValue: p.direction === 'buy' && r.ok ? (row.usd ?? Number(row.amount.slice(1))) : undefined };
}

async function runAll({ direction, tokenId, usd, percent, accounts, jitterMax }) {
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
        try { return await one(accs.get(name), { jobId, direction, mint, tokenId, usd, percent: pct, jitterMax }); } finally { release(); }
      }),
    );
    setTimeout(() => refreshStats().catch(() => {}), 1500);
    return out;
  } finally {
    inflight.delete(lock);
  }
}

// ---------- автоматизации (tasks) ----------
// Buy:  каждые N секунд покупка на случайную сумму из диапазона (USDC) на выбранных кошельках.
// Sell: цена берётся с Dexscreener; при каждом росте на X% от точки отсчёта продаём Y% баланса, точка отсчёта сдвигается.
// Работают на сервере, вкладку терминала держать открытой не нужно. После перезапуска сервера все задачи остановлены.
const TASKS_PATH = new URL('data/tasks.json', root);
const MAX_TASKS = 2;
const SELL_CHECK_MS = 20000;
const tasks = new Map();
const timers = new Map();
let taskSeq = 0;
try {
  for (const t of JSON.parse(fs.readFileSync(TASKS_PATH, 'utf8'))) { tasks.set(t.id, { ...t, running: false }); taskSeq = Math.max(taskSeq, t.id); }
} catch { /* файла ещё нет */ }
function saveTasks() { fs.writeFile(TASKS_PATH, JSON.stringify([...tasks.values()], null, 2), () => {}); }
const publicTask = (t) => ({ ...t });

function stopTask(t, why) {
  t.running = false;
  if (why) t.lastError = why;
  clearTimeout(timers.get(t.id)); timers.delete(t.id);
  saveTasks();
}

async function tickTask(id) {
  const t = tasks.get(id);
  if (!t || !t.running) return;
  let delay = t.side === 'buy' ? t.everySec * 1000 : SELL_CHECK_MS;
  try {
    const names = t.accounts.filter((n) => accs.has(n));
    if (!names.length) return stopTask(t, 'в задаче не осталось кошельков');
    let rows = null;
    if (t.side === 'buy') {
      const usd = Math.round((t.usdMin + Math.random() * (t.usdMax - t.usdMin)) * 100) / 100;
      rows = await runAll({ direction: 'buy', tokenId: t.mint + ':' + CHAIN, usd: String(Math.round(usd * 1e6)), accounts: names });
      t.runs++;
    } else {
      const price = (await getPrices([t.mint])).get(t.mint) || 0;
      if (price > 0) {
        if (!t.basePrice) t.basePrice = price;
        if (price >= t.basePrice * (1 + t.stepPct / 100)) {
          t.lastTrigger = price;
          rows = await runAll({ direction: 'sell', tokenId: t.mint + ':' + CHAIN, percent: t.percent, accounts: names });
          t.basePrice = price;
          t.runs++;
        }
      }
    }
    if (rows) {
      const bad = rows.filter((r) => !r.ok);
      t.lastRunAt = Date.now();
      t.lastError = bad.length ? bad.map((r) => `${r.name}: ${r.error}`).join('; ').slice(0, 300) : '';
      t.failStreak = bad.length === rows.length ? (t.failStreak || 0) + 1 : 0;
      if (t.failStreak >= 3) return stopTask(t, 'остановлена: 3 раза подряд все сделки с ошибкой. ' + t.lastError);
    }
    if (t.maxRuns && t.runs >= t.maxRuns) return stopTask(t, 'выполнен лимит запусков (' + t.maxRuns + ')');
  } catch (e) {
    // "уже выполняется" не считаем ошибкой задачи: просто ждём следующего тика
    t.lastError = e.message;
    if (!/уже выполняется/.test(e.message)) t.failStreak = (t.failStreak || 0) + 1;
    if (t.failStreak >= 3) return stopTask(t, 'остановлена: ' + e.message);
  }
  saveTasks();
  if (t.running) timers.set(id, setTimeout(() => tickTask(id), delay));
}

function startTask(t) {
  t.running = true; t.failStreak = 0; t.lastError = ''; t.basePrice = 0; t.runs = 0;
  clearTimeout(timers.get(t.id));
  timers.set(t.id, setTimeout(() => tickTask(t.id), 300));
  saveTasks();
  log('[task] запущена', t.id, t.side, t.mint);
}

function createTask(b) {
  if (tasks.size >= MAX_TASKS) throw new Error('максимум задач: ' + MAX_TASKS);
  const side = b.side === 'sell' ? 'sell' : 'buy';
  const mint = String(b.mint || '').split(':')[0];
  if (!MINT_RE.test(mint)) throw new Error('у проекта нет настоящего mint');
  const names = [...new Set(Array.isArray(b.accounts) ? b.accounts : [])];
  if (!names.length) throw new Error('выбери кошельки в списке справа');
  const unknown = names.filter((n) => !accs.has(n));
  if (unknown.length) throw new Error('неизвестные кошельки: ' + unknown.join(', '));
  const t = { id: ++taskSeq, side, mint, ticker: String(b.ticker || mint.slice(0, 6)).slice(0, 12), accounts: names, running: false, runs: 0, createdAt: Date.now(), lastError: '' };
  const num = (v) => Number(String(v ?? '').replace(',', '.').replace(/[^\d.]/g, ''));
  if (side === 'buy') {
    t.usdMin = num(b.usdMin); t.usdMax = num(b.usdMax); t.everySec = Math.round(num(b.everySec));
    if (!(t.usdMin > 0) || !(t.usdMax >= t.usdMin)) throw new Error('сумма: "От" больше нуля, "До" не меньше "От"');
    if (t.usdMax * 1e6 > MAX_USD) throw new Error(`сумма вне лимита (maxUsdPerTrade = $${MAX_USD / 1e6})`);
    if (!(t.everySec >= 3)) throw new Error('частота: не чаще раза в 3 секунды');
    t.maxRuns = Math.max(0, Math.round(num(b.maxRuns || 0)));
  } else {
    t.percent = num(b.percent); t.stepPct = num(b.stepPct);
    if (!(t.percent > 0 && t.percent <= 100)) throw new Error('процент продажи 1-100');
    if (!(t.stepPct > 0)) throw new Error('шаг роста должен быть больше нуля');
    t.maxRuns = Math.max(0, Math.round(num(b.maxRuns || 0)));
  }
  tasks.set(t.id, t);
  saveTasks();
  return t;
}

// ---------- обогащение журнала: supply и PnL каждой сделки ----------
async function enrichedJournal(limit) {
  const rows = journal.map((j) => ({ ...j }));
  const bought = new Map(); // wallet:mint -> { usd, qty } средняя цена входа по ходу журнала
  for (const j of rows) {
    if (!j.ok || j.qty == null || j.usd == null) continue;
    const k = j.wallet + ':' + j.mint;
    const b = bought.get(k) || { usd: 0, qty: 0 };
    if (j.side === 'buy') {
      b.usd += j.usd; b.qty += j.qty; bought.set(k, b);
      const price = cachedPrice(j.mint);
      if (price > 0 && j.usd > 0) j.pnlPct = +(((j.qty * price) / j.usd - 1) * 100).toFixed(1);
    } else if (j.side === 'sell' && b.qty > 0 && j.qty > 0) {
      const avg = b.usd / b.qty;
      j.pnlPct = +((j.usd / j.qty / avg - 1) * 100).toFixed(1);
    }
  }
  const out = rows.slice(-limit).reverse();
  for (const j of out) {
    if (j.qty == null || !j.mint) continue;
    try { const t = await tokenInfo(j.mint); if (t.supply > 0) j.supplyPct = Number(((j.qty / t.supply) * 100).toPrecision(3)); } catch { /* mint не найден */ }
  }
  return out;
}

const groupList = () => ['all', ...new Set([...cfg.groups, ...[...accs.values()].map((a) => a.group).filter((g) => g && g !== 'all')])];

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

      if (url.pathname === '/favicon.ico') { res.statusCode = 204; return res.end(); }

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
            sol: s.sol ?? 0, usdc: s.usdc ?? 0, tokens: s.tokens || {}, trades: trades[a.name] || 0, winrate: s.winrate ?? null,
            pnl: s.pnl ?? 0, pnlPercent: s.pnlPercent ?? 0, valueUsd: s.valueUsd ?? 0, invested: s.invested ?? 0,
            statsAt: s.at || null, statsError: s.error || null,
          };
        }));
      }
      if (req.method === 'GET' && url.pathname === '/agents') {
        return send(res, 200, [...accs.keys()].map((name) => ({ name, online: online(name) })));
      }
      if (req.method === 'GET' && url.pathname === '/transactions') {
        return send(res, 200, await enrichedJournal(200));
      }
      if (req.method === 'GET' && url.pathname === '/token') {
        const mint = url.searchParams.get('mint') || '';
        if (!MINT_RE.test(mint)) return send(res, 400, { error: 'mint' });
        try {
          const [info, meta] = await Promise.all([tokenInfo(mint), tokenMeta(mint)]);
          const holders = [...stats.values()].filter((s) => (s.tokens?.[mint] || 0) > 0).length;
          return send(res, 200, { ...info, ...meta, holders });
        } catch (e) { return send(res, 404, { error: e.message }); }
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
        const grp = String(group || 'all').trim() || 'all';
        if (!GROUP_RE.test(grp)) return send(res, 400, { error: 'группа: буквы, цифры, дефис' });
        const sec = String(secret || '').trim();
        if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sec) && !/^\[[\d,\s]+\]$/.test(sec)) return send(res, 400, { error: 'ключ: base58 (64 байта) или JSON-массив байтов' });
        let kp;
        try { kp = loadKeypair(sec); } catch (e) { return send(res, 400, { error: 'ключ не разбирается: ' + e.message }); }
        const addr = kp.publicKey.toBase58();
        if (address && String(address).trim() !== addr) return send(res, 400, { error: 'ключ не от этого адреса' });
        if ([...accs.values()].some((x) => x.address === addr)) return send(res, 400, { error: 'этот кошелёк уже добавлен' });
        cfg.accounts.push({ name, address: addr, group: grp, secret: sec, usd: cfg.defaultUsd });
        saveConfig();
        accs.set(name, { name, usd: cfg.defaultUsd, group: grp, kp, address: addr });
        log('[accounts] добавлен', name);
        return send(res, 200, { ok: true, name, address: addr });
      }
      if (req.method === 'PATCH' && url.pathname === '/accounts') {
        if (!panelOk) return send(res, 403, { error: 'forbidden' });
        const { name, group, newName } = await readJson(req);
        const a = accs.get(name);
        if (!a) return send(res, 404, { error: 'нет такого кошелька' });
        const c = cfg.accounts.find((x) => x.name === name);
        if (group) {
          if (!GROUP_RE.test(String(group))) return send(res, 400, { error: 'группа: буквы, цифры, дефис' });
          a.group = group; if (c) c.group = group;
        }
        if (newName && newName !== name) {
          if (!/^[a-zA-Z0-9_-]{2,24}$/.test(String(newName))) return send(res, 400, { error: 'имя: 2-24 символа, буквы, цифры, дефис' });
          if (accs.has(newName)) return send(res, 400, { error: 'такое имя уже занято' });
          if (c) c.name = newName;
          const entries = [...accs.entries()].map(([k, v]) => (k === name ? [newName, { ...v, name: newName }] : [k, v]));
          accs.clear();
          for (const [k, v] of entries) accs.set(k, v);
          const st = stats.get(name); if (st) { stats.delete(name); stats.set(newName, st); }
          for (const j of journal) if (j.wallet === name) j.wallet = newName; // история остаётся за кошельком
          for (const t of tasks.values()) t.accounts = t.accounts.map((n) => (n === name ? newName : n));
          fs.writeFileSync(JOURNAL, journal.map((j) => JSON.stringify(j)).join('\n') + (journal.length ? '\n' : ''));
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
        queue.delete(name); grants.delete(name);
        for (const t of tasks.values()) t.accounts = t.accounts.filter((n) => n !== name);
        saveConfig();
        log('[accounts] удалён', name);
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/groups') {
        return send(res, 200, groupList().map((g) => ({ name: g, count: g === 'all' ? accs.size : [...accs.values()].filter((a) => a.group === g).length })));
      }
      if (req.method === 'POST' && url.pathname === '/groups') {
        if (!panelOk) return send(res, 403, { error: 'forbidden' });
        const name = String((await readJson(req)).name || '').trim().toLowerCase();
        if (!GROUP_RE.test(name)) return send(res, 400, { error: 'группа: буквы, цифры, дефис' });
        if (groupList().includes(name)) return send(res, 400, { error: 'такая группа уже есть' });
        cfg.groups.push(name);
        saveConfig();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE' && url.pathname === '/groups') {
        if (!panelOk) return send(res, 403, { error: 'forbidden' });
        const name = url.searchParams.get('name');
        if (!name || name === 'all') return send(res, 400, { error: 'группу all удалить нельзя' });
        cfg.groups = cfg.groups.filter((g) => g !== name);
        for (const a of accs.values()) if (a.group === name) { a.group = 'all'; const c = cfg.accounts.find((x) => x.name === a.name); if (c) c.group = 'all'; }
        saveConfig();
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/tasks') return send(res, 200, [...tasks.values()].map(publicTask));
      if (url.pathname.startsWith('/tasks') && req.method !== 'GET') {
        if (!panelOk) return send(res, 403, { error: 'forbidden' });
        try {
          if (req.method === 'POST' && url.pathname === '/tasks') return send(res, 200, publicTask(createTask(await readJson(req))));
          const t = tasks.get(Number(url.searchParams.get('id')));
          if (!t) return send(res, 404, { error: 'нет такой задачи' });
          if (req.method === 'POST' && url.pathname === '/tasks/start') {
            if (t.running) return send(res, 200, publicTask(t));
            if (!t.accounts.length) return send(res, 400, { error: 'в задаче нет кошельков' });
            startTask(t); return send(res, 200, publicTask(t));
          }
          if (req.method === 'POST' && url.pathname === '/tasks/stop') { stopTask(t); return send(res, 200, publicTask(t)); }
          if (req.method === 'DELETE' && url.pathname === '/tasks') { stopTask(t); tasks.delete(t.id); saveTasks(); return send(res, 200, { ok: true }); }
        } catch (e) { return send(res, 400, { error: e.message }); }
        return send(res, 404, { error: 'not found' });
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
