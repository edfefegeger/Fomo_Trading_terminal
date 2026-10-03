// Цены, стоимость позиций и PnL.
//
// Цены берём с Dexscreener: бесплатно, без ключей, без обращения к Fomo.
// Это важно: сервер вообще не трогает Fomo, значит аккаунтам ничего не грозит.
//
// PnL считаем из своего журнала сделок плюс текущей стоимости позиций:
//   PnL = (все продажи) + (текущая стоимость токенов) - (все покупки)
// Значит он честный только по сделкам, которые прошли через терминал.

const PRICE_TTL_MS = 45_000;
const DS_BATCH = 30; // больше 30 адресов Dexscreener не принимает за раз

const prices = new Map(); // mint -> { usd, at }

async function fetchBatch(mints) {
  const url = 'https://api.dexscreener.com/latest/dex/tokens/' + mints.join(',');
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('dexscreener ' + res.status);
  const body = await res.json();
  const pairs = body.pairs || [];

  // по каждому минту берём пару с самой большой ликвидностью
  const best = new Map();
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    if (!mint) continue;
    const liq = Number(p.liquidity?.usd || 0);
    const prev = best.get(mint);
    if (!prev || liq > prev.liq) best.set(mint, { liq, price: Number(p.priceUsd || 0) });
  }
  return best;
}

// Цены пачками, с кэшем. Возвращает Map: mint -> цена в долларах
export async function getPrices(mints) {
  const now = Date.now();
  const need = [...new Set(mints)].filter((m) => {
    const c = prices.get(m);
    return !c || now - c.at > PRICE_TTL_MS;
  });

  for (let i = 0; i < need.length; i += DS_BATCH) {
    const chunk = need.slice(i, i + DS_BATCH);
    try {
      const best = await fetchBatch(chunk);
      for (const m of chunk) {
        const hit = best.get(m);
        prices.set(m, { usd: hit?.price ?? 0, at: Date.now() });
      }
    } catch {
      // если источник не ответил, оставляем прошлую цену, она помечена временем
    }
  }

  const out = new Map();
  for (const m of mints) out.set(m, prices.get(m)?.usd ?? 0);
  return out;
}

// Стоимость всех токенов кошелька: tokens = { mint: количество }
export function holdingsUsd(tokens, priceMap) {
  let sum = 0;
  for (const [mint, amount] of Object.entries(tokens || {})) {
    sum += Number(amount || 0) * (priceMap.get(mint) || 0);
  }
  return sum;
}

// Разбор суммы из журнала: у нас там строки вида "$2.00" либо числа
function usdOf(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// PnL по кошельку: сколько потратил, сколько получил, сколько стоит сейчас
export function pnlFor(wallet, journal, holdingsValueUsd) {
  let spent = 0;
  let got = 0;
  for (const j of journal) {
    if (!j || j.wallet !== wallet || !j.ok) continue;
    if (j.side === 'buy') spent += usdOf(j.amount);
    if (j.side === 'sell') got += usdOf(j.amount);
  }
  const total = got + holdingsValueUsd - spent;
  return {
    spent: +spent.toFixed(2),
    got: +got.toFixed(2),
    holdings: +holdingsValueUsd.toFixed(2),
    pnl: +total.toFixed(2),
    percent: spent > 0 ? +((total / spent) * 100).toFixed(1) : 0,
  };
}

// Сводка по всем кошелькам: стоимость, потрачено, PnL
export function portfolio(statsMap, journal, priceMap) {
  const out = new Map();
  for (const [name, s] of statsMap.entries()) {
    const value = holdingsUsd(s.tokens, priceMap);
    out.set(name, { valueUsd: +value.toFixed(2), ...pnlFor(name, journal, value), tokens: s.tokens || {} });
  }
  return out;
}

// Список всех минтов, которые сейчас у кого-то есть
export function heldMints(statsMap) {
  const set = new Set();
  for (const s of statsMap.values()) for (const m of Object.keys(s.tokens || {})) set.add(m);
  return [...set];
}
