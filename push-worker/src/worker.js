// SandyGram push-рассыльщик: cron раз в минуту читает Firestore и шлёт FCM
// Секрет SERVICE_ACCOUNT = содержимое service-account.json (wrangler secret put SERVICE_ACCOUNT)

const PROJECT = "sandygram-a3b42";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const RTDB_BASE = "https://sandygram-a3b42-default-rtdb.europe-west1.firebasedatabase.app";
const ONLINE_WINDOW = 70e3;
const QRLOGIN_TTL = 5 * 60e3; // refresh-токены в qrlogin не должны залёживаться дольше 5 минут

// ---------- OAuth из сервисного аккаунта (WebCrypto) ----------
let cachedToken = null; // { token, exp }
async function accessToken(env) {
  if (cachedToken && Date.now() < cachedToken.exp - 60e3) return cachedToken.token;
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const enc = new TextEncoder();
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64urlJson = (obj) => b64url(enc.encode(JSON.stringify(obj)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/firebase.database",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  // PEM → CryptoKey
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  }).then(x => x.json());
  if (!r.access_token) throw new Error("oauth: " + JSON.stringify(r));
  cachedToken = { token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 };
  return r.access_token;
}

// ---------- Firestore REST хелперы ----------
const val = (f) => {
  if (!f) return undefined;
  if ("stringValue" in f) return f.stringValue;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("doubleValue" in f) return f.doubleValue;
  if ("booleanValue" in f) return f.booleanValue;
  if ("nullValue" in f) return null;
  if ("mapValue" in f) return fromFields(f.mapValue.fields || {});
  if ("arrayValue" in f) return (f.arrayValue.values || []).map(val);
  return undefined;
};
const fromFields = (fields) => Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, val(v)]));

// Обратное преобразование: JS-значение -> формат полей Firestore REST
const toValue = (v) => {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  return { mapValue: { fields: toFields(v) } };
};
const toFields = (obj) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, toValue(v)]));

async function runQuery(H, structuredQuery) {
  const rows = await fetch(`${FS_BASE}:runQuery`, { method: "POST", headers: H, body: JSON.stringify({ structuredQuery }) }).then(r => r.json());
  return (rows || []).filter(r => r.document).map(r => ({ id: r.document.name.split("/").pop(), ...fromFields(r.document.fields) }));
}
async function getDocById(H, path) {
  const d = await fetch(`${FS_BASE}/${path}`, { headers: H }).then(r => r.json());
  if (d.error) return null;
  return { id: d.name.split("/").pop(), ...fromFields(d.fields) };
}
// последние сообщения чата (для @-упоминаний) — orderBy работает на списке без доп. индекса
async function listMessages(H, chatId, limit = 25) {
  const url = `${FS_BASE}/chats/${chatId}/messages?pageSize=${limit}&orderBy=${encodeURIComponent('"createdAt desc"')}`;
  const d = await fetch(url, { headers: H }).then(r => r.json());
  if (d.error) return [];
  return (d.documents || []).map(doc => ({ id: doc.name.split("/").pop(), ...fromFields(doc.fields) }));
}

// общая отправка FCM с чисткой мёртвых токенов
async function sendToTokens(H, user, { title, body, chatId }) {
  let sent = 0;
  for (const fcmToken of user.fcmTokens) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        message: {
          token: fcmToken,
          notification: { title, body: (body || "").slice(0, 200) },
          data: { chatId: chatId || "" },
          android: { priority: "high", notification: { channel_id: "default", tag: chatId || "" } },
        },
      }),
    }).then(r => r.json());
    if (res.error) {
      const code = res.error.status || "";
      if (code === "NOT_FOUND" || code === "UNREGISTERED" || code === "INVALID_ARGUMENT") {
        await fetch(`${FS_BASE}/users/${user.id}?updateMask.fieldPaths=fcmTokens`, {
          method: "PATCH", headers: H,
          body: JSON.stringify({ fields: { fcmTokens: { arrayValue: { values: user.fcmTokens.filter(t => t !== fcmToken).map(t => ({ stringValue: t })) } } } }),
        }).catch(() => {});
      }
    } else sent++;
  }
  return sent;
}

