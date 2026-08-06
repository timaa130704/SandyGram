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
import * as Clipboard from "expo-clipboard";
import { useAudioRecorder, RecordingPresets, AudioModule, setAudioModeAsync, createAudioPlayer } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { auth, db } from "./fire";
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
    text: "#f2f2f2", muted: "#8f8f8f", inverse: "#f5f5f5", onInverse: "#0d0d0d",
    bubbleIn: "#1f1f1f", danger: "#ff6b6b",
  },
  light: {
    bg: "#f4f4f4", surface: "#ffffff", surface2: "#ececec", outline: "#d4d4d4",
    text: "#111", muted: "#737373", inverse: "#171717", onInverse: "#fafafa",
    bubbleIn: "#ffffff", danger: "#c92a2a",
  },
};
const AVATAR_TONES = ["#2b2b2b", "#3a3a3a", "#4a4a4a", "#5a5a5a", "#6b6b6b", "#7d7d7d", "#909090"];
const ONLINE_WINDOW = 70e3;
const QUICK_REACTIONS = ["❤️", "👍", "🔥", "😂", "😮", "😢"];
const SITE = "https://sandygram-a3b42.web.app";
const APP_VERSION = "1.2.1";
const APK_URL = "https://github.com/timaa130704/SandyGram/releases/latest/download/SandyGram.apk";
// Коды стикеров OpenMoji — картинки лежат на хостинге сайта
const STICKERS = ["1F600","1F602","1F60D","1F60E","1F914","1F644","1F62D","1F621","1F973","1F97A","1F480","1F4A9","1F525","2764","1F44D","1F44E","1F44C","1F64F","1F4AA","1F440","1F389","1F680","26A1","1F31A","1F31D","1F63B","1F63C","1F998","1F984","1F37F"];

const emailFor = (u) => `${u}@sandygram.app`;
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
      : <Text style={{ color: color === -1 ? T.onInverse : "#f5f5f5", fontSize: size * 0.4, fontWeight: "700" }}>{label}</Text>}
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

