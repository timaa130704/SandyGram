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

// --- Модерация: мут и бан теперь реально работают на стороне правил ---
const future = Date.now() + 3600e3;
await updateDoc(doc(owner.db, "chats", gid), { [`mutes.${uidMember}`]: future });
await expectDenied("muted member cannot send", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), { sender: uidMember, senderName: "fmember", text: "во время мута", createdAt: Date.now(), reactions: {}, topicId: "general" }));
await updateDoc(doc(owner.db, "chats", gid), { [`mutes.${uidMember}`]: 1000 }); // мут в прошлом = снят
await setDoc(doc(collection(member.db, "chats", gid, "messages")), { sender: uidMember, senderName: "fmember", text: "после мута", createdAt: Date.now(), reactions: {}, topicId: "general" });
check("member can send after mute expired", true);
await updateDoc(doc(owner.db, "chats", gid), { [`bans.${uidMember}`]: future });
await expectDenied("banned member cannot send", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), { sender: uidMember, senderName: "fmember", text: "во время бана", createdAt: Date.now(), reactions: {}, topicId: "general" }));
await updateDoc(doc(owner.db, "chats", gid), { [`bans.${uidMember}`]: deleteField() });

// --- Нельзя вписать себя в приватный чат (ЛС двух других) ---
await expectDenied("outsider cannot self-add to private DM", () =>
  updateDoc(doc(member.db, "chats", dmId), { members: arrayUnion(uidMember) }));

// --- Голосование в опросе: можно менять только голоса, не вопрос/варианты ---
const pollRef = doc(collection(owner.db, "chats", gid, "messages"));
await setDoc(pollRef, { sender: uidOwner, senderName: "fowner", text: "", createdAt: Date.now(), reactions: {}, topicId: "general",
  poll: { question: "Куда?", options: [{ id: "a", text: "Лес" }, { id: "b", text: "Море" }], votes: {} } });
await updateDoc(doc(member.db, "chats", gid, "messages", pollRef.id), { [`poll.votes.${uidMember}`]: "a" });
check("member votes in poll", true);
await expectDenied("member cannot tamper poll question", () =>
  updateDoc(doc(member.db, "chats", gid, "messages", pollRef.id), { "poll.question": "ВЗЛОМ" }));

// --- Просмотры историй: отмечать можно только свой uid ---
await setDoc(doc(owner.db, "stories", "story_test1"), { uid: uidOwner, image: "x", createdAt: Date.now(), expiresAt: Date.now() + 86400e3, views: {} });
await updateDoc(doc(member.db, "stories", "story_test1"), { [`views.${uidMember}`]: Date.now() });
check("member marks own story view", true);
await expectDenied("cannot forge another user's story view", () =>
  updateDoc(doc(guest2.db, "stories", "story_test1"), { [`views.${uidOwner}`]: Date.now() }));

// ============ 3.0: усиленные правила ============

// Затереть чужие просмотры истории (перезапись всей карты views) — нельзя
await updateDoc(doc(owner.db, "stories", "story_test1"), { [`views.${uidOwner}`]: Date.now() });
await expectDenied("cannot wipe others' story views", () =>
  updateDoc(doc(member.db, "stories", "story_test1"), { views: { [uidMember]: Date.now() } }));
// Реакция на историю — только своим ключом
await updateDoc(doc(member.db, "stories", "story_test1"), { [`reactions.${uidMember}`]: "🔥" });
check("story reaction by own key", true);
await expectDenied("cannot forge another user's story reaction", () =>
  updateDoc(doc(member.db, "stories", "story_test1"), { [`reactions.${uidOwner}`]: "💩" }));

// @-упоминания: только реальные участники (иначе push-worker разошлёт пуши кому угодно)
await setDoc(doc(collection(member.db, "chats", gid, "messages")), {
  sender: uidMember, senderName: "fmember_new", text: "@fowner привет", createdAt: Date.now(),
  reactions: {}, topicId: "general", mentions: [uidOwner] });
check("mention of real member allowed", true);
await expectDenied("mention of non-member denied", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), {
    sender: uidMember, senderName: "fmember_new", text: "спам", createdAt: Date.now(),
    reactions: {}, topicId: "general", mentions: [uidGuest2] }));
await expectDenied("mention flood (>20) denied", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), {
    sender: uidMember, senderName: "fmember_new", text: "спам", createdAt: Date.now(),
    reactions: {}, topicId: "general", mentions: Array.from({ length: 21 }, () => uidOwner) }));

