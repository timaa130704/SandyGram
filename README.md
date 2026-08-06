# SandyGram

Быстрый монохромный мессенджер в стиле Material You: сайт + нативное Android-приложение с общей базой.

**Сайт:** https://sandygram-a3b42.web.app · **Лендинг:** https://info-sandygram.web.app · **APK:** см. [Releases](../../releases/latest)

## Возможности

- Личные чаты, группы с топиками-форумами (закрытие топиков, права), каналы (пишут только админы)
- Админы и роли (👑 владелец / ⭐ админ), исключение участников, инвайт-ссылки `/join/<код>` с deep link в приложение
- Голосовые сообщения, стикеры (OpenMoji), фото и фото-аватарки
- Реакции, ответы (свайп в приложении), пересылка, закрепы, редактирование, @упоминания
- Статусы «в сети» / «печатает…», галочки прочтения ✓/✓✓, поиск
- Push-уведомления (FCM через Cloudflare Worker, бесплатно, без Cloud Functions)
- Блокировка пользователей, скрытие времени захода, очистка истории, удаление аккаунта
- Тёмная и светлая тема, монохромный дизайн

## Архитектура

| Папка | Что это | Стек |
|-------|---------|------|
| `web/` | Сайт + правила Firestore + лендинг | Vanilla JS + Firebase (Auth, Firestore, Hosting) |
| `app/` | Android-приложение | React Native (Expo), общий Firebase |
| `push-worker/` | Рассыльщик пушей | Cloudflare Worker, cron раз в минуту → FCM HTTP v1 |

Бэкенда нет: вся логика на клиентах, безопасность — в `web/firestore.rules`
(каналы, блокировки и членство enforce'ятся правилами). Работает целиком на бесплатных тарифах
(Firebase Spark + Cloudflare Workers Free).

## Запуск

### Веб (локально, эмуляторы)
```bash
cd web && npm i -D firebase-tools@13 && npm i firebase
npx firebase emulators:start --project demo-sandygram   # нужна Java 17+
node test.mjs                                           # интеграционные тесты
```

### Деплой веба
```bash
cd web && npx firebase deploy --project <ваш-проект>
```

### Приложение
```bash
cd app && npm ci
npx expo start                 # разработка через Expo Go
npx expo prebuild -p android   # затем android/gradlew assembleRelease → APK
```

### Push-worker
```bash
cd push-worker
npx wrangler secret put SERVICE_ACCOUNT   # содержимое ключа сервисного аккаунта Firebase
npx wrangler secret put PING_KEY          # любой случайный секрет для ручного /run
npx wrangler deploy
```

## Секреты

В репозитории **нет** приватных ключей. Для своего инстанса нужны:
- свой проект Firebase (конфиг в `web/public/firebase-config.js` и `app/fire.js`)
- ключ сервисного аккаунта — только в секретах Cloudflare Worker
- `google-services.json` своего Android-приложения
