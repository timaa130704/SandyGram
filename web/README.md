# SandyGram (Firebase-версия)

Мессенджер без своего сервера: Firebase Auth + Firestore (realtime) + Hosting.
Работает 24/7 на бесплатном тарифе Spark, ПК не нужен.

## Локальная разработка (эмуляторы)

Нужна Java 17+ (для эмулятора Firestore).

```
npm install
npx firebase emulators:start --project demo-sandygram
```

Сайт: http://localhost:5050 — при заходе с localhost клиент сам подключается
к эмуляторам (см. `public/firebase-config.js`), данные живут до перезапуска эмулятора.

Интеграционные тесты (эмуляторы должны быть запущены):

```
node test.mjs
```

## Деплой в настоящий Firebase

1. [console.firebase.google.com](https://console.firebase.google.com) → Add project (аналитику можно отключить)
2. Build → **Authentication** → Get started → включить **Email/Password**
3. Build → **Firestore Database** → Create database → режим **production**, регион `europe-west1`
4. Project Overview → иконка `</>` (Web) → зарегистрировать приложение → скопировать объект `firebaseConfig`
5. Вставить конфиг в `public/firebase-config.js` (заменить demo-значения)
6. В `.firebaserc` заменить `demo-sandygram` на реальный project id
7. Войти и задеплоить:

```
npx firebase login
npx firebase deploy
```

Сайт будет доступен на `https://<project-id>.web.app`.

## Архитектура данных (Firestore)

- `users/{uid}` — профиль: username, displayName, bio, avatarColor, lastSeen (heartbeat каждые 30 с — заменяет WebSocket-присутствие; «в сети» = lastSeen свежее 70 с)
- `usernames/{name}` — реестр уникальных @username → {uid, email}; смена username = транзакция
- `chats/{chatId}` — тип (private/group/saved), members (uid), ownerUid, admins, topics[], generalClosed, lastMessage, lastRead{uid}, unread{uid}, typing{uid: ts}, pinnedBy, muted, pinnedMessageId, inviteCode
  - id детерминированные: `dm_<uidA>_<uidB>` (сортировано), `saved_<uid>` — дедупликация ЛС бесплатно
- `chats/{chatId}/messages/{id}` — sender, senderName, text, image (data-URL ≤ 700 КБ), topicId, replyTo, reactions, deleted (soft)
- `invites/{code}` — карточка приглашения {chatId, title, memberCount}; чтение только точечное (list запрещён), вступление = не-участник добавляет **только себя** и только в `members` (правило проверяет diff)

## Ограничения против старой версии

- Вход по QR-коду убран (требует серверной выдачи токенов)
- Глобальный поиск по тексту сообщений убран (Firestore не умеет full-text); поиск по чатам и людям остался
- Закрытые топики контролируются на клиенте (правила Firestore проверяют членство и авторство, но не топики)

## Лимиты Spark (бесплатно)

50k чтений / 20k записей в день, 1 ГиБ базы. Фото хранятся в базе как data-URL —
при росте стоит вынести на внешний хостинг картинок (imgbb API и т.п.).