// Подделка времени и гигантский текст
await expectDenied("createdAt far in future denied", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), {
    sender: uidMember, senderName: "fmember_new", text: "прилипну к низу", createdAt: Date.now() + 30 * 86400e3,
    reactions: {}, topicId: "general" }));
await expectDenied("oversized text denied", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), {
    sender: uidMember, senderName: "fmember_new", text: "x".repeat(5000), createdAt: Date.now(),
    reactions: {}, topicId: "general" }));

// Автор не может переписать время своего сообщения
const mineRef = doc(collection(member.db, "chats", gid, "messages"));
await setDoc(mineRef, { sender: uidMember, senderName: "fmember_new", text: "моё", createdAt: Date.now(), reactions: {}, topicId: "general" });
await updateDoc(doc(member.db, "chats", gid, "messages", mineRef.id), { text: "правка", editedAt: Date.now() });
check("author edits own text", true);
await expectDenied("author cannot rewrite createdAt", () =>
  updateDoc(doc(member.db, "chats", gid, "messages", mineRef.id), { createdAt: Date.now() + 86400e3 }));

// Опрос: чужой голос не переписать (fmember — обычный участник, не админ)
await updateDoc(doc(admin.db, "chats", gid, "messages", pollRef.id), { [`poll.votes.${uidAdmin}`]: "b" });
check("admin votes own key in poll", true);
await expectDenied("cannot overwrite another user's poll vote", () =>
  updateDoc(doc(member.db, "chats", gid, "messages", pollRef.id), { [`poll.votes.${uidAdmin}`]: "a" }));

// Реакции: массовое затирание чужих реакций одним апдейтом запрещено
const reactRef = doc(collection(owner.db, "chats", gid, "messages"));
await setDoc(reactRef, { sender: uidOwner, senderName: "fowner", text: "реакции", createdAt: Date.now(),
  reactions: { "❤️": [uidOwner], "🔥": [uidOwner], "👍": [uidOwner] }, topicId: "general" });
await expectDenied("cannot wipe all reactions", () =>
  updateDoc(doc(member.db, "chats", gid, "messages", reactRef.id), { reactions: {} }));
await updateDoc(doc(member.db, "chats", gid, "messages", reactRef.id), { ["reactions.❤️"]: arrayUnion(uidMember) });
check("single reaction toggle still allowed", true);

// Отложенная отправка: своё видно, чужое — нет
await setDoc(doc(member.db, "scheduled", "job_test1"), {
  uid: uidMember, chatId: gid, text: "по расписанию", sendAt: Date.now() + 3600e3, createdAt: Date.now() });
check("scheduled job created", (await getDoc(doc(member.db, "scheduled", "job_test1"))).exists());
await expectDenied("cannot read someone else's scheduled job", () =>
  getDoc(doc(guest2.db, "scheduled", "job_test1")));
await expectDenied("cannot create scheduled job for another uid", () =>
  setDoc(doc(guest2.db, "scheduled", "job_test2"), {
    uid: uidMember, chatId: gid, text: "чужое", sendAt: Date.now() + 1000, createdAt: Date.now() }));

// Исчезающие сообщения: таймер в ЛС ставит участник, в группе — только админ
await updateDoc(doc(owner.db, "chats", dmId), { ttl: 3600e3 });
check("dm member sets disappearing ttl", (await getDoc(doc(admin.db, "chats", dmId))).data().ttl === 3600e3);
await expectDenied("non-admin cannot set group ttl", () =>
  updateDoc(doc(member.db, "chats", gid), { ttl: 1000 }));
await updateDoc(doc(owner.db, "chats", gid), { ttl: 86400e3 });
check("group admin sets ttl", true);

// Медиа: ссылка обязана указывать на наш воркер, размер — в пределах лимита
const R2 = "https://sandygram-push.sandygram.workers.dev/media/abc123.jpg";
await setDoc(doc(collection(member.db, "chats", gid, "messages")), {
  sender: uidMember, senderName: "fmember_new", createdAt: Date.now(), reactions: {}, topicId: "general",
  media: { key: "abc123.jpg", url: R2, type: "image/jpeg", size: 1234, name: "photo.jpg", kind: "image" } });
check("r2 media message allowed", true);
await expectDenied("foreign media url denied", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), {
    sender: uidMember, senderName: "fmember_new", createdAt: Date.now(), reactions: {}, topicId: "general",
    media: { key: "x", url: "https://evil.example.com/track.gif", type: "image/gif", size: 10, kind: "image" } }));
await expectDenied("oversized media denied", () =>
  setDoc(doc(collection(member.db, "chats", gid, "messages")), {
    sender: uidMember, senderName: "fmember_new", createdAt: Date.now(), reactions: {}, topicId: "general",
    media: { key: "big", url: R2, type: "video/mp4", size: 99 * 1024 * 1024, kind: "video" } }));

