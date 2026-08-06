// Интеграционный тест против эмуляторов: повторяет операции клиента + проверяет правила
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword, signInWithEmailAndPassword } from "firebase/auth";
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, runTransaction, arrayUnion, arrayRemove, increment, writeBatch, deleteField,
} from "firebase/firestore";

const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "OK " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
const expectDenied = async (name, fn) => {
  try { await fn(); check(name, false, "операция ПРОШЛА, а должна быть запрещена"); }
  catch (e) { check(name, /permission|insufficient|denied/i.test(e.message) || e.code === "permission-denied", e.code || e.message.slice(0, 60)); }
};

// Каждый пользователь — своё приложение (свой auth-контекст)
function makeClient(tag) {
  const app = initializeApp({ apiKey: "demo", authDomain: "demo-sandygram.firebaseapp.com", projectId: "demo-sandygram" }, tag);
  const auth = getAuth(app);
  const db = getFirestore(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8090);
  return { auth, db };
}
const emailFor = (u) => `${u}@sandygram.app`;
async function register(client, username) {
  const cred = await createUserWithEmailAndPassword(client.auth, emailFor(username), "test123");
  const uid = cred.user.uid;
  await setDoc(doc(client.db, "usernames", username), { uid, email: emailFor(username) });
  await setDoc(doc(client.db, "users", uid), { username, displayName: username, bio: "", avatarColor: 1, createdAt: Date.now(), lastSeen: Date.now() });
  await setDoc(doc(client.db, "chats", `saved_${uid}`), { type: "saved", members: [uid], createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] });
  return uid;
}

const owner = makeClient("owner"), admin = makeClient("admin"), member = makeClient("member"), guest = makeClient("guest");
const uidOwner = await register(owner, "fowner");
const uidAdmin = await register(admin, "fadmin");
const uidMember = await register(member, "fmember");
const uidGuest = await register(guest, "fguest");
check("register x4", true);

// Группа
const gid = "grp_test123456";
await setDoc(doc(owner.db, "chats", gid), {
  type: "group", title: "FireGrp", members: [uidOwner, uidAdmin, uidMember],
  ownerUid: uidOwner, admins: [], avatarColor: 2, createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [],
});
check("create group", true);

// Не-участник не может читать чат
await expectDenied("guest cannot read group", () => getDoc(doc(guest.db, "chats", gid)));

// Сообщение от участника
const msgRef = doc(collection(member.db, "chats", gid, "messages"));
const batch = writeBatch(member.db);
batch.set(msgRef, { sender: uidMember, senderName: "fmember", text: "привет", image: null, createdAt: Date.now(), reactions: {}, topicId: "general" });
batch.update(doc(member.db, "chats", gid), { lastMessage: { text: "привет", senderUid: uidMember, senderName: "fmember", createdAt: Date.now(), hasImage: false }, [`unread.${uidOwner}`]: increment(1), [`unread.${uidAdmin}`]: increment(1) });
await batch.commit();
check("member sends message (batch)", true);

// Не-участник не может писать
await expectDenied("guest cannot send message", () =>
  setDoc(doc(collection(guest.db, "chats", gid, "messages")), { sender: uidGuest, senderName: "fguest", text: "hack", createdAt: Date.now(), reactions: {}, topicId: "general" }));

// Подмена отправителя запрещена
await expectDenied("sender spoofing denied", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), { sender: uidOwner, senderName: "fake", text: "spoof", createdAt: Date.now(), reactions: {}, topicId: "general" }));

// Назначение админа
await updateDoc(doc(owner.db, "chats", gid), { admins: arrayUnion(uidAdmin) });
check("owner promotes admin", true);

// Реакция чужого участника на сообщение (только reactions — разрешено)
await updateDoc(doc(admin.db, "chats", gid, "messages", msgRef.id), { [`reactions.❤️`]: arrayUnion(uidAdmin) });
check("reaction by non-author allowed", true);

// Чужой участник не может править текст чужого сообщения
await expectDenied("non-author cannot edit text", async () => {
  // fguest не участник — возьмём другого участника без прав: создадим сообщение от owner и попробуем править member-ом
  const ref2 = doc(collection(owner.db, "chats", gid, "messages"));
  await setDoc(ref2, { sender: uidOwner, senderName: "fowner", text: "оригинал", createdAt: Date.now(), reactions: {}, topicId: "general" });
  await updateDoc(doc(member.db, "chats", gid, "messages", ref2.id), { text: "взломано", editedAt: Date.now() });
});

// Админ удаляет чужое сообщение (soft delete)
await updateDoc(doc(admin.db, "chats", gid, "messages", msgRef.id), { deleted: true, text: "", image: null, reactions: {} });
check("admin soft-deletes others' message", true);

