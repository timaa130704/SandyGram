// Service worker для веб-пушей SandyGram
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyAjGwFBdfll--_ohWWlaZmV3JT2ksRD7vk",
  authDomain: "sandygram-a3b42.firebaseapp.com",
  projectId: "sandygram-a3b42",
  messagingSenderId: "762527338102",
  appId: "1:762527338102:web:d3750ada94682e5b591957",
});
firebase.messaging();
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow("/"));
});