// Одноразовое: получатель ставит свою отметку, чужую — нет, содержимое не трогает
const vo = doc(collection(owner.db, "chats", gid, "messages"));
await setDoc(vo, { sender: uidOwner, senderName: "fowner", text: "секрет", createdAt: Date.now(),
  reactions: {}, topicId: "general", viewOnce: true, viewedBy: {} });
await updateDoc(doc(member.db, "chats", gid, "messages", vo.id), { [`viewedBy.${uidMember}`]: Date.now() });
check("view-once viewer marks own view", true);
await expectDenied("cannot forge another's view-once mark", () =>
  updateDoc(doc(guest2.db, "chats", gid, "messages", vo.id), { [`viewedBy.${uidMember}`]: 1 }));
await expectDenied("view-once mark cannot change text", () =>
  updateDoc(doc(member.db, "chats", gid, "messages", vo.id), { text: "подмена", [`viewedBy.${uidMember}`]: Date.now() }));

// Игра: ход только в свою очередь и только своим участникам
const gm = doc(collection(owner.db, "chats", gid, "messages"));
await setDoc(gm, { sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
  game: { kind: "ttt", players: [uidOwner, uidMember], board: "---------", turn: uidMember, winner: null } });
await updateDoc(doc(member.db, "chats", gid, "messages", gm.id), {
  game: { kind: "ttt", players: [uidOwner, uidMember], board: "O--------", turn: uidOwner, winner: null } });
check("game move on own turn allowed", true);
await expectDenied("game move out of turn denied", () =>
  updateDoc(doc(member.db, "chats", gid, "messages", gm.id), {
    game: { kind: "ttt", players: [uidOwner, uidMember], board: "OO-------", turn: uidOwner, winner: null } }));
await expectDenied("outsider cannot move in game", () =>
  updateDoc(doc(guest2.db, "chats", gid, "messages", gm.id), {
    game: { kind: "ttt", players: [uidOwner, uidMember], board: "X--------", turn: uidMember, winner: null } }));

// Секретные чаты: конверты enc только для участников чата
await updateDoc(doc(owner.db, "chats", dmId), { e2e: true });
check("dm member turns on e2e", (await getDoc(doc(admin.db, "chats", dmId))).data().e2e === true);
await setDoc(doc(collection(owner.db, "chats", dmId, "messages")), {
  sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
  enc: { [uidOwner]: { n: "bm9uY2U=", c: "Y2lwaGVy" }, [uidAdmin]: { n: "bm9uY2U=", c: "Y2lwaGVy" } } });
check("encrypted message allowed", true);
await expectDenied("enc envelope for outsider denied", () =>
  setDoc(doc(collection(owner.db, "chats", dmId, "messages")), {
    sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
    enc: { [uidGuest2]: { n: "bm9uY2U=", c: "Y2lwaGVy" } } }));

// Кубик: значение обязано лежать в пределах граней, лишних полей нет
await setDoc(doc(collection(owner.db, "chats", gid, "messages")), {
  sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
  dice: { value: 6, sides: 6 } });
check("honest dice allowed", true);
await expectDenied("dice above sides denied", () =>
  setDoc(doc(collection(owner.db, "chats", gid, "messages")), {
    sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
    dice: { value: 42, sides: 6 } }));
await expectDenied("dice with extra field denied", () =>
  setDoc(doc(collection(owner.db, "chats", gid, "messages")), {
    sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
    dice: { value: 3, sides: 6, payload: "x".repeat(500) } }));
await expectDenied("non-int dice denied", () =>
  setDoc(doc(collection(owner.db, "chats", gid, "messages")), {
    sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
    dice: { value: "6", sides: 6 } }));

// Тихая отправка: это просто bool, строку туда не положить
await setDoc(doc(collection(owner.db, "chats", gid, "messages")), {
  sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
  text: "тихо", silent: true });
check("silent message allowed", true);
await expectDenied("non-bool silent denied", () =>
  setDoc(doc(collection(owner.db, "chats", gid, "messages")), {
    sender: uidOwner, senderName: "fowner", createdAt: Date.now(), reactions: {}, topicId: "general",
    text: "тихо", silent: "yes" }));

