"use strict";
// SandyGram на Firebase: без своего сервера — Auth + Firestore (realtime) + Hosting.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, connectAuthEmulator, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, deleteUser,
  GoogleAuthProvider, signInWithPopup,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc,
  deleteDoc, collection, query, where, orderBy, limit, onSnapshot, runTransaction,
  arrayUnion, arrayRemove, increment, writeBatch, deleteField,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getMessaging, getToken } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js";
import { getDatabase, ref as dbRef, onValue, onChildAdded, set as dbSet, update as dbUpdate, push as dbPush, remove as dbRemove } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

const fbApp = initializeApp(window.FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const dbf = getFirestore(fbApp);
if (window.USE_EMULATORS) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(dbf, "127.0.0.1", 8090);
}

const $ = (s) => document.querySelector(s);

// ---------- state ----------
let me = null;                     // {uid, username, displayName, bio, avatarColor}
let chats = new Map();             // chatId -> данные чата (raw doc)
let currentChatId = null;
let currentTopic = null;
let replyTarget = null;
let editTarget = null;
let messages = [];                 // все сообщения текущего чата (raw)
let authMode = "register";
let chatsUnsub = null;
let messagesUnsub = null;
const peerUnsubs = new Map();      // uid -> unsub (профили собеседников в ЛС)
const userCache = new Map();       // uid -> профиль
let lastTypingSent = 0;
let heartbeatTimer = null;
let mentionPool = [];     // участники открытого чата для @-пикера
let mentionMatch = "";    // текущий набранный @префикс
let lastMentionAt = 0;    // последнее уведомление об @упоминании

const EMOJI = "😀 😃 😄 😁 😆 😅 😂 🙂 🙃 😉 😊 😍 🥰 😘 😎 🤓 🤔 😐 😶 🙄 😏 😮 😪 🥱 😴 😌 😋 😜 🤪 🤗 🤭 🤫 😱 😨 😭 😤 😡 🤯 😳 🥳 🤩 🥺 🤢 🤧 😷 🤑 👋 ✋ 🤝 👍 👎 👌 ✌️ 🤞 🙏 💪 👀 ❤️ 🖤 🤍 💔 💯 🔥 ⭐ ✨ 🎉 🎁 🎯 🚀 ⚡ ☕ 🍕 🌙 ☀️".split(" ");
const QUICK_REACTIONS = ["❤️", "👍", "🔥", "😂", "😮", "😢"];
const ONLINE_WINDOW = 70e3; // «в сети», если lastSeen свежее этого
// Сигнальная шина на RTDB: пишем «в чате что-то произошло», чтобы ПК-клиент не опрашивал Firestore
const RTDB = "https://sandygram-a3b42-default-rtdb.europe-west1.firebasedatabase.app";
const rtdb = getDatabase(fbApp, RTDB);
async function bumpChat(chatId) {
  try {
    const t = await auth.currentUser.getIdToken();
    fetch(`${RTDB}/bump/${encodeURIComponent(chatId)}.json?auth=${t}`, { method: "PUT", body: String(Date.now()) }).catch(() => {});
  } catch { /* не критично */ }
}
// Коды OpenMoji из public/stickers/
const STICKERS = ["1F600","1F602","1F60D","1F60E","1F914","1F644","1F62D","1F621","1F973","1F97A","1F480","1F4A9","1F525","2764","1F44D","1F44E","1F44C","1F64F","1F4AA","1F440","1F389","1F680","26A1","1F31A","1F31D","1F63B","1F63C","1F998","1F984","1F37F"];

// ---------- utils ----------
function escapeHtml(v) { return String(v).replace(/[&<>'"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c])); }
function formatMessageText(text) {
  return escapeHtml(text).replace(/(^|[\s.,:;!?()«»"'-])@([a-z0-9_]{3,24})\b/gi, (_, pre, name) => `${pre}<button type="button" class="mention" data-user="${name.toLowerCase()}">@${name}</button>`);
}
function toast(msg) { const n = $("#toast"); n.textContent = msg; n.classList.add("show"); clearTimeout(n._t); n._t = setTimeout(() => n.classList.remove("show"), 2500); }
function randomId(len = 18) { const a = new Uint8Array(len); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, len); }
function formatTime(ts) { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
function formatDay(ts) {
  const d = new Date(ts), today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Сегодня";
  if (d.toDateString() === yesterday.toDateString()) return "Вчера";
  return d.toLocaleDateString([], { day: "numeric", month: "long" });
}
function formatChatTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return formatTime(ts);
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}
function isOnlineUser(u) { return u && Date.now() - (u.lastSeen || 0) < ONLINE_WINDOW; }
function formatLastSeen(u) {
  if (!u) return "";
  if (u.hideLastSeen) return "был(а) недавно"; // приватность: точное время скрыто
  if (isOnlineUser(u)) return "в сети";
  if (!u.lastSeen) return "был(а) недавно";
  const diff = Date.now() - u.lastSeen;
  if (diff < 60e3) return "был(а) только что";
  if (diff < 3600e3) return `был(а) ${Math.floor(diff / 60e3)} мин назад`;
  if (new Date(u.lastSeen).toDateString() === new Date().toDateString()) return `был(а) в ${formatTime(u.lastSeen)}`;
  return `был(а) ${new Date(u.lastSeen).toLocaleDateString([], { day: "2-digit", month: "2-digit" })}`;
}
const emailFor = (username) => `${username}@sandygram.app`;

// ---------- модерация /длительности ----------
function parseDuration(s) {
  s = (s || "").trim().toLowerCase();
  if (!s) return null;
  if (/^(off|0|нет|снять)$/.test(s)) return 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60e3; // голое число = минуты
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/);
  if (!m) return null;
  const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 864e5, w: 6048e5 }[m[2]];
  return Math.round(parseFloat(m[1]) * mult);
}
function fmtDuration(ms) {
  if (!ms) return "навсегда";
  const h = ms / 3600e3;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60e3))} мин`;
  if (h < 24) return `${Math.round(h * 10) / 10} ч`;
  return `${Math.round(h / 24 * 10) / 10} д`;
}
function fmtUntil(ms) {
  if (!ms) return "навсегда";
  const d = new Date(ms);
  return `${d.toLocaleDateString("ru", { day: "numeric", month: "short" })} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
// Аватар: фото, если есть, иначе буква
function avatarHtml(color, letter, photo, cls = "avatar") {
  const inner = photo ? `<img src="${escapeHtml(photo)}" alt="" />` : escapeHtml(letter);
  return `<span class="${cls}" data-color="${color}">${inner}</span>`;
}

// ---------- theme ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "light" ? "#f4f4f4" : "#0a0a0a";
  const label = $("#themeLabel"); if (label) label.textContent = theme === "light" ? "светлая" : "тёмная";
}
applyTheme(localStorage.getItem("drigagram_theme") || "dark");

// ---------- вью чата (title, peer, unread…) ----------
function viewOf(chat) {
  const v = {
    id: chat.id, type: chat.type,
    pinned: (chat.pinnedBy || []).includes(me.uid),
    muted: (chat.muted || []).includes(me.uid),
    unread: (chat.unread || {})[me.uid] || 0,
    lastMessage: chat.lastMessage || null,
    lastReadByOthers: Math.max(0, ...Object.entries(chat.lastRead || {}).filter(([u]) => u !== me.uid).map(([, t]) => t)),
    memberCount: (chat.members || []).length,
    raw: chat,
  };
  if (chat.type === "saved") { v.title = "Избранное"; v.avatarColor = -1; }
  else if (chat.type === "private") {
    const peerUid = (chat.members || []).find(m => m !== me.uid);
    const peer = userCache.get(peerUid);
    v.peerUid = peerUid;
    v.peer = peer || null;
    v.title = peer?.displayName || "…";
    v.avatarColor = peer?.avatarColor ?? 0;
    v.photo = peer?.avatar || null;
  } else {
    v.title = chat.title;
    v.avatarColor = chat.avatarColor || 0;
    v.photo = chat.avatar || null;
  }
  return v;
}
function currentChat() { return currentChatId ? chats.get(currentChatId) : null; }
function currentView() { const c = currentChat(); return c ? viewOf(c) : null; }
function isForum(chat) { return !!(chat?.topics && chat.topics.length); }
function isChatAdmin(chat) { return (chat?.type === "group" || chat?.type === "channel") && (chat.ownerUid === me.uid || (chat.admins || []).includes(me.uid)); }
let myPrefs = { blocked: [], hideLastSeen: false };
async function loadMyPrefs() {
  const p = await getDoc(doc(dbf, "users", me.uid, "private", "prefs")).catch(() => null);
  myPrefs = { blocked: [], hideLastSeen: false, ...(p?.exists() ? p.data() : {}) };
  const label = $("#lastSeenLabel"); if (label) label.textContent = me.hideLastSeen ? "вкл" : "выкл";
}
function topicsView(chat) {
  const all = [{ id: "general", title: "Общий", icon: "#", createdAt: chat.createdAt, closed: !!chat.generalClosed }, ...(chat.topics || [])];
  const lastFor = (tid) => [...messages].reverse().find(m => !m.deleted && (m.topicId || "general") === tid) || null;
  return all.map(t => ({ ...t, lastMessage: currentChatId === chat.id ? lastFor(t.id) : null }))
    .sort((a, b) => (b.lastMessage?.createdAt || b.createdAt || 0) - (a.lastMessage?.createdAt || a.createdAt || 0));
}

// ---------- auth ----------
document.querySelectorAll(".segment").forEach(b => b.addEventListener("click", () => {
  authMode = b.dataset.mode;
  document.querySelectorAll(".segment").forEach(x => x.classList.toggle("active", x === b));
  $("#submitButton").textContent = authMode === "register" ? "Создать аккаунт" : "Войти";
  $("#authError").textContent = "";
}));

$("#authForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#submitButton"); button.disabled = true; $("#authError").textContent = "";
  const username = $("#username").value.trim().toLowerCase().replace(/^@/, "");
  const password = $("#password").value;
  try {
    if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error("Имя: 3–24 символа, только латиница, цифры и _.");
    if (password.length < 6) throw new Error("Пароль: минимум 6 символов.");
    if (authMode === "register") await register(username, password);
    else await login(username, password);
  } catch (error) { $("#authError").textContent = ruError(error); }
  finally { button.disabled = false; }
});
function ruError(error) {
  const code = error?.code || "";
  if (code.includes("email-already-in-use")) return "Такой пользователь уже существует.";
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Неверное имя пользователя или пароль.";
  if (code.includes("too-many-requests")) return "Слишком много попыток. Подождите минуту.";
  if (code.includes("network-request-failed")) return "Нет соединения. Проверьте интернет.";
  return error.message || "Ошибка";
}
async function register(username, password) {
  const taken = await getDoc(doc(dbf, "usernames", username));
  let cred = null;
  if (taken.exists()) {
    // Имя занято. Возможно, это наша же оборванная регистрация — пробуем войти
    try {
      const c = await signInWithEmailAndPassword(auth, taken.data().email || emailFor(username), password);
      if (taken.data().uid && taken.data().uid !== c.user.uid) { await signOut(auth); throw new Error(); }
      cred = c;
    } catch { throw new Error("Такой пользователь уже существует."); }
  } else {
    try { cred = await createUserWithEmailAndPassword(auth, emailFor(username), password); }
    catch (error) {
      if ((error?.code || "").includes("email-already-in-use")) {
        cred = await signInWithEmailAndPassword(auth, emailFor(username), password);
      } else throw error;
    }
  }
  // Дописываем недостающие документы (повторная попытка = самопочинка)
  const uid = cred.user.uid;
  await setDoc(doc(dbf, "usernames", username), { uid, email: emailFor(username) }).catch(() => {});
  const prof = await getDoc(doc(dbf, "users", uid));
  if (!prof.exists()) {
    await setDoc(doc(dbf, "users", uid), {
      username, displayName: username, bio: "",
      avatarColor: Math.floor(Math.random() * 7),
      createdAt: Date.now(), lastSeen: Date.now(),
    });
  }
  const saved = await getDoc(doc(dbf, "chats", `saved_${uid}`));
  if (!saved.exists()) {
    await setDoc(doc(dbf, "chats", `saved_${uid}`), {
      type: "saved", members: [uid], createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [],
    });
  }
}
async function login(username, password) {
  const reg = await getDoc(doc(dbf, "usernames", username));
  const email = reg.exists() ? reg.data().email : emailFor(username);
  await signInWithEmailAndPassword(auth, email, password);
}
$("#logoutButton").addEventListener("click", async () => {
  $("#settingsPanel").classList.add("hidden");
  await signOut(auth);
});

// ---------- вход через Google ----------
$("#googleButton").addEventListener("click", async () => {
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (error) {
    if (!(error?.code || "").includes("popup-closed")) $("#authError").textContent = ruError(error);
  }
});

