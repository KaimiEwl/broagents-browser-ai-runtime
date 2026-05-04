const path = require("path");
const { app, BrowserWindow, clipboard, ipcMain, shell, webContents } = require("electron");

const VITE_DEV_SERVER_URL = "http://127.0.0.1:5173";
const WINDOW_PRELOAD_PATH = path.join(__dirname, "preload.js");

let mainWindow = null;

// agentId -> guest webContents instance
const agentWebviews = new Map();

function registerAgentWebview(agentId, webContentsId) {
  if (!agentId || !Number.isInteger(webContentsId)) {
    return;
  }

  const guestContents = webContents.fromId(webContentsId);

  if (!guestContents) {
    return;
  }

  agentWebviews.set(agentId, guestContents);

  guestContents.once("destroyed", () => {
    const currentContents = agentWebviews.get(agentId);

    if (currentContents && currentContents.id === guestContents.id) {
      agentWebviews.delete(agentId);
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1800,
    height: 1000,
    minWidth: 1280,
    minHeight: 720,
    backgroundColor: "#111827",
    webPreferences: {
      preload: WINDOW_PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
  } else {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

ipcMain.on("register-agent-webview", (event, payload = {}) => {
  const { agentId, webContentsId } = payload;
  registerAgentWebview(agentId, webContentsId);
});

ipcMain.on("agent-message", (event, payload = {}) => {
  const { agentId, text } = payload;

  if (!agentId || typeof text !== "string" || !text.trim()) {
    return;
  }

  const guestContents = agentWebviews.get(agentId);

  if (!guestContents || guestContents.isDestroyed()) {
    event.reply("agent-message-error", {
      agentId,
      error: "WEBVIEW_NOT_READY"
    });
    return;
  }

  guestContents.send("inject-and-send", {
    agentId,
    text
  });
});

ipcMain.on("open-agent-external", (_event, payload = {}) => {
  const { url } = payload;

  if (typeof url !== "string" || !url.trim()) {
    return;
  }

  shell.openExternal(url);
});

ipcMain.on("copy-text", (_event, payload = {}) => {
  const { text } = payload;

  if (typeof text !== "string") {
    return;
  }

  clipboard.writeText(text);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
