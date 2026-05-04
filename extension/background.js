const WS_URL = "ws://localhost:8080";
const RECONNECT_DELAY_MS = 5000;
const SCAN_ALARM_NAME = "scan-open-agent-tabs";
const TARGET_HOSTS = ["chatgpt.com", "gemini.google.com"];
const ALLOW_AUTO_FOCUS_FALLBACK = false;
const EXTENSION_SCRIPT_VERSION = "broagents-extension-2026-03-18-24";
const SITE_URLS = {
  chatgpt: "https://chatgpt.com/",
  gemini: "https://gemini.google.com/app"
};

let socket = null;
let reconnectTimer = null;

const tabRegistry = new Map();
const pendingMessages = [];
const agentDeliveryQueue = new Map();

function getBrowserName() {
  const ua = navigator.userAgent;
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Firefox/")) return "Firefox";
  if (ua.includes("Chrome/")) return "Chrome";
  return "Chrome";
}

function log(message, extra) {
  if (extra) {
    console.log(`[AI Tabs Bridge] ${message}`, extra);
    return;
  }

  console.log(`[AI Tabs Bridge] ${message}`);
}

function sendLogEvent(event, details = {}) {
  sendToServer({
    type: "LOG_EVENT",
    source: "background",
    event,
    details
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withDebuggerTarget(tabId, task) {
  const target = { tabId };
  let attachedHere = false;

  try {
    await chrome.debugger.attach(target, "1.3");
    attachedHere = true;
  } catch (error) {
    const message = String(error?.message || error || "");

    if (!message.toLowerCase().includes("already attached")) {
      throw error;
    }
  }

  try {
    return await task(target);
  } finally {
    if (attachedHere) {
      try {
        await chrome.debugger.detach(target);
      } catch (error) {}
    }
  }
}

async function dispatchDebuggerMouseClick(tabId, x, y) {
  return withDebuggerTarget(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      clickCount: 0
    });
    await wait(30);
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1
    });
    await wait(40);
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1
    });
    return { ok: true };
  });
}

function flushPendingMessages() {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  while (pendingMessages.length > 0) {
    const payload = pendingMessages.shift();
    socket.send(JSON.stringify(payload));
  }
}

function sendToServer(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    pendingMessages.push(payload);
    connectWebSocket();
    return false;
  }

  socket.send(JSON.stringify(payload));
  return true;
}

function registerKnownAgents() {
  for (const entry of tabRegistry.values()) {
    sendToServer({
      type: "REGISTER_AGENT",
      agentId: entry.agentId,
      browser: getBrowserName(),
      site: entry.site,
      tabId: entry.tabId,
      url: entry.url,
      title: entry.title
    });
  }
}

function getAgentId(site, tabId) {
  return `${site}-${tabId}`;
}

function detectSiteFromUrl(url = "") {
  if (url.includes("chatgpt.com")) return "chatgpt";
  if (url.includes("gemini.google.com")) return "gemini";
  return "unknown";
}

function isTargetUrl(url = "") {
  return TARGET_HOSTS.some((host) => url.includes(host));
}

function upsertTab(tabId, site, url, title, state = {}) {
  const agentId = getAgentId(site, tabId);
  const entry = {
    agentId,
    site,
    tabId,
    url: url || "",
    title: title || "",
    busy: Boolean(state.busy),
    composerMode: state.composerMode || "default",
    contentVersion: state.contentVersion || "",
    backgroundVersion: EXTENSION_SCRIPT_VERSION
  };

  tabRegistry.set(tabId, entry);

  sendToServer({
    type: "REGISTER_AGENT",
    agentId: entry.agentId,
    browser: getBrowserName(),
    site: entry.site,
    tabId: entry.tabId,
    url: entry.url,
      title: entry.title,
      busy: entry.busy,
      composerMode: entry.composerMode,
      contentVersion: entry.contentVersion,
      backgroundVersion: entry.backgroundVersion
    });

  return entry;
}