// Первый вход через Google: аккаунта в базе ещё нет — просим выбрать @username
function promptNewUsername(user) {
  return new Promise((resolve) => {
    const suggest = (user.email || "user").split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) || "user";
    openModal(`<h3>Придумайте @username</h3>
      <p class="muted" style="font-size:13px;margin-bottom:10px">Вы вошли через Google. Осталось выбрать имя, по которому вас смогут найти.</p>
      <label class="field"><span>Username</span><input id="pickUsername" maxlength="24" value="${escapeHtml(suggest)}" autocapitalize="off" /></label>
      <p class="error" id="pickError"></p>
      <div class="modal-actions"><button class="cancel">Выйти</button><button class="confirm">Готово</button></div>`);
    $("#modal .cancel").addEventListener("click", () => { closeModal(); resolve(null); });
    $("#modal .confirm").addEventListener("click", async () => {
      const name = $("#pickUsername").value.trim().toLowerCase().replace(/^@/, "");
      if (!/^[a-z0-9_]{3,24}$/.test(name)) { $("#pickError").textContent = "3–24 символа: латиница, цифры и _"; return; }
      try {
        const taken = await getDoc(doc(dbf, "usernames", name));
        if (taken.exists() && taken.data().uid !== user.uid) { $("#pickError").textContent = "Это имя уже занято."; return; }
        const profile = {
          username: name, displayName: (user.displayName || name).slice(0, 40), bio: "",
          avatarColor: Math.floor(Math.random() * 7), createdAt: Date.now(), lastSeen: Date.now(),
        };
        if (user.photoURL) profile.avatar = user.photoURL;
        await setDoc(doc(dbf, "usernames", name), { uid: user.uid, email: user.email || emailFor(name), google: true });
        await setDoc(doc(dbf, "users", user.uid), profile);
        await setDoc(doc(dbf, "chats", `saved_${user.uid}`), { type: "saved", members: [user.uid], createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] }).catch(() => {});
        closeModal(); resolve(profile);
      } catch (error) { $("#pickError").textContent = ruError(error); }
    });
  });
}

// Восстановление профиля, если регистрация когда-то оборвалась на полпути:
// имя находим по uid в реестре usernames и создаём недостающие документы
async function recoverProfile(uid) {
  try {
    const snap = await getDocs(query(collection(dbf, "usernames"), where("uid", "==", uid), limit(1)));
    if (snap.empty) return null;
    const name = snap.docs[0].id;
    const profile = { username: name, displayName: name, bio: "", avatarColor: Math.floor(Math.random() * 7), createdAt: Date.now(), lastSeen: Date.now() };
    await setDoc(doc(dbf, "users", uid), profile);
    await setDoc(doc(dbf, "chats", `saved_${uid}`), { type: "saved", members: [uid], createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] }).catch(() => {});
    return profile;
  } catch { return null; }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { teardown(); showAuth(); return; }
  // При регистрации auth срабатывает раньше, чем запишется профиль — ждём документ
  let profile = null;
  for (let i = 0; i < 5 && !profile; i++) {
    const p = await getDoc(doc(dbf, "users", user.uid)).catch(() => null);
    if (p?.exists()) profile = p.data();
    else await new Promise(r => setTimeout(r, 600));
  }
  if (!profile) profile = await recoverProfile(user.uid); // оборванная регистрация — чиним
  if (!profile) profile = await promptNewUsername(user);  // новый вход через Google — выбираем имя
  if (!profile) { await signOut(auth); return; }
  me = { uid: user.uid, ...profile };
  showMessenger();
});

function showAuth() {
  $("#messengerShell").classList.add("hidden");
  $("#authShell").classList.remove("hidden");
}
function teardown() {
  chatsUnsub?.(); chatsUnsub = null;
  storiesUnsub?.(); storiesUnsub = null;
  stories = [];
  messagesUnsub?.(); messagesUnsub = null;
  for (const unsub of peerUnsubs.values()) unsub();
  peerUnsubs.clear(); userCache.clear();
  clearInterval(heartbeatTimer);
  me = null; chats = new Map(); currentChatId = null; currentTopic = null; messages = [];
}
function showMessenger() {
  $("#authShell").classList.add("hidden");
  $("#messengerShell").classList.remove("hidden");
  renderProfile();
  loadMyPrefs();
  subscribeChats();
  startPresence();
  maybeJoinInvite();
  initWebPush();
  subscribeStories();
  listenIncomingCalls();
}

// ================================================================ ЗВОНКИ (WebRTC, сигналинг через RTDB)
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
];
let pc = null;                 // RTCPeerConnection
let localStream = null;
let activeCall = null;         // { calleeUid, callId, isCaller, video }
let callsListenerStarted = false;
let incomingPending = null;    // { callId, data }

function callPath(calleeUid, callId) { return `calls/${calleeUid}/${callId}`; }

async function startCall(video) {
  const v = currentView();
  if (!v || v.type !== "private" || !v.peer) return;
  if (activeCall) return toast("Уже идёт звонок");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
  } catch { return toast("Нет доступа к микрофону/камере"); }
  const callId = randomId(16);
  activeCall = { calleeUid: v.peerUid, callId, isCaller: true, video };
  openCallUI(v.peer, video, "Вызов…");
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  $("#localVideo").srcObject = video ? localStream : null;
  pc.ontrack = (e) => { $("#remoteVideo").srcObject = e.streams[0]; $("#callStatus").textContent = "Идёт разговор"; startCallTimer(); };
  pc.onicecandidate = (e) => {
    if (e.candidate) dbPush(dbRef(rtdb, `${callPath(v.peerUid, callId)}/iceFrom`), JSON.stringify(e.candidate)).catch(() => {});
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await dbSet(dbRef(rtdb, callPath(v.peerUid, callId)), {
    from: me.uid, fromName: me.displayName || me.username, fromAvatar: me.avatar || null, fromColor: me.avatarColor ?? 0,
    video, offer: JSON.stringify(offer), status: "ringing", createdAt: Date.now(),
  });
  // ждём ответ и ICE от собеседника
  onValue(dbRef(rtdb, `${callPath(v.peerUid, callId)}/answer`), async (snap) => {
    const val = snap.val();
    if (val && pc && !pc.currentRemoteDescription) await pc.setRemoteDescription(JSON.parse(val)).catch(() => {});
  });
  onChildAdded(dbRef(rtdb, `${callPath(v.peerUid, callId)}/iceTo`), (snap) => {
    if (pc) pc.addIceCandidate(JSON.parse(snap.val())).catch(() => {});
  });
  onValue(dbRef(rtdb, `${callPath(v.peerUid, callId)}/status`), (snap) => {
    const st = snap.val();
    if (st === "declined") { toast("Звонок отклонён"); endCall(false); }
    if (st === "ended" && activeCall) endCall(false);
  });
}

function listenIncomingCalls() {
  if (callsListenerStarted) return;
  callsListenerStarted = true;
  onChildAdded(dbRef(rtdb, `calls/${me.uid}`), (snap) => {
    const data = snap.val();
    if (!data || data.status !== "ringing" || Date.now() - (data.createdAt || 0) > 60e3) return;
    if (activeCall) { dbUpdate(dbRef(rtdb, callPath(me.uid, snap.key)), { status: "declined" }).catch(() => {}); return; }
    incomingPending = { callId: snap.key, data };
    $("#incomingAvatar").innerHTML = avatarHtml(data.fromColor ?? 0, (data.fromName || "?")[0].toUpperCase(), data.fromAvatar);
    $("#incomingName").textContent = data.fromName || "Звонок";
    $("#incomingKind").textContent = data.video ? "Входящий видеозвонок" : "Входящий звонок";
    $("#incomingCall").classList.remove("hidden");
    // если за минуту не ответили — прячем
    setTimeout(() => { if (incomingPending?.callId === snap.key) { $("#incomingCall").classList.add("hidden"); incomingPending = null; } }, 60e3);
  });
}

$("#acceptBtn").addEventListener("click", async () => {
  if (!incomingPending) return;
  const { callId, data } = incomingPending;
  incomingPending = null;
  $("#incomingCall").classList.add("hidden");
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: !!data.video });
  } catch { dbUpdate(dbRef(rtdb, callPath(me.uid, callId)), { status: "declined" }); return toast("Нет доступа к микрофону/камере"); }
  activeCall = { calleeUid: me.uid, callId, isCaller: false, video: !!data.video };
  openCallUI({ displayName: data.fromName, avatarColor: data.fromColor, avatar: data.fromAvatar }, !!data.video, "Соединение…");
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  $("#localVideo").srcObject = data.video ? localStream : null;
  pc.ontrack = (e) => { $("#remoteVideo").srcObject = e.streams[0]; $("#callStatus").textContent = "Идёт разговор"; startCallTimer(); };
  pc.onicecandidate = (e) => {
    if (e.candidate) dbPush(dbRef(rtdb, `${callPath(me.uid, callId)}/iceTo`), JSON.stringify(e.candidate)).catch(() => {});
  };
  await pc.setRemoteDescription(JSON.parse(data.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await dbUpdate(dbRef(rtdb, callPath(me.uid, callId)), { answer: JSON.stringify(answer), status: "accepted" });
  onChildAdded(dbRef(rtdb, `${callPath(me.uid, callId)}/iceFrom`), (snap) => {
    if (pc) pc.addIceCandidate(JSON.parse(snap.val())).catch(() => {});
  });
  onValue(dbRef(rtdb, `${callPath(me.uid, callId)}/status`), (snap) => {
    if (snap.val() === "ended" && activeCall) endCall(false);
  });
});

$("#declineBtn").addEventListener("click", () => {
  if (!incomingPending) return;
  dbUpdate(dbRef(rtdb, callPath(me.uid, incomingPending.callId)), { status: "declined" }).catch(() => {});
  $("#incomingCall").classList.add("hidden");
  incomingPending = null;
});

let callTimerInt = null;
let callStartTs = 0;
function startCallTimer() {
  if (callTimerInt) return;
  callStartTs = Date.now();
  callTimerInt = setInterval(() => {
    const sec = Math.floor((Date.now() - callStartTs) / 1000);
    $("#callStatus").textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }, 1000);
}

function openCallUI(peer, video, status) {
  $("#callAvatar").innerHTML = avatarHtml(peer.avatarColor ?? 0, (peer.displayName || "?")[0].toUpperCase(), peer.avatar);
  $("#callName").textContent = peer.displayName || "";
  $("#callStatus").textContent = status;
  $("#camBtn").classList.toggle("hidden", !video);
  $("#localVideo").style.display = video ? "block" : "none";
  $("#muteBtn").classList.remove("off");
  $("#camBtn").classList.remove("off");
  $("#callOverlay").classList.remove("hidden");
}

function endCall(signal = true) {
  if (signal && activeCall)
    dbUpdate(dbRef(rtdb, callPath(activeCall.calleeUid, activeCall.callId)), { status: "ended" }).catch(() => {});
  if (activeCall) {
    const p = callPath(activeCall.calleeUid, activeCall.callId);
    setTimeout(() => dbRemove(dbRef(rtdb, p)).catch(() => {}), 3000);
  }
  try { pc?.close(); } catch {}
  pc = null;
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
  activeCall = null;
  clearInterval(callTimerInt); callTimerInt = null;
  $("#remoteVideo").srcObject = null;
  $("#localVideo").srcObject = null;
  $("#callOverlay").classList.add("hidden");
}

$("#hangupBtn").addEventListener("click", () => endCall(true));
$("#muteBtn").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("#muteBtn").classList.toggle("off", !track.enabled);
});
$("#camBtn").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("#camBtn").classList.toggle("off", !track.enabled);
});
$("#audioCallBtn").addEventListener("click", () => startCall(false));
$("#videoCallBtn").addEventListener("click", () => startCall(true));
window.addEventListener("beforeunload", () => { if (activeCall) endCall(true); });

// ---------- истории ----------
let stories = [];            // все живые истории
let storiesUnsub = null;
let viewerList = [];         // истории открытого юзера
let viewerIndex = 0;
let viewerTimer = null;

function subscribeStories() {
  storiesUnsub?.();
  const q = query(collection(dbf, "stories"), where("expiresAt", ">", Date.now()));
  storiesUnsub = onSnapshot(q, (snap) => {
    stories = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(st => st.expiresAt > Date.now());
    renderStoriesBar();
  }, () => {});
}

function renderStoriesBar() {
  const bar = $("#storiesBar");
  if (!bar) return;
  bar.replaceChildren();
  const byUser = new Map();
  for (const st of stories.sort((a, b) => a.createdAt - b.createdAt)) {
    if (!byUser.has(st.uid)) byUser.set(st.uid, []);
    byUser.get(st.uid).push(st);
  }
  // моя ячейка всегда первая
  const mine = byUser.get(me.uid) || [];
  const myBtn = document.createElement("button");
  myBtn.className = "story-circle me" + (mine.length ? "" : " story-plus");
  myBtn.innerHTML = `<span class="ring">${avatarHtml(me.avatarColor, (me.displayName || me.username)[0].toUpperCase(), me.avatar)}</span><small>Моя история</small>`;
  myBtn.addEventListener("click", () => mine.length ? openStoryViewer(me.uid) : $("#storyInput").click());
  bar.appendChild(myBtn);
  byUser.delete(me.uid);
  // остальные — непросмотренные первыми
  const others = [...byUser.entries()].sort(([, a], [, b]) => {
    const unA = a.some(st => !(st.views || {})[me.uid]) ? 0 : 1;
    const unB = b.some(st => !(st.views || {})[me.uid]) ? 0 : 1;
    return unA - unB || b[b.length - 1].createdAt - a[a.length - 1].createdAt;
  });
  for (const [uid, list] of others) {
    const first = list[0];
    const unseen = list.some(st => !(st.views || {})[me.uid]);
    const btn = document.createElement("button");
    btn.className = "story-circle" + (unseen ? " unseen" : "");
    btn.innerHTML = `<span class="ring">${avatarHtml(first.avatarColor ?? 0, (first.displayName || "?")[0].toUpperCase(), first.avatar)}</span><small>${escapeHtml(first.displayName || first.username)}</small>`;
    btn.addEventListener("click", () => openStoryViewer(uid));
    bar.appendChild(btn);
  }
}

$("#storyInput").addEventListener("change", async () => {
  const file = $("#storyInput").files[0];
  $("#storyInput").value = "";
  if (!file) return;
  let image = await compressImage(file, 1080, 0.8);
  if (image && image.length > 700_000) image = await compressImage(file, 720, 0.6);
  if (!image) return toast("Не удалось обработать фото");
  try {
    await setDoc(doc(collection(dbf, "stories")), {
      uid: me.uid, username: me.username, displayName: me.displayName || me.username,
      avatar: me.avatar || null, avatarColor: me.avatarColor ?? 0,
      image, createdAt: Date.now(), expiresAt: Date.now() + 86400e3, views: {},
    });
    toast("История опубликована на 24 часа");
  } catch (error) { toast(ruError(error)); }
});

