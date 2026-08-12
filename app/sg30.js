// ВНИМАНИЕ: копия web/public/sg30.js — держите файлы синхронными (общая логика 3.0).
"use strict";
// SandyGram 3.0 — общие механизмы поверх базового клиента:
// медиа в R2, исчезающие сообщения, отложенная отправка, папки чатов, мини-игра.
// Модуль намеренно не знает про DOM: только данные и вычисления.

// ---------- медиа в R2 (через push-worker) ----------
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

// Человекочитаемый размер: 1.4 МБ, 320 КБ
export function fmtBytes(n) {
  if (!(n > 0)) return "";
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}

export function mediaKind(type) {
  const t = String(type || "").toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  return "file";
}

// Загрузка файла в R2. getIdToken — функция, возвращающая свежий Firebase ID-токен.
// Возвращает объект media для сообщения: {key, url, type, name, size, kind}
// file — это File/Blob (веб) либо {blob, name, type, size} (React Native).
export async function uploadMedia(workerUrl, getIdToken, file, { onProgress } = {}) {
  if (!workerUrl) throw new Error("Хранилище файлов недоступно");
  if (file.size > MEDIA_MAX_BYTES) throw new Error(`Файл больше ${fmtBytes(MEDIA_MAX_BYTES)}`);
  const token = await getIdToken();
  const type = file.type || "application/octet-stream";
  const body = file.blob || file;

  // XHR, а не fetch: нужен прогресс загрузки для больших файлов
  const res = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${workerUrl}/media/upload`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.setRequestHeader("X-Media-Type", type);
    xhr.setRequestHeader("X-Media-Name", encodeURIComponent(file.name || ""));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body.key) resolve(body);
      else reject(new Error(body.error || `Загрузка не удалась (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Сеть недоступна"));
    xhr.send(body);
  });

  return {
    key: res.key, url: res.url, type, size: res.size,
    name: (file.name || "").slice(0, 120), kind: mediaKind(type),
  };
}

// ---------- исчезающие сообщения ----------
export const TTL_OPTIONS = [
  { ms: 0, label: "Выключено" },
  { ms: 60e3, label: "1 минута" },
  { ms: 3600e3, label: "1 час" },
  { ms: 86400e3, label: "24 часа" },
  { ms: 7 * 86400e3, label: "7 дней" },
];
export const ttlLabel = (ms) => (TTL_OPTIONS.find(o => o.ms === ms) || { label: "выключено" }).label;

// Сколько осталось жить сообщению: строка для подписи под пузырём
export function ttlLeft(expiresAt, now = Date.now()) {
  if (!expiresAt) return "";
  const left = expiresAt - now;
  if (left <= 0) return "исчезает…";
  if (left < 60e3) return `${Math.ceil(left / 1000)} с`;
  if (left < 3600e3) return `${Math.ceil(left / 60e3)} мин`;
  if (left < 86400e3) return `${Math.ceil(left / 3600e3)} ч`;
  return `${Math.ceil(left / 86400e3)} дн`;
}

// Клиент прячет просроченное сразу, не дожидаясь уборки воркером
export const isExpired = (m, now = Date.now()) => !!(m.expiresAt && m.expiresAt <= now)
  || !!(m.viewOnce && m.viewedBy && Object.keys(m.viewedBy).length > 0);

// ---------- папки чатов ----------
// Хранятся в users/{uid}/private/prefs -> folders: [{id, name, icon, chatIds:[...]}]
export const ALL_FOLDER = { id: "all", name: "Все", icon: "💬" };

export function foldersWithCounts(folders, chatList, unreadOf) {
  const out = [{ ...ALL_FOLDER, count: chatList.reduce((n, c) => n + (unreadOf(c) > 0 ? 1 : 0), 0) }];
  for (const f of folders || []) {
    const ids = new Set(f.chatIds || []);
    out.push({ ...f, count: chatList.filter(c => ids.has(c.id) && unreadOf(c) > 0).length });
  }
  return out;
}

export function chatsInFolder(folders, folderId, chatList) {
  if (!folderId || folderId === "all") return chatList;
  const f = (folders || []).find(x => x.id === folderId);
  if (!f) return chatList;
  const ids = new Set(f.chatIds || []);
  return chatList.filter(c => ids.has(c.id));
}

// ---------- мини-игра: крестики-нолики ----------
// Состояние живёт в message.game: {kind:'ttt', players:[uid,uid], board:"---------", turn:uid, winner:null}
export const TTT_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

export function tttWinner(board) {
  for (const [a, b, c] of TTT_LINES) {
    if (board[a] !== "-" && board[a] === board[b] && board[b] === board[c]) return { mark: board[a], line: [a, b, c] };
  }
  return board.includes("-") ? null : { mark: "draw", line: [] };
}

export function newTttGame(meUid, peerUid) {
  return { kind: "ttt", players: [meUid, peerUid], board: "---------", turn: meUid, winner: null, createdAt: Date.now() };
}

// Ход игрока. Возвращает новое состояние game или строку с причиной отказа.
export function tttMove(game, uid, cell) {
  if (!game || game.kind !== "ttt") return "Это не игра";
  if (game.winner) return "Игра уже закончена";
  if (!game.players.includes(uid)) return "Вы не участник этой игры";
  if (game.turn !== uid) return "Сейчас ход соперника";
  if (cell < 0 || cell > 8 || game.board[cell] !== "-") return "Клетка занята";
  const mark = game.players[0] === uid ? "X" : "O";
  const board = game.board.slice(0, cell) + mark + game.board.slice(cell + 1);
  const win = tttWinner(board);
  const other = game.players.find(p => p !== uid) || uid;
  return {
    ...game, board,
    turn: win ? game.turn : other,
    winner: win ? (win.mark === "draw" ? "draw" : uid) : null,
    line: win ? win.line : null,
  };
}

export const tttMark = (game, uid) => (game.players[0] === uid ? "X" : "O");
