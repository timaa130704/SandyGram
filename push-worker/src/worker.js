// SandyGram push-рассыльщик: cron раз в минуту читает Firestore и шлёт FCM
// Секрет SERVICE_ACCOUNT = содержимое service-account.json (wrangler secret put SERVICE_ACCOUNT)

const PROJECT = "sandygram-a3b42";
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const ONLINE_WINDOW = 70e3;

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
    scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging",
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

async function runQuery(H, structuredQuery) {
  const rows = await fetch(`${FS_BASE}:runQuery`, { method: "POST", headers: H, body: JSON.stringify({ structuredQuery }) }).then(r => r.json());
  return (rows || []).filter(r => r.document).map(r => ({ id: r.document.name.split("/").pop(), ...fromFields(r.document.fields) }));
}
async function getDocById(H, path) {
  const d = await fetch(`${FS_BASE}/${path}`, { headers: H }).then(r => r.json());
  if (d.error) return null;
  return { id: d.name.split("/").pop(), ...fromFields(d.fields) };
}

// ---------- основной проход ----------
async function tick(env) {
  const token = await accessToken(env);
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // отметка прошлого запуска
  const meta = await getDocById(H, "meta/push");
  const lastRun = meta?.lastRun || (Date.now() - 120e3);
  const startedAt = Date.now();

  // чаты с новыми сообщениями
  const chats = await runQuery(H, {
    from: [{ collectionId: "chats" }],
    where: { fieldFilter: { field: { fieldPath: "lastMessage.createdAt" }, op: "GREATER_THAN", value: { integerValue: String(lastRun) } } },
    limit: 50,
  });

  const userCache = new Map();
  const getUser = async (uid) => {
    if (!userCache.has(uid)) userCache.set(uid, await getDocById(H, `users/${uid}`));
    return userCache.get(uid);
  };

  let sent = 0;
  for (const chat of chats) {
    const lm = chat.lastMessage || {};
    if ((lm.createdAt || 0) <= lastRun) continue;
    for (const uid of chat.members || []) {
      if (uid === lm.senderUid) continue;
      if ((chat.unread || {})[uid] > 0 === false) continue;
      if ((chat.muted || []).includes(uid)) continue;
      const user = await getUser(uid);
      if (!user || !Array.isArray(user.fcmTokens) || !user.fcmTokens.length) continue;
      if (Date.now() - (user.lastSeen || 0) < ONLINE_WINDOW) continue; // онлайн — пуш не нужен
      const isGroup = chat.type === "group";
      const title = isGroup ? (chat.title || "Группа") : (lm.senderName || "SandyGram");
      const body = (isGroup ? `${lm.senderName}: ` : "") + (lm.text || "📷 Фото");
      for (const fcmToken of user.fcmTokens) {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${PROJECT}/messages:send`, {
          method: "POST", headers: H,
          body: JSON.stringify({
            message: {
              token: fcmToken,
              notification: { title, body: body.slice(0, 200) },
              data: { chatId: chat.id },
              android: { priority: "high", notification: { channel_id: "default", tag: chat.id } },
            },
          }),
        }).then(r => r.json());
        if (res.error) {
          const code = res.error.status || "";
          if (code === "NOT_FOUND" || code === "UNREGISTERED" || code === "INVALID_ARGUMENT") {
            // мёртвый токен — убираем
            await fetch(`${FS_BASE}/users/${uid}?updateMask.fieldPaths=fcmTokens`, {
              method: "PATCH", headers: H,
              body: JSON.stringify({ fields: { fcmTokens: { arrayValue: { values: user.fcmTokens.filter(t => t !== fcmToken).map(t => ({ stringValue: t })) } } } }),
            }).catch(() => {});
          }
        } else sent++;
      }
    }
  }

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

  // сохраняем отметку
  await fetch(`${FS_BASE}/meta/push?updateMask.fieldPaths=lastRun`, {
    method: "PATCH", headers: H,
    body: JSON.stringify({ fields: { lastRun: { integerValue: String(startedAt) } } }),
  });
  return { chats: chats.length, sent, cleaned };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env).then(r => console.log("tick:", JSON.stringify(r))).catch(e => console.error("tick error:", String(e))));
  },
  async fetch(request, env) {
    // ручной прогон для отладки: GET /run?key=<PING_KEY>
    const url = new URL(request.url);
    if (url.pathname === "/run" && url.searchParams.get("key") === env.PING_KEY) {
      try { return Response.json(await tick(env)); }
      catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
    }
    return new Response("SandyGram push worker", { status: 200 });
  },
};