function openStoryViewer(uid) {
  viewerList = stories.filter(st => st.uid === uid).sort((a, b) => a.createdAt - b.createdAt);
  if (!viewerList.length) return;
  viewerIndex = viewerList.findIndex(st => !(st.views || {})[me.uid]);
  if (viewerIndex < 0) viewerIndex = 0;
  $("#storyViewer").classList.remove("hidden");
  showStory();
}
function showStory() {
  const st = viewerList[viewerIndex];
  if (!st) return closeStoryViewer();
  $("#storyImage").src = st.image;
  $("#storyAvatar").innerHTML = avatarHtml(st.avatarColor ?? 0, (st.displayName || "?")[0].toUpperCase(), st.avatar);
  $("#storyName").textContent = st.uid === me.uid ? "Моя история" : (st.displayName || st.username);
  const mins = Math.max(1, Math.round((Date.now() - st.createdAt) / 60e3));
  $("#storyTime").textContent = mins < 60 ? `${mins} мин назад` : `${Math.round(mins / 60)} ч назад`;
  $("#storyDelete").hidden = st.uid !== me.uid;
  $("#storyAdd").hidden = st.uid !== me.uid;
  $("#storyViews").textContent = st.uid === me.uid ? `👁 ${Object.keys(st.views || {}).length}` : "";
  // прогресс
  const prog = $("#storyProgress");
  prog.innerHTML = viewerList.map((_, i) =>
    `<i class="${i < viewerIndex ? "done" : i === viewerIndex ? "active" : ""}"><b></b></i>`).join("");
  // отметка просмотра
  if (st.uid !== me.uid && !(st.views || {})[me.uid]) {
    updateDoc(doc(dbf, "stories", st.id), { [`views.${me.uid}`]: Date.now() }).catch(() => {});
    st.views = { ...(st.views || {}), [me.uid]: Date.now() };
  }
  clearTimeout(viewerTimer);
  viewerTimer = setTimeout(nextStory, 5000);
}
function nextStory() {
  if (viewerIndex < viewerList.length - 1) { viewerIndex++; showStory(); }
  else closeStoryViewer();
}
function prevStory() {
  if (viewerIndex > 0) { viewerIndex--; showStory(); }
}
function closeStoryViewer() {
  clearTimeout(viewerTimer);
  $("#storyViewer").classList.add("hidden");
  renderStoriesBar();
}
$("#storyClose").addEventListener("click", closeStoryViewer);
$("#storyNext").addEventListener("click", nextStory);
$("#storyPrev").addEventListener("click", prevStory);
$("#storyAdd").addEventListener("click", () => { closeStoryViewer(); $("#storyInput").click(); });
$("#storyDelete").addEventListener("click", async () => {
  const st = viewerList[viewerIndex];
  if (!st || st.uid !== me.uid) return;
  clearTimeout(viewerTimer);
  try { await deleteDoc(doc(dbf, "stories", st.id)); toast("История удалена"); } catch (error) { toast(ruError(error)); }
  closeStoryViewer();
});

// Веб-пуши: включаются, когда в firebase-config.js задан VAPID_KEY
async function initWebPush() {
  try {
    if (!window.VAPID_KEY || window.USE_EMULATORS) return;
    if (!("serviceWorker" in navigator) || !("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const messaging = getMessaging(fbApp);
    const tok = await getToken(messaging, { vapidKey: window.VAPID_KEY, serviceWorkerRegistration: reg });
    if (tok) await updateDoc(doc(dbf, "users", me.uid), { fcmTokens: arrayUnion(tok) }).catch(() => {});
  } catch { /* пуши не критичны */ }
}

// ---------- presence (heartbeat вместо WebSocket) ----------
function heartbeat() {
  if (!me || document.hidden) return;
  updateDoc(doc(dbf, "users", me.uid), { lastSeen: Date.now() }).catch(() => {});
}
function startPresence() {
  heartbeat();
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => { heartbeat(); renderChatList(); renderConversationHeader(); }, 30e3);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    heartbeat();
    const v = currentView();
    if (v?.unread) markRead(currentChatId);
  }
});

// ---------- подписка на чаты ----------
function subscribeChats() {
  chatsUnsub?.();
  const q = query(collection(dbf, "chats"), where("members", "array-contains", me.uid));
  chatsUnsub = onSnapshot(q, (snap) => {
    const seen = new Set();
    snap.docChanges().forEach((change) => {
      const chat = { id: change.doc.id, ...change.doc.data() };
      if (change.type === "removed") {
        chats.delete(chat.id);
        if (currentChatId === chat.id) closeConversation();
        return;
      }
      const prev = chats.get(chat.id);
      chats.set(chat.id, chat);
      seen.add(chat.id);
      if (currentChatId === chat.id) onCurrentChatUpdate(prev, chat);
    });
    syncPeerSubscriptions();
    renderChatList();
  }, (error) => toast(ruError(error)));
}
function onCurrentChatUpdate(prev, chat) {
  renderConversationHeader();
  if (isForum(chat)) {
    if (!currentTopic) renderTopicList();
    else if (currentTopic.id !== "general" && !(chat.topics || []).some(t => t.id === currentTopic.id)) renderTopicList();
    else applyComposerState();
  } else if (currentTopic) { // топики удалили совсем
    currentTopic = null; openChat(chat.id);
  }
  refreshTicks();
  // прочитанность при активной вкладке
  const unread = (chat.unread || {})[me.uid] || 0;
  if (unread && !document.hidden) markRead(chat.id);
}
function syncPeerSubscriptions() {
  const wanted = new Set();
  for (const chat of chats.values()) {
    if (chat.type === "private") { const p = (chat.members || []).find(m => m !== me.uid); if (p) wanted.add(p); }
  }
  for (const [uid, unsub] of peerUnsubs) if (!wanted.has(uid)) { unsub(); peerUnsubs.delete(uid); }
  for (const uid of wanted) {
    if (peerUnsubs.has(uid)) continue;
    peerUnsubs.set(uid, onSnapshot(doc(dbf, "users", uid), (d) => {
      if (d.exists()) userCache.set(uid, { uid, ...d.data() });
      renderChatList();
      if (currentView()?.peerUid === uid) renderConversationHeader();
    }));
  }
}
async function fetchUser(uid) {
  if (userCache.has(uid)) return userCache.get(uid);
  const d = await getDoc(doc(dbf, "users", uid));
  if (d.exists()) { const u = { uid, ...d.data() }; userCache.set(uid, u); return u; }
  return null;
}

// ---------- chat list ----------
function typingNames(chat) {
  const fresh = Object.entries(chat.typing || {}).filter(([uid, t]) => uid !== me.uid && Date.now() - t < 3000);
  return fresh.map(([uid]) => userCache.get(uid)?.displayName || "кто-то");
}
function chatPreview(v) {
  const names = typingNames(v.raw);
  if (names.length) return v.type === "group" ? `${names.join(", ")} печатает…` : "печатает…";
  if (v.id !== currentChatId) {
    const draft = localStorage.getItem(`draft_${v.id}`);
    if (draft) return `Черновик: ${draft}`;
  }
  const m = v.lastMessage;
  if (!m) return "Нет сообщений";
  const prefix = m.senderUid === me.uid ? "Вы: " : (v.type === "group" ? `${m.senderName}: ` : "");
  return prefix + (m.text || "📷 Фото");
}
function renderChatList() {
  if (!me) return;
  const list = $("#chatList");
  if (!list) return;
  const views = [...chats.values()].map(viewOf)
    .sort((a, b) => (b.pinned - a.pinned) || ((b.lastMessage?.createdAt || b.raw.createdAt || 0) - (a.lastMessage?.createdAt || a.raw.createdAt || 0)));
  list.replaceChildren();
  for (const v of views) {
    const item = document.createElement("button");
    item.className = "chat-item" + (currentChatId === v.id ? " active" : "");
    const badge = v.unread ? `<span class="badge${v.muted ? " muted-badge" : ""}">${v.unread}</span>` : "";
    item.innerHTML = `
      ${avatarHtml(v.avatarColor, v.type === "saved" ? "☆" : (v.title || "?")[0].toUpperCase(), v.photo)}
      <span class="chat-item-text">
        <strong>${v.pinned ? '<span class="pin-icon">📌</span>' : ""}${escapeHtml(v.title)}${v.muted ? ' <span class="pin-icon">🔇</span>' : ""}</strong>
        <span class="chat-preview${typingNames(v.raw).length ? " typing" : ""}">${escapeHtml(chatPreview(v))}</span>
      </span>
      <span class="chat-meta">
        <span class="chat-time">${v.lastMessage ? formatChatTime(v.lastMessage.createdAt) : ""}</span>
        ${badge}
      </span>`;
    item.addEventListener("click", () => openChat(v.id));
    attachPress(item, (e) => showChatContextMenu(e, v));
    list.appendChild(item);
  }
}
function attachPress(node, handler) {
  node.addEventListener("contextmenu", (e) => { e.preventDefault(); handler(e); });
  let pressTimer;
  node.addEventListener("touchstart", (e) => { pressTimer = setTimeout(() => handler(e.touches[0]), 550); }, { passive: true });
  node.addEventListener("touchend", () => clearTimeout(pressTimer));
  node.addEventListener("touchmove", () => clearTimeout(pressTimer));
}

// ---------- conversation ----------
function applyComposerState() {
  const chat = currentChat();
  let showComposer = true, showClosed = false, closedText = "🔒 Топик закрыт — писать могут только админы";
  if (chat && chat.type === "channel" && !isChatAdmin(chat)) {
    showComposer = false; showClosed = true; closedText = "📢 Писать в канал могут только админы";
  } else if (chat && isForum(chat)) {
    if (!currentTopic) showComposer = false;
    else {
      const fresh = topicsView(chat).find(t => t.id === currentTopic.id);
      if (fresh) currentTopic = fresh;
      if (currentTopic.closed && !isChatAdmin(chat)) { showComposer = false; showClosed = true; }
    }
  }
  $("#messageForm").classList.toggle("hidden", !showComposer);
  $("#closedBar").classList.toggle("hidden", !showClosed);
  $("#closedBar").textContent = closedText;
}
async function openChat(chatId) {
  const chat = chats.get(chatId);
  if (!chat) return;
  // сохранить черновик предыдущего чата
  if (currentChatId && currentChatId !== chatId) {
    const prev = messageInput.value.trim();
    if (prev) localStorage.setItem(`draft_${currentChatId}`, prev);
    else localStorage.removeItem(`draft_${currentChatId}`);
  }
  currentChatId = chatId;
  currentTopic = null;
  replyTarget = null; editTarget = null;
  messageInput.value = localStorage.getItem(`draft_${chatId}`) || "";
  autoGrow(messageInput);
  $("#replyBar").classList.add("hidden");
  $("#backButton").classList.remove("force");
  $("#conversationPlaceholder").classList.add("hidden");
  $("#conversationInner").classList.remove("hidden");
  $("#conversation").classList.add("open");
  applyComposerState();
  renderConversationHeader();
  renderChatList();
  subscribeMessages(chatId);
  loadMentionPool();
}