// ---------- отложенная отправка ----------
// Клиент кладёт задание в коллекцию scheduled, cron раз в минуту разносит созревшие.
async function deliverScheduled(H, now) {
  const due = await runQuery(H, {
    from: [{ collectionId: "scheduled" }],
    where: { fieldFilter: { field: { fieldPath: "sendAt" }, op: "LESS_THAN_OR_EQUAL", value: { integerValue: String(now) } } },
    orderBy: [{ field: { fieldPath: "sendAt" }, direction: "ASCENDING" }],
    limit: 50,
  });
  let delivered = 0;
  for (const job of due) {
    try {
      const chat = await getDocById(H, `chats/${job.chatId}`);
      // Задание могло переехать: чат удалён или автора выгнали — просто выбрасываем.
      if (!chat || !(chat.members || []).includes(job.uid)) {
        await fetch(`${FS_BASE}/scheduled/${job.id}`, { method: "DELETE", headers: H }).catch(() => {});
        continue;
      }
      const createdAt = Date.now();
      const message = {
        sender: job.uid, senderName: job.senderName || "", text: job.text || "", image: job.image || null,
        createdAt, reactions: {}, topicId: job.topicId || "general", scheduled: true,
        ...(job.media ? { media: job.media } : {}),
      };
      await fetch(`${FS_BASE}/chats/${job.chatId}/messages`, {
        method: "POST", headers: H, body: JSON.stringify({ fields: toFields(message) }),
      });
      // lastMessage и счётчики непрочитанного — как это делает клиент при обычной отправке
      const unread = Object.fromEntries((chat.members || [])
        .filter(uid => uid !== job.uid)
        .map(uid => [uid, ((chat.unread || {})[uid] || 0) + 1]));
      const lastMessage = {
        text: job.text || "", senderUid: job.uid, senderName: job.senderName || "",
        createdAt, hasImage: !!(job.image || job.media),
      };
      const mask = "updateMask.fieldPaths=lastMessage&" + Object.keys(unread).map(u => `updateMask.fieldPaths=unread.${u}`).join("&");
      await fetch(`${FS_BASE}/chats/${job.chatId}?${mask}`, {
        method: "PATCH", headers: H,
        body: JSON.stringify({ fields: { lastMessage: toValue(lastMessage), unread: toValue({ ...(chat.unread || {}), ...unread }) } }),
      });
      await fetch(`${FS_BASE}/scheduled/${job.id}`, { method: "DELETE", headers: H }).catch(() => {});
      delivered++;
    } catch (e) { console.error("scheduled job", job.id, String(e)); }
  }
  return delivered;
}

// ---------- исчезающие сообщения ----------
// В чате с ttl клиент ставит сообщению expiresAt; здесь просроченные реально удаляются.
async function purgeExpiring(H, now) {
  const chats = await runQuery(H, {
    from: [{ collectionId: "chats" }],
    where: { fieldFilter: { field: { fieldPath: "ttl" }, op: "GREATER_THAN", value: { integerValue: "0" } } },
    limit: 50,
  });
  let purged = 0;
  for (const chat of chats) {
    const url = `${FS_BASE}/chats/${chat.id}/messages?pageSize=100&orderBy=${encodeURIComponent('"createdAt asc"')}`;
    const d = await fetch(url, { headers: H }).then(r => r.json()).catch(() => null);
    for (const doc of d?.documents || []) {
      const m = fromFields(doc.fields);
      if (!m.expiresAt || m.expiresAt > now) continue;
      await fetch(`${FS_BASE}/chats/${chat.id}/messages/${doc.name.split("/").pop()}`, { method: "DELETE", headers: H }).catch(() => {});
      purged++;
    }
  }
  return purged;
}

