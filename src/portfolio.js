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

// Реальные доллары сделки. Новые записи несут точную дельту USDC из ончейна (usd).
// У старых покупок это сумма из поля amount ("$2"). У старых продаж суммы нет:
// в amount там процент ("50%"), его нельзя считать долларами, поэтому такие продажи пропускаем.
function tradeUsd(j) {
  if (typeof j.usd === 'number') return j.usd;
  if (j.side === 'buy') return usdOf(j.amount);
  return null;
}

export function cachedPrice(mint) {
  return prices.get(mint)?.usd ?? 0;
}

// PnL по кошельку: сколько потратил, сколько получил, сколько стоит сейчас.
// tokens и priceMap нужны для Win rate: доля токенов, по которым итог в плюсе.
export function pnlFor(wallet, journal, holdingsValueUsd, tokens = {}, priceMap = new Map()) {
  let spent = 0;
  let got = 0;
  const per = new Map(); // mint -> { spent, got, sold }
  for (const j of journal) {
    if (!j || j.wallet !== wallet || !j.ok) continue;
    const usd = tradeUsd(j);
    if (usd == null) continue;
    const m = per.get(j.mint) || { spent: 0, got: 0 };
    if (j.side === 'buy') { spent += usd; m.spent += usd; }
    if (j.side === 'sell') { got += usd; m.got += usd; }
    per.set(j.mint, m);
  }
  const total = got + holdingsValueUsd - spent;

  let wins = 0;
  let counted = 0;
  for (const [mint, m] of per) {
    if (m.spent <= 0) continue;
    const held = Number(tokens[mint] || 0) * (priceMap.get(mint) || 0);
    counted++;
    if (m.got + held > m.spent) wins++;
  }
  return {
    spent: +spent.toFixed(2),
    got: +got.toFixed(2),
    holdings: +holdingsValueUsd.toFixed(2),
    pnl: +total.toFixed(2),
    percent: spent > 0 ? +((total / spent) * 100).toFixed(1) : 0,
    winrate: counted ? Math.round((wins / counted) * 100) : null,
  };
}

// Сводка по всем кошелькам: стоимость, потрачено, PnL
export function portfolio(statsMap, journal, priceMap) {
  const out = new Map();
  for (const [name, s] of statsMap.entries()) {
    const value = holdingsUsd(s.tokens, priceMap);
    out.set(name, { valueUsd: +value.toFixed(2), ...pnlFor(name, journal, value, s.tokens, priceMap), tokens: s.tokens || {} });
  }
  return out;
}

// Список всех минтов, которые сейчас у кого-то есть
export function heldMints(statsMap) {
  const set = new Set();
  for (const s of statsMap.values()) for (const m of Object.keys(s.tokens || {})) set.add(m);
  return [...set];
}

// Название, тикер, капитализация и ликвидность токена (Dexscreener, без обращения к Fomo)
const metaCache = new Map();
export async function tokenMeta(mint) {
  const c = metaCache.get(mint);
  if (c && Date.now() - c.at < 30_000) return c.v;
  let v = { name: '', symbol: '', priceUsd: 0, marketCap: 0, liquidity: 0 };
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const body = await res.json();
      const pairs = (body.pairs || []).filter((p) => p.baseToken?.address === mint);
      pairs.sort((a, b) => Number(b.liquidity?.usd || 0) - Number(a.liquidity?.usd || 0));
      const p = pairs[0];
      if (p) {
        v = {
          name: p.baseToken.name || '', symbol: p.baseToken.symbol || '',
          priceUsd: Number(p.priceUsd || 0), marketCap: Number(p.marketCap || p.fdv || 0), liquidity: Number(p.liquidity?.usd || 0),
        };
        if (v.priceUsd) prices.set(mint, { usd: v.priceUsd, at: Date.now() });
      }
    }
  } catch { /* источник недоступен: отдаём пустые поля, интерфейс покажет прочерк */ }
  metaCache.set(mint, { at: Date.now(), v });
  return v;
}