// ---------- @-пикер упоминаний ----------
let mentionIdx = 0;
let lastMentionAck = 0;
function notifyMention(m) {
  const who = m.senderName || "Кто-то";
  const body = m.text || "📷 Фото";
  if (!document.hidden && "Notification" in window && Notification.permission === "granted") {
    try { new Notification(`${who} упомянул(а) вас`, { body: body.slice(0, 120), tag: `mention-${m.id || m.createdAt}` }); } catch (e) {}
  }
  toast(`${who} упомянул(а) вас: ${body.slice(0, 60)}`);
}
async function loadMentionPool() {
  const chat = currentChat();
  const members = (chat?.members || []).filter(id => id !== me.uid);
  mentionPool = (await Promise.all(members.map(fetchUser))).filter(Boolean);
  mentionMatch = "";
}
function markMentionSel() {
  const opts = document.querySelectorAll("#mentionPanel .mention-option");
  opts.forEach((o, i) => o.classList.toggle("selected", i === mentionIdx));
}
function updateMentionPicker() {
  const el = $("#mentionPanel");
  if (!el) return;
  const val = messageInput.value;
  const sel = messageInput.selectionStart ?? val.length;
  const m = /(?:^|[\s(])@([a-z0-9_]*)$/.exec(val.slice(0, sel));
  if (!m) { mentionMatch = ""; el.classList.add("hidden"); return; }
  const q = m[1].toLowerCase();
  const list = mentionPool.filter(u => (u.username || "").toLowerCase().startsWith(q));
  if (!list.length || !q) { mentionMatch = ""; el.classList.add("hidden"); return; }
  mentionMatch = q; mentionIdx = 0;
  el.replaceChildren();
  list.slice(0, 8).forEach((u, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mention-option" + (i === 0 ? " selected" : "");
    b._u = u;
    b.innerHTML = `${avatarHtml(u.avatarColor, (u.displayName || "?")[0].toUpperCase(), u.avatar, "avatar sm")}<span class="mname"><strong>${escapeHtml(u.displayName)}</strong><small>@${escapeHtml(u.username)}</small></span>`;
    b.addEventListener("click", () => replaceMention(u));
    el.appendChild(b);
  });
  el.classList.remove("hidden");
}
function replaceMention(u) {
  const el = $("#mentionPanel"); if (el) el.classList.add("hidden");
  const val = messageInput.value;
  const sel = messageInput.selectionStart ?? val.length;
  const m = /(?:^|[\s(])@([a-z0-9_]*)$/.exec(val.slice(0, sel));
  let newVal, caret;
  if (m) {
    const atIdx = m[0].lastIndexOf("@");
    const start = sel - m[0].length + atIdx;
    newVal = val.slice(0, start) + `@${u.username} ` + val.slice(sel);
    caret = start + u.username.length + 2;
  } else { newVal = val + `@${u.username} `; caret = newVal.length; }
  messageInput.value = newVal; autoGrow(messageInput);
  messageInput.setSelectionRange(caret, caret);
  messageInput.focus();
}
document.addEventListener("click", (e) => { if (currentChatId && !e.target.closest("#mentionPanel")) { const el = $("#mentionPanel"); if (el) el.classList.add("hidden"); } });
function subscribeMessages(chatId) {
  messagesUnsub?.();
  messages = [];
  $("#messages").replaceChildren();
  const q = query(collection(dbf, "chats", chatId, "messages"), orderBy("createdAt", "desc"), limit(300));
  let first = true;
  messagesUnsub = onSnapshot(q, (snap) => {
    messages = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
    const chat = currentChat();
    if (!chat) return;
    const myMention = lastMentionAck ? messages.find(m => (m.mentions || []).includes(me.uid) && m.sender !== me.uid && (m.createdAt || 0) > lastMentionAck) : null;
    if (myMention) {
      lastMentionAck = myMention.createdAt || Date.now();
      notifyMention(myMention);
    }
    if (isForum(chat) && !currentTopic) renderTopicList();
    else renderMessagesView(!first);
    if (first) { first = false; if (!document.hidden) markRead(chatId); }
    else if (!document.hidden) {
      const unread = (chat.unread || {})[me.uid] || 0;
      if (unread) markRead(chatId);
    }
  }, (error) => toast(ruError(error)));
}
function visibleMessages() {
  const chat = currentChat();
  let list = messages.filter(m => !m.deleted);
  if (chat && isForum(chat) && currentTopic) list = list.filter(m => (m.topicId || "general") === currentTopic.id);
  return list;
}
function renderMessagesView(animateLast = false) {
  const box = $("#messages");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const list = visibleMessages();
  box.replaceChildren();
  if (!list.length) {
    box.innerHTML = '<div class="empty-chat"><div class="empty-icon">✦</div><h2>Пока пусто</h2><p>Напишите первое сообщение</p></div>';
    renderPinnedBar();
    return;
  }
  let lastDay = "";
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { lastDay = day; box.insertAdjacentHTML("beforeend", `<div class="day-divider">${formatDay(m.createdAt)}</div>`); }
    const node = buildMessageNode(m);
    if (animateLast && i === list.length - 1 && Date.now() - m.createdAt < 3000) node.classList.add("anim");
    box.appendChild(node);
  }
  if (atBottom || animateLast) box.scrollTop = box.scrollHeight;
  renderPinnedBar();
}
function closeConversation() {
  currentChatId = null; currentTopic = null;
  messagesUnsub?.(); messagesUnsub = null;
  messages = [];
  applyComposerState();
  $("#backButton").classList.remove("force");
  $("#conversation").classList.remove("open");
  $("#conversationInner").classList.add("hidden");
  $("#conversationPlaceholder").classList.remove("hidden");
  renderChatList();
}
$("#backButton").addEventListener("click", () => {
  if (currentTopic) renderTopicList();
  else closeConversation();
});
function renderConversationHeader() {
  const v = currentView();
  if (!v) return;
  renderPinnedBar();
  $("#chatTitle").textContent = v.title;
  const avatar = $("#chatAvatar");
  avatar.dataset.color = v.avatarColor;
  if (v.photo) avatar.innerHTML = `<img src="${escapeHtml(v.photo)}" alt="" />`;
  else avatar.textContent = v.type === "saved" ? "☆" : (v.title || "?")[0].toUpperCase();
  const sub = $("#chatSubtitle");
  sub.classList.remove("online");
  const names = typingNames(v.raw);
  if (names.length) {
    const label = v.type === "group" ? `${names.join(", ")} печатает` : "печатает";
    sub.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span> ${escapeHtml(label)}`;
    sub.classList.add("online");
    return;
  }
  $("#audioCallBtn").classList.toggle("hidden", v.type !== "private");
  $("#videoCallBtn").classList.toggle("hidden", v.type !== "private");
  if (v.type === "saved") sub.textContent = "ваши заметки";
  else if (v.type === "channel") sub.textContent = `📢 канал · ${v.memberCount} подписчик(ов)`;
  else if (v.type === "group") {
    if (currentTopic) sub.textContent = `${currentTopic.icon || "#"} ${currentTopic.title}`;
    else if (isForum(v.raw)) sub.textContent = `${topicsView(v.raw).length} топик(ов) · ${v.memberCount} участник(ов)`;
    else sub.textContent = `${v.memberCount} участник(ов)`;
  } else {
    sub.textContent = formatLastSeen(v.peer);
    if (isOnlineUser(v.peer)) sub.classList.add("online");
  }
}
function renderPinnedBar() {
  const bar = $("#pinnedBar");
  const chat = currentChat();
  const pinned = chat?.pinnedMessageId ? messages.find(m => m.id === chat.pinnedMessageId && !m.deleted) : null;
  if (!pinned) return bar.classList.add("hidden");
  $("#pinnedBarText").textContent = `${pinned.senderName}: ${pinned.text || "📷 Фото"}`;
  bar.classList.remove("hidden");
}
$("#pinnedBar").addEventListener("click", (e) => {
  if (e.target.closest("#unpinButton")) return;
  const chat = currentChat();
  const node = chat?.pinnedMessageId && document.querySelector(`[data-message-id="${chat.pinnedMessageId}"]`);
  if (node) { node.scrollIntoView({ behavior: "smooth", block: "center" }); node.classList.add("highlight"); setTimeout(() => node.classList.remove("highlight"), 1200); }
});
$("#unpinButton").addEventListener("click", () => {
  if (currentChatId) updateDoc(doc(dbf, "chats", currentChatId), { pinnedMessageId: deleteField() }).catch(e => toast(ruError(e)));
});
function markRead(chatId) {
  updateDoc(doc(dbf, "chats", chatId), { [`lastRead.${me.uid}`]: Date.now(), [`unread.${me.uid}`]: 0 })
    .then(() => bumpChat(chatId)) // чтобы галочки «прочитано» долетали мгновенно
    .catch(() => {});
}

// ---------- topics ----------
async function openTopic(topic) {
  currentTopic = topic;
  replyTarget = null; editTarget = null;
  $("#replyBar").classList.add("hidden");
  applyComposerState();
  $("#backButton").classList.add("force");
  renderConversationHeader();
  renderMessagesView();
}
function renderTopicList() {
  currentTopic = null;
  applyComposerState();
  $("#backButton").classList.remove("force");
  renderConversationHeader();
  const chat = currentChat();
  const box = $("#messages");
  box.replaceChildren();
  const createButton = document.createElement("button");
  createButton.className = "chat-item topic-create";
  createButton.innerHTML = `<span class="topic-icon">＋</span><span class="chat-item-text"><strong>Новый топик</strong></span>`;
  createButton.addEventListener("click", openCreateTopicModal);
  box.appendChild(createButton);
  for (const topic of topicsView(chat)) {
    const item = document.createElement("button");
    item.className = "chat-item topic-item";
    const last = topic.lastMessage;
    const preview = last ? `${last.senderName}: ${last.text || "📷 Фото"}` : "Нет сообщений";
    item.innerHTML = `
      <span class="topic-icon">${escapeHtml(topic.icon || "#")}</span>
      <span class="chat-item-text">
        <strong>${escapeHtml(topic.title)}${topic.closed ? ' <span class="pin-icon">🔒</span>' : ""}</strong>
        <span class="chat-preview">${escapeHtml(preview)}</span>
      </span>
      <span class="chat-meta"><span class="chat-time">${last ? formatChatTime(last.createdAt) : ""}</span></span>`;
    item.addEventListener("click", () => openTopic(topic));
    attachPress(item, (e) => showTopicContextMenu(e, topic));
    box.appendChild(item);
  }
}
function openCreateTopicModal() {
  openModal(`<h3>Новый топик</h3>
    <label class="field"><span>Эмодзи (иконка)</span><input id="topicIcon" maxlength="4" placeholder="💬" /></label>
    <label class="field"><span>Название</span><input id="topicTitle" maxlength="60" placeholder="Например: Правила" /></label>
    <div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">Создать</button></div>`);
  $("#modal .cancel").addEventListener("click", closeModal);
  $("#modal .confirm").addEventListener("click", async () => {
    const title = $("#topicTitle").value.trim().slice(0, 60);
    if (!title) return toast("Введите название топика");
    const icon = $("#topicIcon").value.trim().slice(0, 4) || "💬";
    try {
      await updateDoc(doc(dbf, "chats", currentChatId), {
        topics: arrayUnion({ id: `top_${randomId(16)}`, title, icon, creatorUid: me.uid, createdAt: Date.now(), closed: false }),
      });
      closeModal();
    } catch (error) { toast(ruError(error)); }
  });
}
async function patchTopic(topicId, patch) {
  const chat = currentChat();
  if (topicId === "general") {
    if ("closed" in patch) await updateDoc(doc(dbf, "chats", chat.id), { generalClosed: patch.closed });
    return;
  }
  const topics = (chat.topics || []).map(t => t.id === topicId ? { ...t, ...patch } : t);
  await updateDoc(doc(dbf, "chats", chat.id), { topics });
}
function showTopicContextMenu(point, topic) {
  const chat = currentChat();
  const admin = isChatAdmin(chat);
  const canManage = admin || topic.creatorUid === me.uid;
  const isGeneral = topic.id === "general";
  const buttons = [];
  if ((isGeneral && admin) || (!isGeneral && canManage)) buttons.push(`<button data-act="toggle">${topic.closed ? "🔓 Открыть топик" : "🔒 Закрыть топик"}</button>`);
  if (!isGeneral && canManage) {
    buttons.push('<button data-act="edit">✎ Изменить</button>');
    buttons.push('<button data-act="delete" class="danger">🗑 Удалить топик</button>');
  }
  if (!buttons.length) return;
  showContextMenu(point, buttons.join(""));
  contextMenu.querySelectorAll("button").forEach(b => b.addEventListener("click", async () => {
    hideContextMenu();
    const act = b.dataset.act;
    try {
      if (act === "toggle") { await patchTopic(topic.id, { closed: !topic.closed }); toast(topic.closed ? "Топик открыт" : "Топик закрыт"); }
      else if (act === "edit") {
        openModal(`<h3>Настройки топика</h3>
          <label class="field"><span>Эмодзи (иконка)</span><input id="topicIcon" maxlength="4" value="${escapeHtml(topic.icon || "")}" /></label>
          <label class="field"><span>Название</span><input id="topicTitle" maxlength="60" value="${escapeHtml(topic.title)}" /></label>
          <div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">Сохранить</button></div>`);
        $("#modal .cancel").addEventListener("click", closeModal);
        $("#modal .confirm").addEventListener("click", async () => {
          try {
            await patchTopic(topic.id, { title: $("#topicTitle").value.trim().slice(0, 60) || topic.title, icon: $("#topicIcon").value.trim().slice(0, 4) || topic.icon });
            closeModal(); toast("Сохранено");
          } catch (error) { toast(ruError(error)); }
        });
      } else if (act === "delete") {
        openConfirm(`Удалить топик «${topic.title}» со всеми сообщениями?`, async () => {
          const chatId = currentChatId;
          await updateDoc(doc(dbf, "chats", chatId), { topics: (currentChat().topics || []).filter(t => t.id !== topic.id) });
          const snap = await getDocs(query(collection(dbf, "chats", chatId, "messages"), where("topicId", "==", topic.id)));
          const batch = writeBatch(dbf);
          snap.docs.forEach(d => batch.delete(d.ref));
          await batch.commit();
        });
      }
    } catch (error) { toast(ruError(error)); }
  }));
}

// ---------- опросы ----------
function renderPollHtml(message) {
  const p = message.poll;
  const votes = p.votes || {};
  const total = Object.keys(votes).length;
  const myVote = votes[me.uid];
  const rows = (p.options || []).map(o => {
    const cnt = Object.values(votes).filter(v => v === o.id).length;
    const pct = total ? Math.round(cnt / total * 100) : 0;
    return `<button type="button" class="poll-option${myVote === o.id ? " voted" : ""}" data-opt="${escapeHtml(o.id)}">
      <span class="poll-bar" style="width:${pct}%"></span>
      <span class="poll-label">${escapeHtml(o.text)}</span>
      <span class="poll-pct">${total ? pct + "%" : ""}</span>
    </button>`;
  }).join("");
  return `<div class="poll" data-message-id="${escapeHtml(message.id)}">
    <div class="poll-q">📊 ${escapeHtml(p.question)}</div>${rows}
    <div class="poll-total">${total ? "Голосов: " + total : "Будьте первым — голосуйте!"}</div>
  </div>`;
}
async function votePoll(message, optionId) {
  const cur = message.poll?.votes?.[me.uid];
  const patch = { [`poll.votes.${me.uid}`]: cur === optionId ? deleteField() : optionId };
  try { await updateDoc(doc(dbf, "chats", currentChatId, "messages", message.id), patch); bumpChat(currentChatId); }
  catch (error) { toast(ruError(error)); }
}
function openCreatePollModal() {
  const chat = currentChat();
  if (!chat || (isForum(chat) && !currentTopic)) return toast("Откройте чат или топик");
  let optCount = 2;
  const optInput = (i) => `<label class="field"><span>Вариант ${i + 1}</span><input class="poll-opt-input" maxlength="60" /></label>`;
  openModal(`<h3>Новый опрос</h3>
    <label class="field"><span>Вопрос</span><input id="pollQuestion" maxlength="120" placeholder="О чём спросим?" /></label>
    <div id="pollOpts">${optInput(0)}${optInput(1)}</div>
    <button type="button" class="settings-row" id="addPollOpt"><span class="row-icon">＋</span><span>Добавить вариант</span></button>
    <div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">Создать</button></div>`);
  $("#addPollOpt").addEventListener("click", () => {
    if (optCount >= 8) return;
    $("#pollOpts").insertAdjacentHTML("beforeend", optInput(optCount++));
  });
  $("#modal .cancel").addEventListener("click", closeModal);
  $("#modal .confirm").addEventListener("click", async () => {
    const question = $("#pollQuestion").value.trim().slice(0, 120);
    const options = [...document.querySelectorAll(".poll-opt-input")]
      .map(i => i.value.trim().slice(0, 60)).filter(Boolean)
      .map(text => ({ id: randomId(8), text }));
    if (!question) return toast("Введите вопрос");
    if (options.length < 2) return toast("Нужно минимум 2 варианта");
    try { await sendMessage({ poll: { question, options, votes: {} } }); closeModal(); }
    catch (error) { toast(ruError(error)); }
  });
}

// ---------- messages: отрисовка ----------
const TICK_ONE = '<svg viewBox="0 0 18 12" width="17" height="12"><path d="M2 6.5 6 10.5 14.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TICK_TWO = '<svg viewBox="0 0 24 12" width="21" height="12"><path d="M2 6.5 6 10.5 14.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M11.5 9 13 10.5 21.5 1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function ticksFor(message) {
  const v = currentView();
  if (message.sender !== me.uid || v?.type === "saved") return "";
  const read = (v?.lastReadByOthers || 0) >= message.createdAt;
  return `<span class="ticks${read ? " read" : ""}">${read ? TICK_TWO : TICK_ONE}</span>`;
}
function refreshTicks() {
  const v = currentView();
  if (!v) return;
  document.querySelectorAll(".message.mine").forEach(node => {
    const ticks = node.querySelector(".ticks");
    if (ticks && !ticks.classList.contains("read") && (v.lastReadByOthers || 0) >= node._message.createdAt) {
      ticks.classList.add("read", "just-read");
      ticks.innerHTML = TICK_TWO;
    }
  });
}
function buildMessageNode(message) {
  const row = document.createElement("div");
  const mine = message.sender === me.uid;
  if (message.notice) {
    row.className = "message notice-row";
    row.dataset.messageId = message.id;
    row._message = message;
    row.innerHTML = `<div class="notice">${formatMessageText(message.text || "")}<span class="meta">${formatTime(message.createdAt)}</span></div>`;
    return row;
  }
  row.className = `message${mine ? " mine" : ""}`;
  row.dataset.messageId = message.id;
  row._message = message;
  const v = currentView();
  const showSender = v?.type === "group" && !mine;
  row.innerHTML = `<div class="bubble">
    ${showSender ? `<span class="sender-name">${escapeHtml(message.senderName)}</span>` : ""}
    ${message.forwardedFrom ? `<div class="fwd">Переслано от ${escapeHtml(message.forwardedFrom)}</div>` : ""}
    ${message.replyTo ? `<div class="reply-quote" data-target="${escapeHtml(message.replyTo.id)}"><b>${escapeHtml(message.replyTo.sender)}</b>${escapeHtml(message.replyTo.text)}</div>` : ""}
    ${message.image ? `<img class="photo" src="${escapeHtml(message.image)}" alt="Фото" loading="lazy" />` : ""}
    ${message.sticker ? `<img class="sticker-msg" src="/stickers/${escapeHtml(message.sticker)}.png" alt="Стикер" loading="lazy" />` : ""}
    ${message.voice ? `<span class="voice-wrap"><audio class="voice-msg" controls preload="metadata" src="${escapeHtml(message.voice.data)}"></audio><small class="voice-len">${message.voice.duration || 0} сек</small></span>` : ""}
    ${message.poll ? renderPollHtml(message) : ""}
    <span class="msg-text">${formatMessageText(message.text || "")}</span>
    <span class="meta"><span class="edited">${message.editedAt ? "изм. " : ""}</span>${formatTime(message.createdAt)} ${ticksFor(message)}</span>
    <div class="reactions"></div>
  </div>`;
  renderReactions(row);
  row.querySelector(".reply-quote")?.addEventListener("click", () => {
    const target = document.querySelector(`[data-message-id="${message.replyTo.id}"]`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  row.querySelector(".photo")?.addEventListener("click", () => openModal(`<img src="${escapeHtml(message.image)}" style="width:100%;border-radius:14px" />`));
  attachPress(row, (e) => showMessageContextMenu(e, row));
  row.addEventListener("dblclick", () => toggleReaction(message, "❤️"));
  return row;
}
function renderReactions(node) {
  const message = node._message;
  const box = node.querySelector(".reactions");
  box.replaceChildren();
  for (const [emoji, users] of Object.entries(message.reactions || {})) {
    if (!users.length) continue;
    const chip = document.createElement("button");
    chip.className = "reaction-chip" + (users.includes(me.uid) ? " own" : "");
    chip.textContent = `${emoji} ${users.length}`;
    chip.addEventListener("click", () => toggleReaction(message, emoji));
    box.appendChild(chip);
  }
}
async function toggleReaction(message, emoji) {
  const ref = doc(dbf, "chats", currentChatId, "messages", message.id);
  const patch = {};
  const already = (message.reactions?.[emoji] || []).includes(me.uid);
  if (already) patch[`reactions.${emoji}`] = arrayRemove(me.uid);
  else {
    for (const [key, users] of Object.entries(message.reactions || {})) if (users.includes(me.uid)) patch[`reactions.${key}`] = arrayRemove(me.uid);
    patch[`reactions.${emoji}`] = arrayUnion(me.uid);
  }
  try { await updateDoc(ref, patch); } catch (error) { toast(ruError(error)); }
}

// ---------- отправка ----------
const messageInput = $("#messageInput");
function autoGrow(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 120) + "px"; }
messageInput.addEventListener("input", () => {
  autoGrow(messageInput);
  updateMentionPicker();
  const now = Date.now();
  if (currentChatId && now - lastTypingSent > 1800) {
    lastTypingSent = now;
    updateDoc(doc(dbf, "chats", currentChatId), { [`typing.${me.uid}`]: now }).catch(() => {});
  }
});
messageInput.addEventListener("keydown", (e) => {
  const panel = $("#mentionPanel");
  const pickerOpen = panel && !panel.classList.contains("hidden");
  if (pickerOpen) {
    const opts = panel.querySelectorAll(".mention-option");
    if (e.key === "ArrowDown") { e.preventDefault(); mentionIdx = (mentionIdx + 1) % opts.length; markMentionSel(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); mentionIdx = (mentionIdx - 1 + opts.length) % opts.length; markMentionSel(); return; }
    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      const opt = panel.querySelector(".mention-option");
      if (opt && opt._u) replaceMention(opt._u);
      return;
    }
    if (e.key === "Escape") { panel.classList.add("hidden"); return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); $("#messageForm").requestSubmit(); }
});
async function sendMessage({ text = "", image = null, sticker = null, voice = null, poll = null, toChatId = null, forwardedFrom = null }) {
  const chatId = toChatId || currentChatId;
  const chat = chats.get(chatId);
  if (!chat) return;
  const message = {
    sender: me.uid, senderName: me.displayName || me.username,
    text: text.slice(0, 4000), image, createdAt: Date.now(), reactions: {},
    topicId: (!toChatId && isForum(chat) && currentTopic) ? currentTopic.id : "general",
  };
  if (sticker) message.sticker = sticker;
  if (voice) message.voice = voice;
  if (poll) message.poll = poll;
  if (forwardedFrom) message.forwardedFrom = forwardedFrom;
  if (!toChatId && replyTarget) message.replyTo = { id: replyTarget.id, sender: replyTarget.senderName, text: replyTarget.text ? replyTarget.text.slice(0, 120) : "📷 Фото" };
  // @упоминания → массив uid для уведомлений
  if (text) {
    const unameMap = await memberUsernameMap(chat);
    const mentionArr = [];
    const mentionRe = /@([a-z0-9_]{3,24})\b/gi;
    let mt;
    while ((mt = mentionRe.exec(text))) {
      const uid = unameMap.get(mt[1].toLowerCase());
      if (uid && uid !== me.uid && !mentionArr.includes(uid)) mentionArr.push(uid);
    }
    if (mentionArr.length) message.mentions = mentionArr;
  }
  const ref = doc(collection(dbf, "chats", chatId, "messages"));
  const previewText = message.text || (sticker ? "🧩 Стикер" : voice ? "🎤 Голосовое сообщение" : poll ? "📊 Опрос" : "");
  const chatPatch = {
    lastMessage: { text: previewText, senderUid: me.uid, senderName: message.senderName, createdAt: message.createdAt, hasImage: !!image },
    [`lastRead.${me.uid}`]: message.createdAt,
    [`unread.${me.uid}`]: 0,
    [`typing.${me.uid}`]: 0,
  };
  for (const member of chat.members) if (member !== me.uid) chatPatch[`unread.${member}`] = increment(1);
  const batch = writeBatch(dbf);
  batch.set(ref, message);
  batch.update(doc(dbf, "chats", chatId), chatPatch);
  await batch.commit();
  bumpChat(chatId);
}
let sendBusy = false; // защита от спама по кнопке отправки
$("#messageForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentChatId || sendBusy) return;
  const text = messageInput.value.trim();
  if (!text) return;
  const chat = currentChat();
  if (isForum(chat) && !currentTopic) return;
  // команды модерации /mute /warn /ban(/unban/unmute)
  if (/^\/(mute|warn|ban|unmute|unban)\b/i.test(text)) {
    sendBusy = true;
    try { const handled = await doModeration(text); if (handled) { messageInput.value = ""; autoGrow(messageInput); localStorage.removeItem(`draft_${currentChatId}`); } }
    finally { sendBusy = false; }
    return;
  }
  sendBusy = true;
  // мут/бан для меня
  if ((chat.mutes || {})[me.uid] > Date.now()) { sendBusy = false; toast("Вы замучены — писать сейчас нельзя"); return; }
  if ((chat.bans || {})[me.uid] > Date.now()) { sendBusy = false; localStorage.removeItem(`draft_${currentChatId}`); toast("Вас забанили в этом чате"); return; }
  // очищаем поле сразу — повторный тап не отправит то же самое
  messageInput.value = ""; autoGrow(messageInput);
  localStorage.removeItem(`draft_${currentChatId}`);
  try {
    if (editTarget) {
      await updateDoc(doc(dbf, "chats", currentChatId, "messages", editTarget.id), { text: text.slice(0, 4000), editedAt: Date.now() });
    } else {
      await sendMessage({ text });
      const send = $("#sendButton");
      send.classList.remove("sent"); void send.offsetWidth; send.classList.add("sent");
    }
    cancelReplyEdit();
  } catch (error) {
    messageInput.value = text; autoGrow(messageInput); // вернуть текст при ошибке
    if ((error?.code || "").includes("permission-denied") && currentChat()?.type === "private") toast("Не отправлено: пользователь вас заблокировал");
    else toast(ruError(error));
  } finally { sendBusy = false; }
});

// ---------- reply / edit ----------
function startReply(message) {
  editTarget = null; replyTarget = message;
  $("#replyBarTitle").textContent = `Ответ: ${message.senderName}`;
  $("#replyBarText").textContent = message.text || "📷 Фото";
  $("#replyBar").classList.remove("hidden");
  messageInput.focus();
}
function startEdit(message) {
  replyTarget = null; editTarget = message;
  $("#replyBarTitle").textContent = "Редактирование";
  $("#replyBarText").textContent = message.text;
  $("#replyBar").classList.remove("hidden");
  messageInput.value = message.text; autoGrow(messageInput); messageInput.focus();
}
function cancelReplyEdit() {
  replyTarget = null; editTarget = null;
  $("#replyBar").classList.add("hidden");
}
$("#cancelReply").addEventListener("click", () => { if (editTarget) { messageInput.value = ""; autoGrow(messageInput); } cancelReplyEdit(); });

// ---------- модерация: /mute /warn /ban ----------
async function memberUsernameMap(chat) {
  const map = new Map();
  for (const uid of (chat?.members || [])) { const u = await fetchUser(uid); if (u?.username) map.set(u.username.toLowerCase(), uid); }
  return map;
}
async function postNotice(text) {
  const chatId = currentChatId;
  const chat = chats.get(chatId);
  if (!chat) return;
  const message = {
    sender: me.uid, senderName: me.displayName || me.username,
    text: text.slice(0, 4000), notice: true, createdAt: Date.now(), reactions: {},
    topicId: "general",
  };
  const chatPatch = {
    lastMessage: { text: message.text, senderUid: me.uid, senderName: message.senderName, createdAt: message.createdAt, hasImage: false },
    [`lastRead.${me.uid}`]: message.createdAt, [`unread.${me.uid}`]: 0, [`typing.${me.uid}`]: 0,
  };
  for (const member of chat.members) if (member !== me.uid) chatPatch[`unread.${member}`] = increment(1);
  const batch = writeBatch(dbf);
  batch.set(doc(collection(dbf, "chats", chatId, "messages")), message);
  batch.update(doc(dbf, "chats", chatId), chatPatch);
  await batch.commit();
  bumpChat(chatId);
}
const PERMANENT = 4102444800000; // ~2100
function defaultDuration(cmd) {
  if (cmd === "warn") return 30 * 60e3;
  if (cmd === "ban") return 24 * 3600e3;
  return 60 * 60e3;
}
const MOD_VERBS = { mute: "замутил(а)", warn: "выдал(а) варн", ban: "забанил(а)" };
async function doModeration(raw) {
  const chat = currentChat();
  if (!chat) return false;
  if (chat.type !== "group" && chat.type !== "channel") { if (/^\/(mute|warn|ban|unmute|unban)\b/i.test(raw)) { toast("Команда доступна только в группах/каналах"); return true; } return false; }
  if (!isChatAdmin(chat)) { toast("Модерировать — только админ или создатель"); return true; }
  const mm = raw.trim().match(/^\/(mute|warn|ban|unmute|unban)(?:\s+(.*))?$/i);
  if (!mm) return false;
  const cmd = mm[1].toLowerCase();
  const tokens = (mm[2] || "").trim().split(/\s+/).filter(Boolean);

  let targetUid = null, targetName = "", timeStr = null;
  if (tokens.length && tokens[0].startsWith("@")) {
    targetUid = (await getUsernameUid(tokens[0].slice(1))) || null;
    targetName = tokens[0].toLowerCase();
    timeStr = tokens[1] ?? null;
  } else if (replyTarget && !tokens.length) {
    targetUid = replyTarget.sender; targetName = replyTarget.senderName; timeStr = null;
  } else if (replyTarget && tokens.length) {
    targetUid = replyTarget.sender; targetName = replyTarget.senderName; timeStr = tokens[0];
  } else if (tokens.length) {
    targetUid = (await getUsernameUid(tokens[0])) || null;
    targetName = tokens[0].startsWith("@") ? tokens[0].toLowerCase() : "@" + tokens[0].toLowerCase();
    timeStr = tokens[1] ?? null;
  }
  if (!targetUid) { toast("Укажите @имя или ответьте на сообщение"); return true; }
  if (targetUid === me.uid) { toast("Нельзя модерировать себя"); return true; }

  const memberSet = new Set(chat.members || []);
  const targetRole = chat.ownerUid === targetUid ? "owner" : ((chat.admins || []).includes(targetUid) ? "admin" : "member");
  if (targetRole === "owner") { toast("Владельца нельзя модерировать"); return true; }
  if (targetRole === "admin" && chat.ownerUid !== me.uid) { toast("Админа может модерировать только создатель"); return true; }
  if (cmd !== "unban" && cmd !== "unmute" && !memberSet.has(targetUid)) { toast("Пользователя нет в чате"); return true; }

  const ref = doc(dbf, "chats", chat.id);
  const who = me.displayName || me.username;
  const timeNow = Date.now();
  const dur = timeStr == null ? defaultDuration(cmd) : parseDuration(timeStr);

  const doUnmute = ["unmute", "mute"].includes(cmd) && dur === 0;
  const doUnban = ["unban", "ban"].includes(cmd) && dur === 0;
  try {
    if (cmd === "unmute" || (cmd === "mute" && dur === 0)) {
      await updateDoc(ref, { [`mutes.${targetUid}`]: deleteField() });
      postNotice(`🔔 ${who} снял(а) мут с ${targetName}`); toast("Мут снят");
      return true;
    }
    if (cmd === "unban" || (cmd === "ban" && dur === 0)) {
      await updateDoc(ref, { members: arrayUnion(targetUid), [`bans.${targetUid}`]: deleteField() });
      postNotice(`🚪 ${who} снял(а) бан с ${targetName}`); toast("Бан снят");
      return true;
    }
    if (cmd === "mute") {
      const until = timeNow + dur;
      await updateDoc(ref, { [`mutes.${targetUid}`]: until });
      postNotice(`🔕 ${who} замутил(а) ${targetName} до ${fmtUntil(until)}`);
      toast(`Замучено до ${fmtUntil(until)}`);
      return true;
    }
    if (cmd === "warn") {
      const until = timeNow + dur;
      await updateDoc(ref, { [`warns.${targetUid}`]: increment(1), [`mutes.${targetUid}`]: until });
      postNotice(`⚠️ ${who} ${MOD_VERBS.warn} ${targetName} и замутил(а) до ${fmtUntil(until)}`);
      toast(`Варн выдан, мут до ${fmtUntil(until)}`);
      return true;
    }
    if (cmd === "ban") {
      const until = timeNow + dur;
      await updateDoc(ref, { members: arrayRemove(targetUid), admins: arrayRemove(targetUid), [`bans.${targetUid}`]: until });
      postNotice(`🚫 ${who} забанил(а) ${targetName} до ${fmtUntil(until)}`);
      toast(`Забанен до ${fmtUntil(until)}`);
      return true;
    }
  } catch (error) { toast(ruError(error)); }
  return true;
}
async function getUsernameUid(name) {
  try {
    const reg = await getDoc(doc(dbf, "usernames", name.replace(/^@/, "").toLowerCase()));
    if (reg.exists()) return reg.data().uid;
  } catch { /* ignore */ }
  return null;
}

// ---------- фото ----------
$("#attachButton").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", async () => {
  const file = $("#fileInput").files[0];
  $("#fileInput").value = "";
  if (!file || !currentChatId) return;
  const chat = currentChat();
  if (isForum(chat) && !currentTopic) return;
  let image = await compressImage(file, 1100, 0.8);
  if (image && image.length > 700_000) image = await compressImage(file, 800, 0.6);
  if (!image) return toast("Не удалось обработать изображение");
  if (image.length > 900_000) return toast("Фото слишком большое");
  try { await sendMessage({ image }); cancelReplyEdit(); }
  catch (error) { toast(ruError(error)); }
});
function compressImage(file, max, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

// ---------- emoji ----------
const emojiGrid = $("#emojiGrid");
for (const emoji of EMOJI) {
  const b = document.createElement("button"); b.type = "button"; b.textContent = emoji;
  b.addEventListener("click", () => { messageInput.value += emoji; autoGrow(messageInput); messageInput.focus(); });
  emojiGrid.appendChild(b);
}
$("#emojiButton").addEventListener("click", (e) => { e.stopPropagation(); $("#emojiPanel").classList.toggle("hidden"); });
document.addEventListener("click", (e) => { if (!$("#emojiPanel").contains(e.target) && e.target !== $("#emojiButton")) $("#emojiPanel").classList.add("hidden"); });

// ---------- стикеры ----------
const stickerGrid = $("#stickerGrid");
for (const code of STICKERS) {
  const b = document.createElement("button"); b.type = "button";
  b.innerHTML = `<img src="/stickers/${code}.png" alt="" loading="lazy" />`;
  b.addEventListener("click", async () => {
    $("#emojiPanel").classList.add("hidden");
    const chat = currentChat();
    if (!chat || (isForum(chat) && !currentTopic)) return;
    try { await sendMessage({ sticker: code }); cancelReplyEdit(); }
    catch (error) { toast(ruError(error)); }
  });
  stickerGrid.appendChild(b);
}
$("#tabEmoji").addEventListener("click", () => {
  $("#tabEmoji").classList.add("active"); $("#tabStickers").classList.remove("active");
  $("#emojiGrid").classList.remove("hidden"); stickerGrid.classList.add("hidden");
});
$("#tabStickers").addEventListener("click", () => {
  $("#tabStickers").classList.add("active"); $("#tabEmoji").classList.remove("active");
  stickerGrid.classList.remove("hidden"); $("#emojiGrid").classList.add("hidden");
});

// ---------- голосовые сообщения ----------
let mediaRecorder = null;
let recChunks = [];
let recStart = 0;
let recTimeout = null;
const voiceButton = $("#voiceButton");
voiceButton.addEventListener("click", async () => {
  const chat = currentChat();
  if (!chat || (isForum(chat) && !currentTopic)) return;
  if (mediaRecorder && mediaRecorder.state === "recording") { mediaRecorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      clearTimeout(recTimeout);
      stream.getTracks().forEach(t => t.stop());
      voiceButton.classList.remove("recording");
      const duration = Math.round((Date.now() - recStart) / 1000);
      if (duration < 1 || !recChunks.length) return;
      const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
      const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
      if (dataUrl.length > 900_000) return toast("Слишком длинное голосовое (макс ~1 минута)");
      try { await sendMessage({ voice: { data: dataUrl, duration } }); cancelReplyEdit(); }
      catch (error) { toast(ruError(error)); }
    };
    recStart = Date.now();
    mediaRecorder.start();
    voiceButton.classList.add("recording");
    toast("Запись… нажмите 🎤 ещё раз, чтобы отправить");
    recTimeout = setTimeout(() => { if (mediaRecorder?.state === "recording") mediaRecorder.stop(); }, 60_000);
  } catch { toast("Нет доступа к микрофону"); }
});

