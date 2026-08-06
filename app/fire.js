// Подключение к тому же Firebase-проекту, что и сайт sandygram-a3b42.web.app
import { initializeApp } from "firebase/app";
import { initializeAuth, getReactNativePersistence } from "firebase/auth";
import { initializeFirestore } from "firebase/firestore";
import AsyncStorage from "@react-native-async-storage/async-storage";

const app = initializeApp({
  apiKey: "AIzaSyAjGwFBdfll--_ohWWlaZmV3JT2ksRD7vk",
  authDomain: "sandygram-a3b42.firebaseapp.com",
  projectId: "sandygram-a3b42",
  storageBucket: "sandygram-a3b42.firebasestorage.app",
  messagingSenderId: "762527338102",
  appId: "1:762527338102:web:d3750ada94682e5b591957",
});

// Сессия сохраняется между запусками приложения
export const auth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
// Long polling: WebChannel в React Native работает нестабильно
export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
