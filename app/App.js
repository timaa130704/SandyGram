// SandyGram — нативное приложение (React Native + Expo), общий Firebase с сайтом
import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Image, Modal,
  KeyboardAvoidingView, Platform, StyleSheet, ScrollView,
  ActivityIndicator, Alert, AppState, Linking, Animated, PanResponder,
  BackHandler, Keyboard,
} from "react-native";
import { SafeAreaView, SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as Clipboard from "expo-clipboard";
import { useAudioRecorder, RecordingPresets, AudioModule, setAudioModeAsync, createAudioPlayer } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as Notifications from "expo-notifications";
import { useFonts } from "expo-font";
import { MaterialIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth, db, rtdb } from "./fire";
// Общая логика 3.0 (медиа в R2, исчезающие, папки, мини-игра) — копия web/public/sg30.js
import {
  uploadMedia, fmtBytes, mediaKind, MEDIA_MAX_BYTES,
  TTL_OPTIONS, ttlLabel, ttlLeft, isExpired,
  foldersWithCounts, chatsInFolder, newTttGame, tttMove, tttMark,
} from "./sg30";
import { ensureKeyPair, sealForMembers, openForMe, fingerprint, exportKeyBackup, importKeyBackup, restoreKeyPair } from "./sge2e";
import { ref as dbRef, onValue, onChildAdded, set as dbSet, update as dbUpdate, push as dbPush, remove as dbRemove } from "firebase/database";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as SecureStore from "expo-secure-store";
import * as LocalAuthentication from "expo-local-authentication";
import * as Crypto from "expo-crypto";
import * as Sharing from "expo-sharing";
import * as ScreenCapture from "expo-screen-capture";
import { RTCPeerConnection, RTCView, mediaDevices } from "react-native-webrtc";
import {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  GoogleAuthProvider, signInWithCredential,
} from "firebase/auth";
import { GoogleSignin } from "@react-native-google-signin/google-signin";
GoogleSignin.configure({ webClientId: "762527338102-77jt8o1eshleh05mi1hitbvkeku0bu5k.apps.googleusercontent.com" });
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where,
  orderBy, limit, onSnapshot, runTransaction, arrayUnion, arrayRemove, increment,
  writeBatch, deleteField,
} from "firebase/firestore";

// ---------- темы ----------
const THEMES = {
  dark: {
    bg: "#0a0a0a", surface: "#141414", surface2: "#1e1e1e", outline: "#333",
    text: "#f2f2f2", muted: "#8f8f8f", inverse: "#d0bcff", onInverse: "#381e72",
    bubbleIn: "#1f1f1f", danger: "#ff6b6b",
  },
  light: {
    bg: "#f4f4f4", surface: "#ffffff", surface2: "#ececec", outline: "#d4d4d4",
    text: "#111", muted: "#737373", inverse: "#6750A4", onInverse: "#ffffff",
    bubbleIn: "#ffffff", danger: "#c92a2a",
  },
};
const AVATAR_TONES = ["#f3edff", "#e8ddfd", "#dccffb", "#cfc0f8", "#c2b1f4", "#b5a2f0", "#a893ec"];
const ONLINE_WINDOW = 70e3;
// Ключи сквозного шифрования: приватный лежит в expo-secure-store (Keystore Android),
// публичный публикуется в users/{uid}.e2ePub. Модульная переменная — чтобы был доступ из всех экранов.
let myKeys = null;
const e2eStorage = {
  get: (k) => SecureStore.getItemAsync(k).catch(() => null),
  set: (k, v) => (v ? SecureStore.setItemAsync(k, v) : SecureStore.deleteItemAsync(k)).catch(() => { }),
};
const QUICK_REACTIONS = ["❤️", "👍", "🔥", "😂", "😮", "😢"];
// Полный набор для пикера реакций (правила разрешают до 24 разных эмодзи на сообщение)
const ALL_REACTIONS = [
  "❤️", "👍", "👎", "🔥", "😂", "😮", "😢", "😡", "🎉", "🙏", "👏", "💯",
  "🤔", "🤯", "🥳", "🥺", "😍", "😎", "🤡", "💩", "👀", "💪", "🤝", "✍️",
  "✅", "❌", "⚡", "🌚", "🍓", "🍾", "🏆", "🎯", "🤣", "😴", "🫡", "🙈",
];
const SITE = "https://sandygram-a3b42.web.app";
const LINK_WORKER = "https://sandygram-push.sandygram.workers.dev";
const APP_VERSION = "3.0.0";
const APK_URL = "https://github.com/timaa130704/SandyGram/releases/latest/download/SandyGram.apk";
// Сигнальная шина RTDB — для мгновенного realtime у ПК-клиента
const RTDB = "https://sandygram-a3b42-default-rtdb.europe-west1.firebasedatabase.app";
async function bumpChat(chatId) {
  try {
    const t = await auth.currentUser?.getIdToken();
    if (t) fetch(`${RTDB}/bump/${encodeURIComponent(chatId)}.json?auth=${t}`, { method: "PUT", body: String(Date.now()) }).catch(() => { });
  } catch { }
}
// Коды стикеров OpenMoji — картинки лежат на хостинге сайта
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
];
const STICKERS = ["1F600","1F602","1F60D","1F60E","1F914","1F644","1F62D","1F621","1F973","1F97A","1F480","1F4A9","1F525","2764","1F44D","1F44E","1F44C","1F64F","1F4AA","1F440","1F389","1F680","26A1","1F31A","1F31D","1F63B","1F63C","1F998","1F984","1F37F"];

const emailFor = (u) => `${u}@sandygram.app`;
const modRegex = /^\/(mute|warn|ban|unmute|unban)\b/i;
const PERMANENT_MOD = 4102444800000; // ~2100 год, «навсегда»
function parseDurationMod(s) {
  const t = (s || "").trim().toLowerCase();
  if (!t) return null;
  if (t === "0" || t === "off" || t === "нет" || t === "снять") return 0;
  const m = /^(\d+)([мчдхс]|мин|час|час|ч|день|дня|дней|мес|сек)?$/.exec(t.replace(/\s/g, ""));
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!n) return null;
  const u = m[2] || "м";
  const per = u.includes("с") || u.includes("сек") ? 1e3 : u.includes("м") ? 60e3 : u.includes("ч") || u.includes("х") ? 3600e3 : u.includes("д") ? 864e5 : 30 * 864e5;
  return n * per * (u.includes("м") && !u.includes("мин") ? 1 : u === "мес" ? 30 : 1);
}
function fmtDurationMod(d) {
  if (!d) return "нет";
  if (d >= PERMANENT_MOD) return "навсегда";
  const min = Math.round(d / 60e3);
  if (min < 60) return `${min} мин`;
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)}ч ${min % 60 ? `${min % 60}м` : ""}`;
  const day = Math.floor(h / 24);
  return `${day}д ${Math.floor(h % 24)}ч`;
}
function fmtUntilMod(ts) {
  if (ts >= PERMANENT_MOD) return "навсегда";
  return new Date(ts).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
const randomId = (len = 18) => { let s = ""; while (s.length < len) s += Math.random().toString(16).slice(2); return s.slice(0, len); };
const isOnlineUser = (u) => u && Date.now() - (u.lastSeen || 0) < ONLINE_WINDOW;
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
function fmtDay(ts) {
  const d = new Date(ts), t = new Date();
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return "Сегодня";
  if (d.toDateString() === y.toDateString()) return "Вчера";
  return d.toLocaleDateString([], { day: "numeric", month: "long" });
}
function fmtChatTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
}
function fmtLastSeen(u) {
  if (!u) return "";
  if (u.hideLastSeen) return "был(а) недавно";
  if (isOnlineUser(u)) return "в сети";
  if (!u.lastSeen) return "был(а) недавно";
  const diff = Date.now() - u.lastSeen;
  if (diff < 60e3) return "был(а) только что";
  if (diff < 3600e3) return `был(а) ${Math.floor(diff / 60e3)} мин назад`;
  if (new Date(u.lastSeen).toDateString() === new Date().toDateString()) return `был(а) в ${fmtTime(u.lastSeen)}`;
  return `был(а) ${new Date(u.lastSeen).toLocaleDateString([], { day: "2-digit", month: "2-digit" })}`;
}
const ruError = (e) => {
  const c = e?.code || "";
  if (c.includes("email-already-in-use")) return "Такой пользователь уже существует.";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "Неверное имя пользователя или пароль.";
  if (c.includes("too-many-requests")) return "Слишком много попыток. Подождите минуту.";
  if (c.includes("network-request-failed")) return "Нет соединения. Проверьте интернет.";
  if (c.includes("permission-denied") || /permission/i.test(e?.message || "")) return "Нет прав на это действие.";
  return e?.message || "Ошибка";
};

// ---------- мелкие компоненты ----------
const Avatar = ({ label, color = 0, size = 46, T, photo = null }) => (
  <View style={{
    width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", overflow: "hidden",
    backgroundColor: color === -1 ? T.inverse : AVATAR_TONES[Math.abs(color) % 7],
  }}>
    {photo
      ? <Image source={{ uri: photo }} style={{ width: size, height: size }} />
      : <Text style={{ color: color === -1 ? T.onInverse : "#241a4a", fontSize: size * 0.4, fontWeight: "700" }}>{label}</Text>}
  </View>
);

// Нижний лист с кнопками-действиями
function ActionSheet({ T, items, onClose, header = null }) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: "#0007", justifyContent: "flex-end" }}>
        <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 12, paddingBottom: 30 }}>
          {header}
          {items.map((it, i) => (
            <TouchableOpacity key={i} style={st.row} onPress={() => { onClose(); it.onPress(); }}>
              <Text style={{ color: it.danger ? T.danger : T.text, fontSize: 16 }}>{it.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// Модалка с текстовыми полями
function PromptModal({ T, title, fields, submitLabel = "Сохранить", onSubmit, onClose }) {
  const [vals, setVals] = useState(Object.fromEntries(fields.map(f => [f.key, f.value || ""])));
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#0008", justifyContent: "center", padding: 26 }}>
        <View style={{ backgroundColor: T.surface, borderRadius: 22, padding: 20 }}>
          <Text style={{ color: T.text, fontSize: 18, fontWeight: "800", marginBottom: 12 }}>{title}</Text>
          {fields.map(f => (
            <TextInput key={f.key} value={vals[f.key]} onChangeText={v => setVals(prev => ({ ...prev, [f.key]: v }))}
              placeholder={f.placeholder} placeholderTextColor={T.muted} autoCapitalize="none"
              style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
          ))}
          <View style={{ flexDirection: "row", gap: 10, marginTop: 4 }}>
            <TouchableOpacity onPress={onClose} style={{ flex: 1, padding: 13, borderRadius: 999, backgroundColor: T.surface2, alignItems: "center" }}>
              <Text style={{ color: T.text, fontWeight: "700" }}>Отмена</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { onClose(); onSubmit(vals); }} style={{ flex: 1, padding: 13, borderRadius: 999, backgroundColor: T.inverse, alignItems: "center" }}>
              <Text style={{ color: T.onInverse, fontWeight: "800" }}>{submitLabel}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Спойлер: замазан цветом фона, открывается тапом и обратно не закрывается
function Spoiler({ T, children }) {
  const [open, setOpen] = useState(false);
  return (
    <Text onPress={() => setOpen(true)}
      style={open ? null : { backgroundColor: T?.muted || "#888", color: "transparent" }}>
      {children}
    </Text>
  );
}
// Разметка внутри обычного текста: ```блок```, `код`, ||спойлер||,
// **жирный**, *курсив*, ~~зачёркнутый~~. В RN нет HTML, поэтому каждый
// фрагмент — вложенный <Text> со своим стилем; вставить чужую вёрстку нельзя.
const MD_RE = /(```[\s\S]*?```|`[^`\n]+`|\|\|[\s\S]+?\|\||\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~)/g;
function mdSegments(str, T, keyBase) {
  const out = [];
  let last = 0, m;
  MD_RE.lastIndex = 0;
  while ((m = MD_RE.exec(str))) {
    if (m.index > last) out.push(str.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${m.index}`;
    if (tok.startsWith("```")) out.push(<Text key={k} style={{ fontFamily: "monospace", fontSize: 13.5 }}>{tok.slice(3, -3).replace(/^\r?\n/, "").replace(/\s+$/, "")}</Text>);
    else if (tok.startsWith("`")) out.push(<Text key={k} style={{ fontFamily: "monospace" }}>{tok.slice(1, -1)}</Text>);
    else if (tok.startsWith("||")) out.push(<Spoiler key={k} T={T}>{tok.slice(2, -2)}</Spoiler>);
    else if (tok.startsWith("**")) out.push(<Text key={k} style={{ fontWeight: "800" }}>{tok.slice(2, -2)}</Text>);
    else if (tok.startsWith("~~")) out.push(<Text key={k} style={{ textDecorationLine: "line-through" }}>{tok.slice(2, -2)}</Text>);
    else out.push(<Text key={k} style={{ fontStyle: "italic" }}>{tok.slice(1, -1)}</Text>);
    last = m.index + tok.length;
  }
  if (last < str.length) out.push(str.slice(last));
  return out;
}

// Текст с кликабельными @упоминаниями и разметкой
function MentionText({ text, style, mentionStyle, linkStyle, onMention, onInvite, T }) {
  const nodes = [];
  const urlRE = /https?:\/\/[^\s<]+/gi;
  const plain = [];
  const flush = (s) => {
    let last = 0, m;
    const menRE = /(^|[\s.,:;!?()«»"'-])@([a-z0-9_]{3,24})\b/gi;
    while ((m = menRE.exec(s))) {
      const start = m.index + m[1].length;
      if (start > last) plain.push(s.slice(last, start));
      const name = m[2].toLowerCase();
      nodes.push(<Text key={`m${nodes.length}-${m.index}`} style={mentionStyle} onPress={() => onMention(name)}>@{m[2]}</Text>);
      last = start + m[2].length + 1;
    }
    if (last < s.length) plain.push(s.slice(last));
    if (plain.length) { nodes.push(<Text key={`s${nodes.length}`}>{mdSegments(plain.join(""), T, `md${nodes.length}`)}</Text>); plain.length = 0; }
  };
  let lastText = 0, mu;
  while ((mu = urlRE.exec(text))) {
    if (mu.index > lastText) flush(text.slice(lastText, mu.index));
    const url = mu[0].replace(/[.,;:!?)]+$/, "");
    const invite = url.match(/^https?:\/\/(?:sandygram-a3b42\.web\.app|localhost(?::\d+)?)\/join\/([a-f0-9]{6,})$/i);
    nodes.push(
      <Text key={`l${nodes.length}-${mu.index}`} style={linkStyle}
        onPress={() => invite ? onInvite?.(invite[1]) : Linking.openURL(url).catch(() => { })}>
        {url}
      </Text>
    );
    lastText = mu.index + mu[0].length;
  }
  if (lastText < text.length) flush(text.slice(lastText));
  return <Text style={style}>{nodes}</Text>;
}

// ================================================================
function applyGlobalFont() {
  // выставляем Google Sans всем Text/TextInput по умолчанию
  for (const C of [Text, TextInput]) {
    const anyC = C;
    anyC.defaultProps = anyC.defaultProps || {};
    const prev = anyC.defaultProps.style;
    anyC.defaultProps.style = [{ fontFamily: "GoogleSans" }, prev].filter(Boolean);
  }
}

export default function Root() {
  const [fontsLoaded] = useFonts({
    GoogleSans: require("./assets/fonts/GoogleSans-Regular.ttf"),
    GoogleSansMedium: require("./assets/fonts/GoogleSans-Medium.ttf"),
    GoogleSansBold: require("./assets/fonts/GoogleSans-Bold.ttf"),
  });
  if (fontsLoaded) applyGlobalFont();
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: "#0a0a0a" }} />;
  return (
    <SafeAreaProvider>
      <SandyGram />
    </SafeAreaProvider>
  );
}

// Экран блокировки: пин-код (4 цифры) или биометрия
function PinLock({ T, mode, onUnlock, onSkip }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (pin.length < 4) return;
    setErr("");
    if (mode === "setup") {
      if (!confirm) { setConfirm(true); setPin(""); return; }
      try { await SecureStore.setItemAsync("sandy_pin", pin); onUnlock(); }
      catch { setErr("Не удалось сохранить пин-код"); }
    } else {
      const stored = await SecureStore.getItemAsync("sandy_pin").catch(() => null);
      if (stored && pin === stored) onUnlock();
      else { setErr("Неверный пин-код"); setPin(""); }
    }
  };
  const bio = async () => {
    try {
      const hw = await LocalAuthentication.hasHardwareAsync();
      const en = await LocalAuthentication.isEnrolledAsync();
      if (hw && en) {
        const r = await LocalAuthentication.authenticateAsync({ promptMessage: "Разблокируйте SandyGram" });
        if (r.success) onUnlock();
      } else setErr("Биометрия недоступна — введите пин-код");
    } catch { setErr("Биометрия недоступна — введите пин-код"); }
  };
  return (
    <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: T.bg, zIndex: 999, alignItems: "center", justifyContent: "center", padding: 30 }}>
      <Text style={{ fontSize: 34, marginBottom: 8 }}>🔒</Text>
      <Text style={{ color: T.text, fontSize: 18, fontWeight: "800", marginBottom: 18, textAlign: "center" }}>
        {mode === "setup" ? (confirm ? "Повторите пин-код" : "Придумайте пин-код (4 цифры)") : "Введите пин-код"}
      </Text>
      <TextInput
        value={pin}
        onChangeText={(t) => { setPin(t.replace(/\D/g, "").slice(0, 4)); if (err) setErr(""); }}
        keyboardType="number-pad" secureTextEntry maxLength={4} autoFocus
        style={{ width: 160, textAlign: "center", fontSize: 26, letterSpacing: 14, color: T.text, backgroundColor: T.surface, borderRadius: 14, paddingVertical: 10 }}
      />
      {!!err && <Text style={{ color: T.danger, marginTop: 10, textAlign: "center", fontSize: 13 }}>{err}</Text>}
      <View style={{ flexDirection: "row", gap: 12, marginTop: 24 }}>
        {mode === "enter" && (
          <TouchableOpacity onPress={bio} style={{ padding: 13, borderRadius: 999, backgroundColor: T.surface2 }}>
            <Text style={{ color: T.text, fontWeight: "700" }}>👆 Биометрия</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={submit} style={{ padding: 13, borderRadius: 999, backgroundColor: T.inverse }}>
          <Text style={{ color: T.onInverse, fontWeight: "800" }}>{mode === "setup" ? (confirm ? "Готово" : "Далее") : "Войти"}</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity onPress={onSkip} style={{ marginTop: 20, padding: 10 }}>
        <Text style={{ color: T.muted, fontSize: 13 }}>{mode === "setup" ? "Пропустить" : "Выйти из аккаунта"}</Text>
      </TouchableOpacity>
    </View>
  );
}