// ---------- основной проход ----------
async function tick(env) {
  const token = await accessToken(env);
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // отметка прошлого запуска
  const meta = await getDocById(H, "meta/push");
  const lastRun = meta?.lastRun || (Date.now() - 120e3);
  const startedAt = Date.now();

  // чаты с новыми сообщениями (по возрастанию времени — чтобы при переполнении лимита
  // обрабатывать самые старые и безопасно продвигать метку lastRun, ничего не теряя)
  const PAGE = 200;
  const chats = await runQuery(H, {
    from: [{ collectionId: "chats" }],
    where: { fieldFilter: { field: { fieldPath: "lastMessage.createdAt" }, op: "GREATER_THAN", value: { integerValue: String(lastRun) } } },
    orderBy: [{ field: { fieldPath: "lastMessage.createdAt" }, direction: "ASCENDING" }],
    limit: PAGE,
  });

  const userCache = new Map();
  const getUser = async (uid) => {
    if (!userCache.has(uid)) userCache.set(uid, await getDocById(H, `users/${uid}`));
    return userCache.get(uid);
  };

  let sent = 0;
  const mentioned = new Set(); // uid — уже получили уведомление об @упоминании
  for (const chat of chats) {
    // @-упоминания: уведомляем тех, кого тегнули (даже если чат з нимтит для них), если они офлайн
    const recent = await listMessages(H, chat.id);
    for (const m of recent) {
      if ((m.createdAt || 0) <= lastRun || !Array.isArray(m.mentions)) continue;
      for (const uid of m.mentions) {
        if (!uid || uid === m.sender || mentioned.has(uid)) continue;
        const user = await getUser(uid);
        if (!user || !Array.isArray(user.fcmTokens) || !user.fcmTokens.length) continue;
        if (Date.now() - (user.lastSeen || 0) < ONLINE_WINDOW) continue;
        const senderName = typeof m.senderName === "string" && m.senderName ? m.senderName : "Кто-то";
        mentioned.add(uid);
        sent += await sendToTokens(H, user, { title: "🔔 Вас упомянули", body: `${senderName}: ${m.text || "📷 Фото"}`, chatId: chat.id });
      }
    }

    const lm = chat.lastMessage || {};
    if ((lm.createdAt || 0) <= lastRun) continue;
    for (const uid of chat.members || []) {
      if (uid === lm.senderUid) continue;
      if (mentioned.has(uid)) continue; // уже уведомили об упоминании
      if (!((chat.unread || {})[uid] > 0)) continue;
      if ((chat.muted || []).includes(uid)) continue;
      const user = await getUser(uid);
      if (!user || !Array.isArray(user.fcmTokens) || !user.fcmTokens.length) continue;
      if (Date.now() - (user.lastSeen || 0) < ONLINE_WINDOW) continue; // онлайн — пуш не нужен
      const isGroup = chat.type === "group";
      const title = isGroup ? (chat.title || "Группа") : (lm.senderName || "SandyGram");
      const body = (isGroup ? `${lm.senderName}: ` : "") + (lm.text || "📷 Фото");
      sent += await sendToTokens(H, user, { title, body, chatId: chat.id });
    }
  }

  // Отложенные сообщения и уборка исчезающих — на том же проходе cron.
  let scheduled = 0, expiring = 0;
  try { scheduled = await deliverScheduled(H, startedAt); } catch (e) { console.error("scheduled:", String(e)); }
  try { expiring = await purgeExpiring(H, startedAt); } catch (e) { console.error("expiring:", String(e)); }

  // Чистим просроченные QR-логины: в узлах qrlogin лежит refresh-токен телефона,
  // поэтому мёртвые/использованные записи удаляем каждую минуту (сервисный токен обходит правила RTDB).
  let qrCleaned = 0;
  try {
    const all = await fetch(`${RTDB_BASE}/qrlogin.json?access_token=${token}`).then(r => r.json()).catch(() => null);
    if (all && typeof all === "object") {
      const cutoff = startedAt - QRLOGIN_TTL;
      for (const [node, v] of Object.entries(all)) {
        const ts = (v && (v.at || v.created)) || 0;
        if (ts < cutoff) {
          await fetch(`${RTDB_BASE}/qrlogin/${encodeURIComponent(node)}.json?access_token=${token}`, { method: "DELETE" }).catch(() => {});
          qrCleaned++;
        }
      }
    }
  } catch (e) { console.error("qr cleanup:", String(e)); }

  // раз в час чистим просроченные истории
  let cleaned = 0;
  if (startedAt - (meta?.lastStoryCleanup || 0) > 3600e3) {
    const expired = await runQuery(H, {
      from: [{ collectionId: "stories" }],
      where: { fieldFilter: { field: { fieldPath: "expiresAt" }, op: "LESS_THAN", value: { integerValue: String(startedAt) } } },
      limit: 100,
    });
    for (const st of expired) {
      await fetch(`${FS_BASE}/stories/${st.id}`, { method: "DELETE", headers: H }).catch(() => {});
      cleaned++;
    }
    await fetch(`${FS_BASE}/meta/push?updateMask.fieldPaths=lastStoryCleanup`, {
      method: "PATCH", headers: H,
      body: JSON.stringify({ fields: { lastStoryCleanup: { integerValue: String(startedAt) } } }),
    });
  }

  // сохраняем отметку. Если упёрлись в лимит страницы — двигаем метку только до времени
  // последнего обработанного чата (список по возрастанию), чтобы не пропустить более новые.
  const newLastRun = chats.length >= PAGE
    ? Math.max(lastRun, ...chats.map(c => (c.lastMessage || {}).createdAt || 0))
    : startedAt;
  await fetch(`${FS_BASE}/meta/push?updateMask.fieldPaths=lastRun`, {
    method: "PATCH", headers: H,
    body: JSON.stringify({ fields: { lastRun: { integerValue: String(newLastRun) } } }),
  });
  return { chats: chats.length, sent, cleaned, qrCleaned, scheduled, expiring };
}