// ---------- modal ----------
const modalBackdrop = $("#modalBackdrop");
function openModal(html) { $("#modal").innerHTML = html; modalBackdrop.classList.remove("hidden"); }
function closeModal() { modalBackdrop.classList.add("hidden"); }
modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) closeModal(); });
function openConfirm(text, onConfirm) {
  openModal(`<h3>${escapeHtml(text)}</h3><div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">Да</button></div>`);
  $("#modal .cancel").addEventListener("click", closeModal);
  $("#modal .confirm").addEventListener("click", async () => { closeModal(); try { await onConfirm(); } catch (error) { toast(ruError(error)); } });
}

// ---------- context menu ----------
const contextMenu = $("#contextMenu");
function showContextMenu(point, html) {
  contextMenu.innerHTML = html;
  contextMenu.classList.remove("hidden");
  const rect = contextMenu.getBoundingClientRect();
  let x = point.clientX, y = point.clientY;
  if (x + rect.width > innerWidth - 8) x = innerWidth - rect.width - 8;
  if (y + rect.height > innerHeight - 8) y = innerHeight - rect.height - 8;
  contextMenu.style.left = `${Math.max(8, x)}px`;
  contextMenu.style.top = `${Math.max(8, y)}px`;
}
function hideContextMenu() { contextMenu.classList.add("hidden"); }
document.addEventListener("click", (e) => { if (!contextMenu.contains(e.target)) hideContextMenu(); });
document.addEventListener("scroll", hideContextMenu, true);
document.addEventListener("contextmenu", (e) => { if (!e.target.closest("input, textarea")) e.preventDefault(); });