async function syncTab(tabId) {
  try {
    return (
      (await chrome.tabs.sendMessage(tabId, {
        type: "AI_BRIDGE_SYNC",
        expectedVersion: EXTENSION_SCRIPT_VERSION
      })) || { ok: true }
    );
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || "sync_failed"
    };
  }
}

async function ensureContentScriptInjected(tabId, force = false) {
  if (!force) {
    const synced = await syncTab(tabId);
    const versionMatches =
      synced?.contentVersion && synced.contentVersion === EXTENSION_SCRIPT_VERSION;

    if (synced?.ok && versionMatches) {
      return true;
    }

    sendLogEvent("background.sync.version_mismatch", {
      tabId,
      synced
    });
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    await wait(250);
    const synced = await syncTab(tabId);
    sendLogEvent("background.sync.after_inject", {
      tabId,
      synced
    });
    log(`Injected content script into tab ${tabId}`);
    return Boolean(synced?.ok);
  } catch (error) {
    log(`Failed to inject content script into tab ${tabId}`);
    return false;
  }
}

async function scanOpenAgentTabs() {
  try {
    const tabs = await chrome.tabs.query({});

    for (const tab of tabs) {
      if (typeof tab.id !== "number") {
        continue;
      }

      const url = tab.url || "";
      const site = detectSiteFromUrl(url);

      if (site === "unknown") {
        continue;
      }

      upsertTab(tab.id, site, url, tab.title || "");
      await ensureContentScriptInjected(tab.id);
    }
  } catch (error) {
    log("Failed to scan open agent tabs");
  }
}

async function openAgentTab(site) {
  const url = SITE_URLS[site];

  if (!url) {
    return false;
  }

  try {
    const tab = await chrome.tabs.create({
      url,
      active: false
    });

    if (typeof tab.id === "number") {
      await wait(1000);
      await ensureContentScriptInjected(tab.id, true);
    }

    log(`Opened ${site} tab`);
    return true;
  } catch (error) {
    log(`Failed to open ${site} tab`);
    return false;
  }
}

async function focusTab(entry) {
  try {
    const tab = await chrome.tabs.get(entry.tabId);

    if (!tab) {
      sendLogEvent("background.focus.missing_tab", { agentId: entry.agentId });
      return false;
    }

    await chrome.windows.update(tab.windowId, {
      focused: true
    });
    await chrome.tabs.update(entry.tabId, {
      active: true
    });
    await wait(900);

    sendLogEvent("background.focus.ok", {
      agentId: entry.agentId,
      tabId: entry.tabId,
      windowId: tab.windowId,
      windowState: "normal"
    });
    return true;
  } catch (error) {
    sendLogEvent("background.focus.failed", {
      agentId: entry.agentId,
      tabId: entry.tabId,
      message: error?.message || "unknown"
    });
    return false;
  }
}

async function maybeFocusTab(entry, reason) {
  if (!ALLOW_AUTO_FOCUS_FALLBACK) {
    sendLogEvent("background.focus.skipped", {
      agentId: entry.agentId,
      tabId: entry.tabId,
      reason
    });
    return false;
  }

  return focusTab(entry);
}

async function sendMessageToTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    return {
      ok: false,
      reason: error?.message || "send_message_failed"
    };
  }
}

