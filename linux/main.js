// SandyGram — десктоп-клиент для Linux.
// Тонкая оболочка Electron поверх веб-версии (https://sandygram-a3b42.web.app):
// один код с вебом, всегда актуален, отдельное окно приложения со своей иконкой.
const { app, BrowserWindow, shell, Menu, nativeImage } = require("electron");
const path = require("path");

// URL можно переопределить переменной SANDYGRAM_URL — так тестируются
// preview-каналы хостинга, не пересобирая клиент.
const APP_URL = process.env.SANDYGRAM_URL || "https://sandygram-a3b42.web.app";
const APP_ORIGIN = new URL(APP_URL).origin;

// один экземпляр приложения (второй запуск фокусирует существующее окно)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;

  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  function createWindow() {
    win = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 380,
      minHeight: 560,
      backgroundColor: "#0a0a0a",
      icon: nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")),
      autoHideMenuBar: true,
      title: "SandyGram",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });

    Menu.setApplicationMenu(null);

    win.loadURL(APP_URL);

    // если сеть недоступна — показать понятную заглушку с кнопкой «повторить»
    win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame) return;
      const html =
        "data:text/html;charset=utf-8," +
        encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8">
        <style>html,body{height:100%;margin:0}body{background:#0a0a0a;color:#eee;
        font-family:system-ui,sans-serif;display:flex;flex-direction:column;
        align-items:center;justify-content:center;gap:18px}button{background:#fff;
        color:#000;border:0;border-radius:999px;padding:12px 26px;font-size:15px;
        font-weight:700;cursor:pointer}p{opacity:.6;font-size:14px}</style></head>
        <body><h2>Нет соединения с SandyGram</h2>
        <p>Проверьте интернет и попробуйте снова.</p>
        <button onclick="location.href='${APP_URL}'">Повторить</button>
        </body></html>`);
      win.loadURL(html);
    });

    // внешние ссылки и попытки увести на чужой домен — в системный браузер
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      try {
        if (new URL(url).origin !== APP_ORIGIN && !url.startsWith("data:")) {
          e.preventDefault();
          shell.openExternal(url);
        }
      } catch { /* игнорируем битые url */ }
    });

    win.on("closed", () => { win = null; });
  }

  app.whenReady().then(createWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
