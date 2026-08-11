// Интеграционный тест RTDB-правил (database.rules.json) против эмулятора.
// Проверяет QR-вход, сигналинг звонков и bump — как это делают реальные клиенты.
import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from "firebase/auth";
import { getDatabase, connectDatabaseEmulator, ref, set, get, update, remove } from "firebase/database";

const results = [];
const check = (name, ok, extra = "") => results.push(`${ok ? "OK " : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
const expectDenied = async (name, fn) => {
  try { await fn(); check(name, false, "операция ПРОШЛА, а должна быть запрещена"); }
  catch (e) { check(name, /permission|denied/i.test(e.message) || e.code === "PERMISSION_DENIED", (e.code || e.message).slice(0, 60)); }
};

const DB_URL = "http://127.0.0.1:9002/?ns=demo-sandygram-default-rtdb";
function makeClient(tag) {
  const app = initializeApp({ apiKey: "demo", authDomain: "demo-sandygram.firebaseapp.com", projectId: "demo-sandygram", databaseURL: DB_URL }, tag);
  const auth = getAuth(app);
  const db = getDatabase(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectDatabaseEmulator(db, "127.0.0.1", 9002);
  return { auth, db };
}

const anon = makeClient("anon");        // ПК до входа (не авторизован)
const phone = makeClient("phone");      // телефон (авторизован)
const caller = makeClient("caller");
const callee = makeClient("callee");
const other = makeClient("other");

const phoneUid = (await createUserWithEmailAndPassword(phone.auth, "rphone@sandygram.app", "test123")).user.uid;
const callerUid = (await createUserWithEmailAndPassword(caller.auth, "rcaller@sandygram.app", "test123")).user.uid;
const calleeUid = (await createUserWithEmailAndPassword(callee.auth, "rcallee@sandygram.app", "test123")).user.uid;
const otherUid = (await createUserWithEmailAndPassword(other.auth, "rother@sandygram.app", "test123")).user.uid;
check("auth setup", true);

// --- QR-вход ---
const tok = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
// ПК (не авторизован) создаёт узел со статусом pending
await set(ref(anon.db, `qrlogin/${tok}`), { status: "pending", created: Date.now() });
check("anon PC creates qrlogin node", true);
// ПК читает свой узел точечно
check("anon reads own qrlogin token", (await get(ref(anon.db, `qrlogin/${tok}`))).val().status === "pending");
// перебор всего /qrlogin запрещён (там лежат refresh-токены)
await expectDenied("dump of whole /qrlogin denied", () => get(ref(anon.db, "qrlogin")));
// телефон (авторизован) кладёт refresh-токен
await set(ref(phone.db, `qrlogin/${tok}`), { status: "ok", refresh: "REFRESH", at: Date.now(), uid: phoneUid });
check("phone writes refresh token", true);
// запись без обязательного поля status отклоняется валидатором
await expectDenied("qrlogin write without status denied", () =>
  set(ref(phone.db, `qrlogin/${tok}2`), { refresh: "x" }));

// --- Звонки ---
const callId = "call_test1";
// звонящий создаёт узел у вызываемого с from = собственный uid
await set(ref(caller.db, `calls/${calleeUid}/${callId}`), { from: callerUid, offer: "OFFER", status: "ringing" });
check("caller creates call node", true);
// нельзя создать звонок «от чужого имени»
await expectDenied("cannot spoof call 'from'", () =>
  set(ref(other.db, `calls/${calleeUid}/call_spoof`), { from: callerUid, offer: "x", status: "ringing" }));
// вызываемый читает и отвечает
check("callee reads incoming call", (await get(ref(callee.db, `calls/${calleeUid}/${callId}`))).val().from === callerUid);
await update(ref(callee.db, `calls/${calleeUid}/${callId}`), { answer: "ANSWER", status: "accepted" });
check("callee answers call", true);
// звонящий читает свой исходящий узел
check("caller reads own call node", (await get(ref(caller.db, `calls/${calleeUid}/${callId}`))).val().status === "accepted");
// посторонний не может читать чужой звонок
await expectDenied("outsider cannot read others' call", () => get(ref(other.db, `calls/${calleeUid}/${callId}`)));
await remove(ref(callee.db, `calls/${calleeUid}/${callId}`));
check("callee clears call", true);

// --- bump ---
await expectDenied("anon cannot write bump", () => set(ref(anon.db, "bump/chat1"), Date.now()));
await set(ref(caller.db, "bump/chat1"), Date.now());
check("authed writes bump", true);
check("authed reads bump tree", (await get(ref(caller.db, "bump"))).exists());

// --- прочее дерево закрыто ---
await expectDenied("unknown path write denied", () => set(ref(caller.db, "secret/x"), 1));

console.log(results.join("\n"));
console.log(results.some(r => r.startsWith("FAIL")) ? "\n=== ЕСТЬ ОШИБКИ ===" : "\n=== ВСЕ ТЕСТЫ ПРОШЛИ ===");
process.exit(0);