async function deliverCommandToAgent(entry, payload) {
  const text = payload?.text || "";
  const mode = payload?.mode || "default";
  const useToolsMenu = Boolean(payload?.useToolsMenu);
  const deliveryId = `${Date.now()}-${entry.tabId}`;
  await ensureContentScriptInjected(entry.tabId, true);
  let prepareResult = null;
  const prepareStartedAt = Date.now();
  let didFocusFallback = false;

  while (Date.now() - prepareStartedAt < 30000) {
    prepareResult = await sendMessageToTab(entry.tabId, {
      type: "PREPARE_FOR_INPUT"
    });

    sendLogEvent("background.prepare.result", {
      deliveryId,
      agentId: entry.agentId,
      tabId: entry.tabId,
      prepareResult
    });

    if (prepareResult?.ok && !prepareResult?.busy && prepareResult?.hasInput) {
      break;
    }

    if (prepareResult?.busy) {
      sendLogEvent("background.prepare.wait_busy", {
        deliveryId,
        agentId: entry.agentId,
        tabId: entry.tabId
      });
      await wait(1000);
      continue;
    }

    if (prepareResult?.visibilityState === "hidden") {
      sendLogEvent("background.prepare.hidden_ready_wait", {
        deliveryId,
        agentId: entry.agentId,
        tabId: entry.tabId
      });
    }

    if (!didFocusFallback) {
      didFocusFallback = true;
      sendLogEvent("background.prepare.focus_fallback", {
        deliveryId,
        agentId: entry.agentId,
        tabId: entry.tabId
      });
      const focused = await maybeFocusTab(entry, "prepare_fallback");

      if (focused) {
        await wait(500);
        continue;
      }
    }

    await wait(500);
  }

  if (!prepareResult?.ok || prepareResult?.busy || !prepareResult?.hasInput) {
    sendLogEvent("background.prepare.failed", {
      deliveryId,
      agentId: entry.agentId,
      tabId: entry.tabId,
      prepareResult
    });
    return false;
  }

  await wait(250);

  const sendResult = await sendMessageToTab(entry.tabId, {
    type: "SEND_TO_AGENT",
    agentId: entry.agentId,
    text,
    mode,
    useToolsMenu
  });

  sendLogEvent("background.send.result", {
    deliveryId,
    agentId: entry.agentId,
    tabId: entry.tabId,
    sendResult,
    mode,
    useToolsMenu,
    textLength: (text || "").length
  });

  if (sendResult?.ok && sendResult?.generationStarted === false) {
    sendLogEvent("background.send.start_fallback", {
      deliveryId,
      agentId: entry.agentId,
      tabId: entry.tabId
    });

    const focused = await maybeFocusTab(entry, "send_start_fallback");

    if (!focused) {
      sendLogEvent("background.send.start_fallback.skipped", {
        deliveryId,
        agentId: entry.agentId,
        tabId: entry.tabId
      });
      return true;
    }

    await wait(1200);

    const postSendEnsure = await sendMessageToTab(entry.tabId, {
      type: "ENSURE_GENERATION_STARTED"
    });

    sendLogEvent("background.send.start_fallback.result", {
      deliveryId,
      agentId: entry.agentId,
      tabId: entry.tabId,
      postSendEnsure
    });

    return Boolean(postSendEnsure?.ok && postSendEnsure?.started);
  }

  return Boolean(sendResult?.ok);
}

async function ensureGenerationForAgent(entry) {
  await ensureContentScriptInjected(entry.tabId, true);
  const focused = await maybeFocusTab(entry, "ensure_generation");

  if (!focused) {
    sendLogEvent("background.ensure_start.skipped", {
      agentId: entry.agentId,
      tabId: entry.tabId
    });
    return false;
  }

  await wait(1200);

  const result = await sendMessageToTab(entry.tabId, {
    type: "ENSURE_GENERATION_STARTED"
  });

  sendLogEvent("background.ensure_start.result", {
    agentId: entry.agentId,
    tabId: entry.tabId,
    result
  });

  return Boolean(result?.ok && result?.started);
}

async function diagnoseSlashMenuForAgent(entry) {
  await ensureContentScriptInjected(entry.tabId, true);

  const prepareResult = await sendMessageToTab(entry.tabId, {
    type: "PREPARE_FOR_INPUT"
  });

  sendLogEvent("background.slash_menu.prepare", {
    agentId: entry.agentId,
    tabId: entry.tabId,
    prepareResult
  });

  if (!prepareResult?.ok || prepareResult?.busy || !prepareResult?.hasInput) {
    return {
      ok: false,
      reason: prepareResult?.busy ? "AGENT_BUSY" : "INPUT_NOT_READY",
      prepareResult
    };
  }

  const result = await sendMessageToTab(entry.tabId, {
    type: "DIAGNOSE_SLASH_MENU"
  });

  sendLogEvent("background.slash_menu.result", {
    agentId: entry.agentId,
    tabId: entry.tabId,
    result
  });

  return result;
}

