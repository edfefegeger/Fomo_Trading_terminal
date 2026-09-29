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

// Добавляет нашу подпись к транзакции, которая пришла от Fomo.
export function signSwapTransaction(txBase64, keypair) {
  const raw = Buffer.from(txBase64, 'base64');

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
