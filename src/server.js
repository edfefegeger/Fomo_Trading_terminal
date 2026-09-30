// Локальный сервер: панель с кнопками + очередь заданий + подпись.
// Агенты (юзерскрипт fomo-agent.user.js) сидят во вкладках Fomo в каждом профиле Dolphin,
// держат long-poll запрос к этому серверу и выполняют сделки.
//
// node src/server.js  ->  http://127.0.0.1:8787

import fs from 'node:fs';
import http from 'node:http';
import { loadKeypair, signSwapTransaction } from './sign.js';

const cfg = JSON.parse(fs.readFileSync(new URL('../accounts.config.json', import.meta.url), 'utf8'));
const PORT = 8787;
const HOST = `127.0.0.1:${PORT}`;
const FOMO_ORIGIN = 'https://fomo.family';
const POLL_HOLD_MS = 5000; // сколько сервер держит запрос /poll, если заданий нет
const JOB_TIMEOUT_MS = 60000;

const accs = new Map(cfg.accounts.map((a) => [a.name, { ...a, kp: loadKeypair(a.secret) }]));
const queue = new Map(); // name -> job (агент ещё не забрал)
const pollers = new Map(); // name -> res (агент ждёт задание)
const waiters = new Map(); // `${jobId}:${name}` -> resolve
const lastSeen = new Map(); // name -> timestamp
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

async function runAll({ direction, tokenId, usd }) {
  const jobId = ++jobSeq;
  const [lo, hi] = cfg.jitterMs || [0, 0];

  const tasks = [...accs.values()].map(async (a) => {
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
        // просроченное задание не должно выполниться позже, когда про него уже забыли
        if (queue.get(a.name)?.id === jobId) queue.delete(a.name);
        resolve({ name: a.name, ok: false, error: 'таймаут 60 с (проверь, не прошла ли сделка)' });
      }, JOB_TIMEOUT_MS);
    });

    // если агент уже ждёт в long-poll, отдаём задание сразу
    const p = pollers.get(a.name);
    if (p) {
      pollers.delete(a.name);
      send(p, 200, job);
    } else {
      queue.set(a.name, job);
    }
    return result;
  });

  return Promise.all(tasks);
}

const HTML = `<!doctype html><meta charset=utf-8><title>Fomo multi</title>
<body style="font-family:system-ui;max-width:640px;margin:30px auto;background:#111;color:#eee">
<h3>Fomo multi</h3>
<div id=ag style="margin-bottom:12px;font-size:14px"></div>
<input id=t placeholder="mint:1399811149" style="width:100%;padding:8px;margin-bottom:8px">
<input id=u placeholder="usdc, целые единицы (2000000 = $2)" style="width:100%;padding:8px;margin-bottom:8px">
<button onclick="go('buy')" style="padding:12px 30px;background:#16a34a;color:#fff;border:0">BUY ALL</button>
<button onclick="go('sell')" style="padding:12px 30px;background:#dc2626;color:#fff;border:0">SELL ALL</button>
<pre id=o></pre>
<script>
async function st(){
  const a=await (await fetch('/agents')).json();
  ag.innerHTML=a.map(x=>(x.online?'🟢 ':'🔴 ')+x.name).join(' &nbsp; ');
}
st(); setInterval(st,2000);
async function go(direction){
  const tokenId=t.value.trim();
  if(!tokenId.includes(':')) return alert('tokenId вида mint:1399811149');
  const usd=u.value.trim();
  const what=direction==='buy'?('BUY '+(usd||'по умолчанию')):'SELL (весь баланс)';
  if(!confirm(what+' на всех аккаунтах?\\n'+tokenId)) return;
  o.textContent='...';
  const r=await fetch('/trade',{method:'POST',headers:{'X-Panel':'1','Content-Type':'application/json'},
    body:JSON.stringify({direction,tokenId,usd:usd||undefined})});
  o.textContent=JSON.stringify(await r.json(),null,2);
}
</script>`;

http
  .createServer(async (req, res) => {
    try {
      // защита от DNS rebinding
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

      // --- панель ---
      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, HTML, 'text/html');
      if (req.method === 'GET' && url.pathname === '/agents') {
        return send(res, 200, [...accs.keys()].map((name) => ({ name, online: online(name) })));
      }
      if (req.method === 'POST' && url.pathname === '/trade') {
        // только с самой панели: своя страница, свой заголовок, не чужой origin
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
        if (job) {
          queue.delete(name);
          return send(res, 200, job);
        }

        // заданий нет: держим запрос открытым, ответим сразу, как только появится задание
        const old = pollers.get(name);
        if (old) send(old, 200, {});
        pollers.set(name, res);
        const t = setTimeout(() => {
          if (pollers.get(name) === res) {
            pollers.delete(name);
            lastSeen.set(name, Date.now());
            send(res, 200, {});
          }
        }, POLL_HOLD_MS);
        req.on('close', () => {
          clearTimeout(t);
          if (pollers.get(name) === res) pollers.delete(name);
        });
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
        const done = waiters.get(`${jobId}:${name}`);
        if (done) {
          waiters.delete(`${jobId}:${name}`);
          done({ name, ...result });
        }
        return send(res, 200, { ok: true });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`панель: http://${HOST}`);
    console.log('аккаунты:', [...accs.keys()].join(', '));
  });