async function observeRawTextForAgent(entry, text, waitMs) {
  await ensureContentScriptInjected(entry.tabId, true);

  const prepareResult = await sendMessageToTab(entry.tabId, {
    type: "PREPARE_FOR_INPUT"
  });

  sendLogEvent("background.raw_text.prepare", {
    agentId: entry.agentId,
    tabId: entry.tabId,
    prepareResult,
    textLength: String(text || "").length
  });

  if (!prepareResult?.ok || prepareResult?.busy || !prepareResult?.hasInput) {
    return {
      ok: false,
      reason: prepareResult?.busy ? "AGENT_BUSY" : "INPUT_NOT_READY",
      prepareResult
    };
  }

  const result = await sendMessageToTab(entry.tabId, {
    type: "OBSERVE_RAW_TEXT",
    text: String(text || ""),
    waitMs
  });

  sendLogEvent("background.raw_text.result", {
    agentId: entry.agentId,
    tabId: entry.tabId,
    result
  });

  return result;
}

function queueDeliveryToAgent(entry, payload) {
  const previous = agentDeliveryQueue.get(entry.agentId) || Promise.resolve(false);
  const current = previous
    .catch(() => false)
    .then(() => deliverCommandToAgent(entry, payload))
    .finally(() => {
      if (agentDeliveryQueue.get(entry.agentId) === current) {
        agentDeliveryQueue.delete(entry.agentId);
      }
    });

  agentDeliveryQueue.set(entry.agentId, current);
  return current;
}

function queueEnsureGenerationForAgent(entry) {
  const previous = agentDeliveryQueue.get(entry.agentId) || Promise.resolve(false);
  const current = previous
    .catch(() => false)
    .then(() => ensureGenerationForAgent(entry))
    .finally(() => {
      if (agentDeliveryQueue.get(entry.agentId) === current) {
        agentDeliveryQueue.delete(entry.agentId);
      }
    });

  agentDeliveryQueue.set(entry.agentId, current);
  return current;
}

function queueSlashMenuDiagnosis(entry) {
  const previous = agentDeliveryQueue.get(entry.agentId) || Promise.resolve(false);
  const current = previous
    .catch(() => false)
    .then(() => diagnoseSlashMenuForAgent(entry))
    .finally(() => {
      if (agentDeliveryQueue.get(entry.agentId) === current) {
        agentDeliveryQueue.delete(entry.agentId);
      }
    });

  agentDeliveryQueue.set(entry.agentId, current);
  return current;
}

function queueRawTextObservation(entry, text, waitMs) {
  const previous = agentDeliveryQueue.get(entry.agentId) || Promise.resolve(false);
  const current = previous
    .catch(() => false)
    .then(() => observeRawTextForAgent(entry, text, waitMs))
    .finally(() => {
      if (agentDeliveryQueue.get(entry.agentId) === current) {
        agentDeliveryQueue.delete(entry.agentId);
      }
    });

  agentDeliveryQueue.set(entry.agentId, current);
  return current;
}

async function syncAllKnownTabs() {
  try {
    const tabIds = Array.from(tabRegistry.keys());

    for (const tabId of tabIds) {
      await ensureContentScriptInjected(tabId, true);
    }

    if (tabIds.length === 0) {
      await scanOpenAgentTabs();
    }
  } catch (error) {
    log("Failed to sync known tabs");
  }
}

function startPeriodicScan() {
  chrome.alarms.create(SCAN_ALARM_NAME, {
    periodInMinutes: 0.5
  });
}

function scheduleBootstrapScans() {
  const delays = [0, 1000, 3000, 7000];

  delays.forEach((delay) => {
    setTimeout(() => {
      scanOpenAgentTabs();
    }, delay);
  });
}

