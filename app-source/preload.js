const path = require("path");
const { pathToFileURL } = require("url");
const { contextBridge, ipcRenderer } = require("electron");

const WEBVIEW_PRELOAD_URL = pathToFileURL(
  path.join(__dirname, "preload.js")
).toString();

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setNativeTextareaValue(element, value) {
  const prototype = Object.getPrototypeOf(element);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

  if (descriptor && typeof descriptor.set === "function") {
    descriptor.set.call(element, value);
    return;
  }

  element.value = value;
}

async function injectAndSendMessage(text) {
  const textarea = document.querySelector("textarea");
  // TODO: Update selector.

  if (!textarea) {
    console.warn("[preload] Chat input textarea not found");
    return;
  }

  textarea.focus();
  setNativeTextareaValue(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));

  await wait(300);

  const sendButton = document.querySelector('button[type="submit"]');
  // TODO: Update selector.

  if (!sendButton) {
    console.warn("[preload] Send button not found");
    return;
  }

  sendButton.click();
}

ipcRenderer.on("inject-and-send", async (_event, payload = {}) => {
  const text = typeof payload === "string" ? payload : payload.text;

  if (typeof text !== "string" || !text.trim()) {
    return;
  }

  try {
    await injectAndSendMessage(text);
  } catch (error) {
    console.error("[preload] Failed to inject message", error);
  }
});

contextBridge.exposeInMainWorld("electronAPI", {
  sendAgentMessage(agentId, text) {
    ipcRenderer.send("agent-message", { agentId, text });
  },
  openAgentExternal(url) {
    ipcRenderer.send("open-agent-external", { url });
  },
  copyText(text) {
    ipcRenderer.send("copy-text", { text });
  },
  registerAgentWebview(agentId, webContentsId) {
    ipcRenderer.send("register-agent-webview", { agentId, webContentsId });
  },
  getWebviewPreloadURL() {
    return WEBVIEW_PRELOAD_URL;
  },
  onAgentMessageError(callback) {
    const listener = (_event, payload) => {
      callback(payload);
    };

    ipcRenderer.on("agent-message-error", listener);

    return () => {
      ipcRenderer.removeListener("agent-message-error", listener);
    };
  }
});
