"use strict";
// SandyGram 3.0 — сквозное шифрование секретных чатов (X25519 + XSalsa20-Poly1305).
// Публичный ключ лежит в users/{uid}.e2ePub, приватный НИКОГДА не покидает устройство.
// Сервер и правила Firestore видят только шифротекст: расшифровать его нельзя даже с
// полным доступом к базе — нужен приватный ключ участника.
//
// ВНИМАНИЕ: копия app/sge2e.js — отличается только строкой импорта nacl.
import nacl from "/vendor-nacl.js";

const b64 = {
  enc: (u8) => btoa(String.fromCharCode(...u8)),
  dec: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
const utf8 = {
  enc: (s) => new TextEncoder().encode(s),
  dec: (u8) => new TextDecoder().decode(u8),
};

export const E2E_KEY_STORE = "sg_e2e_secret_v1";

// storage — { get(key), set(key, value) }, у веба это localStorage, у RN — SecureStore.
// Возвращает { pub, secret } в base64. Ключ создаётся один раз на устройство.
export async function ensureKeyPair(storage) {
  const saved = await storage.get(E2E_KEY_STORE);
  if (saved) {
    try {
      const { pub, secret } = JSON.parse(saved);
      if (pub && secret) return { pub, secret };
    } catch { /* битая запись — сгенерируем заново */ }
  }
  const kp = nacl.box.keyPair();
  const pair = { pub: b64.enc(kp.publicKey), secret: b64.enc(kp.secretKey) };
  await storage.set(E2E_KEY_STORE, JSON.stringify(pair));
  return pair;
}

// Забыть ключ (выход из аккаунта): переписка станет нечитаемой — так и задумано.
export async function forgetKeyPair(storage) {
  await storage.set(E2E_KEY_STORE, "");
}

// Шифруем текст для конкретного получателя. Возвращает { n, c } в base64.
export function encryptFor(theirPubB64, mySecretB64, text) {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const box = nacl.box(utf8.enc(String(text)), nonce, b64.dec(theirPubB64), b64.dec(mySecretB64));
  if (!box) throw new Error("Не удалось зашифровать сообщение");
  return { n: b64.enc(nonce), c: b64.enc(box) };
}

// Расшифровка. null — значит ключ не тот (например, сообщение с другого устройства).
export function decryptFrom(theirPubB64, mySecretB64, enc) {
  if (!enc || !enc.n || !enc.c) return null;
  try {
    const open = nacl.box.open(b64.dec(enc.c), b64.dec(enc.n), b64.dec(theirPubB64), b64.dec(mySecretB64));
    return open ? utf8.dec(open) : null;
  } catch { return null; }
}

// В секретном чате сообщение шифруется отдельно для каждого участника (их 2):
// enc = { [uid]: {n, c} }. Так каждый читает своей парой ключей, включая автора.
export function sealForMembers(members, pubByUid, mySecretB64, text) {
  const out = {};
  for (const uid of members) {
    const pub = pubByUid[uid];
    if (!pub) throw new Error("У собеседника ещё нет ключа шифрования");
    out[uid] = encryptFor(pub, mySecretB64, text);
  }
  return out;
}

// Читаем свой конверт. senderPub нужен, потому что box привязан к паре (отправитель, получатель).
export function openForMe(message, meUid, senderPubB64, mySecretB64) {
  const mine = message?.enc?.[meUid];
  if (!mine) return null;
  return decryptFrom(senderPubB64, mySecretB64, mine);
}

// Отпечаток ключа для проверки «тот ли это собеседник» — сверяется голосом или лично.
export function fingerprint(pubB64) {
  if (!pubB64) return "";
  const h = nacl.hash(b64.dec(pubB64)).slice(0, 8);
  return [...h].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase().replace(/(.{4})/g, "$1 ").trim();
}
