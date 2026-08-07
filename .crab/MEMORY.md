# Project memory

Durable notes the agent keeps across sessions.

- (2026-08-07) SandyGram — мессенджер (монохромный, Material You). Бэкенда нет: Firestore + правила безопасности. 4 клиента: web/ (Vanilla JS), app/ (React Native Expo), desktop/ (WPF C# .NET 8, не указан в README-таблице архитектуры), push-worker/ (Cloudflare Worker, cron 1 мин, FCM HTTP v1, JWT из SERVICE_ACCOUNT). RTDB (europe-west1) — статусы в сети/печатает и звонки WebRTC. Логика модерации: /mute /warn /ban /unmute /unban, блокировка, QR-логин. Секреты только в env (wrangler secrets, google-services.json в репо есть у app/).