function SandyGram() {
  const [themeName, setThemeName] = useState("dark");
  const T = THEMES[themeName];
  const [booted, setBooted] = useState(false);
  const [pinLocked, setPinLocked] = useState(false);
  const [pinSetup, setPinSetup] = useState(false);
  const [me, setMe] = useState(null);
  const [chats, setChats] = useState(new Map());
  const [users, setUsers] = useState(new Map());
  const [screen, setScreen] = useState({ name: "list" });
  const [pendingInvite, setPendingInvite] = useState(null);
  const [myPrefs, setMyPrefs] = useState({ blocked: [], hideLastSeen: false });
  const [needName, setNeedName] = useState(null); // {uid, email, displayName, photoURL}
  const [stories, setStories] = useState([]);
  const [call, setCall] = useState(null);        // { calleeUid, callId, isCaller, video, peerName, peerAvatar, peerColor, offer? }
  const [incoming, setIncoming] = useState(null); // { callId, data }

  useEffect(() => { AsyncStorage.getItem("theme").then(v => v && setThemeName(v)); }, []);
  const toggleTheme = () => { const n = themeName === "dark" ? "light" : "dark"; setThemeName(n); AsyncStorage.setItem("theme", n); };

  // ---- уведомление о новой версии ----
  useEffect(() => {
    (async () => {
      try {
        const d = await getDoc(doc(db, "meta", "app"));
        if (!d.exists()) return;
        const latest = d.data().version || "";
        const newer = (a, b) => {
          const x = a.split(".").map(Number), y = b.split(".").map(Number);
          for (let i = 0; i < 3; i++) { if ((x[i] || 0) > (y[i] || 0)) return true; if ((x[i] || 0) < (y[i] || 0)) return false; }
          return false;
        };
        if (latest && newer(latest, APP_VERSION)) {
          Alert.alert("Доступно обновление", `Вышла версия ${latest} (у вас ${APP_VERSION}). Скачать?`, [
            { text: "Позже", style: "cancel" },
            { text: "Скачать", onPress: () => Linking.openURL(d.data().apk || APK_URL) },
          ]);
        }
      } catch { }
    })();
  }, []);

  // ---- deep links: sandygram://join/<code> и https://…/join/<code> ----
  useEffect(() => {
    const handle = (url) => {
      const m = String(url || "").match(/join\/([a-f0-9]{6,})/i);
      if (m) setPendingInvite(m[1]);
    };
    Linking.getInitialURL().then(handle).catch(() => { });
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (me && pendingInvite) { const c = pendingInvite; setPendingInvite(null); joinByCode(c); }
  }, [me, pendingInvite]);

  // ---- auth (с восстановлением оборванной регистрации) ----
  useEffect(() => onAuthStateChanged(auth, async (user) => {
    if (!user) { setMe(null); setNeedName(null); setChats(new Map()); setPinLocked(false); setPinSetup(false); setBooted(true); return; }
    let profile = null;
    for (let i = 0; i < 5 && !profile; i++) {
      try {
        const p = await getDoc(doc(db, "users", user.uid));
        if (p.exists()) profile = { uid: user.uid, ...p.data() };
      } catch { }
      if (!profile) await new Promise(r => setTimeout(r, 600));
    }
    if (!profile) {
      try {
        const snap = await getDocs(query(collection(db, "usernames"), where("uid", "==", user.uid), limit(1)));
        if (!snap.empty) {
          const name = snap.docs[0].id;
          const data = { username: name, displayName: name, bio: "", avatarColor: Math.floor(Math.random() * 7), createdAt: Date.now(), lastSeen: Date.now() };
          await setDoc(doc(db, "users", user.uid), data);
          await setDoc(doc(db, "chats", `saved_${user.uid}`), { type: "saved", members: [user.uid], createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] }).catch(() => { });
          profile = { uid: user.uid, ...data };
        }
      } catch { }
    }
    if (profile) { setNeedName(null); setMe(profile); SecureStore.getItemAsync("sandy_pin").then(pin => {
      if (pin) setPinLocked(true);
      else SecureStore.getItemAsync("sandy_pin_asked").then(asked => { if (!asked) { setPinSetup(true); SecureStore.setItemAsync("sandy_pin_asked", "1").catch(() => {}); } });
    }).catch(() => {}); }
    else setNeedName({ uid: user.uid, email: user.email, displayName: user.displayName, photoURL: user.photoURL });
    setBooted(true);
  }), []);

  // ---- подписка на чаты ----
  useEffect(() => {
    if (!me?.uid) return;
    const q = query(collection(db, "chats"), where("members", "array-contains", me.uid));
    const unsub = onSnapshot(q, (snap) => {
      setChats(prev => {
        const next = new Map(prev);
        snap.docChanges().forEach(ch => {
          if (ch.type === "removed") next.delete(ch.doc.id);
          else next.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
        });
        return next;
      });
    }, () => { });
    return unsub;
  }, [me?.uid]);

  // ---- профили собеседников (presence) ----
  const peerKey = useMemo(() => {
    if (!me?.uid) return "";
    const set = new Set();
    for (const c of chats.values()) if (c.type === "private") { const p = (c.members || []).find(m => m !== me.uid); if (p) set.add(p); }
    return [...set].sort().join(",");
  }, [chats, me?.uid]);
  useEffect(() => {
    if (!me?.uid || !peerKey) return;
    const unsubs = peerKey.split(",").map(uid =>
      onSnapshot(doc(db, "users", uid), d => {
        if (d.exists()) setUsers(prev => new Map(prev).set(uid, { uid, ...d.data() }));
      }));
    return () => unsubs.forEach(u => u());
  }, [me?.uid, peerKey]);

  // ---- heartbeat присутствия ----
  useEffect(() => {
    if (!me?.uid) return;
    const beat = () => { if (AppState.currentState === "active") updateDoc(doc(db, "users", me.uid), { lastSeen: Date.now() }).catch(() => { }); };
    beat();
    const t = setInterval(beat, 30e3);
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") beat(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [me?.uid]);

  // ---- автоблокировка: код-замок снова просят после 5 минут в фоне ----
  useEffect(() => {
    if (!me?.uid) return;
    let hidAt = 0;
    const sub = AppState.addEventListener("change", async (state) => {
      if (state !== "active") { hidAt = Date.now(); return; }
      if (!hidAt || Date.now() - hidAt < 5 * 60e3) return;
      hidAt = 0;
      const pin = await SecureStore.getItemAsync("sandy_pin").catch(() => null);
      if (pin) setPinLocked(true);
    });
    return () => sub.remove();
  }, [me?.uid]);

  // ---- входящие звонки ----
  useEffect(() => {
    if (!me?.uid) return;
    const unsub = onChildAdded(dbRef(rtdb, `calls/${me.uid}`), (snap) => {
      const data = snap.val();
      if (!data || data.status !== "ringing" || Date.now() - (data.createdAt || 0) > 60e3) return;
      setIncoming((cur) => cur ? cur : { callId: snap.key, data });
    });
    return () => unsub();
  }, [me?.uid]);

  const startCall = (peerUid, peer, video) => {
    if (call) return;
    setCall({
      calleeUid: peerUid, callId: randomId(16), isCaller: true, video,
      peerName: peer?.displayName || "Звонок", peerAvatar: peer?.avatar || null, peerColor: peer?.avatarColor ?? 0,
    });
  };

  // ---- истории ----
  useEffect(() => {
    if (!me?.uid) return;
    const q = query(collection(db, "stories"), where("expiresAt", ">", Date.now()));
    const unsub = onSnapshot(q, (snap) => {
      setStories(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(st => st.expiresAt > Date.now()));
    }, () => { });
    return unsub;
  }, [me?.uid]);

  // ---- ключи сквозного шифрования ----
  useEffect(() => {
    if (!me?.uid) return;
    (async () => {
      try {
        myKeys = await ensureKeyPair(e2eStorage);
        if (me.e2ePub !== myKeys.pub) {
          await updateDoc(doc(db, "users", me.uid), { e2ePub: myKeys.pub });
          setMe(prev => (prev ? { ...prev, e2ePub: myKeys.pub } : prev));
        }
      } catch { myKeys = null; }
    })();
  }, [me?.uid]);

  // ---- приватные настройки (чёрный список) ----
  useEffect(() => {
    if (!me?.uid) return;
    getDoc(doc(db, "users", me.uid, "private", "prefs")).then(async p => {
      const data = p.exists() ? p.data() : {};
      setMyPrefs({ blocked: [], hideLastSeen: false, ...data });
      const sid = await registerSession(me.uid);
      // «Выйти везде» с другого устройства: сессия старше метки — выходим сами
      if (data.revokeBefore) {
        const mine = await getDoc(doc(db, "users", me.uid, "sessions", sid)).catch(() => null);
        const born = mine?.data()?.createdAt || 0;
        if (born && born < data.revokeBefore) {
          await AsyncStorage.removeItem("sg_session_id").catch(() => { });
          Alert.alert("", "Сессия завершена с другого устройства");
          signOut(auth).catch(() => { });
        }
      }
    }).catch(() => { });
  }, [me?.uid]);

  // ---- push-уведомления: регистрация FCM-токена + открытие чата по тапу ----
  useEffect(() => {
    if (!me?.uid) return;
    (async () => {
      try {
        await Notifications.setNotificationChannelAsync("default", {
          name: "Сообщения", importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 200, 100, 200], lightColor: "#ffffff",
        });
        const perm = await Notifications.requestPermissionsAsync();
        if (!perm.granted) return;
        const tok = (await Notifications.getDevicePushTokenAsync()).data;
        if (tok) {
          await AsyncStorage.setItem("fcmToken", tok);
          await updateDoc(doc(db, "users", me.uid), { fcmTokens: arrayUnion(tok) }).catch(() => { });
        }
      } catch { }
    })();
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const chatId = resp?.notification?.request?.content?.data?.chatId;
      if (chatId) setScreen({ name: "chat", chatId });
    });
    return () => sub.remove();
  }, [me?.uid]);

  const fetchUser = useCallback(async (uid) => {
    if (users.has(uid)) return users.get(uid);
    try {
      const d = await getDoc(doc(db, "users", uid));
      if (!d.exists()) return null;
      const u = { uid, ...d.data() };
      setUsers(prev => new Map(prev).set(uid, u));
      return u;
    } catch { return null; }
  }, [users]);

  const viewOf = useCallback((chat) => {
    const v = {
      id: chat.id, type: chat.type, raw: chat,
      pinned: (chat.pinnedBy || []).includes(me.uid),
      muted: (chat.muted || []).includes(me.uid),
      unread: (chat.unread || {})[me.uid] || 0,
      lastMessage: chat.lastMessage || null,
      lastReadByOthers: Math.max(0, ...Object.entries(chat.lastRead || {}).filter(([u]) => u !== me.uid).map(([, t]) => t)),
      memberCount: (chat.members || []).length,
    };
    if (chat.type === "saved") { v.title = "Избранное"; v.avatarColor = -1; }
    else if (chat.type === "private") {
      const uid = (chat.members || []).find(m => m !== me.uid);
      const peer = users.get(uid);
      v.peerUid = uid; v.peer = peer;
      v.title = peer?.displayName || "…"; v.avatarColor = peer?.avatarColor ?? 0;
      v.photo = peer?.avatar || null;
    } else { v.title = chat.title; v.avatarColor = chat.avatarColor || 0; v.photo = chat.avatar || null; }
    return v;
  }, [me, users]);

  // ---- общие действия ----
  const openDmWith = useCallback(async (user) => {
    if (!user || user.uid === me.uid) return;
    try {
      const chatId = `dm_${[me.uid, user.uid].sort().join("_")}`;
      const ex = await getDoc(doc(db, "chats", chatId)).catch(() => null);
      if (!ex || !ex.exists()) {
        await setDoc(doc(db, "chats", chatId), { type: "private", members: [me.uid, user.uid].sort(), createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] });
      }
      // я сам начал чат — разрешаю собеседнику отвечать (в режиме «Никто» список заморожен)
      if ((myPrefs.dmMode || (myPrefs.dmClosed ? "contacts" : "all")) !== "none" && !(myPrefs.dmAllow || []).includes(user.uid)) {
        const next = [...new Set([...(myPrefs.dmAllow || []), user.uid])];
        setDoc(doc(db, "users", me.uid, "private", "prefs"), { dmAllow: next }, { merge: true }).catch(() => { });
        setMyPrefs(p => ({ ...p, dmAllow: next }));
      }
      setUsers(prev => new Map(prev).set(user.uid, user));
      setScreen({ name: "chat", chatId });
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  }, [me, myPrefs]);
  const openDmByName = useCallback(async (name) => {
    try {
      const reg = await getDoc(doc(db, "usernames", name));
      if (!reg.exists()) return Alert.alert("", "Пользователь не найден");
      const user = await fetchUser(reg.data().uid);
      if (user) openDmWith(user);
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  }, [fetchUser, openDmWith]);
  const joinByCode = useCallback(async (code) => {
    try {
      const inv = await getDoc(doc(db, "invites", code));
      if (!inv.exists()) return Alert.alert("", "Ссылка недействительна или отозвана.");
      const info = inv.data();
      Alert.alert("Приглашение", `Вступить в «${info.title}» (${info.memberCount} участник(ов))?`, [
        { text: "Отмена", style: "cancel" },
        {
          text: "Вступить", onPress: async () => {
            try {
              await updateDoc(doc(db, "chats", info.chatId), { members: arrayUnion(me.uid) });
              setScreen({ name: "chat", chatId: info.chatId });
            } catch (e) { Alert.alert("Ошибка", ruError(e)); }
          },
        },
      ]);
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  }, [me]);

  if (!booted) return <View style={{ flex: 1, backgroundColor: "#0a0a0a", alignItems: "center", justifyContent: "center" }}><ActivityIndicator color="#888" /></View>;

  const ctx = { T, me, setMe, chats, users, viewOf, fetchUser, screen, setScreen, themeName, toggleTheme,
    setTheme: (n) => { if (n === "dark" || n === "light") { setThemeName(n); AsyncStorage.setItem("theme", n); } },
    openDmWith, openDmByName, joinByCode, myPrefs, setMyPrefs, stories, startCall };
  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      <StatusBar style={themeName === "dark" ? "light" : "dark"} />
      {needName ? <PickNameScreen ctx={ctx} pending={needName} onDone={(p) => { setNeedName(null); setMe(p); }} />
        : !me ? <AuthScreen ctx={ctx} />
          : screen.name === "chat" ? <ChatScreen key={screen.chatId} ctx={ctx} chatId={screen.chatId} />
            : <ListScreen ctx={ctx} />}
      {call && me && <CallScreen T={T} me={me} call={call} onEnd={() => setCall(null)} />}
      {incoming && me && !call && (
        <Modal transparent animationType="fade" onRequestClose={() => {}}>
          <View style={{ flex: 1, backgroundColor: "#000000cc", alignItems: "center", justifyContent: "center" }}>
            <View style={{ backgroundColor: T.surface, borderRadius: 28, padding: 36, alignItems: "center", minWidth: 280 }}>
              <Avatar T={T} label={(incoming.data.fromName || "?")[0].toUpperCase()} color={incoming.data.fromColor ?? 0} photo={incoming.data.fromAvatar} size={84} />
              <Text style={{ color: T.text, fontSize: 20, fontWeight: "800", marginTop: 12 }}>{incoming.data.fromName}</Text>
              <Text style={{ color: T.muted, marginTop: 2 }}>{incoming.data.video ? "Входящий видеозвонок" : "Входящий звонок"}</Text>
              <View style={{ flexDirection: "row", gap: 44, marginTop: 26 }}>
                <TouchableOpacity onPress={() => {
                  dbUpdate(dbRef(rtdb, `calls/${me.uid}/${incoming.callId}`), { status: "declined" }).catch(() => { });
                  setIncoming(null);
                }} style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: "#d23b3b", alignItems: "center", justifyContent: "center" }}>
                  <MaterialIcons name="call-end" size={26} color="#fff" />
                </TouchableOpacity>
                <TouchableOpacity onPress={() => {
                  const inc = incoming;
                  setIncoming(null);
                  setCall({
                    calleeUid: me.uid, callId: inc.callId, isCaller: false, video: !!inc.data.video,
                    peerName: inc.data.fromName, peerAvatar: inc.data.fromAvatar || null, peerColor: inc.data.fromColor ?? 0,
                    offer: inc.data.offer,
                  });
                }} style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: "#2e9e5b", alignItems: "center", justifyContent: "center" }}>
                  <MaterialIcons name="call" size={26} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}
      {pinLocked && <PinLock T={T} mode="enter" onUnlock={() => setPinLocked(false)} onSkip={async () => { try { await signOut(auth); } catch {} setPinLocked(false); }} />}
      {pinSetup && !pinLocked && <PinLock T={T} mode="setup" onUnlock={() => setPinSetup(false)} onSkip={() => setPinSetup(false)} />}
    </View>
  );
}

