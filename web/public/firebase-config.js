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