function showMessageContextMenu(point, node) {
  const message = node._message;
  const chat = currentChat();
  const mine = message.sender === me.uid;
  const isPinned = chat?.pinnedMessageId === message.id;
  showContextMenu(point, `
    <div class="react-row">${QUICK_REACTIONS.map(e => `<button data-act="react" data-emoji="${e}">${e}</button>`).join("")}</div>
    <button data-act="reply">↩ Ответить</button>
    <button data-act="copy">⧉ Копировать</button>
    <button data-act="forward">➦ Переслать</button>
    <button data-act="pin">📌 ${isPinned ? "Открепить" : "Закрепить"}</button>
    ${mine && message.text ? '<button data-act="edit">✎ Изменить</button>' : ""}
    ${mine || isChatAdmin(chat) || chat?.type === "saved" ? '<button data-act="delete" class="danger">🗑 Удалить</button>' : ""}
  `);
  contextMenu.querySelectorAll("button").forEach(b => b.addEventListener("click", async () => {
    hideContextMenu();
    const act = b.dataset.act;
    try {
      if (act === "react") toggleReaction(message, b.dataset.emoji);
      else if (act === "reply") startReply(message);
      else if (act === "copy") { try { await navigator.clipboard.writeText(message.text); toast("Скопировано"); } catch { toast("Не удалось скопировать"); } }
      else if (act === "forward") openForwardPicker(message);
      else if (act === "pin") await updateDoc(doc(dbf, "chats", currentChatId), { pinnedMessageId: isPinned ? deleteField() : message.id });
      else if (act === "edit") startEdit(message);
      else if (act === "delete") {
        const patch = { deleted: true, text: "", image: null, reactions: {} };
        await updateDoc(doc(dbf, "chats", currentChatId, "messages", message.id), patch);
        if (chat.pinnedMessageId === message.id) await updateDoc(doc(dbf, "chats", currentChatId), { pinnedMessageId: deleteField() });
        if (chat.lastMessage?.createdAt === message.createdAt) await updateDoc(doc(dbf, "chats", currentChatId), { "lastMessage.text": "Сообщение удалено", "lastMessage.hasImage": false });
      }
    } catch (error) { toast(ruError(error)); }
  }));
}
function showChatContextMenu(point, v) {
  showContextMenu(point, `
    <button data-act="pin">${v.pinned ? "📌 Открепить" : "📌 Закрепить"}</button>
    <button data-act="mute">${v.muted ? "🔔 Включить звук" : "🔇 Без звука"}</button>
    <button data-act="read">✓ Прочитано</button>
    <button data-act="poll">📊 Создать опрос</button>
    ${v.type === "group" ? '<button data-act="topic"># Создать топик</button>' : ""}
    <button data-act="clear">🧹 Очистить историю</button>
    ${v.type !== "saved" ? `<button data-act="delete" class="danger">🗑 ${v.type === "group" || v.type === "channel" ? "Покинуть/удалить" : "Удалить чат"}</button>` : ""}
  `);
  contextMenu.querySelectorAll("button").forEach(b => b.addEventListener("click", async () => {
    hideContextMenu();
    const act = b.dataset.act;
    const ref = doc(dbf, "chats", v.id);
    try {
      if (act === "pin") await updateDoc(ref, { pinnedBy: v.pinned ? arrayRemove(me.uid) : arrayUnion(me.uid) });
      else if (act === "mute") await updateDoc(ref, { muted: v.muted ? arrayRemove(me.uid) : arrayUnion(me.uid) });
      else if (act === "read") markRead(v.id);
      else if (act === "topic") { if (currentChatId !== v.id) await openChat(v.id); openCreateTopicModal(); }
      else if (act === "poll") { if (currentChatId !== v.id) await openChat(v.id); openCreatePollModal(); }
      else if (act === "clear") {
        openConfirm(`Очистить историю «${v.title}»? Удалятся сообщения, которые вы вправе удалять.`, async () => {
          const snap = await getDocs(query(collection(dbf, "chats", v.id, "messages"), limit(400)));
          const admin = isChatAdmin(v.raw);
          const mine = snap.docs.filter(d => d.data().sender === me.uid || admin || v.type === "saved");
          for (let i = 0; i < mine.length; i += 400) {
            const batch = writeBatch(dbf);
            mine.slice(i, i + 400).forEach(d => batch.delete(d.ref));
            await batch.commit();
          }
          await updateDoc(doc(dbf, "chats", v.id), { lastMessage: deleteField(), pinnedMessageId: deleteField() }).catch(() => {});
          toast(`Удалено сообщений: ${mine.length}`);
        });
      }
      else if (act === "delete") {
        openConfirm(`Удалить «${v.title}»?`, async () => {
          const chat = v.raw;
          if ((chat.type === "group" || chat.type === "channel") && chat.ownerUid !== me.uid) {
            await updateDoc(ref, { members: arrayRemove(me.uid), admins: arrayRemove(me.uid) });
          } else {
            await deleteDoc(ref); // сообщения-сироты не видны без чата; полная чистка — в консоли Firebase
          }
          if (currentChatId === v.id) closeConversation();
        });
      }
    } catch (error) { toast(ruError(error)); }
  }));
}