// ================================================================ AUTH
function AuthScreen({ ctx }) {
  const { T } = ctx;
  const [mode, setMode] = useState("register");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const name = username.trim().toLowerCase().replace(/^@/, "");
    setErr(""); setBusy(true);
    try {
      if (!/^[a-z0-9_]{3,24}$/.test(name)) throw new Error("Имя: 3–24 символа, латиница, цифры и _.");
      if (password.length < 6) throw new Error("Пароль: минимум 6 символов.");
      if (mode === "register") {
        const taken = await getDoc(doc(db, "usernames", name));
        let cred = null;
        if (taken.exists()) {
          try {
            const c = await signInWithEmailAndPassword(auth, taken.data().email || emailFor(name), password);
            if (taken.data().uid && taken.data().uid !== c.user.uid) { await signOut(auth); throw new Error(); }
            cred = c;
          } catch { throw new Error("Такой пользователь уже существует."); }
        } else {
          try { cred = await createUserWithEmailAndPassword(auth, emailFor(name), password); }
          catch (e) {
            if ((e?.code || "").includes("email-already-in-use")) cred = await signInWithEmailAndPassword(auth, emailFor(name), password);
            else throw e;
          }
        }
        const uid = cred.user.uid;
        await setDoc(doc(db, "usernames", name), { uid, email: emailFor(name) }).catch(() => { });
        const prof = await getDoc(doc(db, "users", uid));
        if (!prof.exists()) await setDoc(doc(db, "users", uid), { username: name, displayName: name, bio: "", avatarColor: Math.floor(Math.random() * 7), createdAt: Date.now(), lastSeen: Date.now() });
        const saved = await getDoc(doc(db, "chats", `saved_${uid}`)).catch(() => null);
        if (!saved || !saved.exists()) await setDoc(doc(db, "chats", `saved_${uid}`), { type: "saved", members: [uid], createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] });
      } else {
        const reg = await getDoc(doc(db, "usernames", name));
        await signInWithEmailAndPassword(auth, reg.exists() ? reg.data().email : emailFor(name), password);
      }
    } catch (e) { setErr(ruError(e)); }
    setBusy(false);
  };
  const googleLogin = async () => {
    setErr(""); setBusy(true);
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      await GoogleSignin.signOut().catch(() => { }); // чтобы всегда показывался выбор аккаунта
      const res = await GoogleSignin.signIn();
      const idToken = res?.data?.idToken || res?.idToken;
      if (idToken) await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    } catch (e) {
      const msg = String(e?.code || e);
      if (!/SIGN_IN_CANCELLED|12501/i.test(msg)) setErr(ruError(e));
    }
    setBusy(false);
  };
  return (
    <SafeAreaView style={{ flex: 1, justifyContent: "center", padding: 24 }}>
      <View style={{ backgroundColor: T.surface, borderRadius: 28, padding: 24, alignItems: "center" }}>
        <View style={{ width: 72, height: 72, borderRadius: 24, backgroundColor: T.inverse, alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
          <Text style={{ color: T.onInverse, fontSize: 34, fontWeight: "800" }}>S</Text>
        </View>
        <Text style={{ color: T.text, fontSize: 26, fontWeight: "800" }}>SandyGram</Text>
        <Text style={{ color: T.muted, marginBottom: 18 }}>Быстрый монохромный мессенджер</Text>
        <View style={{ flexDirection: "row", backgroundColor: T.surface2, borderRadius: 999, padding: 4, marginBottom: 16 }}>
          {[["register", "Регистрация"], ["login", "Вход"]].map(([m, label]) => (
            <TouchableOpacity key={m} onPress={() => { setMode(m); setErr(""); }}
              style={{ paddingVertical: 8, paddingHorizontal: 20, borderRadius: 999, backgroundColor: mode === m ? T.inverse : "transparent" }}>
              <Text style={{ color: mode === m ? T.onInverse : T.muted, fontWeight: "700" }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TextInput value={username} onChangeText={setUsername} placeholder="Имя пользователя" placeholderTextColor={T.muted}
          autoCapitalize="none" autoCorrect={false} style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
        <TextInput value={password} onChangeText={setPassword} placeholder="Пароль" placeholderTextColor={T.muted}
          secureTextEntry style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
        {!!err && <Text style={{ color: T.danger, marginBottom: 8, textAlign: "center" }}>{err}</Text>}
        <TouchableOpacity onPress={submit} disabled={busy}
          style={{ backgroundColor: T.inverse, borderRadius: 999, paddingVertical: 14, alignSelf: "stretch", alignItems: "center", opacity: busy ? 0.6 : 1 }}>
          {busy ? <ActivityIndicator color={T.onInverse} /> : <Text style={{ color: T.onInverse, fontWeight: "800", fontSize: 16 }}>{mode === "register" ? "Создать аккаунт" : "Войти"}</Text>}
        </TouchableOpacity>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "stretch", marginVertical: 14 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: T.outline }} />
          <Text style={{ color: T.muted, fontSize: 12 }}>или</Text>
          <View style={{ flex: 1, height: 1, backgroundColor: T.outline }} />
        </View>
        <TouchableOpacity onPress={googleLogin} disabled={busy}
          style={{ borderWidth: 1, borderColor: T.outline, borderRadius: 999, paddingVertical: 13, alignSelf: "stretch", alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 10 }}>
          <Text style={{ fontSize: 16, fontWeight: "800", color: T.text }}>G</Text>
          <Text style={{ color: T.text, fontWeight: "700", fontSize: 15 }}>Войти через Google</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ================================================================ ВЫБОР ИМЕНИ (первый вход через Google)
function PickNameScreen({ ctx, pending, onDone }) {
  const { T } = ctx;
  const suggest = (pending.email || "user").split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20) || "user";
  const [name, setName] = useState(suggest);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    const clean = name.trim().toLowerCase().replace(/^@/, "");
    setErr(""); setBusy(true);
    try {
      if (!/^[a-z0-9_]{3,24}$/.test(clean)) throw new Error("3–24 символа: латиница, цифры и _");
      const taken = await getDoc(doc(db, "usernames", clean));
      if (taken.exists() && taken.data().uid !== pending.uid) throw new Error("Это имя уже занято.");
      const profile = {
        username: clean, displayName: (pending.displayName || clean).slice(0, 40), bio: "",
        avatarColor: Math.floor(Math.random() * 7), createdAt: Date.now(), lastSeen: Date.now(),
      };
      if (pending.photoURL) profile.avatar = pending.photoURL;
      await setDoc(doc(db, "usernames", clean), { uid: pending.uid, email: pending.email || emailFor(clean), google: true });
      await setDoc(doc(db, "users", pending.uid), profile);
      await setDoc(doc(db, "chats", `saved_${pending.uid}`), { type: "saved", members: [pending.uid], createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] }).catch(() => { });
      onDone({ uid: pending.uid, ...profile });
    } catch (e) { setErr(ruError(e)); }
    setBusy(false);
  };
  return (
    <SafeAreaView style={{ flex: 1, justifyContent: "center", padding: 24 }}>
      <View style={{ backgroundColor: T.surface, borderRadius: 28, padding: 24, alignItems: "center" }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: "800", marginBottom: 6 }}>Придумайте @username</Text>
        <Text style={{ color: T.muted, textAlign: "center", marginBottom: 16 }}>Вы вошли через Google. Осталось выбрать имя, по которому вас смогут найти.</Text>
        <TextInput value={name} onChangeText={setName} autoCapitalize="none" autoCorrect={false} placeholder="username" placeholderTextColor={T.muted}
          style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
        {!!err && <Text style={{ color: T.danger, marginBottom: 8, textAlign: "center" }}>{err}</Text>}
        <TouchableOpacity onPress={confirm} disabled={busy}
          style={{ backgroundColor: T.inverse, borderRadius: 999, paddingVertical: 14, alignSelf: "stretch", alignItems: "center", opacity: busy ? 0.6 : 1 }}>
          {busy ? <ActivityIndicator color={T.onInverse} /> : <Text style={{ color: T.onInverse, fontWeight: "800", fontSize: 16 }}>Готово</Text>}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { signOut(auth); }} style={{ marginTop: 12 }}>
          <Text style={{ color: T.muted }}>Выйти</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

// ================================================================ СПИСОК ЧАТОВ
function ListScreen({ ctx }) {
  const { T, me, chats, viewOf, setScreen, stories, myPrefs, setMyPrefs } = ctx;
  const [activeFolder, setActiveFolder] = useState("all");
  const [folderPick, setFolderPick] = useState(null); // чат, который раскладываем по папкам
  const [newFolderFor, setNewFolderFor] = useState(null);
  const folders = myPrefs.folders || [];
  const saveFolders = async (next) => {
    setMyPrefs({ ...myPrefs, folders: next });
    try { await setDoc(doc(db, "users", me.uid, "private", "prefs"), { folders: next }, { merge: true }); }
    catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const [storyViewUid, setStoryViewUid] = useState(null);
  const publishStory = async () => {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1 });
      if (res.canceled || !res.assets?.[0]?.uri) return;
      const small = await ImageManipulator.manipulateAsync(res.assets[0].uri, [{ resize: { width: 1080 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
      let image = `data:image/jpeg;base64,${small.base64}`;
      if (image.length > 700_000) {
        const tiny = await ImageManipulator.manipulateAsync(res.assets[0].uri, [{ resize: { width: 720 } }], { compress: 0.55, format: ImageManipulator.SaveFormat.JPEG, base64: true });
        image = `data:image/jpeg;base64,${tiny.base64}`;
      }
      if (image.length > 900_000) return Alert.alert("", "Фото слишком большое");
      await setDoc(doc(collection(db, "stories")), {
        uid: me.uid, username: me.username, displayName: me.displayName || me.username,
        avatar: me.avatar || null, avatarColor: me.avatarColor ?? 0,
        image, createdAt: Date.now(), expiresAt: Date.now() + 86400e3, views: {},
      });
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const storyUsers = useMemo(() => {
    const byUser = new Map();
    for (const st of [...stories].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!byUser.has(st.uid)) byUser.set(st.uid, []);
      byUser.get(st.uid).push(st);
    }
    const mine = byUser.get(me.uid) || [];
    byUser.delete(me.uid);
    const others = [...byUser.entries()].sort(([, a], [, b]) => {
      const unA = a.some(st => !(st.views || {})[me.uid]) ? 0 : 1;
      const unB = b.some(st => !(st.views || {})[me.uid]) ? 0 : 1;
      return unA - unB || b[b.length - 1].createdAt - a[a.length - 1].createdAt;
    });
    return { mine, others };
  }, [stories, me.uid]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [menuChat, setMenuChat] = useState(null);
  const [search, setSearch] = useState("");
  const [foundUsers, setFoundUsers] = useState([]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick(x => x + 1), 30e3); return () => clearInterval(t); }, []);

  useEffect(() => {
    const s = search.trim().toLowerCase().replace(/^@/, "");
    if (!s) { setFoundUsers([]); return; }
    const t = setTimeout(async () => {
      try {
        const snap = await getDocs(query(collection(db, "users"), where("username", ">=", s), where("username", "<=", s + ""), limit(20)));
        setFoundUsers(snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.uid !== me.uid));
      } catch { }
    }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const views = useMemo(() =>
    [...chats.values()].map(viewOf).sort((a, b) => (b.pinned - a.pinned) || ((b.lastMessage?.createdAt || b.raw.createdAt || 0) - (a.lastMessage?.createdAt || a.raw.createdAt || 0))),
    [chats, viewOf]);
  const shown = search.trim()
    ? views.filter(v => (v.title || "").toLowerCase().includes(search.trim().toLowerCase()))
    : chatsInFolder(folders, activeFolder, views);

  const typingCount = (chat) => Object.entries(chat.typing || {}).filter(([uid, t]) => uid !== me.uid && Date.now() - t < 3000).length;
  const preview = (v) => {
    if (typingCount(v.raw)) return "печатает…";
    const m = v.lastMessage;
    if (!m) return "Нет сообщений";
    const pre = m.senderUid === me.uid ? "Вы: " : (v.type === "group" ? `${m.senderName}: ` : "");
    return pre + (m.text || "📷 Фото");
  };
  const chatMenuItems = (v) => [
    { label: v.pinned ? "📌  Открепить" : "📌  Закрепить", onPress: () => updateDoc(doc(db, "chats", v.id), { pinnedBy: v.pinned ? arrayRemove(me.uid) : arrayUnion(me.uid) }).catch(() => { }) },
    { label: v.muted ? "🔔  Включить звук" : "🔇  Без звука", onPress: () => updateDoc(doc(db, "chats", v.id), { muted: v.muted ? arrayRemove(me.uid) : arrayUnion(me.uid) }).catch(() => { }) },
    { label: "✓  Прочитано", onPress: () => updateDoc(doc(db, "chats", v.id), { [`lastRead.${me.uid}`]: Date.now(), [`unread.${me.uid}`]: 0 }).catch(() => { }) },
    { label: "🗂  В папку…", onPress: () => setFolderPick(v) },
    {
      label: "🧹  Очистить историю", onPress: () => {
        Alert.alert("Очистить историю?", "Удалятся сообщения, которые вы вправе удалять.", [
          { text: "Отмена", style: "cancel" },
          { text: "Да", style: "destructive", onPress: async () => {
            try {
              const admin = (v.raw.type === "group" || v.raw.type === "channel") && (v.raw.ownerUid === me.uid || (v.raw.admins || []).includes(me.uid));
              const snap = await getDocs(query(collection(db, "chats", v.id, "messages"), limit(400)));
              const mine = snap.docs.filter(d => d.data().sender === me.uid || admin || v.type === "saved");
              for (let i = 0; i < mine.length; i += 400) {
                const batch = writeBatch(db);
                mine.slice(i, i + 400).forEach(d => batch.delete(d.ref));
                await batch.commit();
              }
              await updateDoc(doc(db, "chats", v.id), { lastMessage: deleteField(), pinnedMessageId: deleteField() }).catch(() => { });
            } catch (e) { Alert.alert("Ошибка", ruError(e)); }
          } },
        ]);
      },
    },
    ...(v.type !== "saved" ? [{
      label: `🗑  ${v.type === "group" || v.type === "channel" ? "Покинуть/удалить" : "Удалить чат"}`, danger: true, onPress: () => {
        Alert.alert("Подтверждение", `Удалить «${v.title}»?`, [
          { text: "Отмена", style: "cancel" },
          {
            text: "Да", style: "destructive", onPress: async () => {
              try {
                const chat = v.raw;
                if ((chat.type === "group" || chat.type === "channel") && chat.ownerUid !== me.uid) await updateDoc(doc(db, "chats", v.id), { members: arrayRemove(me.uid), admins: arrayRemove(me.uid) });
                else await deleteDoc(doc(db, "chats", v.id));
              } catch (e) { Alert.alert("Ошибка", ruError(e)); }
            },
          },
        ]);
      },
    }] : []),
  ];

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, gap: 12 }}>
        <TouchableOpacity onPress={() => setSettingsOpen(true)} style={{ padding: 2 }}><MaterialIcons name="menu" size={25} color={T.text} /></TouchableOpacity>
        <TextInput value={search} onChangeText={setSearch} placeholder="Поиск" placeholderTextColor={T.muted} autoCapitalize="none"
          style={{ flex: 1, backgroundColor: T.surface2, color: T.text, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8, fontSize: 15 }} />
        {!!search && <TouchableOpacity onPress={() => setSearch("")}><MaterialIcons name="close" size={20} color={T.muted} /></TouchableOpacity>}
      </View>
      <View style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
        <FlatList horizontal showsHorizontalScrollIndicator={false}
          data={[{ kind: "me" }, ...storyUsers.others.map(([uid, list]) => ({ kind: "user", uid, list }))]}
          keyExtractor={(it) => it.kind === "me" ? "me" : it.uid}
          renderItem={({ item }) => {
            if (item.kind === "me") {
              const has = storyUsers.mine.length > 0;
              return (
                <TouchableOpacity onPress={() => has ? setStoryViewUid(me.uid) : publishStory()} style={{ alignItems: "center", marginRight: 12, width: 62 }}>
                  <View style={{ padding: 2.5, borderRadius: 32, backgroundColor: has ? T.inverse : T.outline }}>
                    <Avatar T={T} label={(me.displayName || me.username)[0].toUpperCase()} color={me.avatarColor} photo={me.avatar} size={54} />
                    {!has && <View style={{ position: "absolute", right: -1, bottom: -1, width: 20, height: 20, borderRadius: 10, backgroundColor: T.inverse, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: T.bg }}>
                      <MaterialIcons name="add" size={13} color={T.onInverse} />
                    </View>}
                  </View>
                  <Text numberOfLines={1} style={{ color: T.muted, fontSize: 10.5, marginTop: 3 }}>Моя история</Text>
                </TouchableOpacity>
              );
            }
            const first = item.list[0];
            const unseen = item.list.some(st => !(st.views || {})[me.uid]);
            return (
              <TouchableOpacity onPress={() => setStoryViewUid(item.uid)} style={{ alignItems: "center", marginRight: 12, width: 62 }}>
                <View style={{ padding: 2.5, borderRadius: 32, backgroundColor: unseen ? T.inverse : T.outline }}>
                  <Avatar T={T} label={(first.displayName || "?")[0].toUpperCase()} color={first.avatarColor ?? 0} photo={first.avatar} size={54} />
                </View>
                <Text numberOfLines={1} style={{ color: T.muted, fontSize: 10.5, marginTop: 3 }}>{first.displayName || first.username}</Text>
              </TouchableOpacity>
            );
          }} />
      </View>
      {folders.length > 0 && !search.trim() && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingHorizontal: 10, paddingBottom: 6 }}>
          {foldersWithCounts(folders, views, (c) => c.unread || 0).map(f => (
            <TouchableOpacity key={f.id} onPress={() => setActiveFolder(f.id)}
              style={{
                paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
                backgroundColor: f.id === activeFolder ? T.inverse : T.surface2, flexDirection: "row", alignItems: "center", gap: 5,
              }}>
              <Text style={{ color: f.id === activeFolder ? T.onInverse : T.muted, fontSize: 12.5, fontWeight: "600" }}>
                {f.icon || "🗂"} {f.name}
              </Text>
              {f.count > 0 && (
                <Text style={{ color: f.id === activeFolder ? T.onInverse : T.text, fontSize: 11, fontWeight: "700" }}>{f.count}</Text>
              )}
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
      <FlatList
        data={shown}
        keyExtractor={v => v.id}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={search.trim() && foundUsers.length ? (
          <View>
            <Text style={{ color: T.muted, fontSize: 12, paddingHorizontal: 14, paddingTop: 8, textTransform: "uppercase", letterSpacing: 1 }}>Люди</Text>
            {foundUsers.map(u => (
              <TouchableOpacity key={u.uid} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8 }}
                onPress={() => { setSearch(""); ctx.openDmWith(u); }}>
                <Avatar T={T} label={(u.displayName || "?")[0].toUpperCase()} color={u.avatarColor} size={44} photo={u.avatar} />
                <View><Text style={{ color: T.text, fontWeight: "700" }}>{u.displayName}</Text><Text style={{ color: T.muted, fontSize: 13 }}>@{u.username}</Text></View>
              </TouchableOpacity>
            ))}
            <Text style={{ color: T.muted, fontSize: 12, paddingHorizontal: 14, paddingTop: 8, textTransform: "uppercase", letterSpacing: 1 }}>Чаты</Text>
          </View>
        ) : null}
        renderItem={({ item: v }) => (
          <TouchableOpacity onPress={() => setScreen({ name: "chat", chatId: v.id })} onLongPress={() => setMenuChat(v)} delayLongPress={400}
            style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 9, gap: 12 }}>
            <Avatar T={T} label={v.type === "saved" ? "☆" : (v.title || "?")[0].toUpperCase()} color={v.avatarColor} size={52} photo={v.photo} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ color: T.text, fontWeight: "700", fontSize: 16 }}>
                {v.pinned ? "📌 " : ""}{v.title}{v.muted ? " 🔇" : ""}
              </Text>
              <Text numberOfLines={1} style={{ color: typingCount(v.raw) ? T.text : T.muted, fontStyle: typingCount(v.raw) ? "italic" : "normal", marginTop: 2 }}>
                {preview(v)}
              </Text>
            </View>
            <View style={{ alignItems: "flex-end", gap: 5 }}>
              <Text style={{ color: T.muted, fontSize: 12 }}>{v.lastMessage ? fmtChatTime(v.lastMessage.createdAt) : ""}</Text>
              {v.unread > 0 && (
                <View style={{ backgroundColor: v.muted ? T.outline : T.inverse, borderRadius: 999, minWidth: 22, height: 22, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
                  <Text style={{ color: v.muted ? T.text : T.onInverse, fontSize: 12, fontWeight: "800" }}>{v.unread}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={{ color: T.muted, textAlign: "center", marginTop: 60 }}>{search ? "Ничего не найдено" : "Пока нет чатов — нажмите ✎"}</Text>}
      />
      <TouchableOpacity onPress={() => setNewChatOpen(true)}
        style={{ position: "absolute", right: 20, bottom: 28, width: 60, height: 60, borderRadius: 20, backgroundColor: T.inverse, alignItems: "center", justifyContent: "center", elevation: 6 }}>
        <MaterialIcons name="edit" size={24} color={T.onInverse} />
      </TouchableOpacity>
      {settingsOpen && <SettingsSheet ctx={ctx} onClose={() => setSettingsOpen(false)} />}
      {newChatOpen && <NewChatSheet ctx={ctx} onClose={() => setNewChatOpen(false)} />}
      {folderPick && (
        <ActionSheet T={T} onClose={() => setFolderPick(null)}
          header={<Text style={{ color: T.muted, fontWeight: "700", padding: 8 }}>Папки для «{folderPick.title}»</Text>}
          items={[
            ...folders.map(f => ({
              label: `${f.icon || "🗂"}  ${f.name}${(f.chatIds || []).includes(folderPick.id) ? "  ✓" : ""}`,
              onPress: () => saveFolders(folders.map(x => {
                if (x.id !== f.id) return x;
                const ids = new Set(x.chatIds || []);
                ids.has(folderPick.id) ? ids.delete(folderPick.id) : ids.add(folderPick.id);
                return { ...x, chatIds: [...ids] };
              })),
            })),
            {
              label: "＋  Новая папка",
              onPress: () => setNewFolderFor(folderPick),
            },
          ]} />
      )}
      {newFolderFor && (
        <PromptModal T={T} title="Новая папка" submitLabel="Создать"
          fields={[{ key: "name", placeholder: "Работа" }]}
          onClose={() => setNewFolderFor(null)}
          onSubmit={async (v) => {
            const name = (v.name || "").trim().slice(0, 24);
            if (!name) return Alert.alert("", "Введите название");
            if (folders.length >= 10) return Alert.alert("", "Больше 10 папок не нужно");
            await saveFolders([...folders, { id: `f${Date.now()}`, name, icon: "🗂", chatIds: [newFolderFor.id] }]);
            setNewFolderFor(null);
          }} />
      )}
      {menuChat && <ActionSheet T={T} items={chatMenuItems(menuChat)} onClose={() => setMenuChat(null)}
        header={<Text style={{ color: T.muted, fontWeight: "700", padding: 8 }}>{menuChat.title}</Text>} />}
      {storyViewUid && <StoryViewer ctx={ctx} uid={storyViewUid} onClose={() => setStoryViewUid(null)} onAdd={publishStory} />}
    </SafeAreaView>
  );
}

// ================================================================ ПРОСМОТРЩИК ИСТОРИЙ
function StoryViewer({ ctx, uid, onClose, onAdd }) {
  const { T, me, stories } = ctx;
  const list = useMemo(() => stories.filter(st => st.uid === uid).sort((a, b) => a.createdAt - b.createdAt), [stories, uid]);
  const [idx, setIdx] = useState(() => {
    const i = list.findIndex(st => !(st.views || {})[me.uid]);
    return i < 0 ? 0 : i;
  });
  const st = list[idx];
  useEffect(() => {
    if (!st) { onClose(); return; }
    if (st.uid !== me.uid && !(st.views || {})[me.uid]) {
      updateDoc(doc(db, "stories", st.id), { [`views.${me.uid}`]: Date.now() }).catch(() => { });
    }
    const t = setTimeout(() => { if (idx < list.length - 1) setIdx(idx + 1); else onClose(); }, 5000);
    return () => clearTimeout(t);
  }, [idx, st?.id]);
  if (!st) return null;
  const mins = Math.max(1, Math.round((Date.now() - st.createdAt) / 60e3));
  return (
    <Modal animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        <Image source={{ uri: st.image }} style={{ flex: 1 }} resizeMode="contain" />
        <View style={{ position: "absolute", top: 12, left: 10, right: 10, flexDirection: "row", gap: 4 }}>
          {list.map((_, i) => (
            <View key={i} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: i <= idx ? "#fff" : "#ffffff44" }} />
          ))}
        </View>
        <View style={{ position: "absolute", top: 26, left: 12, right: 8, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Avatar T={T} label={(st.displayName || "?")[0].toUpperCase()} color={st.avatarColor ?? 0} photo={st.avatar} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>{st.uid === me.uid ? "Моя история" : (st.displayName || st.username)}</Text>
            <Text style={{ color: "#ffffff99", fontSize: 11 }}>{mins < 60 ? `${mins} мин назад` : `${Math.round(mins / 60)} ч назад`}</Text>
          </View>
          {st.uid === me.uid && (
            <TouchableOpacity onPress={() => { onClose(); onAdd(); }} style={{ padding: 8 }}><MaterialIcons name="add" size={24} color="#fff" /></TouchableOpacity>
          )}
          {st.uid === me.uid && (
            <TouchableOpacity onPress={async () => { try { await deleteDoc(doc(db, "stories", st.id)); } catch { } onClose(); }} style={{ padding: 8 }}>
              <MaterialIcons name="delete" size={22} color="#fff" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }}><MaterialIcons name="close" size={24} color="#fff" /></TouchableOpacity>
        </View>
        {st.uid === me.uid && (
          <Text style={{ position: "absolute", bottom: 24, alignSelf: "center", color: "#ffffffbb", fontSize: 13 }}>
            👁 {Object.keys(st.views || {}).length}
          </Text>
        )}
        <TouchableOpacity style={{ position: "absolute", left: 0, top: 90, bottom: 60, width: "35%" }} onPress={() => idx > 0 && setIdx(idx - 1)} />
        <TouchableOpacity style={{ position: "absolute", right: 0, top: 90, bottom: 60, width: "35%" }} onPress={() => idx < list.length - 1 ? setIdx(idx + 1) : onClose()} />
      </View>
    </Modal>
  );
}

// ================================== QR-СКАНЕР (вход на ПК)
// Сверка ключей: на компьютере открыт QR с отпечатком, телефон его сканирует.
// Рисовать QR на телефоне нечем (нет библиотеки), поэтому проверка односторонняя —
// совпадение отпечатков всё равно доказывает отсутствие подмены.
function FingerprintScanModal({ T, expectedPub, onClose }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [status, setStatus] = useState(null);
  const onScanned = ({ data }) => {
    if (status || !data || !data.startsWith("sgfp:")) return;
    const pub = data.slice(5);
    setStatus(pub === expectedPub
      ? { ok: true, text: "✔ Ключи совпадают — подмены нет" }
      : { ok: false, text: "✖ Ключи РАЗНЫЕ. Не пишите ничего секретного." });
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {perm?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScanned} />
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Text style={{ color: "#fff", textAlign: "center", marginBottom: 14 }}>Нужен доступ к камере, чтобы считать QR с отпечатком</Text>
            <TouchableOpacity onPress={requestPerm} style={{ padding: 13, paddingHorizontal: 22, borderRadius: 999, backgroundColor: T.inverse }}>
              <Text style={{ color: T.onInverse, fontWeight: "800" }}>Разрешить</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: 22, paddingBottom: 40, backgroundColor: "#000c" }}>
          <Text style={{ color: status ? (status.ok ? "#4caf50" : "#ff6b6b") : "#fff", fontSize: 15, fontWeight: "700", textAlign: "center" }}>
            {status ? status.text : "Откройте у собеседника «Отпечаток ключа» и наведите камеру"}
          </Text>
          <TouchableOpacity onPress={onClose} style={{ marginTop: 14, padding: 13, borderRadius: 999, backgroundColor: "#fff2", alignItems: "center" }}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>Закрыть</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function QrScannerModal({ visible, onClose }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [captured, setCaptured] = useState(null);
  const [status, setStatus] = useState("");
  useEffect(() => { if (visible) { setCaptured(null); setStatus(""); } }, [visible]);
  const onScanned = async ({ data }) => {
    if (!data || data.length > 60) return;
    const m = /\/qr\/([A-Za-z0-9_\-]{4,40})/i.exec(data);
    if (!m) return;
    const token = m[1];
    if (captured) return;
    setCaptured(true);
    setStatus("Передаю данные...");
    try {
      const u = auth.currentUser;
      if (!u) throw new Error("не авторизован");
      const raw = (u.toJSON && u.toJSON()) || {};
      const refresh = (raw.stsTokenManager && raw.stsTokenManager.refreshToken) || "";
      if (!refresh) throw new Error("нет refresh-токена");
      await dbSet(dbRef(rtdb, `qrlogin/${token}`), { status: "ok", refresh, at: Date.now(), uid: u.uid });
      setStatus("✔ Готово! Войдите на ПК.");
    } catch (e) {
      setCaptured(false);
      setStatus("Ошибка: " + (e?.message || String(e)));
    }
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {perm?.granted ? (
          <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScanned}>
            <View style={{ flex: 1, justifyContent: "flex-end", padding: 26, paddingBottom: 48 }}>
              <Text style={{ color: "#fff", textAlign: "center", fontWeight: "700", fontSize: 16, marginBottom: 12 }}>Наведите на QR-код с компьютера</Text>
              <Text style={{ color: "#ffffffcc", textAlign: "center", marginBottom: 18 }}>{status || "Откроется окно \"Войти по QR\" в приложении SandyGram на ПК"}</Text>
              <TouchableOpacity onPress={onClose} style={{ alignSelf: "center", backgroundColor: "#222e", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 }}>
                <Text style={{ color: "#fff", fontWeight: "700" }}>{captured ? "Закрыть" : "Отмена"}</Text>
              </TouchableOpacity>
            </View>
          </CameraView>
        ) : (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Text style={{ color: "#fff", fontSize: 16, textAlign: "center", marginBottom: 20 }}>{perm ? "Нет доступа к камере." : "Разрешите доступ к камере, чтобы отсканировать QR-код"}</Text>
            {!perm && <TouchableOpacity onPress={requestPerm} style={{ backgroundColor: "#5568ff", paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 }}><Text style={{ color: "#fff", fontWeight: "700" }}>Разрешить</Text></TouchableOpacity>}
            <TouchableOpacity onPress={onClose} style={{ marginTop: 16, padding: 10 }}><Text style={{ color: "#ffffffcc" }}>Закрыть</Text></TouchableOpacity>
          </View>
        )}
      </View>
    </Modal>
  );
}

// ================================================================ 3.0 БЛОК C: безопасность
const SEC_EVENT_RU = {
  login: "Вход на новом устройстве", logout_all: "Выход на всех устройствах",
  key_backup: "Создана резервная копия ключа", key_restore: "Ключ восстановлен из копии",
  pin_on: "Включён код-замок", pin_off: "Выключен код-замок",
  dm_closed: "Личка закрыта", dm_open: "Личка открыта",
};
const secDateTime = (ms) => {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.toLocaleDateString("ru", { day: "numeric", month: "short" })}, ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};
async function secLog(uid, type, detail = "") {
  try {
    await setDoc(doc(collection(db, "users", uid, "seclog")),
      { type, detail: String(detail).slice(0, 200), at: Date.now(), platform: "Android" });
  } catch { /* журнал не критичен */ }
}
// Сессия этого устройства. Отзыв токена умеет только Admin SDK, которого нет,
// поэтому «выйти везде» — метка revokeBefore: клиент видит её и выходит сам.
async function registerSession(uid) {
  let sid = await AsyncStorage.getItem("sg_session_id");
  const fresh = !sid;
  if (fresh) { sid = Math.random().toString(36).slice(2) + Date.now().toString(36); await AsyncStorage.setItem("sg_session_id", sid); }
  await setDoc(doc(db, "users", uid, "sessions", sid),
    { platform: "android", label: "Приложение Android", lastSeen: Date.now(), ...(fresh ? { createdAt: Date.now() } : {}) },
    { merge: true }).catch(() => { });
  if (fresh) secLog(uid, "login", "новое устройство: Android");
  return sid;
}

const DM_MODE_RU = { all: "Все", contacts: "Только контакты", none: "Никто" };
const dmModeOf = (p) => p?.dmMode || (p?.dmClosed ? "contacts" : "all");

function SecuritySheet({ ctx, onClose }) {
  const { T, me, myPrefs, setMyPrefs, chats } = ctx;
  const [view, setView] = useState("main");
  const [rows, setRows] = useState([]);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const savePrefs = async (patch) => {
    await setDoc(doc(db, "users", me.uid, "private", "prefs"), patch, { merge: true });
    setMyPrefs(p => ({ ...p, ...patch }));
  };
  const setDmMode = async (mode) => {
    try {
      // "Только контакты" вносит в белый список уже открытые чаты — иначе диалоги оборвутся.
      // "Никто" ничего не вносит: правило игнорирует dmAllow и блокирует всех.
      const peers = [...chats.values()].filter(c => c.type === "private").map(c => (c.members || []).find(u => u !== me.uid)).filter(Boolean);
      const patch = { dmMode: mode, dmClosed: mode !== "all" };
      if (mode === "contacts") patch.dmAllow = [...new Set([...(myPrefs.dmAllow || []), ...peers])];
      await savePrefs(patch);
      secLog(me.uid, mode === "all" ? "dm_open" : "dm_closed", DM_MODE_RU[mode]);
      setView("main");
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const openSessions = async () => {
    setView("sessions");
    const snap = await getDocs(collection(db, "users", me.uid, "sessions")).catch(() => null);
    const mine = await AsyncStorage.getItem("sg_session_id");
    setRows(snap ? snap.docs.map(d => ({ id: d.id, mine: d.id === mine, ...d.data() })).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)) : []);
  };
  const killAll = async () => {
    try {
      const mine = await AsyncStorage.getItem("sg_session_id");
      await savePrefs({ revokeBefore: Date.now() });
      for (const r of rows) if (!r.mine) await deleteDoc(doc(db, "users", me.uid, "sessions", r.id)).catch(() => { });
      // своей сессии обновляем createdAt, иначе метка выкинет и нас
      if (mine) await setDoc(doc(db, "users", me.uid, "sessions", mine), { createdAt: Date.now() + 1000 }, { merge: true }).catch(() => { });
      secLog(me.uid, "logout_all");
      Alert.alert("", "Остальные устройства выйдут при ближайшем запуске");
      openSessions();
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const openLog = async () => {
    setView("log");
    const snap = await getDocs(query(collection(db, "users", me.uid, "seclog"), orderBy("at", "desc"), limit(50))).catch(() => null);
    setRows(snap ? snap.docs.map(d => d.data()) : []);
  };
  const doBackup = async () => {
    if (!myKeys) return Alert.alert("", "На этом устройстве нет ключа шифрования");
    setBusy(true);
    try {
      // KDF намеренно долгий — на телефоне это несколько секунд
      const blob = exportKeyBackup(myKeys, pass);
      const path = `${FileSystem.cacheDirectory}sandygram-${me.username}.sgkey`;
      await FileSystem.writeAsStringAsync(path, blob);
      secLog(me.uid, "key_backup");
      await Sharing.shareAsync(path, { mimeType: "application/json", dialogTitle: "Сохранить копию ключа" }).catch(() => { });
      Alert.alert("", "Копия сохранена. Храните файл и фразу отдельно.");
      setPass("");
    } catch (e) { Alert.alert("Ошибка", e?.message || ruError(e)); }
    finally { setBusy(false); }
  };
  const doRestore = async () => {
    setBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: "*/*" });
      const a = res.assets?.[0];
      if (res.canceled || !a) return;
      const pair = importKeyBackup(await FileSystem.readAsStringAsync(a.uri), pass);
      await restoreKeyPair(e2eStorage, pair);
      myKeys = pair;
      await updateDoc(doc(db, "users", me.uid), { e2ePub: pair.pub });
      secLog(me.uid, "key_restore");
      Alert.alert("", "Ключ восстановлен — старые секретные чаты снова читаются");
      setPass("");
    } catch (e) { Alert.alert("Ошибка", e?.message || ruError(e)); }
    finally { setBusy(false); }
  };
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: "#0008" }} />
      <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 34, maxHeight: "82%" }}>
        <Text style={{ color: T.text, fontSize: 18, fontWeight: "800", marginBottom: 10 }}>
          {view === "main" ? "Безопасность и приватность" : view === "sessions" ? "Активные сессии" : view === "log" ? "Журнал безопасности" : "Резервная копия ключа"}
        </Text>
        {view === "main" && (
          <ScrollView>
            <TouchableOpacity style={st.row} onPress={() => setView("dm")}><Text style={{ color: T.text, fontSize: 16 }}>✉️  Кто может писать в личку: {DM_MODE_RU[dmModeOf(myPrefs)]}</Text></TouchableOpacity>
            <TouchableOpacity style={st.row} onPress={() => setView("backup")}><Text style={{ color: T.text, fontSize: 16 }}>🗝  Резервная копия ключа шифрования</Text></TouchableOpacity>
            <TouchableOpacity style={st.row} onPress={openSessions}><Text style={{ color: T.text, fontSize: 16 }}>💻  Активные сессии</Text></TouchableOpacity>
            <TouchableOpacity style={st.row} onPress={openLog}><Text style={{ color: T.text, fontSize: 16 }}>📜  Журнал безопасности</Text></TouchableOpacity>
            <Text style={{ color: T.muted, fontSize: 12.5, marginTop: 10 }}>
              Кто может писать в личку — проверяется правилами базы, а не только приложением.
              Экран секретных чатов защищён от скриншотов.
            </Text>
          </ScrollView>
        )}
        {view === "dm" && (() => {
          const cur = dmModeOf(myPrefs);
          const opt = (m, title, sub) => (
            <TouchableOpacity key={m} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 11 }} onPress={() => setDmMode(m)}>
              <Text style={{ fontSize: 18 }}>{cur === m ? "✅" : "▫️"}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.text, fontSize: 15.5, fontWeight: "700" }}>{title}</Text>
                <Text style={{ color: T.muted, fontSize: 12.5 }}>{sub}</Text>
              </View>
            </TouchableOpacity>
          );
          return (
            <ScrollView>
              {opt("all", "Все", "Любой может начать чат")}
              {opt("contacts", "Только контакты", "Пишут лишь те, с кем у вас уже есть переписка. Когда вы сами кому-то напишете, он станет контактом.")}
              {opt("none", "Никто", "Вам не сможет написать никто, даже те, с кем чат уже открыт.")}
              <TouchableOpacity onPress={() => setView("main")} style={{ marginTop: 8, padding: 12, alignItems: "center" }}><Text style={{ color: T.muted }}>Назад</Text></TouchableOpacity>
            </ScrollView>
          );
        })()}
        {view === "sessions" && (
          <ScrollView>
            {rows.length === 0 && <Text style={{ color: T.muted }}>Записей нет</Text>}
            {rows.map(r => (
              <View key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.text, fontWeight: "700" }}>{r.label || r.platform}{r.mine ? " — это устройство" : ""}</Text>
                  <Text style={{ color: T.muted, fontSize: 12 }}>активна {secDateTime(r.lastSeen || r.createdAt)}</Text>
                </View>
                {!r.mine && (
                  <TouchableOpacity onPress={async () => { await deleteDoc(doc(db, "users", me.uid, "sessions", r.id)).catch(() => { }); openSessions(); }}>
                    <Text style={{ color: T.danger }}>Убрать</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
            <Text style={{ color: T.muted, fontSize: 12.5, marginTop: 8 }}>
              «Выйти везде» помечает старые сессии отозванными — клиент, увидев метку, выходит сам. Мгновенный отзыв токена требует серверного ключа, поэтому офлайн-устройство выйдет при следующем запуске.
            </Text>
            <TouchableOpacity onPress={killAll} style={{ marginTop: 12, padding: 13, borderRadius: 999, backgroundColor: T.danger, alignItems: "center" }}>
              <Text style={{ color: "#fff", fontWeight: "800" }}>Выйти на всех устройствах</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setView("main")} style={{ marginTop: 8, padding: 12, alignItems: "center" }}><Text style={{ color: T.muted }}>Назад</Text></TouchableOpacity>
          </ScrollView>
        )}
        {view === "log" && (
          <ScrollView>
            {rows.length === 0 && <Text style={{ color: T.muted }}>Пока пусто</Text>}
            {rows.map((r, i) => (
              <View key={i} style={{ paddingVertical: 8 }}>
                <Text style={{ color: T.text, fontWeight: "700" }}>{SEC_EVENT_RU[r.type] || r.type}</Text>
                <Text style={{ color: T.muted, fontSize: 12 }}>{secDateTime(r.at)} · {r.platform || ""}{r.detail ? " · " + r.detail : ""}</Text>
              </View>
            ))}
            <Text style={{ color: T.muted, fontSize: 12.5, marginTop: 8 }}>Записи только добавляются: правила базы не дают изменить их задним числом.</Text>
            <TouchableOpacity onPress={() => setView("main")} style={{ marginTop: 8, padding: 12, alignItems: "center" }}><Text style={{ color: T.muted }}>Назад</Text></TouchableOpacity>
          </ScrollView>
        )}
        {view === "backup" && (
          <ScrollView>
            <Text style={{ color: T.muted, fontSize: 13, marginBottom: 10 }}>
              Ключ секретных чатов лежит только на этом телефоне. Копия шифруется парольной фразой: без неё её не прочитает никто, включая нас. Забудете фразу — копия бесполезна.
            </Text>
            <TextInput value={pass} onChangeText={setPass} secureTextEntry placeholder="Парольная фраза (от 8 символов)" placeholderTextColor={T.muted}
              style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
            <TouchableOpacity disabled={busy} onPress={doBackup} style={{ marginTop: 10, padding: 13, borderRadius: 999, backgroundColor: T.inverse, alignItems: "center", opacity: busy ? 0.6 : 1 }}>
              <Text style={{ color: T.onInverse, fontWeight: "800" }}>{busy ? "Считаем ключ…" : "Сохранить копию"}</Text>
            </TouchableOpacity>
            <TouchableOpacity disabled={busy} onPress={doRestore} style={{ marginTop: 8, padding: 13, borderRadius: 999, backgroundColor: T.surface2, alignItems: "center", opacity: busy ? 0.6 : 1 }}>
              <Text style={{ color: T.text, fontWeight: "700" }}>Восстановить из файла</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setView("main")} style={{ marginTop: 8, padding: 12, alignItems: "center" }}><Text style={{ color: T.muted }}>Назад</Text></TouchableOpacity>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}
// ================================================================ НАСТРОЙКИ
function SettingsSheet({ ctx, onClose }) {
  const { T, me, setMe, themeName, toggleTheme } = ctx;
  const [secOpen, setSecOpen] = useState(false);
  const togglePrivacy = async () => {
    try {
      const next = !me.hideLastSeen;
      await updateDoc(doc(db, "users", me.uid), { hideLastSeen: next });
      setMe({ ...me, hideLastSeen: next });
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const deleteAccount = () => {
    Alert.alert("Удалить аккаунт?", "НАВСЕГДА. Профиль и имя освободятся.", [
      { text: "Отмена", style: "cancel" },
      { text: "Удалить", style: "destructive", onPress: async () => {
        try {
          await deleteDoc(doc(db, "chats", `saved_${me.uid}`)).catch(() => { });
          await deleteDoc(doc(db, "users", me.uid, "private", "prefs")).catch(() => { });
          await deleteDoc(doc(db, "usernames", me.username)).catch(() => { });
          await deleteDoc(doc(db, "users", me.uid));
          const { deleteUser } = await import("firebase/auth");
          await deleteUser(auth.currentUser);
        } catch (e) {
          if ((e?.code || "").includes("requires-recent-login")) {
            Alert.alert("", "Для удаления войдите заново и повторите (защита Firebase)");
            signOut(auth);
          } else Alert.alert("Ошибка", ruError(e));
        }
      } },
    ]);
  };
  const [editOpen, setEditOpen] = useState(false);
  const [qrScan, setQrScan] = useState(false);
  const [name, setName] = useState(me.displayName || "");
  const [uname, setUname] = useState(me.username);
  const [bio, setBio] = useState(me.bio || "");
  const save = async () => {
    try {
      const newU = uname.trim().toLowerCase().replace(/^@/, "");
      if (newU !== me.username) {
        if (!/^[a-z0-9_]{3,24}$/.test(newU)) throw new Error("Username: 3–24 символа, латиница, цифры и _.");
        await runTransaction(db, async (tx) => {
          const taken = await tx.get(doc(db, "usernames", newU));
          if (taken.exists()) throw new Error("Этот username уже занят.");
          const old = await tx.get(doc(db, "usernames", me.username));
          tx.set(doc(db, "usernames", newU), { uid: me.uid, email: old.exists() ? old.data().email : emailFor(me.username) });
          tx.delete(doc(db, "usernames", me.username));
          tx.update(doc(db, "users", me.uid), { username: newU });
        });
      }
      const displayName = name.trim().slice(0, 40) || newU;
      await updateDoc(doc(db, "users", me.uid), { displayName, bio: bio.trim().slice(0, 160) });
      setMe({ ...me, username: newU, displayName, bio: bio.trim() });
      setEditOpen(false);
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: "#0008" }} />
      <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 22, paddingBottom: 36 }}>
        {!editOpen ? (<>
          <View style={{ alignItems: "center", marginBottom: 14 }}>
            <Avatar T={T} label={(me.displayName || me.username)[0].toUpperCase()} color={me.avatarColor} size={72} photo={me.avatar} />
            <Text style={{ color: T.text, fontSize: 20, fontWeight: "800", marginTop: 10 }}>{me.displayName || me.username}</Text>
            <Text style={{ color: T.muted }}>@{me.username}</Text>
            {!!me.bio && <Text style={{ color: T.text, marginTop: 4 }}>{me.bio}</Text>}
          </View>
          <TouchableOpacity style={st.row} onPress={() => setEditOpen(true)}><Text style={{ color: T.text, fontSize: 16 }}>👤  Изменить профиль</Text></TouchableOpacity>
          <TouchableOpacity style={st.row} onPress={async () => {
            try {
              const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
              if (res.canceled || !res.assets?.[0]?.uri) return;
              const small = await ImageManipulator.manipulateAsync(res.assets[0].uri, [{ resize: { width: 128 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
              const dataUrl = `data:image/jpeg;base64,${small.base64}`;
              if (dataUrl.length > 90_000) return Alert.alert("Ошибка", "Не удалось сжать фото");
              await updateDoc(doc(db, "users", me.uid), { avatar: dataUrl });
              setMe({ ...me, avatar: dataUrl });
            } catch (e) { Alert.alert("Ошибка", ruError(e)); }
          }}><Text style={{ color: T.text, fontSize: 16 }}>🖼  Фото профиля</Text></TouchableOpacity>
          <TouchableOpacity style={st.row} onPress={toggleTheme}><Text style={{ color: T.text, fontSize: 16 }}>◐  Тема: {themeName === "dark" ? "тёмная" : "светлая"}</Text></TouchableOpacity>
          <TouchableOpacity style={st.row} onPress={async () => {
            const next = ((me.avatarColor ?? 0) + 1) % 7;
            await updateDoc(doc(db, "users", me.uid), { avatarColor: next }).catch(() => { });
            setMe({ ...me, avatarColor: next });
          }}><Text style={{ color: T.text, fontSize: 16 }}>🎨  Сменить цвет аватара</Text></TouchableOpacity>
          <TouchableOpacity style={st.row} onPress={togglePrivacy}><Text style={{ color: T.text, fontSize: 16 }}>👁  Скрывать время захода: {me.hideLastSeen ? "вкл" : "выкл"}</Text></TouchableOpacity>
          <TouchableOpacity style={st.row} onPress={() => setQrScan(true)}><Text style={{ color: T.text, fontSize: 16 }}>📷  Войти на компьютере по QR</Text></TouchableOpacity>
          <TouchableOpacity style={st.row} onPress={() => setSecOpen(true)}><Text style={{ color: T.text, fontSize: 16 }}>🛡  Безопасность и приватность</Text></TouchableOpacity>
          {secOpen && <SecuritySheet ctx={ctx} onClose={() => setSecOpen(false)} />}
          <QrScannerModal visible={qrScan} onClose={() => setQrScan(false)} />         
          <TouchableOpacity style={st.row} onPress={deleteAccount}><Text style={{ color: T.danger, fontSize: 16 }}>🗑  Удалить аккаунт</Text></TouchableOpacity>
          <TouchableOpacity style={st.row} onPress={async () => {
            try { const tok = await AsyncStorage.getItem("fcmToken"); if (tok) await updateDoc(doc(db, "users", me.uid), { fcmTokens: arrayRemove(tok) }); } catch { }
            signOut(auth);
          }}><Text style={{ color: T.danger, fontSize: 16 }}>Выйти из аккаунта</Text></TouchableOpacity>
        </>) : (<>
          <Text style={{ color: T.text, fontSize: 18, fontWeight: "800", marginBottom: 12 }}>Профиль</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Имя" placeholderTextColor={T.muted} style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
          <TextInput value={uname} onChangeText={setUname} placeholder="Username" autoCapitalize="none" placeholderTextColor={T.muted} style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
          <TextInput value={bio} onChangeText={setBio} placeholder="О себе" placeholderTextColor={T.muted} style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
          <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
            <TouchableOpacity onPress={() => setEditOpen(false)} style={{ flex: 1, padding: 13, borderRadius: 999, backgroundColor: T.surface2, alignItems: "center" }}><Text style={{ color: T.text, fontWeight: "700" }}>Отмена</Text></TouchableOpacity>
            <TouchableOpacity onPress={save} style={{ flex: 1, padding: 13, borderRadius: 999, backgroundColor: T.inverse, alignItems: "center" }}><Text style={{ color: T.onInverse, fontWeight: "800" }}>Сохранить</Text></TouchableOpacity>
          </View>
        </>)}
      </View>
    </Modal>
  );
}

// ================================================================ НОВЫЙ ЧАТ
function NewChatSheet({ ctx, onClose }) {
  const { T, me, setScreen, openDmWith, joinByCode } = ctx;
  const [q, setQ] = useState("");
  const [found, setFound] = useState([]);
  const [groupMode, setGroupMode] = useState(false);
  const [kind, setKind] = useState("group");
  const [title, setTitle] = useState("");
  const [invite, setInvite] = useState("");
  const [selected, setSelected] = useState([]);
  useEffect(() => {
    const t = setTimeout(async () => {
      const s = q.trim().toLowerCase().replace(/^@/, "");
      if (!s) return setFound([]);
      try {
        const snap = await getDocs(query(collection(db, "users"), where("username", ">=", s), where("username", "<=", s + ""), limit(20)));
        setFound(snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.uid !== me.uid));
      } catch { }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);
  const createGroup = async () => {
    const tt = title.trim().slice(0, 60);
    if (!tt) return Alert.alert("Ошибка", "Введите название группы");
    const chatId = `grp_${randomId(16)}`;
    try {
      await setDoc(doc(db, "chats", chatId), {
        type: kind, title: tt, members: [me.uid, ...selected.map(u => u.uid)],
        ownerUid: me.uid, admins: [], avatarColor: Math.floor(Math.random() * 7),
        createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [],
      });
      onClose(); setScreen({ name: "chat", chatId });
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const tryJoin = () => {
    const m = invite.trim().match(/([a-f0-9]{12,})\s*$/i);
    if (!m) return Alert.alert("", "Вставьте ссылку вида …/join/<код> или сам код");
    onClose(); joinByCode(m[1]);
  };
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: "#0008" }} />
      <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 34, maxHeight: "80%" }}>
        <Text style={{ color: T.text, fontSize: 18, fontWeight: "800", marginBottom: 12 }}>{groupMode ? (kind === "channel" ? "Новый канал" : "Новая группа") : "Новое сообщение"}</Text>
        {groupMode && <TextInput value={title} onChangeText={setTitle} placeholder="Название группы" placeholderTextColor={T.muted} style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />}
        <TextInput value={q} onChangeText={setQ} placeholder="Найти пользователя (@имя)" autoCapitalize="none" placeholderTextColor={T.muted} style={[st.input, { backgroundColor: T.surface2, color: T.text }]} />
        {!groupMode && (<>
          <TouchableOpacity style={st.row} onPress={() => { setKind("group"); setGroupMode(true); }}><Text style={{ color: T.text, fontSize: 16 }}>👥  Создать группу</Text></TouchableOpacity>
          <TouchableOpacity style={st.row} onPress={() => { setKind("channel"); setGroupMode(true); }}><Text style={{ color: T.text, fontSize: 16 }}>📢  Создать канал</Text></TouchableOpacity>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <TextInput value={invite} onChangeText={setInvite} placeholder="Ссылка-приглашение или код" autoCapitalize="none" placeholderTextColor={T.muted}
              style={[st.input, { backgroundColor: T.surface2, color: T.text, flex: 1, marginBottom: 0 }]} />
            <TouchableOpacity onPress={tryJoin} style={{ padding: 12, borderRadius: 999, backgroundColor: T.inverse }}>
              <Text style={{ color: T.onInverse, fontWeight: "800" }}>Войти</Text>
            </TouchableOpacity>
          </View>
        </>)}
        {groupMode && selected.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {selected.map(u => (
              <TouchableOpacity key={u.uid} onPress={() => setSelected(selected.filter(x => x.uid !== u.uid))}
                style={{ backgroundColor: T.surface2, borderRadius: 999, paddingVertical: 5, paddingHorizontal: 12 }}>
                <Text style={{ color: T.text, fontSize: 13 }}>@{u.username} ✕</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        <FlatList data={found} keyExtractor={u => u.uid} keyboardShouldPersistTaps="handled" style={{ marginTop: 8 }} renderItem={({ item: u }) => (
          <TouchableOpacity style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}
            onPress={() => groupMode ? (selected.some(x => x.uid === u.uid) || setSelected([...selected, u])) : (onClose(), openDmWith(u))}>
            <Avatar T={T} label={(u.displayName || "?")[0].toUpperCase()} color={u.avatarColor} size={44} photo={u.avatar} />
            <View><Text style={{ color: T.text, fontWeight: "700" }}>{u.displayName}</Text><Text style={{ color: T.muted, fontSize: 13 }}>@{u.username}</Text></View>
          </TouchableOpacity>
        )} />
        {groupMode && (
          <TouchableOpacity onPress={createGroup} style={{ padding: 14, borderRadius: 999, backgroundColor: T.inverse, alignItems: "center", marginTop: 8 }}>
            <Text style={{ color: T.onInverse, fontWeight: "800" }}>{kind === "channel" ? "Создать канал" : "Создать группу"}</Text>
          </TouchableOpacity>
        )}
      </View>
    </Modal>
  );
}

// ================================================================ ИНФО О ЧАТЕ
function ChatInfoSheet({ ctx, chat, onClose }) {
  const { T, me, viewOf, fetchUser, openDmWith, myPrefs, setMyPrefs } = ctx;
  const v = viewOf(chat);
  const [members, setMembers] = useState([]);
  const [memberMenu, setMemberMenu] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const [editGroupOpen, setEditGroupOpen] = useState(false);
  const iAmOwner = chat.ownerUid === me.uid;
  const iAmAdmin = (chat.type === "group" || chat.type === "channel") && (iAmOwner || (chat.admins || []).includes(me.uid));
  const roleOf = (uid) => uid === chat.ownerUid ? "owner" : ((chat.admins || []).includes(uid) ? "admin" : "member");
  const roleMark = { owner: " 👑", admin: " ⭐", member: "" };

  useEffect(() => {
    if (chat.type !== "group" && chat.type !== "channel") return;
    Promise.all((chat.members || []).map(fetchUser)).then(list => setMembers(list.filter(Boolean)));
  }, [(chat.members || []).join(",")]);

  const inviteLink = async () => {
    try {
      let code = chat.inviteCode;
      if (!code) {
        code = randomId(18);
        await setDoc(doc(db, "invites", code), { chatId: chat.id, title: chat.title, memberCount: chat.members.length, avatarColor: chat.avatarColor || 0 });
        await updateDoc(doc(db, "chats", chat.id), { inviteCode: code });
      }
      const link = `${SITE}/join/${code}`;
      Alert.alert("Ссылка приглашения", link, [
        {
          text: "Отозвать", style: "destructive", onPress: async () => {
            try {
              await deleteDoc(doc(db, "invites", code));
              await updateDoc(doc(db, "chats", chat.id), { inviteCode: deleteField() });
              Alert.alert("", "Ссылка отозвана. Создайте новую при необходимости.");
            } catch (e) { Alert.alert("Ошибка", ruError(e)); }
          },
        },
        { text: "Копировать", onPress: async () => { await Clipboard.setStringAsync(link); } },
        { text: "Закрыть", style: "cancel" },
      ]);
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const memberItems = (m) => {
    const role = roleOf(m.uid);
    const isSelf = m.uid === me.uid;
    const items = [];
    if (!isSelf) items.push({ label: "💬  Написать сообщение", onPress: () => { onClose(); openDmWith(m); } });
    if (iAmOwner && !isSelf && role !== "owner") {
      items.push(role === "admin"
        ? { label: "⭐  Снять админа", onPress: () => updateDoc(doc(db, "chats", chat.id), { admins: arrayRemove(m.uid) }).catch(e => Alert.alert("Ошибка", ruError(e))) }
        : { label: "⭐  Назначить админом", onPress: () => updateDoc(doc(db, "chats", chat.id), { admins: arrayUnion(m.uid) }).catch(e => Alert.alert("Ошибка", ruError(e))) });
    }
    if (!isSelf && role !== "owner" && (iAmOwner || (iAmAdmin && role === "member"))) {
      items.push({
        label: "🚫  Исключить из группы", danger: true, onPress: () => {
          Alert.alert("Подтверждение", `Исключить ${m.displayName}?`, [
            { text: "Отмена", style: "cancel" },
            { text: "Да", style: "destructive", onPress: () => updateDoc(doc(db, "chats", chat.id), { members: arrayRemove(m.uid), admins: arrayRemove(m.uid) }).catch(e => Alert.alert("Ошибка", ruError(e))) },
          ]);
        },
      });
    }
    return items;
  };

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={{ flex: 1, backgroundColor: "#0008" }} />
      <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 34, maxHeight: "82%" }}>
        <ScrollView>
          <View style={{ alignItems: "center", marginBottom: 12 }}>
            <Avatar T={T} label={chat.type === "saved" ? "☆" : (v.title || "?")[0].toUpperCase()} color={v.avatarColor} size={72} photo={v.photo} />
            <Text style={{ color: T.text, fontSize: 20, fontWeight: "800", marginTop: 10 }}>{v.title}</Text>
            {(chat.type === "group" || chat.type === "channel") && <Text style={{ color: T.muted }}>{v.memberCount} {chat.type === "channel" ? "подписчик(ов)" : "участник(ов)"}</Text>}
            {chat.type === "private" && v.peer && (<>
              <Text style={{ color: T.muted }}>@{v.peer.username}</Text>
              {!!v.peer.bio && <Text style={{ color: T.text, marginTop: 4 }}>{v.peer.bio}</Text>}
              <Text style={{ color: T.muted, marginTop: 4 }}>{fmtLastSeen(v.peer)}</Text>
            </>)}
            {chat.type === "saved" && <Text style={{ color: T.muted }}>Ваши личные заметки</Text>}
          </View>
          {chat.type === "private" && v.peer && (
            <TouchableOpacity style={st.row} onPress={async () => {
              const blocked = (myPrefs.blocked || []).includes(v.peer.uid);
              try {
                await setDoc(doc(db, "users", me.uid, "private", "prefs"),
                  { blocked: blocked ? arrayRemove(v.peer.uid) : arrayUnion(v.peer.uid) }, { merge: true });
                setMyPrefs({ ...myPrefs, blocked: blocked ? (myPrefs.blocked || []).filter(x => x !== v.peer.uid) : [...(myPrefs.blocked || []), v.peer.uid] });
                Alert.alert("", blocked ? "Разблокирован(а)" : "Заблокирован(а) — больше не сможет вам писать");
              } catch (e) { Alert.alert("Ошибка", ruError(e)); }
            }}>
              <Text style={{ color: (myPrefs.blocked || []).includes(v.peer.uid) ? T.text : T.danger, fontSize: 16 }}>
                {(myPrefs.blocked || []).includes(v.peer.uid) ? "✓  Разблокировать" : "🚫  Заблокировать"}
              </Text>
            </TouchableOpacity>
          )}
          {(chat.type === "group" || chat.type === "channel") && (<>
            {iAmAdmin && (
              <TouchableOpacity style={st.row} onPress={() => setEditGroupOpen(true)}><Text style={{ color: T.text, fontSize: 16 }}>✎  Название и фото</Text></TouchableOpacity>
            )}
            <TouchableOpacity style={st.row} onPress={() => setAddOpen(true)}><Text style={{ color: T.text, fontSize: 16 }}>＋  Добавить участника</Text></TouchableOpacity>
            {iAmAdmin && <TouchableOpacity style={st.row} onPress={inviteLink}><Text style={{ color: T.text, fontSize: 16 }}>🔗  Ссылка приглашения</Text></TouchableOpacity>}
            <Text style={{ color: T.muted, fontSize: 12, textTransform: "uppercase", letterSpacing: 1, marginTop: 10, marginBottom: 4 }}>Участники</Text>
            {members.map(m => (
              <TouchableOpacity key={m.uid} onPress={() => setMemberMenu(m)} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 7 }}>
                <Avatar T={T} label={(m.displayName || "?")[0].toUpperCase()} color={m.avatarColor} size={44} photo={m.avatar} />
                <View>
                  <Text style={{ color: T.text, fontWeight: "700" }}>{m.displayName}{roleMark[roleOf(m.uid)]}</Text>
                  <Text style={{ color: T.muted, fontSize: 13 }}>@{m.username} · {fmtLastSeen(m)}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </>)}
        </ScrollView>
      </View>
      {memberMenu && memberItems(memberMenu).length > 0 && (
        <ActionSheet T={T} items={memberItems(memberMenu)} onClose={() => setMemberMenu(null)}
          header={<Text style={{ color: T.muted, fontWeight: "700", padding: 8 }}>{memberMenu.displayName}</Text>} />
      )}
      {editGroupOpen && (
        <PromptModal T={T} title="Название и фото" submitLabel="Сохранить"
          fields={[{ key: "title", placeholder: "Название", value: chat.title || "" }]}
          onClose={() => setEditGroupOpen(false)}
          onSubmit={async ({ title }) => {
            try {
              const patch = { title: title.trim().slice(0, 60) || chat.title };
              Alert.alert("Фото", "Выбрать новое фото?", [
                { text: "Без фото", onPress: async () => { await updateDoc(doc(db, "chats", chat.id), patch); } },
                { text: "Выбрать", onPress: async () => {
                  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
                  if (!res.canceled && res.assets?.[0]?.uri) {
                    const small = await ImageManipulator.manipulateAsync(res.assets[0].uri, [{ resize: { width: 128 } }], { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG, base64: true });
                    patch.avatar = `data:image/jpeg;base64,${small.base64}`;
                  }
                  await updateDoc(doc(db, "chats", chat.id), patch);
                } },
              ]);
            } catch (e) { Alert.alert("Ошибка", ruError(e)); }
          }} />
      )}
      {addOpen && (
        <PromptModal T={T} title="Добавить участника" submitLabel="Добавить"
          fields={[{ key: "name", placeholder: "@имя" }]}
          onClose={() => setAddOpen(false)}
          onSubmit={async ({ name }) => {
            try {
              const n = name.trim().toLowerCase().replace(/^@/, "");
              const reg = await getDoc(doc(db, "usernames", n));
              if (!reg.exists()) return Alert.alert("", "Пользователь не найден");
              await updateDoc(doc(db, "chats", chat.id), { members: arrayUnion(reg.data().uid) });
            } catch (e) { Alert.alert("Ошибка", ruError(e)); }
          }} />
      )}
    </Modal>
  );
}

// ================================================================ ЧАТ
function ChatScreen({ ctx, chatId }) {
  const { T, me, chats, viewOf, setScreen, openDmByName, fetchUser, joinByCode } = ctx;
  const chat = chats.get(chatId);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [topic, setTopic] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [uploadPct, setUploadPct] = useState(null); // прогресс загрузки вложения в R2
  const [peerKeys, setPeerKeys] = useState({}); // uid -> публичный ключ, для расшифровки
  const [e2eOpen, setE2eOpen] = useState(false);
  const [ttlOpen, setTtlOpen] = useState(false); // выбор таймера исчезающих
  const [schedOpen, setSchedOpen] = useState(false); // отложенная отправка
  const [editTarget, setEditTarget] = useState(null);
  const [menuMsg, setMenuMsg] = useState(null);
  const [forwardMsg, setForwardMsg] = useState(null);
  const [forwardNote, setForwardNote] = useState("");   // комментарий к пересылке
  const [reactPick, setReactPick] = useState(null);     // сообщение для полного эмодзи-пикера
  const [nextSilent, setNextSilent] = useState(false);  // следующее сообщение — без пуша
  const [fpScan, setFpScan] = useState(null);           // сверка отпечатка ключа по QR
  const [dmDenied, setDmDenied] = useState(false);      // получатель ограничил, кто может ему писать

  // Секретный чат: Android не даёт снять скриншот и не показывает чат в списке задач
  useEffect(() => {
    if (!chat?.e2e) return;
    ScreenCapture.preventScreenCaptureAsync().catch(() => { });
    return () => { ScreenCapture.allowScreenCaptureAsync().catch(() => { }); };
  }, [chat?.e2e]);
  const [sel, setSel] = useState({ start: 0, end: 0 }); // выделение в поле ввода → панель форматирования
  const [selForce, setSelForce] = useState(null);       // разовая установка курсора после форматирования
  const [forwardSel, setForwardSel] = useState(new Set());
  const [photoView, setPhotoView] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [topicMenu, setTopicMenu] = useState(null);
  const [topicModal, setTopicModal] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [stickerOpen, setStickerOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const recStartRef = useRef(0);
  const lastTyping = useRef(0);
  const listRef = useRef(null);
  const sendingRef = useRef(false); // защита от спама по кнопке отправки
  const [mentionList, setMentionList] = useState([]); // подсказки @-пикера
  const [mentionBanner, setMentionBanner] = useState(null); // уведомление об @упоминании
  const lastMentionAckRef = useRef(0);

  const isForum = !!(chat?.topics && chat.topics.length);
  const isAdmin = (chat?.type === "group" || chat?.type === "channel") && (chat.ownerUid === me.uid || (chat.admins || []).includes(me.uid));

  // карта @имя → uid участников (для @-пикера и команд)
  const memberUsernameMapRef = useRef(Promise.resolve(new Map()));
  const memberUserInfoRef = useRef(Promise.resolve(new Map()));
  useEffect(() => {
    if (!chat) return;
    const build = async () => {
      const map = new Map(); const info = new Map();
      for (const uid of chat.members || []) { const u = await fetchUser(uid); if (u?.username) { map.set(u.username.toLowerCase(), uid); info.set(uid, u); } }
      return { map, info };
    };
    const p = build();
    memberUsernameMapRef.current = p.then(r => r.map);
    memberUserInfoRef.current = p.then(r => r.info);
  }, [chatId]);

  // системный жест/кнопка «назад» = навигация, а не выход из приложения
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (searchOpen) { setSearchOpen(false); return true; }
      if (topic) { setTopic(null); return true; }
      setScreen({ name: "list" });
      return true;
    });
    return () => sub.remove();
  }, [topic, searchOpen]);

  // клавиатура не должна перекрывать поле ввода (edge-to-edge Android)
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const s1 = Keyboard.addListener("keyboardDidShow", (e) => setKbHeight(e.endCoordinates?.height || 0));
    const s2 = Keyboard.addListener("keyboardDidHide", () => setKbHeight(0));
    return () => { s1.remove(); s2.remove(); };
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(`draft_${chatId}`).then(v => { if (v) setText(v); }).catch(() => { });
  }, [chatId]);

  useEffect(() => {
    const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "desc"), limit(300));
    let firstSnap = true;
    const unsub = onSnapshot(q, (snap) => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      setMessages(list);
      if (firstSnap) {
        // базовая отметка по последнему сообщению — не показываем баннер на историю
        firstSnap = false;
        lastMentionAckRef.current = list.reduce((mx, m) => Math.max(mx, m.createdAt || 0), 0);
        return;
      }
      const mine = list.find(m => (m.mentions || []).includes(me.uid) && m.sender !== me.uid && (m.createdAt || 0) > lastMentionAckRef.current);
      if (mine) {
        lastMentionAckRef.current = mine.createdAt || Date.now();
        setMentionBanner(mine);
        setTimeout(() => setMentionBanner(null), 5000);
      }
    }, () => { });
    return unsub;
  }, [chatId]);

  const unreadCount = (chat?.unread || {})[me.uid] || 0;
  useEffect(() => {
    if (!chat) return;
    if (unreadCount && AppState.currentState === "active") {
      updateDoc(doc(db, "chats", chatId), { [`lastRead.${me.uid}`]: Date.now(), [`unread.${me.uid}`]: 0 })
        .then(() => bumpChat(chatId)).catch(() => { });
    }
  }, [unreadCount, messages.length]);

  if (!chat) {
    return (
      <SafeAreaView style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: T.muted }}>Чат недоступен</Text>
        <TouchableOpacity onPress={() => setScreen({ name: "list" })}><Text style={{ color: T.text, marginTop: 10 }}>‹ Назад</Text></TouchableOpacity>
      </SafeAreaView>
    );
  }

  const v = viewOf(chat);
  const lastReadByOthers = v.lastReadByOthers;
  const typing = Object.entries(chat.typing || {}).filter(([uid, t]) => uid !== me.uid && Date.now() - t < 3000);
  const topicsList = isForum ? [{ id: "general", title: "Общий", icon: "#", closed: !!chat.generalClosed, createdAt: chat.createdAt }, ...chat.topics] : [];
  const currentClosed = topic ? (topic.id === "general" ? !!chat.generalClosed : !!(chat.topics || []).find(t => t.id === topic.id)?.closed) : false;
  const canWrite = (chat.type !== "channel" || isAdmin) && (!isForum || (topic && (!currentClosed || isAdmin))) && !dmDenied;
  const pinnedMsg = chat.pinnedMessageId ? messages.find(m => m.id === chat.pinnedMessageId && !m.deleted) : null;

  // Просроченные исчезающие и просмотренные одноразовые прячем сразу — сервер добьёт позже
  const visible = messages.filter(m => !m.deleted && !isExpired(m) && (!isForum || !topic || (m.topicId || "general") === topic.id));

  // ---------- операции ----------
  const sendTo = async (targetChat, { textBody = "", image = null, sticker = null, voice = null, poll = null, media = null, game = null, dice = null, silent = false, viewOnce = false, forwardedFrom = null }) => {
    const msg = {
      sender: me.uid, senderName: me.displayName || me.username,
      text: textBody.slice(0, 4000), image, createdAt: Date.now(), reactions: {},
      topicId: (targetChat.id === chatId && isForum && topic) ? topic.id : "general",
    };
    if (sticker) msg.sticker = sticker;
    if (voice) msg.voice = voice;
    if (poll) msg.poll = poll;
    if (media) msg.media = media;
    if (game) msg.game = game;
    if (dice) msg.dice = dice;
    // «без звука»: воркер видит флаг и не шлёт пуш — ни обычный, ни по упоминанию
    if (silent) msg.silent = true;
    if (viewOnce) { msg.viewOnce = true; msg.viewedBy = {}; }
    // Исчезающие сообщения: таймер чата задаёт срок жизни, добивает push-worker
    if (targetChat.ttl > 0) msg.expiresAt = msg.createdAt + targetChat.ttl;
    if (forwardedFrom) msg.forwardedFrom = forwardedFrom;
    // Секретный чат: в базу уходят только конверты enc[uid], plaintext остаётся на устройстве
    if (targetChat.e2e && msg.text) {
      if (!myKeys) throw new Error("Нет ключа шифрования на этом устройстве");
      const pubs = {};
      for (const uid of targetChat.members) {
        pubs[uid] = uid === me.uid ? myKeys.pub : (await fetchUser(uid))?.e2ePub || null;
      }
      msg.enc = sealForMembers(targetChat.members, pubs, myKeys.secret, msg.text);
      msg.text = "";
    }
    if (!forwardedFrom && targetChat.id === chatId && replyTo) msg.replyTo = { id: replyTo.id, sender: replyTo.senderName, text: replyTo.text ? replyTo.text.slice(0, 120) : "📷 Фото" };
    if (textBody) {
      const map = await memberUsernameMapRef.current;
      const arr = [];
      const re = /@([a-z0-9_]{3,24})\b/gi;
      let mt; while ((mt = re.exec(textBody))) { const uid = map.get(mt[1].toLowerCase()); if (uid && uid !== me.uid && !arr.includes(uid)) arr.push(uid); }
      if (arr.length) msg.mentions = arr;
    }
    // превью ссылки (через воркер)
    const urlHit = (textBody || "").match(/https?:\/\/[^\s<]+/i);
    if (urlHit && LINK_WORKER) {
      try {
        const clean = urlHit[0].replace(/[.,;:!?)]+$/, "");
        const p = await fetch(`${LINK_WORKER}/link-preview?url=${encodeURIComponent(clean)}`).then(r => r.json()).catch(() => null);
        if (p && p.title) msg.preview = { url: clean, title: p.title, desc: p.desc || "", image: p.image || "" };
      } catch { /* превью не критично */ }
    }
    const mediaPreview = media
      ? (media.kind === "video" ? "🎬 Видео" : media.kind === "audio" ? "🎵 Аудио" : media.kind === "image" ? "🖼 Изображение" : `📎 ${media.name || "Файл"}`)
      : "";
    const previewText = (targetChat.e2e ? "🔒 Секретное сообщение" : msg.text)
      || (sticker ? "🧩 Стикер" : voice ? "🎤 Голосовое сообщение" : poll ? "📊 Опрос"
          : game ? "🎮 Крестики-нолики" : dice ? `🎲 ${dice.value}` : mediaPreview);
    const patch = {
      // silent живёт и в lastMessage: воркер решает про пуш по нему, не читая сообщения
      lastMessage: { text: previewText, senderUid: me.uid, senderName: msg.senderName, createdAt: msg.createdAt, hasImage: !!image || media?.kind === "image", silent: !!silent },
      [`lastRead.${me.uid}`]: msg.createdAt, [`unread.${me.uid}`]: 0, [`typing.${me.uid}`]: 0,
    };
    for (const m of targetChat.members) if (m !== me.uid) patch[`unread.${m}`] = increment(1);
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "chats", targetChat.id, "messages")), msg);
    batch.update(doc(db, "chats", targetChat.id), patch);
    await batch.commit();
    bumpChat(targetChat.id);
  };
  const handleSlash = async (body) => {
    const [cmd, ...rest] = body.trim().split(/\s+/);
    const c = (cmd || "").replace(/^\/+/, "").toLowerCase();
    if (["mute", "warn", "ban", "unmute", "unban"].includes(c)) return runModeration(body);
    if (c === "info") { setInfoOpen(true); return true; }
    if (c === "theme") { const t = (rest[0] || "").toLowerCase(); if (t === "dark" || t === "light") ctx.setTheme(t); else ctx.toggleTheme(); return true; }
    if (c === "saved") { const sv = [...chats.values()].find(v => v.type === "saved"); if (sv) setScreen({ name: "chat", chatId: sv.id }); else Alert.alert("", "Нет «Избранного»"); return true; }
    if (c === "help") { Alert.alert("Команды", "/info\n/theme [dark|light]\n/saved\n/dice [граней]\n/help\n/mute /warn /ban"); return true; }
    // /dice [граней] — честный бросок на системном ГПСЧ, не Math.random
    if (c === "dice" || c === "roll") {
      const sides = Math.min(1000, Math.max(2, parseInt(rest[0], 10) || 6));
      // отбрасываем хвост диапазона, иначе младшие значения выпадают чаще
      const limit = Math.floor(4294967296 / sides) * sides;
      let n;
      do {
        const b = Crypto.getRandomBytes(4);
        n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
      } while (n >= limit);
      await sendTo(chat, { dice: { value: (n % sides) + 1, sides } });
      setReplyTo(null);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      return true;
    }
    return false;
  };
  const submit = async () => {
    const body = text.trim();
    if (!body || sendingRef.current) return;
    // слэш-команды: модерация + служебные
    if (/^\/(mute|warn|ban|unmute|unban|info|theme|help|saved|dice|roll)\b/i.test(body)) {
      sendingRef.current = true;
      try {
        const handled = await handleSlash(body);
        if (handled) { setText(""); setMentionList([]); AsyncStorage.removeItem(`draft_${chatId}`).catch(() => { }); }
      } catch (e) { Alert.alert("Ошибка", ruError(e)); }
      finally { sendingRef.current = false; }
      return;
    }
    if ((chat.mutes || {})[me.uid] > Date.now()) { Alert.alert("", "Вы замучены — писать сейчас нельзя"); return; }
    if ((chat.bans || {})[me.uid] > Date.now()) { Alert.alert("", "Вас забанили в этом чате"); return; }
    sendingRef.current = true;
    setText(""); // очищаем сразу — повторный тап не отправит то же самое
    AsyncStorage.removeItem(`draft_${chatId}`).catch(() => { });
    try {
      if (editTarget) {
        await updateDoc(doc(db, "chats", chatId, "messages", editTarget.id), { text: body.slice(0, 4000), editedAt: Date.now() });
        if (chat.lastMessage?.createdAt === editTarget.createdAt) await updateDoc(doc(db, "chats", chatId), { "lastMessage.text": body.slice(0, 4000) });
        setEditTarget(null);
      } else {
        await sendTo(chat, { textBody: body, silent: nextSilent });
        setNextSilent(false);
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      }
      setReplyTo(null);
    } catch (e) {
      setText(body); // вернуть текст при ошибке
      if ((e?.code || "").includes("permission-denied") && chat.type === "private") setDmDenied(true);
      else Alert.alert("Ошибка", ruError(e));
    } finally { sendingRef.current = false; }
  };
  // Вложения 3.0: фото/видео/файлы уезжают в R2 через воркер, а не base64 в документ
  const uploadAndSend = async (file, viewOnce = false) => {
    if (file.size > MEDIA_MAX_BYTES) return Alert.alert("Слишком большой файл", `Максимум ${fmtBytes(MEDIA_MAX_BYTES)}`);
    setUploadPct(0);
    try {
      const media = await uploadMedia(LINK_WORKER, () => auth.currentUser.getIdToken(), file, { onProgress: setUploadPct });
      await sendTo(chat, { media, viewOnce });
      setReplyTo(null);
    } catch (e) { Alert.alert("Ошибка", e?.message || ruError(e)); }
    finally { setUploadPct(null); }
  };
  // RN не знает про File — заворачиваем локальный uri в blob для uploadMedia
  const assetToFile = async (uri, name, type) => {
    const blob = await (await fetch(uri)).blob();
    return { blob, name, type: blob.type || type, size: blob.size || 0 };
  };
  const pickPhoto = async (viewOnce = false) => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.85, allowsEditing: false });
    const a = res.assets?.[0];
    if (res.canceled || !a) return;
    const isVideo = a.type === "video" || /\.(mp4|mov|webm|mkv)$/i.test(a.uri || "");
    const name = a.fileName || (isVideo ? `video-${Date.now()}.mp4` : `photo-${Date.now()}.jpg`);
    const type = a.mimeType || (isVideo ? "video/mp4" : "image/jpeg");
    let uri = a.uri;
    // фото пережимаем, видео отправляем как есть
    if (!isVideo) {
      try {
        const ctx = ImageManipulator.manipulate(uri).resize({ width: 2048 });
        const img = await ctx.renderAsync();
        const out = await img.saveAsync({ compress: 0.85, format: "jpeg" });
        if (out?.uri) uri = out.uri;
      } catch { /* не вышло — отправим оригинал */ }
    }
    await uploadAndSend(await assetToFile(uri, name, type), viewOnce);
  };
  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: "*/*" });
    const a = res.assets?.[0];
    if (res.canceled || !a) return;
    await uploadAndSend(await assetToFile(a.uri, a.name || "file", a.mimeType || "application/octet-stream"));
  };
  // Форматирование выделенного куска: оборачиваем в ту же разметку, что понимает MentionText
  const applyFormat = (mark) => {
    const { start, end } = sel;
    if (start === end) return;
    const picked = text.slice(start, end);
    const inner = picked
      .replace(/```([\s\S]*?)```/g, "$1").replace(/\|\|([\s\S]+?)\|\|/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1").replace(/~~([^~\n]+)~~/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1").replace(/`([^`\n]+)`/g, "$1");
    // тот же значок второй раз — снимаем форматирование
    const already = mark && picked.startsWith(mark) && picked.endsWith(mark) && picked.length > mark.length * 2;
    const out = !mark || already ? inner : `${mark}${inner}${mark}`;
    const val = text.slice(0, start) + out + text.slice(end);
    setText(val);
    setSel({ start: start + out.length, end: start + out.length });
    setSelForce({ start: start + out.length, end: start + out.length });
    AsyncStorage.setItem(`draft_${chatId}`, val).catch(() => { });
  };
  const onChangeText = (val) => {
    setText(val);
    if (val.trim()) AsyncStorage.setItem(`draft_${chatId}`, val).catch(() => { });
    else AsyncStorage.removeItem(`draft_${chatId}`).catch(() => { });
    const now = Date.now();
    if (now - lastTyping.current > 1800) {
      lastTyping.current = now;
      updateDoc(doc(db, "chats", chatId), { [`typing.${me.uid}`]: now }).catch(() => { });
    }
    // @-пикер: показываем подсказки после @префикса
    const m = /(?:^|[\s(])@([a-z0-9_]*)$/.exec(val.slice(0, val.length));
    if (!m || !m[1]) { setMentionList([]); return; }
    const q = m[1].toLowerCase();
    Promise.all([memberUsernameMapRef.current, memberUserInfoRef.current]).then(([map, info]) => {
      const list = [...map.entries()].filter(([uname]) => uname.startsWith(q) && map.get(uname) !== me.uid).slice(0, 6);
      setMentionList(list.map(([uname, uid]) => ({ uid, uname, user: info.get(uid) || null })));
    }).catch(() => setMentionList([]));
  };
  const insertMention = (it) => {
    const val = text;
    const m = /(?:^|[\s(])@([a-z0-9_]*)$/.exec(val);
    const nt = m ? `${val.slice(0, val.length - m[0].length + m[0].lastIndexOf("@"))}@${it.uname} ` : `${val}@${it.uname} `;
    AsyncStorage.setItem(`draft_${chatId}`, nt).catch(() => { });
    setText(nt);
    setMentionList([]);
  };
  // голосовые: тап — запись, повторный тап — отправка (expo-audio)
  const toggleRec = async () => {
    if (recording) {
      setRecording(false);
      try {
        await recorder.stop();
        const uri = recorder.uri;
        const dur = Math.max(1, Math.round((Date.now() - recStartRef.current) / 1000));
        if (!uri) return;
        const b64 = await FileSystem.readAsStringAsync(uri, { encoding: "base64" });
        const dataUrl = `data:audio/mp4;base64,${b64}`;
        if (dataUrl.length > 900_000) return Alert.alert("", "Слишком длинное голосовое (макс ~1 минута)");
        await sendTo(chat, { voice: { data: dataUrl, duration: dur } });
        setReplyTo(null);
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      } catch (e) { Alert.alert("Ошибка", ruError(e)); }
      return;
    }
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) return Alert.alert("", "Нет доступа к микрофону");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recStartRef.current = Date.now();
      setRecording(true);
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const toggleReaction = async (m, emoji) => {
    const ref = doc(db, "chats", chatId, "messages", m.id);
    const patch = {};
    const already = (m.reactions?.[emoji] || []).includes(me.uid);
    if (already) patch[`reactions.${emoji}`] = arrayRemove(me.uid);
    else {
      for (const [k, us] of Object.entries(m.reactions || {})) if (us.includes(me.uid)) patch[`reactions.${k}`] = arrayRemove(me.uid);
      patch[`reactions.${emoji}`] = arrayUnion(me.uid);
    }
    await updateDoc(ref, patch).catch(() => { });
  };
  // Мини-игра: ход проверяется общей логикой sg30, правила Firestore дублируют проверку
  // Расшифровка секретного сообщения: приватный ключ есть только на этом устройстве
  const decryptMessage = (m) => {
    if (!myKeys) return "🔒 Зашифровано (нет ключа на этом устройстве)";
    const senderPub = m.sender === me.uid ? myKeys.pub : (peerKeys[m.sender] || null);
    if (!senderPub) return "🔒 Зашифровано";
    const text = openForMe(m, me.uid, senderPub, myKeys.secret);
    return text === null ? "🔒 Не удалось расшифровать (ключ другого устройства)" : text;
  };
  // Одноразовое: открываем на весь экран и сразу помечаем просмотр — больше его не увидит никто
  const revealViewOnce = async (m) => {
    const url = m.media?.url || m.image;
    if (url) setPhotoView(url);
    else if (m.text) Alert.alert("Одноразовое сообщение", m.text);
    try { await updateDoc(doc(db, "chats", chatId, "messages", m.id), { [`viewedBy.${me.uid}`]: Date.now() }); }
    catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  // Публичные ключи участников нужны и для шифрования, и для расшифровки входящих
  useEffect(() => {
    if (!chat?.members) return;
    let alive = true;
    (async () => {
      const out = {};
      for (const uid of chat.members) {
        if (uid === me.uid) continue;
        const u = await fetchUser(uid).catch(() => null);
        if (u?.e2ePub) out[uid] = u.e2ePub;
      }
      if (alive) setPeerKeys(out);
    })();
    return () => { alive = false; };
  }, [chatId, (chat?.members || []).join(",")]);

  const playTtt = async (m, cell) => {
    const next = tttMove(m.game, me.uid, cell);
    if (typeof next === "string") return Alert.alert("", next);
    try { await updateDoc(doc(db, "chats", chatId, "messages", m.id), { game: next }); }
    catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const votePoll = async (m, optionId) => {
    const cur = m.poll?.votes?.[me.uid];
    try {
      await updateDoc(doc(db, "chats", chatId, "messages", m.id), { [`poll.votes.${me.uid}`]: cur === optionId ? deleteField() : optionId });
      bumpChat(chatId);
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const deleteMsg = async (m) => {
    try {
      await updateDoc(doc(db, "chats", chatId, "messages", m.id), { deleted: true, text: "", image: null, reactions: {} });
      const extra = {};
      if (chat.pinnedMessageId === m.id) extra.pinnedMessageId = deleteField();
      if (chat.lastMessage?.createdAt === m.createdAt) { extra["lastMessage.text"] = "Сообщение удалено"; extra["lastMessage.hasImage"] = false; }
      if (Object.keys(extra).length) await updateDoc(doc(db, "chats", chatId), extra);
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const togglePin = async (m) => {
    try {
      await updateDoc(doc(db, "chats", chatId), { pinnedMessageId: chat.pinnedMessageId === m.id ? deleteField() : m.id });
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const patchTopic = async (topicId, patch) => {
    if (topicId === "general") {
      if ("closed" in patch) await updateDoc(doc(db, "chats", chatId), { generalClosed: patch.closed });
      return;
    }
    const topics = (chat.topics || []).map(t => t.id === topicId ? { ...t, ...patch } : t);
    await updateDoc(doc(db, "chats", chatId), { topics });
  };
  const deleteTopic = async (t) => {
    try {
      await updateDoc(doc(db, "chats", chatId), { topics: (chat.topics || []).filter(x => x.id !== t.id) });
      const snap = await getDocs(query(collection(db, "chats", chatId, "messages"), where("topicId", "==", t.id)));
      const batch = writeBatch(db);
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };

  const listData = useMemo(() => {
    const out = [];
    const arr = visible;
    for (let i = 0; i < arr.length; i++) {
      out.push({ kind: "msg", m: arr[i] });
      const older = arr[i + 1];
      if (!older || new Date(older.createdAt).toDateString() !== new Date(arr[i].createdAt).toDateString()) {
        out.push({ kind: "day", ts: arr[i].createdAt, key: `day_${arr[i].id}` });
      }
    }
    return out;
  }, [visible]);

  const scrollToMessage = (id) => {
    const idx = listData.findIndex(it => it.kind === "msg" && it.m.id === id);
    if (idx >= 0) listRef.current?.scrollToIndex({ index: idx, viewPosition: 0.5, animated: true });
  };

  const subtitle = typing.length
    ? "печатает…"
    : chat.type === "saved" ? "ваши заметки"
      : chat.type === "channel" ? `📢 канал · ${v.memberCount} подписчик(ов)`
      : chat.type === "group"
        ? (topic ? `${topic.icon || "#"} ${topic.title}` : (isForum ? `${topicsList.length} топик(ов) · ${v.memberCount} участник(ов)` : `${v.memberCount} участник(ов)`))
        : fmtLastSeen(v.peer);

  const searchHits = searchOpen && searchText.trim()
    ? visible.filter(m => m.text && m.text.toLowerCase().includes(searchText.trim().toLowerCase())).slice(0, 30)
    : [];

  // ---------- модерация: /mute /warn /ban ----------
  const postNoticeApk = async (text) => {
    const message = {
      sender: me.uid, senderName: me.displayName || me.username,
      text: text.slice(0, 4000), notice: true, createdAt: Date.now(), reactions: {},
      topicId: (isForum && topic) ? topic.id : "general",
    };
    const patch = {
      lastMessage: { text: message.text, senderUid: me.uid, senderName: message.senderName, createdAt: message.createdAt, hasImage: false },
      [`lastRead.${me.uid}`]: message.createdAt, [`unread.${me.uid}`]: 0, [`typing.${me.uid}`]: 0,
    };
    for (const m of chat.members || []) if (m !== me.uid) patch[`unread.${m}`] = increment(1);
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "chats", chatId, "messages")), message);
    batch.update(doc(db, "chats", chatId), patch);
    await batch.commit();
    bumpChat(chatId);
  };
  const runModeration = async (raw) => {
    if (chat.type !== "group" && chat.type !== "channel") { Alert.alert("", "Команда доступна только в группах/каналах"); return true; }
    if (!isAdmin) { Alert.alert("", "Модерировать — только админ или создатель"); return true; }
    const mm = raw.match(/^\/(mute|warn|ban|unmute|unban)(?:\s+(.*))?$/i);
    if (!mm) return false;
    const cmd = mm[1].toLowerCase();
    const tokens = (mm[2] || "").trim().split(/\s+/).filter(Boolean);
    const map = await memberUsernameMapRef.current;
    let targetUid = null, targetName = "", timeStr = null;
    if (tokens.length && tokens[0].startsWith("@")) {
      targetUid = map.get(tokens[0].slice(1).toLowerCase()) || null; targetName = tokens[0].toLowerCase(); timeStr = tokens[1] ?? null;
    } else if (replyTo && !tokens.length) { targetUid = replyTo.sender; targetName = replyTo.senderName; }
    else if (replyTo && tokens.length) { targetUid = replyTo.sender; targetName = replyTo.senderName; timeStr = tokens[0]; }
    else if (tokens.length) {
      targetUid = map.get(tokens[0].replace(/^@/, "").toLowerCase()) || null;
      targetName = tokens[0].startsWith("@") ? tokens[0].toLowerCase() : "@" + tokens[0].toLowerCase();
      timeStr = tokens[1] ?? null;
    }
    if (!targetUid) { Alert.alert("", "Укажите @имя или ответьте на сообщение"); return true; }
    if (targetUid === me.uid) { Alert.alert("", "Нельзя модерировать себя"); return true; }
    const targetRole = chat.ownerUid === targetUid ? "owner" : ((chat.admins || []).includes(targetUid) ? "admin" : "member");
    if (targetRole === "owner") { Alert.alert("", "Владельца нельзя модерировать"); return true; }
    if (targetRole === "admin" && chat.ownerUid !== me.uid) { Alert.alert("", "Админа может модерировать только создатель"); return true; }
    if (cmd !== "unban" && cmd !== "unmute" && !(chat.members || []).includes(targetUid)) { Alert.alert("", "Пользователя нет в чате"); return true; }
    const ref = doc(db, "chats", chat.id);
    const who = me.displayName || me.username;
    const timeNow = Date.now();
    const dur = timeStr == null ? (cmd === "warn" ? 30 * 60e3 : cmd === "ban" ? 24 * 3600e3 : 60 * 60e3) : parseDurationMod(timeStr);
    if (dur == null) { Alert.alert("", "Не понял время. Пример: /mute @имя 2ч или 30м"); return true; }
    const nm = (str) => String(str).replace(/^@/, "");
    try {
      if (cmd === "unmute" || (cmd === "mute" && dur === 0)) {
        await updateDoc(ref, { [`mutes.${targetUid}`]: deleteField() });
        await postNoticeApk(`🔔 ${who} снял(а) мут с @${nm(targetName)}`); Alert.alert("", "Мут снят"); return true;
      }
      if (cmd === "unban" || (cmd === "ban" && dur === 0)) {
        await updateDoc(ref, { members: arrayUnion(targetUid), [`bans.${targetUid}`]: deleteField() });
        await postNoticeApk(`🚪 ${who} снял(а) бан с @${nm(targetName)}`); Alert.alert("", "Бан снят"); return true;
      }
      if (cmd === "mute") {
        const until = timeNow + dur;
        await updateDoc(ref, { [`mutes.${targetUid}`]: until });
        await postNoticeApk(`🔕 ${who} замутил(а) ${targetName} до ${fmtUntilMod(until)}`);
        Alert.alert("", `Замучен до ${fmtUntilMod(until)}`); return true;
      }
      if (cmd === "warn") {
        const until = timeNow + dur;
        await updateDoc(ref, { [`warns.${targetUid}`]: increment(1), [`mutes.${targetUid}`]: until });
        await postNoticeApk(`⚠️ ${who} выдал(а) варн ${targetName} и замутил(а) до ${fmtUntilMod(until)}`);
        Alert.alert("", `Варн выдан, мут до ${fmtUntilMod(until)}`); return true;
      }
      if (cmd === "ban") {
        const until = timeNow + dur;
        await updateDoc(ref, { members: arrayRemove(targetUid), admins: arrayRemove(targetUid), [`bans.${targetUid}`]: until });
        await postNoticeApk(`🚫 ${who} забанил(а) ${targetName} до ${fmtUntilMod(until)}`);
        Alert.alert("", `Забанен до ${fmtUntilMod(until)}`); return true;
      }
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
    return true;
  };

  const msgMenuItems = (m) => {
    const mine = m.sender === me.uid;
    const items = [
      { label: "↩  Ответить", onPress: () => { setEditTarget(null); setReplyTo(m); } },
      { label: "⧉  Копировать", onPress: async () => { await Clipboard.setStringAsync(m.text || ""); } },
      { label: "➦  Переслать", onPress: () => setForwardMsg(m) },
      { label: chat.pinnedMessageId === m.id ? "📌  Открепить" : "📌  Закрепить", onPress: () => togglePin(m) },
    ];
    if (mine && m.text) items.push({ label: "✎  Изменить", onPress: () => { setReplyTo(null); setEditTarget(m); setText(m.text); } });
    if (mine || isAdmin || chat.type === "saved") items.push({ label: "🗑  Удалить", danger: true, onPress: () => deleteMsg(m) });
    return items;
  };
  const topicMenuItems = (t) => {
    const canManage = isAdmin || t.creatorUid === me.uid;
    const isGeneral = t.id === "general";
    const items = [];
    if ((isGeneral && isAdmin) || (!isGeneral && canManage)) items.push({ label: t.closed ? "🔓  Открыть топик" : "🔒  Закрыть топик", onPress: () => patchTopic(t.id, { closed: !t.closed }).catch(e => Alert.alert("Ошибка", ruError(e))) });
    if (!isGeneral && canManage) {
      items.push({ label: "✎  Изменить", onPress: () => setTopicModal({ mode: "edit", topic: t }) });
      items.push({
        label: "🗑  Удалить топик", danger: true, onPress: () => {
          Alert.alert("Подтверждение", `Удалить топик «${t.title}» со всеми сообщениями?`, [
            { text: "Отмена", style: "cancel" },
            { text: "Да", style: "destructive", onPress: () => deleteTopic(t) },
          ]);
        },
      });
    }
    return items;
  };

  return (
    <SafeAreaView style={{ flex: 1 }}>
      {/* header */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingVertical: 8, gap: 10, backgroundColor: T.surface }}>
        <TouchableOpacity onPress={() => topic ? setTopic(null) : setScreen({ name: "list" })} style={{ padding: 6 }}>
          <MaterialIcons name="arrow-back" size={23} color={T.text} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setInfoOpen(true)} style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
          <Avatar T={T} label={chat.type === "saved" ? "☆" : (v.title || "?")[0].toUpperCase()} color={v.avatarColor} size={40} photo={v.photo} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: T.text, fontWeight: "800", fontSize: 16 }}>{v.title}</Text>
            <Text numberOfLines={1} style={{ color: typing.length || isOnlineUser(v.peer) ? T.text : T.muted, fontSize: 12.5 }}>{subtitle}</Text>
          </View>
        </TouchableOpacity>
        {chat.type === "private" && (
          <TouchableOpacity onPress={() => ctx.startCall(v.peerUid, v.peer, false)} style={{ padding: 6 }}>
            <MaterialIcons name="call" size={22} color={T.text} />
          </TouchableOpacity>
        )}
        {chat.type === "private" && (
          <TouchableOpacity onPress={() => ctx.startCall(v.peerUid, v.peer, true)} style={{ padding: 6 }}>
            <MaterialIcons name="videocam" size={22} color={T.text} />
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={() => { setSearchOpen(x => !x); setSearchText(""); }} style={{ padding: 6 }}>
          <MaterialIcons name="search" size={22} color={T.text} />
        </TouchableOpacity>
      </View>

      {/* банер-уведомление об @упоминании */}
      {mentionBanner && (
        <TouchableOpacity onPress={() => setMentionBanner(null)} style={{ backgroundColor: T.inverse, paddingVertical: 8, paddingHorizontal: 14 }}>
          <Text style={{ color: T.onInverse, fontSize: 13.5, fontWeight: "600", textAlign: "center" }}>
            🔔 {mentionBanner.senderName} упомянул(а) вас: {(mentionBanner.text || "📷 Фото").slice(0, 80)}
          </Text>
        </TouchableOpacity>
      )}

      {/* поиск по сообщениям */}
      {searchOpen && (
        <View style={{ backgroundColor: T.surface, paddingHorizontal: 12, paddingBottom: 8 }}>
          <TextInput value={searchText} onChangeText={setSearchText} placeholder="Поиск по сообщениям" placeholderTextColor={T.muted} autoFocus
            style={{ backgroundColor: T.surface2, color: T.text, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8 }} />
          {searchHits.map(m => (
            <TouchableOpacity key={m.id} onPress={() => { setSearchOpen(false); scrollToMessage(m.id); }} style={{ paddingVertical: 6 }}>
              <Text numberOfLines={1} style={{ color: T.text }}><Text style={{ fontWeight: "700" }}>{m.senderName}: </Text>{m.text}</Text>
            </TouchableOpacity>
          ))}
          {!!searchText.trim() && !searchHits.length && <Text style={{ color: T.muted, paddingVertical: 6 }}>Не найдено</Text>}
        </View>
      )}

      {/* плашка закрепа */}
      {pinnedMsg && (!isForum || topic) && (
        <TouchableOpacity onPress={() => scrollToMessage(pinnedMsg.id)}
          style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: T.surface, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: T.outline }}>
          <Text>📌</Text>
          <Text numberOfLines={1} style={{ color: T.text, flex: 1, fontSize: 13.5 }}>{pinnedMsg.senderName}: {pinnedMsg.text || "📷 Фото"}</Text>
          <TouchableOpacity onPress={() => togglePin(pinnedMsg)}><MaterialIcons name="close" size={18} color={T.muted} /></TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* форум: список топиков */}
      {isForum && !topic ? (
        <FlatList
          data={topicsList}
          keyExtractor={t => t.id}
          ListHeaderComponent={
            <TouchableOpacity onPress={() => setTopicModal({ mode: "create" })} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 }}>
              <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: T.inverse, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ fontSize: 20, color: T.onInverse }}>＋</Text>
              </View>
              <Text style={{ color: T.text, fontWeight: "700" }}>Новый топик</Text>
            </TouchableOpacity>
          }
          renderItem={({ item: t }) => {
            const last = messages.find(m => !m.deleted && (m.topicId || "general") === t.id);
            return (
              <TouchableOpacity onPress={() => setTopic(t)} onLongPress={() => setTopicMenu(t)} delayLongPress={400}
                style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 }}>
                <View style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: T.surface2, alignItems: "center", justifyContent: "center" }}>
                  <Text style={{ fontSize: 20 }}>{t.icon || "#"}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.text, fontWeight: "700" }}>{t.title}{t.closed ? " 🔒" : ""}</Text>
                  <Text numberOfLines={1} style={{ color: T.muted, fontSize: 13 }}>{last ? `${last.senderName}: ${last.text || "📷 Фото"}` : "Нет сообщений"}</Text>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      ) : (
        <KeyboardAvoidingView style={{ flex: 1, paddingBottom: Platform.OS === "android" ? kbHeight : 0 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <FlatList
            ref={listRef}
            inverted
            data={listData}
            keyExtractor={it => it.kind === "day" ? it.key : it.m.id}
            contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 8 }}
            onScrollToIndexFailed={() => { }}
            renderItem={({ item }) => item.kind === "day" ? (
              <View style={{ alignItems: "center", marginVertical: 8 }}>
                <Text style={{ color: T.muted, fontSize: 12, backgroundColor: T.surface, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, overflow: "hidden" }}>{fmtDay(item.ts)}</Text>
              </View>
            ) : (
              <MessageBubble T={T} m={item.m} mine={item.m.sender === me.uid} meUid={me.uid}
                group={chat.type === "group"} lastReadByOthers={lastReadByOthers} saved={chat.type === "saved"}
                onLongPress={() => setMenuMsg(item.m)} onPhoto={(url) => setPhotoView(url || item.m.image)}
                onDoubleTap={() => toggleReaction(item.m, "❤️")}
                onSwipeReply={() => { setEditTarget(null); setReplyTo(item.m); }}
                onMention={openDmByName}
                onInvite={joinByCode}
                onVote={(m, o) => votePoll(m, o)}
                onGameMove={(m, cell) => playTtt(m, cell)}
                onReveal={(m) => revealViewOnce(m)}
                decrypt={decryptMessage}
                onQuotePress={() => item.m.replyTo && scrollToMessage(item.m.replyTo.id)} />
            )}
            ListEmptyComponent={<View style={{ transform: [{ scaleY: -1 }], alignItems: "center", marginTop: 40 }}><Text style={{ color: T.muted }}>Пока пусто — напишите первое сообщение</Text></View>}
          />
          {(replyTo || editTarget) && (
            <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: T.surface, paddingHorizontal: 14, paddingVertical: 8, gap: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.text, fontWeight: "700", fontSize: 13 }}>{editTarget ? "Редактирование" : `Ответ: ${replyTo.senderName}`}</Text>
                <Text numberOfLines={1} style={{ color: T.muted, fontSize: 13 }}>{(editTarget || replyTo).text || "📷 Фото"}</Text>
              </View>
              <TouchableOpacity onPress={() => { if (editTarget) setText(""); setReplyTo(null); setEditTarget(null); }}>
                <MaterialIcons name="close" size={20} color={T.muted} />
              </TouchableOpacity>
            </View>
          )}
          {uploadPct !== null && (
            <View style={{ backgroundColor: T.surface, paddingHorizontal: 14, paddingVertical: 8 }}>
              <Text style={{ color: T.muted, fontSize: 12, marginBottom: 5 }}>Загрузка вложения… {Math.round(uploadPct * 100)}%</Text>
              <View style={{ height: 4, borderRadius: 4, backgroundColor: T.surface2, overflow: "hidden" }}>
                <View style={{ height: 4, width: `${Math.round(uploadPct * 100)}%`, backgroundColor: T.inverse }} />
              </View>
            </View>
          )}
          {mentionList.length > 0 && (
            <View style={{ backgroundColor: T.surface, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderColor: T.outline }}>
              {mentionList.map(it => (
                <TouchableOpacity key={it.uid} onPress={() => insertMention(it)} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 7 }}>
                  <Avatar T={T} label={(it.user?.displayName || it.uname || "?")[0].toUpperCase()} color={it.user?.avatarColor ?? 0} size={34} photo={it.user?.avatar || null} />
                  <Text style={{ color: T.text, fontSize: 15, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>{it.user?.displayName || it.uname}</Text>
                  <Text style={{ color: T.muted, fontSize: 13, marginLeft: "auto" }}>@{it.uname}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {/* панель форматирования — появляется, когда в поле ввода что-то выделено */}
          {canWrite && sel.end > sel.start && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: T.surface2 }}>
              {[
                { m: "**", label: "Ж", st: { fontWeight: "900" } },
                { m: "*", label: "К", st: { fontStyle: "italic" } },
                { m: "~~", label: "Ч", st: { textDecorationLine: "line-through" } },
                { m: "`", label: "</>", st: { fontFamily: "monospace" } },
                { m: "||", label: "Спойлер", st: {} },
                { m: "", label: "Убрать", st: { opacity: 0.7 } },
              ].map(b => (
                <TouchableOpacity key={b.label} onPress={() => applyFormat(b.m)}
                  style={{ paddingHorizontal: 11, paddingVertical: 6, borderRadius: 999, backgroundColor: T.surface }}>
                  <Text style={{ color: T.text, fontSize: 14, ...b.st }}>{b.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {canWrite ? (
            <View style={{ flexDirection: "row", alignItems: "flex-end", padding: 8, gap: 4, backgroundColor: T.surface }}>
              <TouchableOpacity onPress={() => setStickerOpen(true)} style={{ padding: 10 }}><MaterialIcons name="emoji-emotions" size={23} color={T.muted} /></TouchableOpacity>
              <TouchableOpacity onPress={() => setAttachOpen(true)} style={{ padding: 10 }}><MaterialIcons name="attach-file" size={23} color={T.muted} /></TouchableOpacity>
              {/* selection задаём только сразу после форматирования, иначе курсор прыгает при наборе */}
              <TextInput value={text} onChangeText={onChangeText} selection={selForce}
                onSelectionChange={(e) => { setSel(e.nativeEvent.selection); if (selForce) setSelForce(null); }}
                placeholder={recording ? "Идёт запись…" : "Сообщение"} placeholderTextColor={recording ? T.danger : T.muted} multiline
                style={{ flex: 1, backgroundColor: T.surface2, color: T.text, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120, fontSize: 16 }} />
              <TouchableOpacity onPress={toggleRec} style={{ padding: 10 }}>
                <MaterialIcons name={recording ? "stop-circle" : "mic"} size={23} color={recording ? T.danger : T.muted} />
              </TouchableOpacity>
              {/* Долгое нажатие — отправить без пуша, не будя собеседника */}
              <TouchableOpacity onPress={submit}
                onLongPress={() => { setNextSilent(v => !v); Alert.alert("", nextSilent ? "Обычная отправка" : "Следующее сообщение — без звука 🔕"); }}
                style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: nextSilent ? T.surface2 : T.inverse, borderWidth: nextSilent ? 1.5 : 0, borderColor: T.inverse, alignItems: "center", justifyContent: "center" }}>
                <MaterialIcons name={editTarget ? "check" : nextSilent ? "notifications-off" : "send"} size={20} color={nextSilent ? T.text : T.onInverse} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ padding: 14, alignItems: "center", backgroundColor: T.surface }}>
              <Text style={{ color: T.muted, textAlign: "center" }}>{
                dmDenied ? "🚫 Этот пользователь ограничил круг тех, кто может ему писать"
                  : chat.type === "channel" ? "📢 Писать в канал могут только админы"
                  : "🔒 Топик закрыт — писать могут только админы"
              }</Text>
            </View>
          )}
        </KeyboardAvoidingView>
      )}

      {/* меню сообщения */}
      {menuMsg && (
        <Modal transparent animationType="fade" onRequestClose={() => setMenuMsg(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setMenuMsg(null)} style={{ flex: 1, backgroundColor: "#0006", justifyContent: "center", padding: 30 }}>
            <View style={{ backgroundColor: T.surface, borderRadius: 20, padding: 8 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-around", paddingVertical: 8 }}>
                {QUICK_REACTIONS.map(e => (
                  <TouchableOpacity key={e} onPress={() => { toggleReaction(menuMsg, e); setMenuMsg(null); }}>
                    <Text style={{ fontSize: 26 }}>{e}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity onPress={() => { const m = menuMsg; setMenuMsg(null); setReactPick(m); }}>
                  <Text style={{ fontSize: 24, color: T.muted }}>＋</Text>
                </TouchableOpacity>
              </View>
              {msgMenuItems(menuMsg).map((it, i) => (
                <TouchableOpacity key={i} style={st.row} onPress={() => { setMenuMsg(null); it.onPress(); }}>
                  <Text style={{ color: it.danger ? T.danger : T.text, fontSize: 16 }}>{it.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {/* полный пикер реакций */}
      {reactPick && (
        <Modal transparent animationType="fade" onRequestClose={() => setReactPick(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setReactPick(null)} style={{ flex: 1, backgroundColor: "#0006", justifyContent: "center", padding: 24 }}>
            <View style={{ backgroundColor: T.surface, borderRadius: 22, padding: 12, maxHeight: 340 }}>
              <Text style={{ color: T.muted, fontSize: 13, marginBottom: 8 }}>Выберите реакцию</Text>
              <ScrollView>
                <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
                  {ALL_REACTIONS.map(e => (
                    <TouchableOpacity key={e} onPress={() => { const m = reactPick; setReactPick(null); toggleReaction(m, e); }}
                      style={{ width: "12.5%", alignItems: "center", paddingVertical: 7 }}>
                      <Text style={{ fontSize: 25 }}>{e}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {/* пересылка (мультивыбор) */}
      {forwardMsg && (
        <Modal transparent animationType="slide" onRequestClose={() => { setForwardMsg(null); setForwardSel(new Set()); setForwardNote(""); }}>
          <TouchableOpacity activeOpacity={1} onPress={() => { setForwardMsg(null); setForwardSel(new Set()); setForwardNote(""); }} style={{ flex: 1, backgroundColor: "#0008" }} />
          <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 34, maxHeight: "70%" }}>
            <Text style={{ color: T.text, fontSize: 18, fontWeight: "800", marginBottom: 10 }}>Переслать в…</Text>
            <ScrollView>
              {[...chats.values()].map(viewOf).map(c => {
                const on = forwardSel.has(c.id);
                return (
                  <TouchableOpacity key={c.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}
                    onPress={() => { const n = new Set(forwardSel); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); setForwardSel(n); }}>
                    <View style={{ width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: T.inverse, alignItems: "center", justifyContent: "center", backgroundColor: on ? T.inverse : "transparent" }}>
                      {on && <Text style={{ color: T.onInverse, fontSize: 13, fontWeight: "800" }}>✓</Text>}
                    </View>
                    <Avatar T={T} label={c.type === "saved" ? "☆" : (c.title || "?")[0].toUpperCase()} color={c.avatarColor} size={44} />
                    <Text style={{ color: T.text, fontWeight: "700", flex: 1 }}>{c.title}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {/* комментарий к пересылке уезжает отдельным сообщением после самого форварда */}
            <TextInput value={forwardNote} onChangeText={setForwardNote} placeholder="Комментарий (необязательно)" placeholderTextColor={T.muted} multiline maxLength={1000}
              style={{ marginTop: 10, backgroundColor: T.surface2, color: T.text, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, maxHeight: 90, fontSize: 15 }} />
            <TouchableOpacity disabled={forwardSel.size === 0} onPress={async () => {
              const msg = forwardMsg; const ids = [...forwardSel]; const note = forwardNote.trim();
              setForwardMsg(null); setForwardSel(new Set()); setForwardNote("");
              try {
                for (const id of ids) {
                  await sendTo(chats.get(id), { textBody: msg.text || "", image: msg.image || null, forwardedFrom: msg.senderName });
                  if (note) await sendTo(chats.get(id), { textBody: note });
                }
                if (ids.length > 1) Alert.alert("", `Переслано в ${ids.length} чатов`);
              } catch (e) { Alert.alert("Ошибка", ruError(e)); }
            }} style={{ marginTop: 12, padding: 14, borderRadius: 999, backgroundColor: forwardSel.size ? T.inverse : T.surface2, alignItems: "center", opacity: forwardSel.size ? 1 : 0.6 }}>
              <Text style={{ color: forwardSel.size ? T.onInverse : T.muted, fontWeight: "800" }}>{forwardSel.size ? `Переслать (${forwardSel.size})` : "Переслать"}</Text>
            </TouchableOpacity>
          </View>
        </Modal>
      )}

      {/* просмотр фото */}
      {photoView && (
        <Modal transparent animationType="fade" onRequestClose={() => setPhotoView(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setPhotoView(null)} style={{ flex: 1, backgroundColor: "#000d", alignItems: "center", justifyContent: "center" }}>
            <Image source={{ uri: photoView }} style={{ width: "94%", height: "80%" }} resizeMode="contain" />
          </TouchableOpacity>
        </Modal>
      )}

      {/* стикеры */}
      {stickerOpen && (
        <Modal transparent animationType="slide" onRequestClose={() => setStickerOpen(false)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setStickerOpen(false)} style={{ flex: 1, backgroundColor: "#0008" }} />
          <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 14, paddingBottom: 30, maxHeight: "55%" }}>
            <Text style={{ color: T.text, fontSize: 16, fontWeight: "800", marginBottom: 8, paddingLeft: 6 }}>Стикеры</Text>
            <FlatList data={STICKERS} numColumns={5} keyExtractor={c => c}
              renderItem={({ item: code }) => (
                <TouchableOpacity style={{ flex: 1, padding: 6 }}
                  onPress={async () => {
                    setStickerOpen(false);
                    try { await sendTo(chat, { sticker: code }); setReplyTo(null); listRef.current?.scrollToOffset({ offset: 0, animated: true }); }
                    catch (e) { Alert.alert("Ошибка", ruError(e)); }
                  }}>
                  <Image source={{ uri: `${SITE}/stickers/${code}.png` }} style={{ width: "100%", aspectRatio: 1 }} />
                </TouchableOpacity>
              )} />
          </View>
        </Modal>
      )}

      {e2eOpen && (
        <ActionSheet T={T} onClose={() => setE2eOpen(false)}
          header={
            <View style={{ padding: 12, paddingTop: 4, gap: 6 }}>
              <Text style={{ color: T.text, fontWeight: "700", fontSize: 15 }}>Секретный чат</Text>
              <Text style={{ color: T.muted, fontSize: 12.5 }}>
                Шифрование на устройстве (X25519 + XSalsa20-Poly1305). Сервер и база видят только шифротекст.
                Приватный ключ не покидает телефон — на другом устройстве старые сообщения не откроются.
              </Text>
              <Text style={{ color: T.muted, fontSize: 12 }}>Ваш отпечаток: {fingerprint(myKeys?.pub)}</Text>
              <Text style={{ color: T.muted, fontSize: 12 }}>
                Отпечаток собеседника: {(() => {
                  const peer = (chat.members || []).find(u => u !== me.uid);
                  return peerKeys[peer] ? fingerprint(peerKeys[peer]) : "ключа ещё нет";
                })()}
              </Text>
            </View>
          }
          items={[{
            label: "📷  Сверить ключи по QR",
            onPress: () => {
              const peer = (chat.members || []).find(u => u !== me.uid);
              if (!peerKeys[peer]) return Alert.alert("", "У собеседника ещё нет ключа");
              setFpScan(peerKeys[peer]);
            },
          }, {
            label: chat.e2e ? "🔓  Выключить шифрование" : "🔒  Включить шифрование",
            onPress: async () => {
              const peer = (chat.members || []).find(u => u !== me.uid);
              if (!chat.e2e && !peerKeys[peer]) return Alert.alert("", "Собеседник ещё не заходил в 3.0 — ключа нет");
              try { await updateDoc(doc(db, "chats", chat.id), { e2e: !chat.e2e }); }
              catch (e) { Alert.alert("Ошибка", ruError(e)); }
            },
          }]} />
      )}
      {fpScan && <FingerprintScanModal T={T} expectedPub={fpScan} onClose={() => setFpScan(null)} />}
      {ttlOpen && (
        <ActionSheet T={T} onClose={() => setTtlOpen(false)}
          header={<Text style={{ color: T.muted, fontSize: 12.5, padding: 12, paddingTop: 4 }}>
            Новые сообщения будут удаляться сами. Уже отправленные не тронем.</Text>}
          items={TTL_OPTIONS.map(o => ({
            label: `${o.ms ? "🔥" : "✖"}  ${o.label}${(chat?.ttl || 0) === o.ms ? "  ✓" : ""}`,
            onPress: async () => {
              if ((chat.type === "group" || chat.type === "channel") && !isAdmin) return Alert.alert("", "Таймер в группе меняет только админ");
              try { await updateDoc(doc(db, "chats", chat.id), { ttl: o.ms || null }); }
              catch (e) { Alert.alert("Ошибка", ruError(e)); }
            },
          }))} />
      )}
      {schedOpen && (
        <PromptModal T={T} title="Отложенная отправка" submitLabel="Запланировать"
          fields={[
            { key: "text", placeholder: "Что отправить?", value: text },
            { key: "mins", placeholder: "Через сколько минут (например 60)", value: "60" },
          ]}
          onClose={() => setSchedOpen(false)}
          onSubmit={async (v) => {
            const body = (v.text || "").trim();
            const mins = Math.round(Number(v.mins) || 0);
            if (!body) return Alert.alert("", "Введите текст");
            if (!(mins >= 1)) return Alert.alert("", "Минимум одна минута");
            try {
              await setDoc(doc(collection(db, "scheduled")), {
                uid: me.uid, chatId: chat.id, text: body, sendAt: Date.now() + mins * 60e3,
                createdAt: Date.now(), senderName: me.displayName || me.username, topicId: topic?.id || "general",
              });
              setSchedOpen(false); setText("");
              Alert.alert("", `Отправим через ${mins} мин — можно закрыть приложение`);
            } catch (e) { Alert.alert("Ошибка", ruError(e)); }
          }} />
      )}
      {attachOpen && (
        <ActionSheet T={T} onClose={() => setAttachOpen(false)} items={[
          { label: "📷  Фото или видео", onPress: () => pickPhoto(false) },
          { label: "📎  Файл", onPress: pickFile },
          { label: "👁  Одноразовое фото", onPress: () => pickPhoto(true) },
          { label: "📊  Опрос", onPress: () => setPollOpen(true) },
          { label: "⏰  Отложенная отправка", onPress: () => setSchedOpen(true) },
          { label: `🔥  Исчезающие: ${ttlLabel(chat?.ttl || 0)}`, onPress: () => setTtlOpen(true) },
          ...(chat?.type === "private" ? [{ label: chat.e2e ? "🔒  Секретный чат: вкл" : "🔓  Включить шифрование", onPress: () => setE2eOpen(true) }] : []),
          ...(chat?.type === "private" ? [{
            label: "🎮  Крестики-нолики",
            onPress: async () => {
              const peer = (chat.members || []).find(u => u !== me.uid);
              if (!peer) return;
              try { await sendTo(chat, { game: newTttGame(me.uid, peer) }); } catch (e) { Alert.alert("Ошибка", ruError(e)); }
            },
          }] : []),
        ]} />
      )}
      {pollOpen && (
        <PromptModal T={T} title="Новый опрос" submitLabel="Создать"
          fields={[
            { key: "q", placeholder: "Вопрос" },
            { key: "o1", placeholder: "Вариант 1" },
            { key: "o2", placeholder: "Вариант 2" },
            { key: "o3", placeholder: "Вариант 3 (необязательно)" },
            { key: "o4", placeholder: "Вариант 4 (необязательно)" },
            { key: "o5", placeholder: "Вариант 5 (необязательно)" },
            { key: "o6", placeholder: "Вариант 6 (необязательно)" },
            { key: "o7", placeholder: "Вариант 7 (необязательно)" },
            { key: "o8", placeholder: "Вариант 8 (необязательно)" },
          ]}
          onClose={() => setPollOpen(false)}
          onSubmit={async (v) => {
            const question = v.q.trim().slice(0, 120);
            const options = [v.o1, v.o2, v.o3, v.o4, v.o5, v.o6, v.o7, v.o8].map(x => (x || "").trim().slice(0, 60)).filter(Boolean)
              .map(text => ({ id: randomId(8), text }));
            if (!question || options.length < 2) return Alert.alert("", "Нужен вопрос и минимум 2 варианта");
            try { await sendTo(chat, { poll: { question, options, votes: {} } }); listRef.current?.scrollToOffset({ offset: 0, animated: true }); }
            catch (e) { Alert.alert("Ошибка", ruError(e)); }
          }} />
      )}

      {infoOpen && <ChatInfoSheet ctx={ctx} chat={chat} onClose={() => setInfoOpen(false)} />}
      {topicMenu && topicMenuItems(topicMenu).length > 0 && (
        <ActionSheet T={T} items={topicMenuItems(topicMenu)} onClose={() => setTopicMenu(null)}
          header={<Text style={{ color: T.muted, fontWeight: "700", padding: 8 }}>{topicMenu.icon} {topicMenu.title}</Text>} />
      )}
      {topicModal && (
        <PromptModal T={T} title={topicModal.mode === "create" ? "Новый топик" : "Настройки топика"}
          submitLabel={topicModal.mode === "create" ? "Создать" : "Сохранить"}
          fields={[
            { key: "icon", placeholder: "Эмодзи (иконка)", value: topicModal.topic?.icon || "" },
            { key: "title", placeholder: "Название", value: topicModal.topic?.title || "" },
          ]}
          onClose={() => setTopicModal(null)}
          onSubmit={async ({ icon, title: tt }) => {
            try {
              const cleanTitle = tt.trim().slice(0, 60);
              const cleanIcon = icon.trim().slice(0, 4);
              if (topicModal.mode === "create") {
                if (!cleanTitle) return Alert.alert("", "Введите название топика");
                await updateDoc(doc(db, "chats", chatId), {
                  topics: arrayUnion({ id: `top_${randomId(16)}`, title: cleanTitle, icon: cleanIcon || "💬", creatorUid: me.uid, createdAt: Date.now(), closed: false }),
                });
              } else {
                await patchTopic(topicModal.topic.id, { title: cleanTitle || topicModal.topic.title, icon: cleanIcon || topicModal.topic.icon });
              }
            } catch (e) { Alert.alert("Ошибка", ruError(e)); }
          }} />
      )}
    </SafeAreaView>
  );
}

// ---------- пузырь сообщения (свайп вправо = ответить) ----------
// Медиа 3.0: файл лежит в R2, показываем превью или карточку
function MediaBubble({ T, m, mine, onPhoto }) {
  const md = m.media || {};
  const fg = mine ? T.onInverse : T.text;
  if (md.kind === "image") {
    return (
      <TouchableOpacity onPress={() => onPhoto && onPhoto(md.url)}>
        <Image source={{ uri: md.url }} style={{ width: 220, height: 220, borderRadius: 12, marginBottom: m.text ? 6 : 0 }} resizeMode="cover" />
      </TouchableOpacity>
    );
  }
  const icon = md.kind === "video" ? "▶" : md.kind === "audio" ? "🎵" : "📎";
  return (
    <TouchableOpacity onPress={() => Linking.openURL(md.url)}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, minWidth: 190 }}>
      <Text style={{ fontSize: 20, color: fg }}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: fg, fontSize: 13.5, fontWeight: "700" }}>{md.name || (md.kind === "video" ? "Видео" : "Файл")}</Text>
        <Text style={{ color: mine ? T.onInverse : T.muted, fontSize: 11.5, opacity: 0.85 }}>{fmtBytes(md.size)}</Text>
      </View>
    </TouchableOpacity>
  );
}

// Мини-игра: крестики-нолики прямо в пузыре
function TttBubble({ T, m, mine, meUid, onMove }) {
  const g = m.game || {};
  const fg = mine ? T.onInverse : T.text;
  const status = g.winner === "draw" ? "Ничья"
    : g.winner ? (g.winner === meUid ? "Вы победили 🎉" : "Соперник победил")
    : g.turn === meUid ? `Ваш ход (${tttMark(g, meUid)})` : "Ход соперника";
  return (
    <View style={{ marginVertical: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", width: 3 * 46 }}>
        {[...(g.board || "---------")].map((c, i) => (
          <TouchableOpacity key={i} disabled={c !== "-" || !!g.winner} onPress={() => onMove && onMove(m, i)}
            style={{
              width: 44, height: 44, margin: 1, borderRadius: 8, alignItems: "center", justifyContent: "center",
              backgroundColor: (g.line || []).includes(i) ? T.inverse : (mine ? T.onInverse + "22" : T.surface2),
            }}>
            <Text style={{ fontSize: 22, fontWeight: "800", color: (g.line || []).includes(i) ? T.onInverse : fg }}>{c === "-" ? "" : c}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={{ color: mine ? T.onInverse : T.muted, fontSize: 11.5, marginTop: 5 }}>{status}</Text>
    </View>
  );
}

function MessageBubble({ T, m, mine, meUid, group, lastReadByOthers, saved, onLongPress, onPhoto, onDoubleTap, onSwipeReply, onMention, onInvite, onQuotePress, onVote, onGameMove, onReveal, decrypt }) {
  const lastTap = useRef(0);
  // В секретном чате текста в документе нет — расшифровываем на месте
  const bodyText = m.enc ? (decrypt ? decrypt(m) : "🔒 Зашифровано") : m.text;
  const read = mine && lastReadByOthers >= m.createdAt;
  const pan = useRef(new Animated.Value(0)).current;
  const responder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => g.dx > 18 && Math.abs(g.dx) > Math.abs(g.dy) * 1.8,
    onPanResponderMove: (_, g) => { if (g.dx > 0) pan.setValue(Math.min(g.dx, 80)); },
    onPanResponderRelease: (_, g) => {
      if (g.dx > 55) onSwipeReply();
      Animated.spring(pan, { toValue: 0, useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.spring(pan, { toValue: 0, useNativeDriver: true }).start(),
  })).current;
  const onPress = () => {
    const now = Date.now();
    if (now - lastTap.current < 280) onDoubleTap();
    lastTap.current = now;
  };
  if (m.notice) {
    return (
      <View style={{ alignItems: "center", marginVertical: 3 }}>
        <Text style={{ color: T.muted, fontSize: 12, backgroundColor: T.surface2, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 999, overflow: "hidden", textAlign: "center" }}>{m.text}</Text>
      </View>
    );
  }
  return (
    <Animated.View {...responder.panHandlers} style={{ transform: [{ translateX: pan }] }}>
      <TouchableOpacity activeOpacity={0.85} onLongPress={onLongPress} onPress={onPress} delayLongPress={350}
        style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "84%", marginVertical: 2 }}>
        <View style={{
          backgroundColor: mine ? T.inverse : T.bubbleIn,
          borderRadius: 18, borderBottomRightRadius: mine ? 6 : 18, borderBottomLeftRadius: mine ? 18 : 6,
          paddingHorizontal: 12, paddingVertical: 8,
        }}>
          {group && !mine && <Text style={{ color: T.muted, fontSize: 12.5, fontWeight: "700", marginBottom: 2 }}>{m.senderName}</Text>}
          {m.forwardedFrom && <Text style={{ color: mine ? T.onInverse : T.muted, fontSize: 12.5, fontStyle: "italic", marginBottom: 2 }}>Переслано от {m.forwardedFrom}</Text>}
          {m.replyTo && (
            <TouchableOpacity onPress={onQuotePress} style={{ borderLeftWidth: 2, borderLeftColor: mine ? T.onInverse : T.muted, paddingLeft: 8, marginBottom: 4, opacity: 0.8 }}>
              <Text style={{ color: mine ? T.onInverse : T.text, fontSize: 12.5, fontWeight: "700" }}>{m.replyTo.sender}</Text>
              <Text numberOfLines={1} style={{ color: mine ? T.onInverse : T.muted, fontSize: 12.5 }}>{m.replyTo.text}</Text>
            </TouchableOpacity>
          )}
          {m.viewOnce && !mine && !(m.viewedBy || {})[meUid] ? (
            <TouchableOpacity onPress={() => onReveal && onReveal(m)}
              style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, minWidth: 180 }}>
              <Text style={{ fontSize: 18 }}>👁</Text>
              <Text style={{ color: mine ? T.onInverse : T.text, fontSize: 14 }}>Одноразовое — нажмите, чтобы открыть</Text>
            </TouchableOpacity>
          ) : (<>
          {m.image && (
            <TouchableOpacity onPress={onPhoto}>
              <Image source={{ uri: m.image }} style={{ width: 220, height: 220, borderRadius: 12, marginBottom: m.text ? 6 : 0 }} resizeMode="cover" />
            </TouchableOpacity>
          )}
          {m.sticker && <Image source={{ uri: `${SITE}/stickers/${m.sticker}.png` }} style={{ width: 140, height: 140 }} />}
          {m.preview && (
            <TouchableOpacity onPress={() => Linking.openURL(m.preview.url)} style={{ marginTop: 6, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: mine ? T.onInverse + "44" : T.muted + "44", backgroundColor: mine ? T.inverse : T.bubbleIn, alignSelf: "flex-start", maxWidth: 230 }}>
              {!!m.preview.image && <Image source={{ uri: m.preview.image }} style={{ width: 230, height: 120 }} resizeMode="cover" />}
              <View style={{ padding: 8 }}>
                <Text numberOfLines={2} style={{ color: mine ? T.onInverse : T.text, fontWeight: "700", fontSize: 13 }}>{m.preview.title || m.preview.url}</Text>
                {!!m.preview.desc && <Text numberOfLines={2} style={{ color: mine ? T.onInverse : T.muted, fontSize: 12, marginTop: 2 }}>{m.preview.desc}</Text>}
              </View>
            </TouchableOpacity>
          )}
          {m.poll && (
            <View style={{ minWidth: 220, marginVertical: 4 }}>
              <Text style={{ color: mine ? T.onInverse : T.text, fontWeight: "700", marginBottom: 8 }}>📊 {m.poll.question}</Text>
              {(m.poll.options || []).map(o => {
                const votes = m.poll.votes || {};
                const total = Object.keys(votes).length;
                const cnt = Object.values(votes).filter(x => x === o.id).length;
                const pct = total ? Math.round(cnt / total * 100) : 0;
                const my = votes && Object.entries(votes).some(([u, x]) => x === o.id && u === meUid);
                return (
                  <TouchableOpacity key={o.id} onPress={() => onVote && onVote(m, o.id)}
                    style={{ borderWidth: 1, borderColor: mine ? T.onInverse : T.outline, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 11, marginBottom: 6, overflow: "hidden" }}>
                    <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, backgroundColor: mine ? T.onInverse : T.text, opacity: 0.12 }} />
                    <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                      <Text style={{ color: mine ? T.onInverse : T.text, fontSize: 13.5, flex: 1 }}>{o.text}</Text>
                      {total > 0 && <Text style={{ color: mine ? T.onInverse : T.text, fontSize: 12, fontWeight: "700", marginLeft: 8 }}>{pct}%</Text>}
                    </View>
                  </TouchableOpacity>
                );
              })}
              <Text style={{ color: mine ? T.onInverse : T.muted, fontSize: 11, opacity: 0.7 }}>
                {Object.keys(m.poll.votes || {}).length ? `Голосов: ${Object.keys(m.poll.votes).length}` : "Будьте первым — голосуйте!"}
              </Text>
            </View>
          )}
          {m.voice && <VoiceBubble T={T} m={m} mine={mine} />}
          {m.media && <MediaBubble T={T} m={m} mine={mine} onPhoto={onPhoto} />}
          {m.game && <TttBubble T={T} m={m} mine={mine} meUid={meUid} onMove={onGameMove} />}
          {m.dice && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}>
              <Text style={{ fontSize: 26 }}>🎲</Text>
              <Text style={{ color: mine ? T.onInverse : T.text, fontSize: 24, fontWeight: "800" }}>{m.dice.value}</Text>
              <Text style={{ color: mine ? T.onInverse : T.muted, fontSize: 12, opacity: 0.75 }}>из {m.dice.sides}</Text>
            </View>
          )}
          </>)}
          {!!bodyText && !(m.viewOnce && !mine && !(m.viewedBy || {})[meUid]) && (
            <MentionText text={bodyText} onMention={onMention} onInvite={onInvite} T={T}
              style={{ color: mine ? T.onInverse : T.text, fontSize: 15.5 }}
              mentionStyle={{ fontWeight: "700", textDecorationLine: "underline" }}
              linkStyle={{ color: mine ? T.onInverse : T.inverse, textDecorationLine: "underline", fontWeight: "600" }} />
          )}
          <View style={{ flexDirection: "row", alignSelf: "flex-end", alignItems: "center", gap: 4, marginTop: 2 }}>
            {!!m.editedAt && <Text style={{ color: mine ? T.onInverse : T.muted, fontSize: 10.5, opacity: 0.7 }}>изм.</Text>}
            <Text style={{ color: mine ? T.onInverse : T.muted, fontSize: 10.5, opacity: 0.7 }}>{fmtTime(m.createdAt)}</Text>
            {mine && !saved && <Text style={{ color: T.onInverse, fontSize: 11, opacity: read ? 1 : 0.55 }}>{read ? "✓✓" : "✓"}</Text>}
          </View>
          {Object.keys(m.reactions || {}).some(k => m.reactions[k].length > 0) && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
              {Object.entries(m.reactions).filter(([, us]) => us.length).map(([e, us]) => (
                <View key={e} style={{ backgroundColor: mine ? "#00000022" : T.surface2, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}>
                  <Text style={{ fontSize: 12, color: mine ? T.onInverse : T.text }}>{e} {us.length}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

// ================================================================ ЭКРАН ЗВОНКА (WebRTC)
function CallScreen({ T, me, call, onEnd }) {
  const [status, setStatus] = useState(call.isCaller ? "Вызов…" : "Соединение…");
  const [localUrl, setLocalUrl] = useState(null);
  const [remoteUrl, setRemoteUrl] = useState(null);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const startTs = useRef(0);
  const path = `calls/${call.calleeUid}/${call.callId}`;

  useEffect(() => {
    let unsubs = [];
    let alive = true;
    let ringTimer = null;
    (async () => {
      try {
        const stream = await mediaDevices.getUserMedia({ audio: true, video: call.video });
        if (!alive) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (call.video) setLocalUrl(stream.toURL());
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        pcRef.current = pc;
        stream.getTracks().forEach(t => pc.addTrack(t, stream));
        pc.ontrack = (e) => {
          if (e.streams && e.streams[0]) {
            setRemoteUrl(e.streams[0].toURL());
            if (!startTs.current) {
              clearTimeout(ringTimer);
              startTs.current = Date.now();
              timerRef.current = setInterval(() => {
                const sec = Math.floor((Date.now() - startTs.current) / 1000);
                setStatus(`${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`);
              }, 1000);
            }
          }
        };
        if (call.isCaller) {
          pc.onicecandidate = (e) => { if (e.candidate) dbPush(dbRef(rtdb, `${path}/iceFrom`), JSON.stringify(e.candidate)).catch(() => { }); };
          const offer = await pc.createOffer({});
          await pc.setLocalDescription(offer);
          await dbSet(dbRef(rtdb, path), {
            from: me.uid, fromName: me.displayName || me.username, fromAvatar: me.avatar || null, fromColor: me.avatarColor ?? 0,
            video: call.video, offer: JSON.stringify(offer), status: "ringing", createdAt: Date.now(),
          });
          unsubs.push(onValue(dbRef(rtdb, `${path}/answer`), async (snap) => {
            const val = snap.val();
            if (val && pcRef.current && !pcRef.current.remoteDescription) {
              try { await pcRef.current.setRemoteDescription(JSON.parse(val)); } catch { }
            }
          }));
          unsubs.push(onChildAdded(dbRef(rtdb, `${path}/iceTo`), (snap) => {
            try { pcRef.current?.addIceCandidate(JSON.parse(snap.val())); } catch { }
          }));
          // нет ответа за 45 секунд — сами кладём трубку
          ringTimer = setTimeout(() => { if (alive && !startTs.current) { setStatus("Нет ответа"); hangup(true); } }, 45000);
        } else {
          pc.onicecandidate = (e) => { if (e.candidate) dbPush(dbRef(rtdb, `${path}/iceTo`), JSON.stringify(e.candidate)).catch(() => { }); };
          await pc.setRemoteDescription(JSON.parse(call.offer));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await dbUpdate(dbRef(rtdb, path), { answer: JSON.stringify(answer), status: "accepted" });
          unsubs.push(onChildAdded(dbRef(rtdb, `${path}/iceFrom`), (snap) => {
            try { pcRef.current?.addIceCandidate(JSON.parse(snap.val())); } catch { }
          }));
        }
        unsubs.push(onValue(dbRef(rtdb, `${path}/status`), (snap) => {
          const st = snap.val();
          if (st === "declined") { setStatus("Отклонён"); setTimeout(hangup, 800); }
          if (st === "ended") hangup(false);
        }));
      } catch (e) {
        Alert.alert("Ошибка звонка", ruError(e));
        hangup(true);
      }
    })();
    return () => {
      alive = false;
      clearTimeout(ringTimer);
      unsubs.forEach(u => { try { u(); } catch { } });
    };
  }, []);

  const hangup = (signal = true) => {
    if (signal) dbUpdate(dbRef(rtdb, path), { status: "ended" }).catch(() => { });
    setTimeout(() => dbRemove(dbRef(rtdb, path)).catch(() => { }), 3000);
    try { pcRef.current?.close(); } catch { }
    streamRef.current?.getTracks().forEach(t => t.stop());
    clearInterval(timerRef.current);
    onEnd();
  };

  const toggleMute = () => {
    const t = streamRef.current?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setMuted(!t.enabled);
  };
  const toggleCam = () => {
    const t = streamRef.current?.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setCamOff(!t.enabled);
  };

  return (
    <Modal animationType="slide" onRequestClose={() => hangup(true)}>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {remoteUrl && call.video
          ? <RTCView streamURL={remoteUrl} style={{ flex: 1 }} objectFit="cover" />
          : (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
              <Avatar T={T} label={(call.peerName || "?")[0].toUpperCase()} color={call.peerColor} photo={call.peerAvatar} size={110} />
            </View>
          )}
        {localUrl && call.video && (
          <RTCView streamURL={localUrl} style={{ position: "absolute", top: 50, right: 16, width: 110, height: 160, borderRadius: 14 }} objectFit="cover" zOrder={1} />
        )}
        <View style={{ position: "absolute", top: 56, left: 0, right: 0, alignItems: "center" }}>
          <Text style={{ color: "#fff", fontSize: 22, fontWeight: "800" }}>{call.peerName}</Text>
          <Text style={{ color: "#ffffff99", marginTop: 4 }}>{status}</Text>
        </View>
        <View style={{ position: "absolute", bottom: 54, left: 0, right: 0, flexDirection: "row", justifyContent: "center", gap: 22 }}>
          <TouchableOpacity onPress={toggleMute} style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: muted ? "#ffffff10" : "#ffffff22", alignItems: "center", justifyContent: "center" }}>
            <MaterialIcons name={muted ? "mic-off" : "mic"} size={24} color="#fff" />
          </TouchableOpacity>
          {call.video && (
            <TouchableOpacity onPress={toggleCam} style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: camOff ? "#ffffff10" : "#ffffff22", alignItems: "center", justifyContent: "center" }}>
              <MaterialIcons name={camOff ? "videocam-off" : "videocam"} size={24} color="#fff" />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => hangup(true)} style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: "#d23b3b", alignItems: "center", justifyContent: "center" }}>
            <MaterialIcons name="call-end" size={26} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ---------- проигрыватель голосовых (expo-audio) ----------
function VoiceBubble({ T, m, mine }) {
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef(null);
  useEffect(() => () => { try { playerRef.current?.remove(); } catch { } }, []);
  const toggle = async () => {
    try {
      if (playerRef.current) {
        try { playerRef.current.remove(); } catch { }
        playerRef.current = null; setPlaying(false);
        return;
      }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      const player = createAudioPlayer({ uri: m.voice.data });
      playerRef.current = player;
      player.addListener("playbackStatusUpdate", (s) => {
        if (s.didJustFinish) { try { player.remove(); } catch { } playerRef.current = null; setPlaying(false); }
      });
      player.play();
      setPlaying(true);
    } catch { setPlaying(false); }
  };
  return (
    <TouchableOpacity onPress={toggle} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, minWidth: 160 }}>
      <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: mine ? T.onInverse : T.inverse, alignItems: "center", justifyContent: "center" }}>
        <MaterialIcons name={playing ? "pause" : "play-arrow"} size={20} color={mine ? T.inverse : T.onInverse} />
      </View>
      <View>
        <Text style={{ color: mine ? T.onInverse : T.text, fontWeight: "700", fontSize: 13.5 }}>Голосовое</Text>
        <Text style={{ color: mine ? T.onInverse : T.muted, fontSize: 12, opacity: 0.8 }}>{m.voice.duration || 0} сек</Text>
      </View>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  input: { alignSelf: "stretch", borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12, fontSize: 16, marginBottom: 10 },
  row: { paddingVertical: 13, paddingHorizontal: 6 },
});
