// Конфигурация Firebase.
// Локально (localhost) автоматически используются эмуляторы и демо-проект.
// После создания реального проекта вставьте сюда объект из консоли Firebase:
// Project settings -> General -> Your apps -> SDK setup and configuration -> Config
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyAjGwFBdfll--_ohWWlaZmV3JT2ksRD7vk",
  authDomain: "sandygram-a3b42.firebaseapp.com",
  projectId: "sandygram-a3b42",
  storageBucket: "sandygram-a3b42.firebasestorage.app",
  messagingSenderId: "762527338102",
  appId: "1:762527338102:web:d3750ada94682e5b591957",
};
window.USE_EMULATORS = ["localhost", "127.0.0.1"].includes(location.hostname);

// Ключ веб-пушей (Cloud Messaging → Web Push certificates); пусто = пуши в браузере выключены
window.VAPID_KEY = "BBGJ2vVEgOLEYLhaBwGMw7qYFlEPHWNW6yE94hxS1bapT0LEj9h4qNyDo4nMrHTv6E-GT4USYdEqpuOq1B2khMk";

// Cloudflare Worker «sandygram-push»: эндпоинт обмена QR refresh-токена на Custom Token.
// Заполняется после деплоя воркера (wrangler deploy) — URL вида https://sandygram-push.<поддомен>.workers.dev
window.QR_WORKER_URL = "";