function connectWebSocket() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  log(`Connecting to ${WS_URL}`);
  socket = new WebSocket(WS_URL);

  socket.addEventListener("open", () => {
    log("WebSocket connected");
    sendToServer({
      type: "REGISTER_CLIENT",
      clientType: "extension-background"
    });
    flushPendingMessages();
    registerKnownAgents();
    scheduleBootstrapScans();
  });

  socket.addEventListener("message", async (event) => {
    let message = null;

    try {
      message = JSON.parse(event.data);
    } catch (error) {
      log("Invalid message from server");
      return;
    }

    if (message.type === "SYNC_AGENT_STATE") {
      await syncAllKnownTabs();
      return;
    }

    if (message.type === "OPEN_AGENT_TAB") {
      await openAgentTab(message.site || "");
      return;
    }

    if (message.type === "ENSURE_AGENT_GENERATION" && message.agentId) {
      for (const entry of tabRegistry.values()) {
        if (entry.agentId !== message.agentId) {
          continue;
        }

        try {
          await queueEnsureGenerationForAgent(entry);
        } catch (error) {
          log(`Failed to ensure generation for tab ${entry.tabId}`);
          sendLogEvent("background.ensure_start.exception", {
            agentId: entry.agentId,
            tabId: entry.tabId,
            message: error?.message || "unknown"
          });
        }
      }
      return;
    }

    if (message.type === "DIAGNOSE_SLASH_MENU" && message.agentId) {
      for (const entry of tabRegistry.values()) {
        if (entry.agentId !== message.agentId) {
          continue;
        }

        try {
          await queueSlashMenuDiagnosis(entry);
        } catch (error) {
          log(`Failed to diagnose slash menu for tab ${entry.tabId}`);
          sendLogEvent("background.slash_menu.exception", {
            agentId: entry.agentId,
            tabId: entry.tabId,
            message: error?.message || "unknown"
          });
        }
      }
      return;
    }

    if (message.type === "OBSERVE_RAW_TEXT" && message.agentId) {
      for (const entry of tabRegistry.values()) {
        if (entry.agentId !== message.agentId) {
          continue;
        }

        try {
          await queueRawTextObservation(entry, message.text || "", message.waitMs);
        } catch (error) {
          log(`Failed to observe raw text for tab ${entry.tabId}`);
          sendLogEvent("background.raw_text.exception", {
            agentId: entry.agentId,
            tabId: entry.tabId,
            message: error?.message || "unknown"
          });
        }
      }
      return;
    }

    if (message.type !== "SEND_TO_AGENT" || !message.agentId) {
      return;
    }

    for (const entry of tabRegistry.values()) {
      if (entry.agentId !== message.agentId) {
        continue;
      }

      try {
        await queueDeliveryToAgent(entry, {
          text: message.text || "",
          mode: typeof message.mode === "string" ? message.mode : "default",
          useToolsMenu: Boolean(message.useToolsMenu)
        });
      } catch (error) {
        log(`Failed to send command to tab ${entry.tabId}`);
        sendLogEvent("background.send.exception", {
          agentId: entry.agentId,
          tabId: entry.tabId,
          message: error?.message || "unknown"
        });
      }
    }
  });

  socket.addEventListener("close", () => {
    log("WebSocket closed");
    socket = null;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, RECONNECT_DELAY_MS);
  });

  socket.addEventListener("error", () => {
    log("WebSocket error");
  });
}

chrome.runtime.onInstalled.addListener(() => {
  connectWebSocket();
  scheduleBootstrapScans();
  startPeriodicScan();
});