// ---------- QR-вход: refresh-токен → Firebase Custom Token ----------
// Телефон по QR-коду кладёт свой refresh-токен в RTDB qrlogin/<node> (см. app/App.js),
// веб забирает его и просит здесь выдать custom token для signInWithCustomToken.
const WEB_API_KEY = "AIzaSyAjGwFBdfll--_ohWWlaZmV3JT2ksRD7vk"; // публичный ключ из firebase-config.js веба

async function uidByRefreshToken(refreshToken) {
  const r = await fetch(`https://securetoken.googleapis.com/v1/token?key=${WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!r.ok) throw new Error(`securetoken HTTP ${r.status}`);
  const data = await r.json();
  let payload = data.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  payload += "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(atob(payload)).user_id;
}

async function customToken(env, uid) {
  const sa = JSON.parse(env.SERVICE_ACCOUNT);
  const enc = new TextEncoder();
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64urlJson = (obj) => b64url(enc.encode(JSON.stringify(obj)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson({
    iss: sa.client_email,
    sub: sa.client_email,
    aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
    iat: now, exp: now + 3600, uid,
  })}`;
  const pem = sa.private_key.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  return `${unsigned}.${b64url(sig)}`;
}

// ---------- Медиа в R2 ----------
// Раньше фото/голосовые лежали base64 внутри документа Firestore: лимит 1 МБ на документ,
// быстрое выжигание квоты и никаких видео. Теперь файл уходит в R2, а в сообщении
// остаётся только ключ. Ключи случайные (capability URL) — угадать чужой нельзя.
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_TYPES_OK = /^(image|video|audio)\/[a-z0-9.+-]+$|^application\/(pdf|zip|octet-stream)$/i;

// Проверка Firebase ID-токена: один вызов identitytoolkit, обратно uid.
async function uidByIdToken(idToken) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${WEB_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  return d?.users?.[0]?.localId || null;
}

const mediaKey = (uid, ext) => `${uid}/${crypto.randomUUID().replace(/-/g, "")}${ext}`;
const extOf = (type) => {
  const map = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
    "audio/mpeg": ".mp3", "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/ogg": ".ogg",
    "application/pdf": ".pdf", "application/zip": ".zip",
  };
  return map[String(type).toLowerCase()] || ".bin";
};

// Защита от SSRF: пускаем превью только на публичные http(s)-хосты,
// блокируя localhost, .local/.internal и приватные/loopback/link-local IP-адреса.
function isSafePreviewUrl(target) {
  let u;
  try { u = new URL(target); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "0.0.0.0" || host === "::" || host === "::1"
      || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const p = host.split(".").map(Number);
    if (p.some(n => n > 255)) return false;
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
    if (p[0] === 169 && p[1] === 254) return false;              // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;  // private
    if (p[0] === 192 && p[1] === 168) return false;              // private
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false; // CGNAT
    return true;
  }
  if (host.includes(":")) { // literal IPv6 — режем loopback/ULA/link-local
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8")
        || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) return false;
  }
  return true;
}