// ---------- 3.0 блок C: приватность ----------
// Закрытая личка: чужой писать не может, а тот, кому мы писали сами (dmAllow) — может.
const dmC = `dm_${[uidOwner, uidMember].sort().join("_")}`;
await setDoc(doc(owner.db, "chats", dmC), { type: "private", members: [uidOwner, uidMember].sort(), createdAt: Date.now(), lastRead: {}, unread: {}, pinnedBy: [], muted: [] });
// Режим 'contacts': чужой (не в dmAllow) писать не может, а тот, кто в dmAllow — может.
await setDoc(doc(owner.db, "users", uidOwner, "private", "prefs"), { dmMode: "contacts", dmAllow: [uidAdmin] }, { merge: true });
await expectDenied("dmMode=contacts blocks stranger", () =>
  setDoc(doc(collection(member.db, "chats", dmC, "messages")), {
    sender: uidMember, senderName: "fmember", createdAt: Date.now(), reactions: {}, topicId: "general", text: "спам" }));
await setDoc(doc(collection(admin.db, "chats", dmId, "messages")), {
  sender: uidAdmin, senderName: "fadmin", createdAt: Date.now(), reactions: {}, topicId: "general", text: "мне можно" });
check("dmMode=contacts allows dmAllow peer", true);
// Режим 'none' — жёсткая блокировка: не пишет НИКТО, даже тот, кто уже в dmAllow.
await setDoc(doc(owner.db, "users", uidOwner, "private", "prefs"), { dmMode: "none", dmAllow: [uidAdmin] }, { merge: true });
await expectDenied("dmMode=none blocks non-listed", () =>
  setDoc(doc(collection(member.db, "chats", dmC, "messages")), {
    sender: uidMember, senderName: "fmember", createdAt: Date.now(), reactions: {}, topicId: "general", text: "спам2" }));
await expectDenied("dmMode=none blocks even dmAllow contact", () =>
  setDoc(doc(collection(admin.db, "chats", dmId, "messages")), {
    sender: uidAdmin, senderName: "fadmin", createdAt: Date.now(), reactions: {}, topicId: "general", text: "я в списке, но нельзя" }));
// Старое поле dmClosed=true работает как 'contacts' (обратная совместимость).
await setDoc(doc(owner.db, "users", uidOwner, "private", "prefs"), { dmMode: deleteField(), dmClosed: true }, { merge: true });
await expectDenied("legacy dmClosed blocks stranger", () =>
  setDoc(doc(collection(member.db, "chats", dmC, "messages")), {
    sender: uidMember, senderName: "fmember", createdAt: Date.now(), reactions: {}, topicId: "general", text: "спам3" }));
// Режим 'all' (личка открыта): пишет кто угодно.
await setDoc(doc(owner.db, "users", uidOwner, "private", "prefs"), { dmMode: "all", dmClosed: false }, { merge: true });
await setDoc(doc(collection(member.db, "chats", dmC, "messages")), {
  sender: uidMember, senderName: "fmember", createdAt: Date.now(), reactions: {}, topicId: "general", text: "теперь можно" });
check("dmMode=all allows anyone", true);

// Чужие приватные настройки недоступны никому, кроме владельца
await expectDenied("foreign prefs unreadable", () => getDoc(doc(admin.db, "users", uidOwner, "private", "prefs")));

// Сессии: свои — можно, чужие — нет
await setDoc(doc(owner.db, "users", uidOwner, "sessions", "sess1"),
  { platform: "web", label: "Linux · Firefox", createdAt: Date.now(), lastSeen: Date.now() });
check("own session write allowed", true);
await expectDenied("foreign session write denied", () =>
  setDoc(doc(admin.db, "users", uidOwner, "sessions", "hack"), { platform: "web", createdAt: Date.now() }));
await expectDenied("foreign session read denied", () => getDoc(doc(admin.db, "users", uidOwner, "sessions", "sess1")));

// Журнал безопасности: дописывается, но не переписывается задним числом
await setDoc(doc(owner.db, "users", uidOwner, "seclog", "e1"), { type: "login", at: Date.now(), platform: "web" });
check("seclog append allowed", true);
await expectDenied("seclog rewrite denied", () =>
  updateDoc(doc(owner.db, "users", uidOwner, "seclog", "e1"), { type: "nothing" }));
await expectDenied("seclog backdating denied", () =>
  setDoc(doc(owner.db, "users", uidOwner, "seclog", "e2"), { type: "login", at: Date.now() + 3600000 }));
await expectDenied("foreign seclog write denied", () =>
  setDoc(doc(admin.db, "users", uidOwner, "seclog", "e3"), { type: "login", at: Date.now() }));

console.log(results.join("\n"));
console.log(results.some(r => r.startsWith("FAIL")) ? "\n=== ЕСТЬ ОШИБКИ ===" : "\n=== ВСЕ ТЕСТЫ ПРОШЛИ ===");
process.exit(0);