// ---------- forward ----------
function openForwardPicker(message) {
  const views = [...chats.values()].map(viewOf);
  const rows = views.map(c => `<button class="user-row" data-chat="${escapeHtml(c.id)}"><span class="avatar" data-color="${c.avatarColor}">${c.type === "saved" ? "☆" : escapeHtml((c.title || "?")[0].toUpperCase())}</span><span class="info"><strong>${escapeHtml(c.title)}</strong></span></button>`).join("");
  openModal(`<h3>Переслать в…</h3><div class="user-results">${rows}</div><div class="modal-actions"><button class="cancel">Отмена</button></div>`);
  $("#modal .cancel").addEventListener("click", closeModal);
  document.querySelectorAll("#modal .user-row").forEach(row => row.addEventListener("click", async () => {
    closeModal();
    try {
      await sendMessage({ text: message.text || "", image: message.image || null, toChatId: row.dataset.chat, forwardedFrom: message.senderName });
      toast("Переслано");
    } catch (error) { toast(ruError(error)); }
  }));
}

// ---------- профиль / настройки ----------
function renderProfile() {
  const name = me.displayName || me.username;
  $("#settingsName").textContent = name;
  $("#settingsHandle").textContent = `@${me.username}`;
  $("#settingsBio").textContent = me.bio || "";
  const avatar = $("#settingsAvatar");
  avatar.dataset.color = me.avatarColor;
  if (me.avatar) avatar.innerHTML = `<img src="${escapeHtml(me.avatar)}" alt="" />`;
  else avatar.textContent = name[0].toUpperCase();
}
$("#avatarInput").addEventListener("change", async () => {
  const file = $("#avatarInput").files[0];
  $("#avatarInput").value = "";
  if (!file) return;
  let dataUrl = await compressImage(file, 128, 0.8);
  if (dataUrl && dataUrl.length > 60_000) dataUrl = await compressImage(file, 96, 0.6);
  if (!dataUrl) return toast("Не удалось обработать изображение");
  try {
    await updateDoc(doc(dbf, "users", me.uid), { avatar: dataUrl });
    me.avatar = dataUrl;
    renderProfile(); toast("Фото профиля обновлено");
  } catch (error) { toast(ruError(error)); }
});
$("#menuButton").addEventListener("click", () => $("#settingsPanel").classList.remove("hidden"));
$("#closeSettings").addEventListener("click", () => $("#settingsPanel").classList.add("hidden"));
document.querySelectorAll("#settingsPanel .settings-row").forEach(row => row.addEventListener("click", () => {
  const action = row.dataset.action;
  if (action === "profile") {
    openModal(`<h3>Профиль</h3>
      <label class="field"><span>Имя</span><input id="editName" maxlength="40" value="${escapeHtml(me.displayName || "")}" /></label>
      <label class="field"><span>Username</span><input id="editUsername" maxlength="24" value="${escapeHtml(me.username)}" autocapitalize="off" autocomplete="off" /></label>
      <p class="muted" style="font-size:12.5px;margin:-4px 0 8px">По username вас смогут найти. Латиница, цифры и _</p>
      <label class="field"><span>О себе</span><input id="editBio" maxlength="160" value="${escapeHtml(me.bio || "")}" /></label>
      <div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">Сохранить</button></div>`);
    $("#modal .cancel").addEventListener("click", closeModal);
    $("#modal .confirm").addEventListener("click", async () => {
      try {
        const newUsername = $("#editUsername").value.trim().toLowerCase().replace(/^@/, "");
        if (newUsername !== me.username) {
          if (!/^[a-z0-9_]{3,24}$/.test(newUsername)) throw new Error("Username: 3–24 символа, латиница, цифры и _.");
          await runTransaction(dbf, async (tx) => {
            const takenDoc = await tx.get(doc(dbf, "usernames", newUsername));
            if (takenDoc.exists()) throw new Error("Этот username уже занят.");
            const oldReg = await tx.get(doc(dbf, "usernames", me.username));
            const email = oldReg.exists() ? oldReg.data().email : emailFor(me.username);
            tx.set(doc(dbf, "usernames", newUsername), { uid: me.uid, email });
            tx.delete(doc(dbf, "usernames", me.username));
            tx.update(doc(dbf, "users", me.uid), { username: newUsername });
          });
          me.username = newUsername;
        }
        const displayName = $("#editName").value.trim().slice(0, 40) || me.username;
        const bio = $("#editBio").value.trim().slice(0, 160);
        await updateDoc(doc(dbf, "users", me.uid), { displayName, bio });
        me.displayName = displayName; me.bio = bio;
        renderProfile(); closeModal(); toast("Сохранено");
      } catch (error) { toast(ruError(error)); }
    });
  } else if (action === "photo") {
    $("#avatarInput").click();
  } else if (action === "privacy") {
    const next = !me.hideLastSeen;
    updateDoc(doc(dbf, "users", me.uid), { hideLastSeen: next }).then(() => {
      me.hideLastSeen = next;
      $("#lastSeenLabel").textContent = next ? "вкл" : "выкл";
      toast(next ? "Время захода скрыто — другие видят «был(а) недавно»" : "Время захода снова видно");
    }).catch(e => toast(ruError(e)));
  } else if (action === "deleteAccount") {
    openConfirm("Удалить аккаунт НАВСЕГДА? Профиль и имя освободятся, переписки в группах останутся.", async () => {
      try {
        await deleteDoc(doc(dbf, "chats", `saved_${me.uid}`)).catch(() => {});
        await deleteDoc(doc(dbf, "users", me.uid, "private", "prefs")).catch(() => {});
        await deleteDoc(doc(dbf, "usernames", me.username)).catch(() => {});
        await deleteDoc(doc(dbf, "users", me.uid));
        await deleteUser(auth.currentUser);
        toast("Аккаунт удалён");
      } catch (error) {
        if ((error?.code || "").includes("requires-recent-login")) {
          toast("Для удаления войдите заново и повторите (защита Firebase)");
          await signOut(auth);
        } else toast(ruError(error));
      }
    });
  } else if (action === "appearance") {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    localStorage.setItem("drigagram_theme", next); applyTheme(next);
  } else if (action === "color") {
    const dots = [0,1,2,3,4,5,6].map(i => `<button class="color-dot avatar ${i === me.avatarColor ? "selected" : ""}" data-color="${i}" data-i="${i}"></button>`).join("");
    openModal(`<h3>Цвет аватара</h3><div class="color-row">${dots}</div><div class="modal-actions"><button class="cancel">Готово</button></div>`);
    $("#modal .cancel").addEventListener("click", closeModal);
    document.querySelectorAll("#modal .color-dot").forEach(dot => dot.addEventListener("click", async () => {
      try {
        await updateDoc(doc(dbf, "users", me.uid), { avatarColor: Number(dot.dataset.i) });
        me.avatarColor = Number(dot.dataset.i);
        renderProfile(); closeModal();
      } catch (error) { toast(ruError(error)); }
    }));
  }
}));

// ---------- новый чат / группа / поиск людей ----------
async function searchUsers(q) {
  q = q.trim().toLowerCase().replace(/^@/, "");
  if (!q) return [];
  const snap = await getDocs(query(collection(dbf, "users"), where("username", ">=", q), where("username", "<=", q + ""), limit(20)));
  return snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.uid !== me.uid);
}
async function openDmWith(user) {
  if (user.uid === me.uid) return toast("Это вы");
  try {
    const chatId = `dm_${[me.uid, user.uid].sort().join("_")}`;
    if (!chats.has(chatId)) {
      const existing = await getDoc(doc(dbf, "chats", chatId)).catch(() => null);
      if (!existing || !existing.exists()) {
        await setDoc(doc(dbf, "chats", chatId), {
          type: "private", members: [me.uid, user.uid].sort(),
          createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [],
        });
      }
      userCache.set(user.uid, user);
      // ждём, пока подписка подхватит чат
      for (let i = 0; i < 20 && !chats.has(chatId); i++) await new Promise(r => setTimeout(r, 100));
    }
    if (chats.has(chatId)) openChat(chatId);
    else toast("Не удалось открыть чат — попробуйте ещё раз");
  } catch (error) { toast(ruError(error)); }
}
async function openDmByUsername(name) {
  try {
    const reg = await getDoc(doc(dbf, "usernames", name));
    if (!reg.exists()) return toast("Пользователь не найден");
    const user = await fetchUser(reg.data().uid);
    if (user) openDmWith(user);
  } catch (error) { toast(ruError(error)); }
}
$("#messages").addEventListener("click", (e) => {
  const mention = e.target.closest(".mention");
  if (mention) { e.stopPropagation(); openDmByUsername(mention.dataset.user); return; }
  const opt = e.target.closest(".poll-option");
  if (opt) {
    e.stopPropagation();
    const node = opt.closest("[data-message-id]")?.closest(".message") || opt.closest(".message");
    const msg = node?._message;
    if (msg) votePoll(msg, opt.dataset.opt);
  }
});
$("#newChatFab").addEventListener("click", () => { $("#newChatPanel").classList.remove("hidden"); $("#userSearch").focus(); });
$("#closeNewChat").addEventListener("click", () => $("#newChatPanel").classList.add("hidden"));
let userSearchTimer;
$("#userSearch").addEventListener("input", () => {
  clearTimeout(userSearchTimer);
  userSearchTimer = setTimeout(async () => {
    const q = $("#userSearch").value;
    const box = $("#userResults"); box.replaceChildren();
    if (!q.trim()) return;
    try {
      const users = await searchUsers(q);
      if (!users.length) { box.innerHTML = '<p class="muted" style="padding:12px">Никого не найдено</p>'; return; }
      for (const user of users) {
        const row = document.createElement("button");
        row.className = "user-row";
        row.innerHTML = `${avatarHtml(user.avatarColor, (user.displayName || "?")[0].toUpperCase(), user.avatar)}<span class="info"><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></span>`;
        row.addEventListener("click", async () => {
          $("#newChatPanel").classList.add("hidden");
          $("#userSearch").value = ""; box.replaceChildren();
          await openDmWith(user);
        });
        box.appendChild(row);
      }
    } catch (error) { toast(ruError(error)); }
  }, 300);
});
$("#createGroupButton").addEventListener("click", () => openCreateGroupModal("group"));
$("#createChannelButton").addEventListener("click", () => openCreateGroupModal("channel"));
function openCreateGroupModal(kind) {
  const selected = new Map(); // username -> user
  openModal(`<h3>${kind === "channel" ? "Новый канал" : "Новая группа"}</h3>
    <label class="field"><span>Название</span><input id="groupTitle" maxlength="60" placeholder="${kind === "channel" ? "Мой канал" : "Моя группа"}" /></label>
    <label class="field"><span>Добавить участника (@имя)</span><input id="groupMemberInput" placeholder="username" /></label>
    <div class="member-chip-row" id="memberChips"></div>
    <div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">Создать</button></div>`);
  const chips = $("#memberChips");
  async function addName(name) {
    name = name.trim().toLowerCase().replace(/^@/, "");
    if (!name || selected.has(name)) return;
    const reg = await getDoc(doc(dbf, "usernames", name));
    if (!reg.exists()) return toast(`@${name} не найден`);
    const user = await fetchUser(reg.data().uid);
    selected.set(name, user);
    const chip = document.createElement("span"); chip.className = "member-chip"; chip.textContent = `@${name} ✕`;
    chip.style.cursor = "pointer";
    chip.addEventListener("click", () => { selected.delete(name); chip.remove(); });
    chips.appendChild(chip);
  }
  $("#groupMemberInput").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    addName(e.target.value); e.target.value = "";
  });
  $("#modal .cancel").addEventListener("click", closeModal);
  $("#modal .confirm").addEventListener("click", async () => {
    await addName($("#groupMemberInput").value);
    const title = $("#groupTitle").value.trim().slice(0, 60);
    if (!title) return toast("Введите название группы");
    try {
      const chatId = `grp_${randomId(16)}`;
      await setDoc(doc(dbf, "chats", chatId), {
        type: kind, title,
        members: [me.uid, ...[...selected.values()].map(u => u.uid)],
        ownerUid: me.uid, admins: [],
        avatarColor: Math.floor(Math.random() * 7),
        createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [],
      });
      closeModal();
      $("#newChatPanel").classList.add("hidden");
      for (let i = 0; i < 20 && !chats.has(chatId); i++) await new Promise(r => setTimeout(r, 100));
      if (chats.has(chatId)) openChat(chatId);
    } catch (error) { toast(ruError(error)); }
  });
}