// Ограниченное по объёму чтение тела ответа (og-теги живут в начале документа)
async function readCapped(resp, maxBytes = 512 * 1024) {
  const reader = resp.body?.getReader();
  if (!reader) return (await resp.text()).slice(0, maxBytes);
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
    if (total >= maxBytes) { try { await reader.cancel(); } catch {} break; }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// CORS для браузера: QR-вход вызывается с веба (sandygram-a3b42.web.app) на workers.dev
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Media-Type, X-Media-Name",
  "Access-Control-Max-Age": "86400",
};
const json = (body, status = 200) => Response.json(body, { status, headers: CORS });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).then(r => console.log("tick:", JSON.stringify(r))).catch(e => console.error("tick error:", String(e))));
  },
  async fetch(request, env) {
    // preflight (браузер, cross-origin POST с Content-Type: application/json)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/run" && url.searchParams.get("key") === env.PING_KEY) {
      try { return json(await tick(env)); }
      catch (e) { return json({ error: String(e) }, 500); }
    }
    // QR-вход: POST {"refreshToken": "..."} -> {"token": "<Firebase Custom Token>"}
    if (request.method === "POST" && url.pathname === "/qr/exchange") {
      try {
        const body = await request.json();
        const refreshToken = String(body?.refreshToken || "").trim();
        if (!refreshToken) return json({ error: "refreshToken required" }, 400);
        const uid = await uidByRefreshToken(refreshToken);
        const token = await customToken(env, uid);
        return json({ token });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }
    // Загрузка медиа: POST /media/upload, тело = сырые байты.
    // Authorization: Bearer <Firebase ID token>, X-Media-Type: image/jpeg, X-Media-Name: имя файла.
    // Ответ: {key, url, size, type, name}
    if (request.method === "POST" && url.pathname === "/media/upload") {
      if (!env.MEDIA) return json({ error: "media storage not configured" }, 503);
      const idToken = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!idToken) return json({ error: "auth required" }, 401);
      const uid = await uidByIdToken(idToken);
      if (!uid) return json({ error: "bad token" }, 401);

      const type = (request.headers.get("x-media-type") || "application/octet-stream").split(";")[0].trim();
      if (!MEDIA_TYPES_OK.test(type)) return json({ error: "type not allowed" }, 415);
      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > MEDIA_MAX_BYTES) return json({ error: "too large", max: MEDIA_MAX_BYTES }, 413);

      const body = new Uint8Array(await request.arrayBuffer());
      if (!body.length) return json({ error: "empty body" }, 400);
      if (body.length > MEDIA_MAX_BYTES) return json({ error: "too large", max: MEDIA_MAX_BYTES }, 413);

      const key = mediaKey(uid, extOf(type));
      const name = (request.headers.get("x-media-name") || "").slice(0, 120);
      await env.MEDIA.put(key, body, {
        httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" },
        customMetadata: { uid, name, at: String(Date.now()) },
      });
      return json({ key, url: `${url.origin}/media/${key}`, size: body.length, type, name });
    }

    // Выдача медиа: GET /media/<uid>/<random>.<ext> — ключ случайный, поэтому чужой не угадать.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname.startsWith("/media/")) {
      if (!env.MEDIA) return json({ error: "media storage not configured" }, 503);
      const key = decodeURIComponent(url.pathname.slice("/media/".length));
      if (!key || key.includes("..")) return json({ error: "bad key" }, 400);
      const obj = await env.MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
      if (!obj) return new Response("not found", { status: 404, headers: CORS });
      const headers = new Headers(CORS);
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      headers.set("cache-control", "public, max-age=31536000, immutable");
      if (obj.range) headers.set("content-range", `bytes ${obj.range.offset}-${obj.range.offset + obj.range.length - 1}/${obj.size}`);
      headers.set("accept-ranges", "bytes");
      const hasBody = "body" in obj && obj.body;
      return new Response(request.method === "HEAD" || !hasBody ? null : obj.body, {
        status: obj.range ? 206 : (hasBody ? 200 : 304),
        headers,
      });
    }

    // Превью ссылок: GET /link-preview?url=... -> {url, title, desc, image}
    if (request.method === "GET" && url.pathname === "/link-preview") {
      try {
        const target = (url.searchParams.get("url") || "").trim();
        if (!isSafePreviewUrl(target)) return json({ error: "bad url" }, 400);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        let resp, current = target;
        try {
          // редиректы проверяем вручную — иначе через Location можно увести запрос на внутренний адрес
          for (let hop = 0; hop < 4; hop++) {
            resp = await fetch(current, { signal: ctrl.signal, redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; SandyGram LinkPreview)" } });
            if (resp.status < 300 || resp.status >= 400) break;
            const loc = resp.headers.get("location");
            if (!loc) break;
            current = new URL(loc, current).toString();
            if (!isSafePreviewUrl(current)) return json({ error: "blocked redirect" }, 400);
          }
        } finally { clearTimeout(timer); }
        const html = await readCapped(resp);
        const og = (prop) => {
          const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i");
          const m = html.match(re);
          return m ? m[1].replace(/&amp;/g, "&").trim() : "";
        };
        const title = og("og:title") || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || "";
        const desc = og("og:description") || og("description");
        const image = og("og:image") || og("twitter:image");
        return json({ url: target, title: title.slice(0, 200), desc: desc.slice(0, 300), image: image.slice(0, 1000) });
      } catch (e) { return json({ error: String(e) }, 502); }
    }
    return new Response("SandyGram push worker", { status: 200, headers: CORS });
  },
};
