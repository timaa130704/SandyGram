"use strict";
// SandyGram 3.0 — сквозное шифрование секретных чатов (X25519 + XSalsa20-Poly1305).
// Публичный ключ лежит в users/{uid}.e2ePub, приватный НИКОГДА не покидает устройство.
// Сервер и правила Firestore видят только шифротекст: расшифровать его нельзя даже с
// полным доступом к базе — нужен приватный ключ участника.
//
// ВНИМАНИЕ: копия web/public/sge2e.js — отличается только строкой импорта nacl.
import nacl from "tweetnacl";
import * as Crypto from "expo-crypto";
// В React Native нет window.crypto — отдаём tweetnacl генератор случайных чисел из expo-crypto.
nacl.setPRNG((x, n) => {
  const bytes = Crypto.getRandomBytes(n);
  for (let i = 0; i < n; i++) x[i] = bytes[i];
});

// React Native не даёт btoa/atob/TextEncoder — реализуем сами, без зависимостей.
const B64A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const b64 = {
  enc(u8) {
    let out = "";
    for (let i = 0; i < u8.length; i += 3) {
      const a = u8[i], b = u8[i + 1], c = u8[i + 2];
      out += B64A[a >> 2] + B64A[((a & 3) << 4) | ((b || 0) >> 4)];
      out += i + 1 < u8.length ? B64A[((b & 15) << 2) | ((c || 0) >> 6)] : "=";
      out += i + 2 < u8.length ? B64A[c & 63] : "=";
    }
    return out;
  },
  dec(s) {
    const clean = String(s).replace(/[^A-Za-z0-9+/]/g, "");
    const out = new Uint8Array((clean.length * 3) >> 2);
    let p = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64A.indexOf(clean[i]) << 18) | (B64A.indexOf(clean[i + 1]) << 12)
        | ((B64A.indexOf(clean[i + 2]) & 63) << 6) | (B64A.indexOf(clean[i + 3]) & 63);
      out[p++] = (n >> 16) & 255;
      if (i + 2 < clean.length) out[p++] = (n >> 8) & 255;
      if (i + 3 < clean.length) out[p++] = n & 255;
    }
    return out.subarray(0, p);
  },
};
const utf8 = {
  enc(s) {
    const str = unescape(encodeURIComponent(String(s)));
    const u8 = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) u8[i] = str.charCodeAt(i);
    return u8;
  },
  dec(u8) {
    let str = "";
    for (let i = 0; i < u8.length; i++) str += String.fromCharCode(u8[i]);
    return decodeURIComponent(escape(str));
  },
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