// ---------- chat info ----------
$("#chatTitleBlock").addEventListener("click", openChatInfo);
$("#chatMenuButton").addEventListener("click", (e) => { const v = currentView(); if (v) showChatContextMenu(e, v); e.stopPropagation(); });
async function openChatInfo() {
  const v = currentView();
  if (!v) return;
  const body = $("#chatInfoBody");
  if (v.type === "group" || v.type === "channel") {
    const chat = v.raw;
    const iAmOwner = chat.ownerUid === me.uid;
    const iAmAdmin = isChatAdmin(chat);
    const members = (await Promise.all(chat.members.map(fetchUser))).filter(Boolean);
    const roleOf = (uid) => uid === chat.ownerUid ? "owner" : ((chat.admins || []).includes(uid) ? "admin" : "member");
    const roleMark = { owner: " 👑", admin: " ⭐", member: "" };
    body.innerHTML = `
      <div class="settings-profile">${avatarHtml(v.avatarColor, (v.title || "?")[0].toUpperCase(), v.photo, "avatar large")}
      <h3>${escapeHtml(v.title)}</h3><p class="muted">${v.memberCount} участник(ов)</p></div>
      ${iAmAdmin ? '<button class="settings-row" id="editGroupButton"><span class="row-icon">✎</span><span>Название и фото</span></button>' : ""}
      <button class="settings-row" id="addMemberButton"><span class="row-icon">＋</span><span>Добавить участника</span></button>
      ${iAmAdmin ? '<button class="settings-row" id="inviteLinkButton"><span class="row-icon">🔗</span><span>Ссылка приглашения</span></button>' : ""}
      <div class="search-section-title">Участники</div><div id="memberList"></div>`;
    const list = body.querySelector("#memberList");
    for (const m of members) {
      const role = roleOf(m.uid);
      const row = document.createElement("button");
      row.className = "user-row";
      row.innerHTML = `${avatarHtml(m.avatarColor, (m.displayName || "?")[0].toUpperCase(), m.avatar)}
        <span class="info"><strong>${escapeHtml(m.displayName)}${roleMark[role]}</strong><small>@${escapeHtml(m.username)} · ${formatLastSeen(m)}</small></span>`;
      row.addEventListener("click", (e) => showMemberContextMenu(e, m, role, iAmOwner, iAmAdmin));
      list.appendChild(row);
    }
    $("#addMemberButton").addEventListener("click", () => {
      openModal(`<h3>Добавить участника</h3><label class="field"><span>@имя</span><input id="newMemberName" placeholder="username" /></label>
        <div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">Добавить</button></div>`);
      $("#modal .cancel").addEventListener("click", closeModal);
      $("#modal .confirm").addEventListener("click", async () => {
        try {
          const name = $("#newMemberName").value.trim().toLowerCase().replace(/^@/, "");
          const reg = await getDoc(doc(dbf, "usernames", name));
          if (!reg.exists()) return toast("Пользователь не найден");
          await updateDoc(doc(dbf, "chats", chat.id), { members: arrayUnion(reg.data().uid) });
          closeModal(); openChatInfo(); toast("Добавлен(а)");
        } catch (error) { toast(ruError(error)); }
      });
    });
    body.querySelector("#inviteLinkButton")?.addEventListener("click", openInviteLinkModal);
    body.querySelector("#editGroupButton")?.addEventListener("click", () => {
      openModal(`<h3>Настройки ${chat.type === "channel" ? "канала" : "группы"}</h3>
        <label class="field"><span>Название</span><input id="editGroupTitle" maxlength="60" value="${escapeHtml(chat.title || "")}" /></label>
        <button type="button" class="settings-row" id="pickGroupPhoto"><span class="row-icon">🖼</span><span>Выбрать фото</span></button>
        <div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">Сохранить</button></div>`);
      let newPhoto = null;
      $("#pickGroupPhoto").addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "file"; input.accept = "image/*";
        input.addEventListener("change", async () => {
          if (!input.files[0]) return;
          newPhoto = await compressImage(input.files[0], 128, 0.8);
          if (newPhoto && newPhoto.length > 60_000) newPhoto = await compressImage(input.files[0], 96, 0.6);
          toast(newPhoto ? "Фото выбрано" : "Не удалось обработать фото");
        });
        input.click();
      });
      $("#modal .cancel").addEventListener("click", closeModal);
      $("#modal .confirm").addEventListener("click", async () => {
        try {
          const patch = { title: $("#editGroupTitle").value.trim().slice(0, 60) || chat.title };
          if (newPhoto) patch.avatar = newPhoto;
          await updateDoc(doc(dbf, "chats", chat.id), patch);
          bumpChat(chat.id);
          closeModal(); openChatInfo(); toast("Сохранено");
        } catch (error) { toast(ruError(error)); }
      });
    });
  } else if (v.type === "private" && v.peer) {
    const peer = v.peer;
    const blocked = (myPrefs.blocked || []).includes(peer.uid);
    body.innerHTML = `
      <div class="settings-profile">${avatarHtml(peer.avatarColor, (peer.displayName || "?")[0].toUpperCase(), peer.avatar, "avatar large")}
      <h3>${escapeHtml(peer.displayName)}</h3><p class="muted">@${escapeHtml(peer.username)}</p>
      <p>${escapeHtml(peer.bio || "")}</p><p class="muted">${formatLastSeen(peer)}</p></div>
      <button class="settings-row" id="blockButton"><span class="row-icon">${blocked ? "✓" : "🚫"}</span><span>${blocked ? "Разблокировать" : "Заблокировать"}</span></button>`;
    $("#blockButton").addEventListener("click", async () => {
      try {
        await setDoc(doc(dbf, "users", me.uid, "private", "prefs"),
          { blocked: blocked ? arrayRemove(peer.uid) : arrayUnion(peer.uid) }, { merge: true });
        myPrefs.blocked = blocked ? (myPrefs.blocked || []).filter(x => x !== peer.uid) : [...(myPrefs.blocked || []), peer.uid];
        toast(blocked ? "Разблокирован(а)" : "Заблокирован(а) — больше не сможет вам писать");
        openChatInfo();
      } catch (error) { toast(ruError(error)); }
    });
  } else {
    body.innerHTML = `<div class="settings-profile"><div class="avatar large" data-color="-1">☆</div><h3>Избранное</h3><p class="muted">Ваши личные заметки</p></div>`;
  }
  $("#chatInfoPanel").classList.remove("hidden");
}
$("#closeChatInfo").addEventListener("click", () => $("#chatInfoPanel").classList.add("hidden"));

function showMemberContextMenu(point, member, role, iAmOwner, iAmAdmin) {
  const buttons = [];
  const isSelf = member.uid === me.uid;
  if (!isSelf) buttons.push('<button data-act="dm">💬 Написать сообщение</button>');
  if (iAmOwner && !isSelf && role !== "owner") {
    buttons.push(role === "admin" ? '<button data-act="demote">⭐ Снять админа</button>' : '<button data-act="promote">⭐ Назначить админом</button>');
  }
  if (!isSelf && role !== "owner" && (iAmOwner || (iAmAdmin && role === "member"))) {
    buttons.push('<button data-act="kick" class="danger">🚫 Исключить из группы</button>');
  }
  if (!buttons.length) return;
  const chatId = currentChatId;
  showContextMenu(point, buttons.join(""));
  contextMenu.querySelectorAll("button").forEach(b => b.addEventListener("click", async () => {
    hideContextMenu();
    const act = b.dataset.act;
    const ref = doc(dbf, "chats", chatId);
    try {
      if (act === "dm") { $("#chatInfoPanel").classList.add("hidden"); openDmWith(member); }
      else if (act === "promote") { await updateDoc(ref, { admins: arrayUnion(member.uid) }); openChatInfo(); toast("Назначен(а) админом"); }
      else if (act === "demote") { await updateDoc(ref, { admins: arrayRemove(member.uid) }); openChatInfo(); toast("Права админа сняты"); }
      else if (act === "kick") {
        openConfirm(`Исключить ${member.displayName} из группы?`, async () => {
          await updateDoc(ref, { members: arrayRemove(member.uid), admins: arrayRemove(member.uid) });
          openChatInfo(); toast("Исключён(а)");
        });
      }
    } catch (error) { toast(ruError(error)); }
  }));
}

// ---------- инвайт-ссылки ----------
async function openInviteLinkModal() {
  const chat = currentChat();
  try {
    let code = chat.inviteCode;
    if (!code) {
      code = randomId(18);
      await setDoc(doc(dbf, "invites", code), { chatId: chat.id, title: chat.title, memberCount: chat.members.length, avatarColor: chat.avatarColor || 0 });
      await updateDoc(doc(dbf, "chats", chat.id), { inviteCode: code });
    }
    const link = `${location.origin}/join/${code}`;
    openModal(`<h3>Ссылка приглашения</h3>
      <p class="muted" style="font-size:13px">Любой, кто перейдёт по ссылке и войдёт в аккаунт, сможет вступить в группу.</p>
      <div class="invite-link-box">${escapeHtml(link)}</div>
      <div class="modal-actions">
        <button class="cancel" id="revokeInvite">Новая ссылка</button>
        <button class="confirm" id="copyInvite">Копировать</button>
      </div>`);
    $("#copyInvite").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(link); toast("Ссылка скопирована"); closeModal(); }
      catch { toast("Не удалось скопировать — выделите вручную"); }
    });
    $("#revokeInvite").addEventListener("click", async () => {
      try {
        await deleteDoc(doc(dbf, "invites", code));
        await updateDoc(doc(dbf, "chats", chat.id), { inviteCode: deleteField() });
        toast("Старая ссылка отозвана");
        closeModal(); openInviteLinkModal();
      } catch (error) { toast(ruError(error)); }
    });
  } catch (error) { toast(ruError(error)); }
}
let pendingInviteCode = null;
const inviteMatch = location.pathname.match(/^\/join\/([a-f0-9]{6,})$/);
if (inviteMatch) { pendingInviteCode = inviteMatch[1]; history.replaceState(null, "", "/"); }
async function maybeJoinInvite() {
  if (!pendingInviteCode || !me) return;
  const code = pendingInviteCode; pendingInviteCode = null;
  try {
    const inv = await getDoc(doc(dbf, "invites", code));
    if (!inv.exists()) return toast("Ссылка недействительна или отозвана.");
    const info = inv.data();
    const alreadyMember = chats.has(info.chatId);
    openModal(`<h3>Приглашение в группу</h3>
      <div class="settings-profile"><div class="avatar large" data-color="${info.avatarColor}">${escapeHtml((info.title || "?")[0].toUpperCase())}</div>
      <h3>${escapeHtml(info.title)}</h3><p class="muted">${info.memberCount} участник(ов)</p></div>
      <div class="modal-actions"><button class="cancel">Отмена</button><button class="confirm">${alreadyMember ? "Открыть" : "Вступить"}</button></div>`);
    $("#modal .cancel").addEventListener("click", closeModal);
    $("#modal .confirm").addEventListener("click", async () => {
      try {
        if (!alreadyMember) await updateDoc(doc(dbf, "chats", info.chatId), { members: arrayUnion(me.uid) });
        closeModal();
        for (let i = 0; i < 30 && !chats.has(info.chatId); i++) await new Promise(r => setTimeout(r, 100));
        if (chats.has(info.chatId)) { openChat(info.chatId); if (!alreadyMember) toast("Вы вступили в группу"); }
      } catch (error) { closeModal(); toast(ruError(error)); }
    });
  } catch (error) { toast(ruError(error)); }
}

// ---------- поиск по чатам и людям ----------
let searchTimer;
$("#chatSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const queryText = $("#chatSearch").value.trim();
  const results = $("#searchResults");
  const list = $("#chatList");
  if (!queryText) { results.classList.add("hidden"); list.classList.remove("hidden"); return; }
  searchTimer = setTimeout(async () => {
    list.classList.add("hidden"); results.classList.remove("hidden");
    results.replaceChildren();
    const views = [...chats.values()].map(viewOf);
    const matched = views.filter(c => (c.title || "").toLowerCase().includes(queryText.toLowerCase()));
    if (matched.length) {
      results.insertAdjacentHTML("beforeend", '<div class="search-section-title">Чаты</div>');
      for (const c of matched) {
        const item = document.createElement("button");
        item.className = "chat-item";
        item.innerHTML = `<span class="avatar" data-color="${c.avatarColor}">${c.type === "saved" ? "☆" : escapeHtml(c.title[0].toUpperCase())}</span><span class="chat-item-text"><strong>${escapeHtml(c.title)}</strong></span>`;
        item.addEventListener("click", () => { $("#chatSearch").value = ""; results.classList.add("hidden"); list.classList.remove("hidden"); openChat(c.id); });
        results.appendChild(item);
      }
    }
    try {
      const users = await searchUsers(queryText);
      if (users.length) {
        results.insertAdjacentHTML("beforeend", '<div class="search-section-title">Люди</div>');
        for (const user of users) {
          const row = document.createElement("button");
          row.className = "user-row";
          row.innerHTML = `${avatarHtml(user.avatarColor, (user.displayName || "?")[0].toUpperCase(), user.avatar)}<span class="info"><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></span>`;
          row.addEventListener("click", async () => {
            $("#chatSearch").value = "";
            results.classList.add("hidden"); list.classList.remove("hidden");
            await openDmWith(user);
          });
          results.appendChild(row);
        }
      }
      if (!results.children.length) results.innerHTML = '<p class="muted" style="padding:16px">Ничего не найдено</p>';
    } catch { /* поиск не критичен */ }
  }, 300);
});