// Текст с кликабельными @упоминаниями
function MentionText({ text, style, mentionStyle, onMention }) {
  const nodes = [];
  const re = /(^|[\s.,:;!?()«»"'-])@([a-z0-9_]{3,24})\b/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length;
    if (start > last) nodes.push(text.slice(last, start));
    const name = m[2].toLowerCase();
    nodes.push(
      <Text key={`m${start}`} style={mentionStyle} onPress={() => onMention(name)}>@{m[2]}</Text>
    );
    last = start + m[2].length + 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <Text style={style}>{nodes}</Text>;
}

// ================================================================
export default function Root() {
  return (
    <SafeAreaProvider>
      <SandyGram />
    </SafeAreaProvider>
  );
}

function SandyGram() {
  const [themeName, setThemeName] = useState("dark");
  const T = THEMES[themeName];
  const [booted, setBooted] = useState(false);
  const [me, setMe] = useState(null);
  const [chats, setChats] = useState(new Map());
  const [users, setUsers] = useState(new Map());
  const [screen, setScreen] = useState({ name: "list" });
  const [pendingInvite, setPendingInvite] = useState(null);
  const [myPrefs, setMyPrefs] = useState({ blocked: [], hideLastSeen: false });
  const [needName, setNeedName] = useState(null); // {uid, email, displayName, photoURL}

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
    if (!user) { setMe(null); setNeedName(null); setChats(new Map()); setBooted(true); return; }
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
    if (profile) { setNeedName(null); setMe(profile); }
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

  // ---- приватные настройки (чёрный список) ----
  useEffect(() => {
    if (!me?.uid) return;
    getDoc(doc(db, "users", me.uid, "private", "prefs")).then(p => {
      if (p.exists()) setMyPrefs({ blocked: [], hideLastSeen: false, ...p.data() });
      else setMyPrefs({ blocked: [], hideLastSeen: false });
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
    } else { v.title = chat.title; v.avatarColor = chat.avatarColor || 0; }
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
      setUsers(prev => new Map(prev).set(user.uid, user));
      setScreen({ name: "chat", chatId });
    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  }, [me]);
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

  const ctx = { T, me, setMe, chats, users, viewOf, fetchUser, screen, setScreen, themeName, toggleTheme, openDmWith, openDmByName, joinByCode, myPrefs, setMyPrefs };
  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      <StatusBar style={themeName === "dark" ? "light" : "dark"} />
      {needName ? <PickNameScreen ctx={ctx} pending={needName} onDone={(p) => { setNeedName(null); setMe(p); }} />
        : !me ? <AuthScreen ctx={ctx} />
          : screen.name === "chat" ? <ChatScreen key={screen.chatId} ctx={ctx} chatId={screen.chatId} />
            : <ListScreen ctx={ctx} />}
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
  const { T, me, chats, viewOf, setScreen } = ctx;
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
    : views;

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
        <TouchableOpacity onPress={() => setSettingsOpen(true)}><Text style={{ color: T.text, fontSize: 22 }}>☰</Text></TouchableOpacity>
        <TextInput value={search} onChangeText={setSearch} placeholder="Поиск" placeholderTextColor={T.muted} autoCapitalize="none"
          style={{ flex: 1, backgroundColor: T.surface2, color: T.text, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 8, fontSize: 15 }} />
        {!!search && <TouchableOpacity onPress={() => setSearch("")}><Text style={{ color: T.muted, fontSize: 18 }}>✕</Text></TouchableOpacity>}
      </View>
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
        <Text style={{ color: T.onInverse, fontSize: 24 }}>✎</Text>
      </TouchableOpacity>
      {settingsOpen && <SettingsSheet ctx={ctx} onClose={() => setSettingsOpen(false)} />}
      {newChatOpen && <NewChatSheet ctx={ctx} onClose={() => setNewChatOpen(false)} />}
      {menuChat && <ActionSheet T={T} items={chatMenuItems(menuChat)} onClose={() => setMenuChat(null)}
        header={<Text style={{ color: T.muted, fontWeight: "700", padding: 8 }}>{menuChat.title}</Text>} />}
    </SafeAreaView>
  );
}

// ================================================================ НАСТРОЙКИ
function SettingsSheet({ ctx, onClose }) {
  const { T, me, setMe, themeName, toggleTheme } = ctx;
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
  const { T, me, chats, viewOf, setScreen, openDmByName } = ctx;
  const chat = chats.get(chatId);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [topic, setTopic] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [editTarget, setEditTarget] = useState(null);
  const [menuMsg, setMenuMsg] = useState(null);
  const [forwardMsg, setForwardMsg] = useState(null);
  const [photoView, setPhotoView] = useState(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [topicMenu, setTopicMenu] = useState(null);
  const [topicModal, setTopicModal] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [stickerOpen, setStickerOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const recStartRef = useRef(0);
  const lastTyping = useRef(0);
  const listRef = useRef(null);
  const sendingRef = useRef(false); // защита от спама по кнопке отправки

  const isForum = !!(chat?.topics && chat.topics.length);
  const isAdmin = (chat?.type === "group" || chat?.type === "channel") && (chat.ownerUid === me.uid || (chat.admins || []).includes(me.uid));

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
    const q = query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "desc"), limit(300));
    const unsub = onSnapshot(q, (snap) => {
      setMessages(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, () => { });
    return unsub;
  }, [chatId]);

  const unreadCount = (chat?.unread || {})[me.uid] || 0;
  useEffect(() => {
    if (!chat) return;
    if (unreadCount && AppState.currentState === "active") {
      updateDoc(doc(db, "chats", chatId), { [`lastRead.${me.uid}`]: Date.now(), [`unread.${me.uid}`]: 0 }).catch(() => { });
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
  const canWrite = (chat.type !== "channel" || isAdmin) && (!isForum || (topic && (!currentClosed || isAdmin)));
  const pinnedMsg = chat.pinnedMessageId ? messages.find(m => m.id === chat.pinnedMessageId && !m.deleted) : null;

  const visible = messages.filter(m => !m.deleted && (!isForum || !topic || (m.topicId || "general") === topic.id));

  // ---------- операции ----------
  const sendTo = async (targetChat, { textBody = "", image = null, sticker = null, voice = null, forwardedFrom = null }) => {
    const msg = {
      sender: me.uid, senderName: me.displayName || me.username,
      text: textBody.slice(0, 4000), image, createdAt: Date.now(), reactions: {},
      topicId: (targetChat.id === chatId && isForum && topic) ? topic.id : "general",
    };
    if (sticker) msg.sticker = sticker;
    if (voice) msg.voice = voice;
    if (forwardedFrom) msg.forwardedFrom = forwardedFrom;
    if (!forwardedFrom && targetChat.id === chatId && replyTo) msg.replyTo = { id: replyTo.id, sender: replyTo.senderName, text: replyTo.text ? replyTo.text.slice(0, 120) : "📷 Фото" };
    const previewText = msg.text || (sticker ? "🧩 Стикер" : voice ? "🎤 Голосовое сообщение" : "");
    const patch = {
      lastMessage: { text: previewText, senderUid: me.uid, senderName: msg.senderName, createdAt: msg.createdAt, hasImage: !!image },
      [`lastRead.${me.uid}`]: msg.createdAt, [`unread.${me.uid}`]: 0, [`typing.${me.uid}`]: 0,
    };
    for (const m of targetChat.members) if (m !== me.uid) patch[`unread.${m}`] = increment(1);
    const batch = writeBatch(db);
    batch.set(doc(collection(db, "chats", targetChat.id, "messages")), msg);
    batch.update(doc(db, "chats", targetChat.id), patch);
    await batch.commit();
  };
  const submit = async () => {
    const body = text.trim();
    if (!body || sendingRef.current) return;
    sendingRef.current = true;
    setText(""); // очищаем сразу — повторный тап не отправит то же самое
    try {
      if (editTarget) {
        await updateDoc(doc(db, "chats", chatId, "messages", editTarget.id), { text: body.slice(0, 4000), editedAt: Date.now() });
        if (chat.lastMessage?.createdAt === editTarget.createdAt) await updateDoc(doc(db, "chats", chatId), { "lastMessage.text": body.slice(0, 4000) });
        setEditTarget(null);
      } else {
        await sendTo(chat, { textBody: body });
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      }
      setReplyTo(null);
    } catch (e) {
      setText(body); // вернуть текст при ошибке
      if ((e?.code || "").includes("permission-denied") && chat.type === "private") Alert.alert("", "Не отправлено: пользователь вас заблокировал");
      else Alert.alert("Ошибка", ruError(e));
    } finally { sendingRef.current = false; }
  };
  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.5, base64: true, allowsEditing: false });
    if (res.canceled || !res.assets?.[0]?.base64) return;
    const dataUrl = `data:image/jpeg;base64,${res.assets[0].base64}`;
    if (dataUrl.length > 900_000) return Alert.alert("Ошибка", "Фото слишком большое — выберите поменьше");
    try { await sendTo(chat, { image: dataUrl }); setReplyTo(null); } catch (e) { Alert.alert("Ошибка", ruError(e)); }
  };
  const onChangeText = (val) => {
    setText(val);
    const now = Date.now();
    if (now - lastTyping.current > 1800) {
      lastTyping.current = now;
      updateDoc(doc(db, "chats", chatId), { [`typing.${me.uid}`]: now }).catch(() => { });
    }
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
          <Text style={{ color: T.text, fontSize: 24 }}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setInfoOpen(true)} style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
          <Avatar T={T} label={chat.type === "saved" ? "☆" : (v.title || "?")[0].toUpperCase()} color={v.avatarColor} size={40} photo={v.photo} />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={{ color: T.text, fontWeight: "800", fontSize: 16 }}>{v.title}</Text>
            <Text numberOfLines={1} style={{ color: typing.length || isOnlineUser(v.peer) ? T.text : T.muted, fontSize: 12.5 }}>{subtitle}</Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => { setSearchOpen(x => !x); setSearchText(""); }} style={{ padding: 6 }}>
          <Text style={{ color: T.text, fontSize: 18 }}>⌕</Text>
        </TouchableOpacity>
      </View>

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
          <TouchableOpacity onPress={() => togglePin(pinnedMsg)}><Text style={{ color: T.muted, fontSize: 16 }}>✕</Text></TouchableOpacity>
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
              <MessageBubble T={T} m={item.m} mine={item.m.sender === me.uid}
                group={chat.type === "group"} lastReadByOthers={lastReadByOthers} saved={chat.type === "saved"}
                onLongPress={() => setMenuMsg(item.m)} onPhoto={() => setPhotoView(item.m.image)}
                onDoubleTap={() => toggleReaction(item.m, "❤️")}
                onSwipeReply={() => { setEditTarget(null); setReplyTo(item.m); }}
                onMention={openDmByName}
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
                <Text style={{ color: T.muted, fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
          )}
          {canWrite ? (
            <View style={{ flexDirection: "row", alignItems: "flex-end", padding: 8, gap: 4, backgroundColor: T.surface }}>
              <TouchableOpacity onPress={() => setStickerOpen(true)} style={{ padding: 10 }}><Text style={{ fontSize: 20 }}>🙂</Text></TouchableOpacity>
              <TouchableOpacity onPress={pickPhoto} style={{ padding: 10 }}><Text style={{ fontSize: 20 }}>📎</Text></TouchableOpacity>
              <TextInput value={text} onChangeText={onChangeText} placeholder={recording ? "Идёт запись…" : "Сообщение"} placeholderTextColor={recording ? T.danger : T.muted} multiline
                style={{ flex: 1, backgroundColor: T.surface2, color: T.text, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, maxHeight: 120, fontSize: 16 }} />
              <TouchableOpacity onPress={toggleRec} style={{ padding: 10 }}>
                <Text style={{ fontSize: 20 }}>{recording ? "⏹" : "🎤"}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={submit} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: T.inverse, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: T.onInverse, fontSize: 18 }}>{editTarget ? "✓" : "➤"}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ padding: 14, alignItems: "center", backgroundColor: T.surface }}>
              <Text style={{ color: T.muted }}>{chat.type === "channel" ? "📢 Писать в канал могут только админы" : "🔒 Топик закрыт — писать могут только админы"}</Text>
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

      {/* пересылка */}
      {forwardMsg && (
        <Modal transparent animationType="slide" onRequestClose={() => setForwardMsg(null)}>
          <TouchableOpacity activeOpacity={1} onPress={() => setForwardMsg(null)} style={{ flex: 1, backgroundColor: "#0008" }} />
          <View style={{ backgroundColor: T.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28, padding: 20, paddingBottom: 34, maxHeight: "70%" }}>
            <Text style={{ color: T.text, fontSize: 18, fontWeight: "800", marginBottom: 10 }}>Переслать в…</Text>
            <ScrollView>
              {[...chats.values()].map(viewOf).map(c => (
                <TouchableOpacity key={c.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8 }}
                  onPress={async () => {
                    const msg = forwardMsg; setForwardMsg(null);
                    try {
                      await sendTo(c.raw, { textBody: msg.text || "", image: msg.image || null, forwardedFrom: msg.senderName });
                    } catch (e) { Alert.alert("Ошибка", ruError(e)); }
                  }}>
                  <Avatar T={T} label={c.type === "saved" ? "☆" : (c.title || "?")[0].toUpperCase()} color={c.avatarColor} size={44} />
                  <Text style={{ color: T.text, fontWeight: "700" }}>{c.title}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
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
function MessageBubble({ T, m, mine, group, lastReadByOthers, saved, onLongPress, onPhoto, onDoubleTap, onSwipeReply, onMention, onQuotePress }) {
  const lastTap = useRef(0);
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
          {m.image && (
            <TouchableOpacity onPress={onPhoto}>
              <Image source={{ uri: m.image }} style={{ width: 220, height: 220, borderRadius: 12, marginBottom: m.text ? 6 : 0 }} resizeMode="cover" />
            </TouchableOpacity>
          )}
          {m.sticker && <Image source={{ uri: `${SITE}/stickers/${m.sticker}.png` }} style={{ width: 140, height: 140 }} />}
          {m.voice && <VoiceBubble T={T} m={m} mine={mine} />}
          {!!m.text && (
            <MentionText text={m.text} onMention={onMention}
              style={{ color: mine ? T.onInverse : T.text, fontSize: 15.5 }}
              mentionStyle={{ fontWeight: "700", textDecorationLine: "underline" }} />
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
        <Text style={{ color: mine ? T.inverse : T.onInverse, fontSize: 15 }}>{playing ? "⏸" : "▶"}</Text>
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