chrome.runtime.onStartup.addListener(() => {
  connectWebSocket();
  scheduleBootstrapScans();
  startPeriodicScan();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SCAN_ALARM_NAME) {
    connectWebSocket();
    scanOpenAgentTabs();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab && typeof sender.tab.id === "number" ? sender.tab.id : null;

  if (!message || !message.type || tabId === null) {
    return false;
  }

  if (message.type === "DEBUGGER_MOUSE_CLICK") {
    (async () => {
      try {
        const x = Number(message.x);
        const y = Number(message.y);

        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          sendResponse({ ok: false, reason: "INVALID_COORDS" });
          return;
        }

        await dispatchDebuggerMouseClick(tabId, x, y);
        sendLogEvent("background.debugger.mouse_click", {
          tabId,
          x,
          y,
          ok: true
        });
        sendResponse({ ok: true });
      } catch (error) {
        sendLogEvent("background.debugger.mouse_click_failed", {
          tabId,
          x: message.x,
          y: message.y,
          message: error?.message || "unknown"
        });
        sendResponse({
          ok: false,
          reason: error?.message || "DEBUGGER_MOUSE_CLICK_FAILED"
        });
      }
    })();

    return true;
  }

  if (message.type === "REGISTER_AGENT") {
    const site = message.site || "unknown";
    connectWebSocket();
    const entry = upsertTab(
      tabId,
      site,
      message.url || sender.tab.url || "",
      message.title || sender.tab.title || "",
      message.state || {}
    );

    sendResponse({ ok: true, agentId: entry.agentId });
    return true;
  }

  if (message.type === "AGENT_HEARTBEAT") {
    const site = message.site || "unknown";
    connectWebSocket();
    const entry = upsertTab(
      tabId,
      site,
      message.url || sender.tab.url || "",
      message.title || sender.tab.title || "",
      message.state || {}
    );

    sendResponse({ ok: true, agentId: entry.agentId });
    return true;
  }

  if (message.type === "TEXT_UPDATE") {
    const existingEntry = tabRegistry.get(tabId);
    const site = message.site || (existingEntry ? existingEntry.site : "unknown");
    connectWebSocket();
    const entry = existingEntry ||
      upsertTab(
        tabId,
        site,
        message.url || sender.tab.url || "",
        message.title || sender.tab.title || "",
        message.state || {}
      );

    sendToServer({
      type: "TEXT_UPDATE",
      agentId: entry.agentId,
      browser: getBrowserName(),
      site,
      text: message.text || "",
      url: message.url || sender.tab.url || "",
      title: message.title || sender.tab.title || "",
      busy: Boolean(message.state?.busy),
      composerMode: message.state?.composerMode || "default"
    });

    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "LOG_EVENT") {
    const existingEntry = tabRegistry.get(tabId);
    const site = message.site || (existingEntry ? existingEntry.site : "unknown");
    const agentId = existingEntry?.agentId || getAgentId(site, tabId);

    sendToServer({
      type: "LOG_EVENT",
      source: "content",
      agentId,
      browser: getBrowserName(),
      site,
      tabId,
      url: message.details?.url || sender.tab.url || "",
      title: message.details?.title || sender.tab.title || "",
      event: message.event || "content.log",
      details: message.details || {}
    });

    sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = tabRegistry.get(tabId);

  if (!entry) {
    return;
  }

  sendToServer({
    type: "UNREGISTER_AGENT",
    agentId: entry.agentId
  });

  tabRegistry.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  const url = tab.url || "";
  if (!isTargetUrl(url)) {
    return;
  }

  const site = detectSiteFromUrl(url);
  connectWebSocket();
  upsertTab(tabId, site, url, tab.title || "");
  ensureContentScriptInjected(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";

    if (!isTargetUrl(url)) {
      return;
    }

    const site = detectSiteFromUrl(url);
    connectWebSocket();
    upsertTab(tabId, site, url, tab.title || "");
    await ensureContentScriptInjected(tabId);
  } catch (error) {}
});

chrome.webNavigation.onCommitted.addListener(({ tabId, url }) => {
  if (!isTargetUrl(url)) {
    return;
  }

  const site = detectSiteFromUrl(url);
  connectWebSocket();
  upsertTab(tabId, site, url, "");
});

chrome.webNavigation.onCompleted.addListener(async ({ tabId, url }) => {
  if (!isTargetUrl(url)) {
    return;
  }

  const site = detectSiteFromUrl(url);
  connectWebSocket();
  upsertTab(tabId, site, url, "");
  await ensureContentScriptInjected(tabId);
});

connectWebSocket();
scheduleBootstrapScans();
startPeriodicScan();
