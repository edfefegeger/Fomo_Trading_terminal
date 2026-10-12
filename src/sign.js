// Подпись подготовленной транзакции ключом кошелька.
//
// Что уже есть в транзакции от Fomo:
//   - подпись их плательщика комиссии
//   - собранные инструкции обмена (маршрут DFlow)
// Что добавляем мы:
//   - подпись кошелька пользователя
//
// Подпись это чистая криптография, браузер не нужен. Поэтому подписываем здесь,
// а отправляем уже из вкладки, потому что их edge режет серверные запросы.

import { Transaction, VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519';

// Ключ может прийти в любом из трёх видов, поддерживаем все.
export function loadKeypair(secret) {
  if (!secret || typeof secret !== 'string') throw new Error('пустой ключ');

  const trimmed = secret.trim();

  // вид 1: JSON массив байтов, так отдаёт большинство кошельков
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  // вид 2: base58, 64 байта
  if (trimmed.length > 80) {
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  }
  // вид 3: base58, только 32 байта seed
  return Keypair.fromSeed(bs58.decode(trimmed));
}

// ---------- формат v1 (SIMD-0385) ----------
// Fomo стал отдавать транзакции нового формата. web3.js 1.x его разобрать не может,
// поэтому подписываем по байтам. Раскладка:
//   [0x81][3 байта заголовка: подписантов, readonly-подписантов, readonly-остальных][u32 маска конфигов]
//   [32 байта blockhash][u8 число инструкций][u8 число адресов][адреса по 32 байта] ...инструкции...
//   [подписи по 64 байта, в самом КОНЦЕ, без префикса длины]
// Подписывается всё, что стоит до блока подписей (включая первый байт 0x81).
const isV1 = (raw) => raw.length > 42 && raw[0] === 0x81;

function v1Layout(raw) {
  const numSigs = raw[1];
  const sigStart = raw.length - numSigs * 64;
  const addrStart = 42;
  if (!numSigs || sigStart <= addrStart + numSigs * 32) throw new Error('v1: разбор раскладки не сошёлся (подписей ' + numSigs + ')');
  const signers = [];
  for (let i = 0; i < numSigs; i++) signers.push(raw.subarray(addrStart + i * 32, addrStart + (i + 1) * 32));
  return { numSigs, sigStart, signers };
}

function signV1(raw, keypair) {
  const { numSigs, sigStart, signers } = v1Layout(raw);
  const me = keypair.publicKey.toBytes();
  const idx = signers.findIndex((k) => Buffer.compare(Buffer.from(k), Buffer.from(me)) === 0);
  if (idx < 0) throw new Error('v1: кошелька ' + keypair.publicKey.toBase58() + ' нет среди подписантов транзакции');
  const message = raw.subarray(0, sigStart);

  // самопроверка: подпись плательщика Fomo (если уже стоит) должна сходиться с нашим представлением о том, что подписывается.
  for (let i = 0; i < numSigs; i++) {
    if (i === idx) continue;
    const sig = raw.subarray(sigStart + i * 64, sigStart + (i + 1) * 64);
    if (sig.every((b) => b === 0)) continue;
    if (!ed25519.verify(sig, message, signers[i])) {
      throw new Error('v1: подпись плательщика Fomo не сходится с разобранным сообщением. Формат изменился, транзакцию не подписываю');
    }
  }
  const out = Buffer.from(raw);
  const sig = ed25519.sign(message, keypair.secretKey.subarray(0, 32));
  Buffer.from(sig).copy(out, sigStart + idx * 64);
  return out.toString('base64');
}

// Добавляет нашу подпись к транзакции, которая пришла от Fomo.
export function signSwapTransaction(txBase64, keypair) {
  const raw = Buffer.from(txBase64, 'base64');
  if (isV1(raw)) return signV1(raw, keypair);

  // Пробуем legacy формат, он тут и ожидается: размер около 924 байт
  try {
    const tx = Transaction.from(raw);
    tx.partialSign(keypair);
    return tx.serialize().toString('base64');
  } catch (legacyError) {
    // Если не вышло, пробуем версионированный формат
    try {
      const vtx = VersionedTransaction.deserialize(raw);
      vtx.sign([keypair]);
      return Buffer.from(vtx.serialize()).toString('base64');
    } catch (versionedError) {
      throw new Error(
        `не удалось разобрать транзакцию. legacy: ${legacyError.message}. versioned: ${versionedError.message}`,
      );
    }
  }
}

// Список программ, которые вызывает транзакция. Нужен серверу, чтобы логировать и проверять белый список перед подписью.
export function programIds(txBase64) {
  const raw = Buffer.from(txBase64, 'base64');
  if (isV1(raw)) return ['v1-не-разобрано']; // инструкции v1 не разбираем: белый список для них не применим
  try {
    const tx = Transaction.from(raw);
    return [...new Set(tx.instructions.map((i) => i.programId.toBase58()))];
  } catch {
    const m = VersionedTransaction.deserialize(raw).message;
    return [...new Set(m.compiledInstructions.map((i) => m.staticAccountKeys[i.programIdIndex].toBase58()))];
  }
}

// Проверка: убедиться, что в транзакции действительно нужна наша подпись,
// и что к ней уже приложена подпись их плательщика.
export function inspectTransaction(txBase64) {
  const raw = Buffer.from(txBase64, 'base64');
  const out = { bytes: raw.length };

  try {
    const tx = Transaction.from(raw);
    out.format = 'legacy';
    out.feePayer = tx.feePayer?.toBase58() || null;
    out.signatures = tx.signatures.map((s) => ({
      pubkey: s.publicKey.toBase58(),
      signed: s.signature ? true : false,
      signatureLength: s.signature ? s.signature.length : 0,
    }));
  } catch {
    out.format = 'versioned или неизвестный';
  }
  return out;
}

export function verifyKeyMatches(keypair, expectedAddress) {
  const actual = keypair.publicKey.toBase58();
  if (expectedAddress && actual !== expectedAddress) {
    throw new Error(`ключ не от того кошелька. в ключе ${actual}, ожидали ${expectedAddress}`);
  }
  return actual;
}

// ---------- CLI ----------
// node src/sign.js inspect <base64>
// node src/sign.js sign <base64> <secret_key> [ожидаемый адрес]
const isMain = process.argv[1] && process.argv[1].endsWith('sign.js');
if (isMain) {
  const [cmd, txBase64, secret, expected] = process.argv.slice(2);
  try {
    if (cmd === 'inspect') {
      console.log(JSON.stringify(inspectTransaction(txBase64), null, 2));
    } else if (cmd === 'sign') {
      const kp = loadKeypair(secret);
      verifyKeyMatches(kp, expected);
      const signed = signSwapTransaction(txBase64, kp);
      console.log(`подписано ключом ${kp.publicKey.toBase58()}`);
      console.log(signed);
    } else {
      console.log('команды: inspect <base64> | sign <base64> <secret_key> [ожидаемый адрес]');
    }
  } catch (e) {
    console.error('ошибка:', e.message);
    process.exitCode = 1;
  }
}