// Топики: создать, закрыть
await updateDoc(doc(owner.db, "chats", gid), { topics: arrayUnion({ id: "top_abc", title: "Новости", icon: "📰", creatorUid: uidOwner, createdAt: Date.now(), closed: false }) });
const chatSnap = await getDoc(doc(owner.db, "chats", gid));
const topics = chatSnap.data().topics.map(t => t.id === "top_abc" ? { ...t, closed: true } : t);
await updateDoc(doc(owner.db, "chats", gid), { topics });
check("topic created and closed", (await getDoc(doc(member.db, "chats", gid))).data().topics[0].closed === true);

// Инвайт: создание карточки + вступление не-участника (добавляет ТОЛЬКО себя)
const code = "aabbccddeeff0011";
await setDoc(doc(owner.db, "invites", code), { chatId: gid, title: "FireGrp", memberCount: 3, avatarColor: 2 });
await updateDoc(doc(owner.db, "chats", gid), { inviteCode: code });
check("invite card created", true);
const inv = await getDoc(doc(guest.db, "invites", code));
check("guest reads invite card", inv.exists() && inv.data().chatId === gid);
await updateDoc(doc(guest.db, "chats", gid), { members: arrayUnion(uidGuest) });
check("guest joins via invite (self-add)", true);
const afterJoin = await getDoc(doc(guest.db, "chats", gid));
check("guest now member", afterJoin.data().members.includes(uidGuest));

// Не-участник НЕ может добавить себя + ещё кого-то / изменить другие поля
const guest2 = makeClient("guest2");
const uidGuest2 = await register(guest2, "fguest2");
await expectDenied("outsider cannot add self+other", () =>
  updateDoc(doc(guest2.db, "chats", gid), { members: arrayUnion(uidGuest2, "someone_else") }));
await expectDenied("outsider cannot change title while joining", () =>
  updateDoc(doc(guest2.db, "chats", gid), { members: arrayUnion(uidGuest2), title: "HACKED" }));

// Кик: админ исключает участника
await updateDoc(doc(admin.db, "chats", gid), { members: arrayRemove(uidGuest), admins: arrayRemove(uidGuest) });
check("admin kicks member", !(await getDoc(doc(owner.db, "chats", gid))).data().members.includes(uidGuest));

// Смена username транзакцией
await runTransaction(member.db, async (tx) => {
  const takenDoc = await tx.get(doc(member.db, "usernames", "fmember_new"));
  if (takenDoc.exists()) throw new Error("занят");
  const oldReg = await tx.get(doc(member.db, "usernames", "fmember"));
  tx.set(doc(member.db, "usernames", "fmember_new"), { uid: uidMember, email: oldReg.data().email });
  tx.delete(doc(member.db, "usernames", "fmember"));
  tx.update(doc(member.db, "users", uidMember), { username: "fmember_new" });
});
check("username rename tx", (await getDoc(doc(member.db, "users", uidMember))).data().username === "fmember_new");
// Вход по новому username (lookup без авторизации)
const freshClient = makeClient("fresh");
const reg = await getDoc(doc(freshClient.db, "usernames", "fmember_new"));
await signInWithEmailAndPassword(freshClient.auth, reg.data().email, "test123");
check("login by new username", true);

// Чужой username занять нельзя
await expectDenied("cannot claim someone's username entry", () =>
  setDoc(doc(guest.db, "usernames", "stolen"), { uid: uidOwner, email: "x@sandygram.app" }));

// ЛС + дедупликация id
const dmId = `dm_${[uidOwner, uidAdmin].sort().join("_")}`;
await setDoc(doc(owner.db, "chats", dmId), { type: "private", members: [uidOwner, uidAdmin].sort(), createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] });
check("dm created deterministic id", (await getDoc(doc(admin.db, "chats", dmId))).exists());

// Список чатов участника
const myChats = await getDocs(query(collection(owner.db, "chats"), where("members", "array-contains", uidOwner)));
check("chat list query", myChats.docs.length >= 3, `${myChats.docs.length} чатов`);

// Поиск людей по префиксу
const found = await getDocs(query(collection(owner.db, "users"), where("username", ">=", "fgue"), where("username", "<=", "fgue"), limit(20)));
check("prefix user search", found.docs.length === 2, found.docs.map(d => d.data().username).join(","));

console.log(results.join("\n"));
console.log(results.some(r => r.startsWith("FAIL")) ? "\n=== ЕСТЬ ОШИБКИ ===" : "\n=== ВСЕ ТЕСТЫ ПРОШЛИ ===");
process.exit(0);
