const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { inspectOutgoingText } = require("./scripts/lib/outgoing-text-guard");
const {
  loadSquadState,
  getActiveRun,
  getNextQueueItem,
  getRecentNotifications
} = require("./scripts/lib/squad-core");
const { loadScenarioPacks } = require("./scripts/lib/scenario-packs");

const PORT = (() => {
  const requested = Number.parseInt(
    process.env.BROAGENTS_PORT || process.env.PORT || "8080",
    10
  );
  return Number.isFinite(requested) && requested > 0 ? requested : 8080;
})();
const BROAGENTS_DIR = __dirname;
const DATA_DIR = path.join(__dirname, "data");
const AGENT_STATE_PATH = path.join(DATA_DIR, "agent-state.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const DIST_DIR = path.join(BROAGENTS_DIR, "dist");
const SCRIPTS_DIR = path.join(__dirname, "scripts");
const PASTE_SCRIPT_PATH = path.join(SCRIPTS_DIR, "paste-focused-window.ps1");
const MAX_ACTIVITY_ITEMS = 200;
const PROJECT_ROOT = resolveProjectRoot();

let nextClientId = 1;
const agentState = loadAgentState();
const agentWaiters = new Map();
const recentActivity = [];

const httpServer = http.createServer(handleHttpRequest);
const wss = new WebSocket.Server({ server: httpServer });

function loadAgentState() {
  try {
    if (!fs.existsSync(AGENT_STATE_PATH)) {
      return new Map();
    }

    const raw = fs.readFileSync(AGENT_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      return new Map();
    }

    return new Map(
      parsed
        .filter((entry) => entry && typeof entry.agentId === "string")
        .map((entry) => [entry.agentId, entry])
    );
  } catch (error) {
    console.log(`[warn] failed to load state: ${error.message}`);
    return new Map();
  }
}

function persistAgentState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    fs.writeFileSync(
      AGENT_STATE_PATH,
      JSON.stringify(Array.from(agentState.values()), null, 2),
      "utf8"
    );
  } catch (error) {
    console.log(`[warn] failed to persist state: ${error.message}`);
  }
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogFilePath(name) {
  const date = new Date().toISOString().slice(0, 10);
  ensureLogDir();
  return path.join(LOG_DIR, `${name}-${date}.jsonl`);
}

function appendLog(name, payload) {
  try {
    const entry = {
      time: new Date().toISOString(),
      ...payload
    };
    fs.appendFileSync(getLogFilePath(name), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.log(`[warn] failed to write log ${name}: ${error.message}`);
  }
}

function safeParse(message) {
  try {
    return JSON.parse(message.toString());
  } catch (error) {
    return null;
  }
}

function sendJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  const encoded = JSON.stringify(payload);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(encoded);
    }
  });
}

function pushActivity(entry) {
  const item = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    time: new Date().toISOString(),
    ...entry
  };

  recentActivity.push(item);

  if (recentActivity.length > MAX_ACTIVITY_ITEMS) {
    recentActivity.splice(0, recentActivity.length - MAX_ACTIVITY_ITEMS);
  }

  broadcast({
    type: "ACTIVITY_EVENT",
    activity: item
  });

  return item;
}

function requestAgentStateSync() {
  const encoded = JSON.stringify({ type: "SYNC_AGENT_STATE" });

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    if (client.meta.role !== "extension-background") {
      return;
    }

    client.send(encoded);
  });
}

function forwardToRole(role, payload) {
  let delivered = 0;
  const encoded = JSON.stringify(payload);

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    if (client.meta?.role !== role) {
      return;
    }

    client.send(encoded);
    delivered += 1;
  });

  return delivered;
}

function forwardToAgent(agentId, payload) {
  let delivered = 0;

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!client.meta.agentIds.has(agentId)) {
      return;
    }

    client.send(JSON.stringify(payload));
    delivered += 1;
  });

  return delivered;
}

function replayStateToDashboard(ws) {
  const connectedAgentIds = getConnectedAgentIds();

  for (const [agentId, agent] of agentState.entries()) {
    sendJson(ws, {
      type: "AGENT_REGISTERED",
      agentId,
      connected: connectedAgentIds.has(agentId),
      browser: agent.browser || "Unknown",
      firstSeenAt: agent.firstSeenAt || null,
      lastSeenAt: agent.lastSeenAt || null,
      offlineSince: agent.offlineSince || null,
      site: agent.site || null,
      title: agent.title || null,
      url: agent.url || null,
      tabId: agent.tabId || null,
      busy: Boolean(agent.busy),
      composerMode: agent.composerMode || "default"
    });

    if (agent.lastText) {
      sendJson(ws, {
        type: "TEXT_UPDATE",
        agentId,
        connected: connectedAgentIds.has(agentId),
        browser: agent.browser || "Unknown",
        firstSeenAt: agent.firstSeenAt || null,
        lastSeenAt: agent.lastSeenAt || null,
        offlineSince: agent.offlineSince || null,
        site: agent.site || null,
        title: agent.title || null,
        url: agent.url || null,
        busy: Boolean(agent.busy),
        composerMode: agent.composerMode || "default",
        text: agent.lastText,
        timestamp: agent.timestamp || Date.now()
      });
    }
  }
}

function getConnectedAgentIds() {
  const connectedAgentIds = new Set();

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    if (client.meta?.role !== "extension-background") {
      return;
    }

    client.meta.agentIds.forEach((agentId) => {
      connectedAgentIds.add(agentId);
    });
  });

  return connectedAgentIds;
}

function getAgentSnapshot(agentId, connectedAgentIds = getConnectedAgentIds()) {
  const agent = agentState.get(agentId);

  if (!agent) {
    return null;
  }

  return {
    agentId,
    connected: connectedAgentIds.has(agentId),
    browser: agent.browser || "Unknown",
    firstSeenAt: agent.firstSeenAt || null,
    lastSeenAt: agent.lastSeenAt || null,
    offlineSince: agent.offlineSince || null,
    site: agent.site || null,
    title: agent.title || null,
    url: agent.url || null,
    tabId: agent.tabId || null,
    busy: Boolean(agent.busy),
    composerMode: agent.composerMode || "default",
    contentVersion: agent.contentVersion || null,
    backgroundVersion: agent.backgroundVersion || null,
    lastText: agent.lastText || "",
    timestamp: agent.timestamp || null
  };
}

function resolveAgentWaiters(agentId, snapshot) {
  const waiters = agentWaiters.get(agentId);

  if (!waiters || waiters.length === 0) {
    return;
  }

  const remaining = [];

  for (const waiter of waiters) {
    const timestampOk =
      !waiter.minTimestamp || (snapshot.timestamp || 0) >= waiter.minTimestamp;
    const textChanged = snapshot.lastText !== waiter.previousText;

    if (timestampOk && textChanged) {
      clearTimeout(waiter.timer);
      waiter.resolve(snapshot);
      continue;
    }

    remaining.push(waiter);
  }

  if (remaining.length === 0) {
    agentWaiters.delete(agentId);
    return;
  }

  agentWaiters.set(agentId, remaining);
}

function waitForAgentReply(agentId, previousText, timeoutMs, minTimestamp) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = agentWaiters.get(agentId) || [];
      const remaining = waiters.filter((waiter) => waiter.timer !== timer);

      if (remaining.length === 0) {
        agentWaiters.delete(agentId);
      } else {
        agentWaiters.set(agentId, remaining);
      }

      reject(new Error("TIMEOUT"));
    }, timeoutMs);

    const nextWaiters = agentWaiters.get(agentId) || [];
    nextWaiters.push({
      previousText,
      minTimestamp,
      timer,
      resolve
    });
    agentWaiters.set(agentId, nextWaiters);
  });
}

function updateAgentRegistration(message) {
  const agentId = message.agentId;

  if (!agentId) {
    return null;
  }

  const previous = agentState.get(agentId) || {};
  const next = {
    agentId,
    browser: message.browser || previous.browser || "Unknown",
    firstSeenAt: previous.firstSeenAt || Date.now(),
    lastSeenAt: Date.now(),
    offlineSince: null,
    site: message.site || previous.site || null,
    title: message.title || previous.title || null,
    url: message.url || previous.url || null,
    tabId: message.tabId || previous.tabId || null,
    busy: Boolean(message.busy ?? previous.busy),
    composerMode: message.composerMode || previous.composerMode || "default",
    contentVersion: message.contentVersion || previous.contentVersion || null,
    backgroundVersion: message.backgroundVersion || previous.backgroundVersion || null,
    lastText: previous.lastText || "",
    timestamp: previous.timestamp || null
  };

  agentState.set(agentId, next);
  persistAgentState();
  pushActivity({
    kind: "status",
    agentId,
    site: next.site || null,
    title: next.title || null,
    text: "Tab is online."
  });
  return next;
}

function updateAgentText(message) {
  const agentId = message.agentId;

  if (!agentId) {
    return null;
  }

  const previous = agentState.get(agentId) || {};
  const next = {
    agentId,
    browser: message.browser || previous.browser || "Unknown",
    firstSeenAt: previous.firstSeenAt || Date.now(),
    lastSeenAt: Date.now(),
    offlineSince: null,
    site: message.site || previous.site || null,
    title: message.title || previous.title || null,
    url: message.url || previous.url || null,
    tabId: previous.tabId || null,
    busy: Boolean(message.busy ?? previous.busy),
    composerMode: message.composerMode || previous.composerMode || "default",
    contentVersion: message.contentVersion || previous.contentVersion || null,
    backgroundVersion: message.backgroundVersion || previous.backgroundVersion || null,
    lastText: message.text || "",
    timestamp: Date.now()
  };

  agentState.set(agentId, next);
  persistAgentState();
  pushActivity({
    kind: "reply",
    agentId,
    site: next.site || null,
    title: next.title || null,
    text: extractLatestReplyText(next) || next.lastText || ""
  });
  resolveAgentWaiters(agentId, getAgentSnapshot(agentId));
  return next;
}

function sendCommandToAgent(agentId, text, mode = "default", useToolsMenu = false) {
  const inspection = inspectOutgoingText(text);

  if (!inspection.ok) {
    appendLog("send-blocked", {
      agentId,
      mode,
      inspection,
      preview: String(text || "").slice(0, 300)
    });
    const error = new Error(inspection.code);
    error.code = inspection.code;
    error.inspection = inspection;
    throw error;
  }

  appendLog("send-command", {
    agentId,
    mode,
    useToolsMenu,
    textLength: text.length,
    preview: text.slice(0, 300)
  });
  const agent = agentState.get(agentId) || {};
  pushActivity({
    kind: "request",
    agentId,
    site: agent.site || null,
    title: agent.title || null,
    text
  });
  return forwardToAgent(agentId, {
    type: "SEND_TO_AGENT",
    agentId,
    text,
    mode,
    useToolsMenu,
    timestamp: Date.now()
  });
}

function ensureAgentGeneration(agentId) {
  appendLog("ensure-generation", {
    agentId
  });
  return forwardToAgent(agentId, {
    type: "ENSURE_AGENT_GENERATION",
    agentId,
    timestamp: Date.now()
  });
}

function diagnoseSlashMenu(agentId) {
  appendLog("slash-menu-diagnose", {
    agentId
  });
  return forwardToAgent(agentId, {
    type: "DIAGNOSE_SLASH_MENU",
    agentId,
    timestamp: Date.now()
  });
}

function observeRawText(agentId, text, waitMs) {
  appendLog("raw-text-observe", {
    agentId,
    textLength: String(text || "").length,
    preview: String(text || "").slice(0, 100),
    waitMs: Number(waitMs) || null
  });
  return forwardToAgent(agentId, {
    type: "OBSERVE_RAW_TEXT",
    agentId,
    text: String(text || ""),
    waitMs,
    timestamp: Date.now()
  });
}

function normalizeDelayMs(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(number), 0), 300000);
}

function normalizeTimeoutMs(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(Math.max(Math.floor(number), 1000), 300000);
}

function getSquadSnapshot() {
  const state = loadSquadState();
  const activeRun = getActiveRun(state);
  const nextTask = getNextQueueItem(state);
  const notifications = getRecentNotifications(state, 10);

  return {
    goals: state.goals || [],
    queue: state.queue || [],
    activeRun,
    nextTask,
    notifications,
    lastUpdatedAt: state.lastUpdatedAt || null
  };
}

function getScenarioSnapshot() {
  return loadScenarioPacks();
}

function selectRelayAgents(agentIds) {
  const connectedAgentIds = getConnectedAgentIds();

  if (Array.isArray(agentIds) && agentIds.length > 0) {
    return agentIds
      .map((agentId) => getAgentSnapshot(agentId, connectedAgentIds))
      .filter((agent) => agent?.connected)
      .filter(Boolean)
      .slice(0, 2);
  }

  return Array.from(connectedAgentIds.keys())
    .sort((left, right) => left.localeCompare(right))
    .map((agentId) => getAgentSnapshot(agentId, connectedAgentIds))
    .filter(Boolean)
    .slice(0, 2);
}

function extractLatestReplyText(agent) {
  const text = (agent?.lastText || "").trim();

  if (!text) {
    return "";
  }

  const blocks = text
    .split("\n\n--------------------\n\n")
    .map((block) => block.trim())
    .filter(Boolean);

  const labels = [];

  if (agent?.site === "chatgpt") {
    labels.push("ChatGPT:\n");
  }

  if (agent?.site === "gemini") {
    labels.push("Gemini:\n");
  }

  labels.push("ChatGPT:\n", "Gemini:\n");

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];

    for (const label of labels) {
      if (block.startsWith(label)) {
        return block.slice(label.length).trim();
      }
    }
  }

  return text;
}

async function askAgentAndWait(agentId, text, timeoutMs) {
  const agent = getAgentSnapshot(agentId);

  if (!agent) {
    throw new Error("AGENT_NOT_FOUND");
  }

  const delivered = sendCommandToAgent(agentId, text);

  if (delivered === 0) {
    throw new Error("AGENT_NOT_CONNECTED");
  }

  const snapshot = await waitForAgentReply(
    agentId,
    agent.lastText || "",
    timeoutMs,
    Date.now()
  );

  return {
    delivered,
    agent: snapshot,
    latestReply: extractLatestReplyText(snapshot)
  };
}

function formatRelayMessage(question, results) {
  const sections = [];

  sections.push(`Question:\n${question}`);

  results.forEach((result, index) => {
    const title = result.agent.title || result.agent.agentId;
    const browser = result.agent.browser || "Unknown";
    const site = (result.agent.site || "agent").toUpperCase();
    const reply = result.latestReply || result.agent.lastText || "(no reply)";

    sections.push(
      `Agent ${index + 1}: ${site} ${browser}\nTitle: ${title}\n\n${reply}`
    );
  });

  return sections.join("\n\n====================\n\n");
}

function pasteTextIntoFocusedWindow(text, delayMs, submit = true) {
  return new Promise((resolve, reject) => {
    try {
      if (!fs.existsSync(SCRIPTS_DIR)) {
        fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
      }

      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const tempPath = path.join(
        DATA_DIR,
        `focused-paste-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
      );

      fs.writeFileSync(tempPath, text, "utf8");

      const child = spawn(
        "powershell.exe",
        [
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          PASTE_SCRIPT_PATH,
          "-TextPath",
          tempPath,
          "-DelayMs",
          String(delayMs),
          ...(submit ? [] : ["-NoSubmit"])
        ],
        {
          windowsHide: true
        }
      );

      let stderr = "";

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        try {
          fs.unlinkSync(tempPath);
        } catch (unlinkError) {}

        reject(error);
      });

      child.on("close", (code) => {
        try {
          fs.unlinkSync(tempPath);
        } catch (unlinkError) {}

        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `PASTE_FAILED_${code}`));
      });
    } catch (error) {
      reject(error);
    }
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function writeBuffer(res, statusCode, contentType, content) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": contentType
  });
  res.end(content);
}

function getContentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function tryServeDashboard(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) {
    return false;
  }

  if (pathname === "/health" || pathname.startsWith("/api/")) {
    return false;
  }

  const requestedPath =
    pathname === "/" ? "index.html" : decodeURIComponent(pathname.replace(/^\/+/, ""));
  const resolvedPath = path.resolve(DIST_DIR, requestedPath);

  if (!resolvedPath.startsWith(DIST_DIR)) {
    return false;
  }

  let filePath = resolvedPath;

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    if (path.extname(requestedPath)) {
      return false;
    }

    filePath = path.join(DIST_DIR, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = req.method === "HEAD" ? "" : fs.readFileSync(filePath);
  writeBuffer(res, 200, getContentType(filePath), content);
  return true;
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString("utf8");

      if (body.length > 1024 * 1024) {
        reject(new Error("BODY_TOO_LARGE"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("INVALID_JSON"));
      }
    });

    req.on("error", reject);
  });
}

function readUtf8IfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return "";
    }

    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return "";
  }
}

function parseCsv(text) {
  const raw = String(text || "").trim();

  if (!raw) {
    return [];
  }

  const lines = raw
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return [];
  }

  const headers = splitCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    const record = {};

    headers.forEach((header, index) => {
      record[header] = values[index] || "";
    });

    return record;
  });
}

function splitCsvLine(line) {
  const values = [];
  let current = "";
  let insideQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (insideQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
      continue;
    }

    if (char === "," && !insideQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function extractMarkdownBullets(text, heading) {
  const lines = String(text || "").split(/\r?\n/g);
  const startIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === heading.trim().toLowerCase()
  );

  if (startIndex === -1) {
    return [];
  }

  const items = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      if (items.length > 0) {
        break;
      }
      continue;
    }

    if (trimmed.startsWith("## ") || trimmed.startsWith("### ")) {
      break;
    }

    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    }
  }

  return items;
}

function extractNumberedSteps(text, heading) {
  const lines = String(text || "").split(/\r?\n/g);
  const startIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === heading.trim().toLowerCase()
  );

  if (startIndex === -1) {
    return [];
  }

  const items = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("## ")) {
      break;
    }

    if (/^\d+\./.test(trimmed)) {
      items.push(trimmed.replace(/^\d+\.\s*/, "").trim());
    }
  }

  return items;
}

function extractSubheadings(text, heading) {
  const lines = String(text || "").split(/\r?\n/g);
  const startIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === heading.trim().toLowerCase()
  );

  if (startIndex === -1) {
    return [];
  }

  const items = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("## ")) {
      break;
    }

    if (trimmed.startsWith("### ")) {
      items.push(trimmed.slice(4).trim());
    }
  }

  return items;
}

function extractFirstInlineCode(text) {
  const match = String(text || "").match(/`([^`]+)`/);
  return match ? match[1].trim() : "";
}

function extractHeadingTitle(text) {
  const match = String(text || "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function extractRouteCode(text) {
  const match = String(text || "").match(/`([^`]*->[^`]*)`/);
  return match ? match[1].trim() : "";
}

function extractSectionParagraph(text, heading) {
  const lines = String(text || "").split(/\r?\n/g);
  const startIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === heading.trim().toLowerCase()
  );

  if (startIndex === -1) {
    return "";
  }

  const chunks = [];

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();

    if (!trimmed) {
      if (chunks.length > 0) {
        break;
      }
      continue;
    }

    if (trimmed.startsWith("## ")) {
      break;
    }

    chunks.push(trimmed);
  }

  return chunks.join(" ");
}

function getLegacyProjectStatusSnapshotDoNotUse() {
  const growthPlan = readUtf8IfExists(
    path.join(PROJECT_STATUS_DIR, "project-growth-plan-v1.md")
  );
  const resourcePlan = readUtf8IfExists(
    path.join(PROJECT_STATUS_DIR, "resource-plan-v2.md")
  );
  const sprintOffer = readUtf8IfExists(
    path.join(PROJECT_STATUS_DIR, "dormant-pipeline-audit-sprint.md")
  );
  const proofPlan = readUtf8IfExists(
    path.join(PROJECT_STATUS_DIR, "proof-plan-v1.md")
  );
  const sendReady = parseCsv(
    readUtf8IfExists(
      path.join(PROJECT_STATUS_DIR, "assets", "send-ready-batch-v1.csv")
    )
  );
  const directWave = parseCsv(
    readUtf8IfExists(
      path.join(PROJECT_STATUS_DIR, "assets", "expanded-live-wave-v1.csv")
    )
  );
  const nearboundWave = parseCsv(
    readUtf8IfExists(
      path.join(PROJECT_STATUS_DIR, "assets", "nearbound-seed-v1.csv")
    )
  );
  const waveTracker = parseCsv(
    readUtf8IfExists(
      path.join(PROJECT_STATUS_DIR, "assets", "cold-warm-wave-tracker-v1.csv")
    )
  );
  const connectedAgents = getConnectedAgentIds();

  return {
    generatedAt: new Date().toISOString(),
    offer: {
      title: extractHeadingTitle(sprintOffer) || "Old Leads to Meetings",
      summary:
        extractSectionParagraph(sprintOffer, "## Promise") ||
        "Turn one dormant CRM segment into qualified replies, meetings, and revived opportunities."
    },
    positioning:
      extractSectionParagraph(sprintOffer, "## Positioning") ||
      "Done-for-you execution",
    buyerOutcomes: extractMarkdownBullets(
      sprintOffer,
      "## What the client is really buying"
    ),
    proofPlan: extractMarkdownBullets(proofPlan, "## Minimum proof package"),
    currentFocus:
      extractRouteCode(resourcePlan) ||
      extractFirstInlineCode(resourcePlan) ||
      "target -> reply -> short call -> paid pilot offer -> paid pilot",
    roadmap:
      extractSubheadings(growthPlan, "## План 1-10").length > 0
        ? extractSubheadings(growthPlan, "## План 1-10")
        : extractNumberedSteps(growthPlan, "## План 1-10"),
    milestones: extractSubheadings(growthPlan, "## Три ближайших вехи"),
    directWave,
    nearboundWave: nearboundWave.slice(0, 7),
    sendReady,
    trackerSummary: {
      total: waveTracker.length,
      ready: waveTracker.filter((item) => item.status === "ready").length,
      queued: waveTracker.filter((item) => item.status === "queued").length,
      direct: waveTracker.filter((item) => item.lane === "direct").length,
      warm: waveTracker.filter((item) => item.lane === "warm").length
    },
    agents: {
      totalKnown: agentState.size,
      connected: connectedAgents.size
    }
  };
}

function resolveProjectRoot() {
  const configuredPath = process.env.BROAGENTS_PROJECT_DIR;

  if (configuredPath && configuredPath.trim()) {
    return path.resolve(configuredPath.trim());
  }

  return path.resolve(BROAGENTS_DIR, "..");
}

function shouldSkipProjectEntry(name) {
  if (name.startsWith("_BROAGENTS_SANDBOX")) {
    return true;
  }

  return [
    ".git",
    ".next",
    ".vscode",
    "BROAGENTS",
    "backups",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "release"
  ].includes(name);
}

function collectProjectFiles(rootDir, extensions, limit = 8, maxDepth = 3) {
  const matches = [];

  function visit(currentDir, depth) {
    if (matches.length >= limit || depth > maxDepth || !fs.existsSync(currentDir)) {
      return;
    }

    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (matches.length >= limit) {
        return;
      }

      if (entry.isDirectory()) {
        if (!shouldSkipProjectEntry(entry.name)) {
          visit(path.join(currentDir, entry.name), depth + 1);
        }
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();

      if (!extensions.includes(extension)) {
        continue;
      }

      matches.push(path.relative(rootDir, path.join(currentDir, entry.name)));
    }
  }

  visit(rootDir, 0);
  return matches;
}

function listTopLevelProjectEntries(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => !shouldSkipProjectEntry(entry.name))
    .slice(0, 12)
    .map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "dir" : "file"
    }));
}

function getProjectStatusSnapshot() {
  const markdownFiles = collectProjectFiles(PROJECT_ROOT, [".md"], 8, 3);
  const csvFiles = collectProjectFiles(PROJECT_ROOT, [".csv"], 8, 3);
  const jsonFiles = collectProjectFiles(PROJECT_ROOT, [".json"], 8, 2);
  const firstMarkdown = markdownFiles[0]
    ? readUtf8IfExists(path.join(PROJECT_ROOT, markdownFiles[0]))
    : "";
  const connectedAgents = getConnectedAgentIds();

  return {
    generatedAt: new Date().toISOString(),
    projectName: path.basename(PROJECT_ROOT),
    projectRoot: PROJECT_ROOT,
    broagentsRoot: BROAGENTS_DIR,
    summary:
      extractHeadingTitle(firstMarkdown) ||
      "BROAGENTS attached to the current project folder.",
    topLevel: listTopLevelProjectEntries(PROJECT_ROOT),
    markdownFiles,
    csvFiles,
    jsonFiles,
    agents: {
      totalKnown: agentState.size,
      connected: connectedAgents.size
    }
  };
}

function getRouteParts(urlString) {
  const url = new URL(urlString, `http://localhost:${PORT}`);
  return {
    url,
    pathname: url.pathname.replace(/\/+$/, "") || "/",
    parts: url.pathname.split("/").filter(Boolean)
  };
}

async function handleHttpRequest(req, res) {
  if (req.method === "OPTIONS") {
    writeJson(res, 204, {});
    return;
  }

  const { url, pathname, parts } = getRouteParts(req.url);

  if (req.method === "GET" && pathname === "/health") {
    const connectedAgentIds = getConnectedAgentIds();

    writeJson(res, 200, {
      ok: true,
      websocketPort: PORT,
      agents: agentState.size,
      connectedAgents: connectedAgentIds.size
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/agents") {
    const connectedAgentIds = getConnectedAgentIds();

    writeJson(res, 200, {
      agents: Array.from(agentState.keys()).map((agentId) =>
        getAgentSnapshot(agentId, connectedAgentIds)
      )
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/activity") {
    const limit = Math.min(
      Math.max(Number.parseInt(url.searchParams.get("limit") || "18", 10) || 18, 1),
      100
    );

    writeJson(res, 200, {
      activity: recentActivity.slice(-limit)
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/squad/state") {
    writeJson(res, 200, getSquadSnapshot());
    return;
  }

  if (req.method === "GET" && pathname === "/api/scenario-packs") {
    writeJson(res, 200, getScenarioSnapshot());
    return;
  }

  if (req.method === "GET" && pathname === "/api/project-status") {
    writeJson(res, 200, getProjectStatusSnapshot());
    return;
  }

  if (req.method === "POST" && pathname === "/api/sync") {
    requestAgentStateSync();
    writeJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/agent-tabs/open") {
    let body;

    try {
      body = await collectRequestBody(req);
    } catch (error) {
      writeJson(res, 400, { error: error.message });
      return;
    }

    const site =
      typeof body.site === "string" ? body.site.trim().toLowerCase() : "";
    const requestedCount = Number(body.count);
    const count = Number.isFinite(requestedCount)
      ? Math.min(Math.max(Math.trunc(requestedCount), 1), 6)
      : 1;

    if (!["chatgpt", "gemini"].includes(site)) {
      writeJson(res, 400, { error: "SITE_REQUIRED" });
      return;
    }

    let delivered = 0;

    for (let index = 0; index < count; index += 1) {
      delivered += forwardToRole("extension-background", {
        type: "OPEN_AGENT_TAB",
        site
      });
    }

    if (delivered === 0) {
      writeJson(res, 409, { error: "NO_EXTENSION_CLIENT" });
      return;
    }

    writeJson(res, 200, {
      ok: true,
      site,
      count,
      delivered
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/focused-window/paste") {
    let body;

    try {
      body = await collectRequestBody(req);
    } catch (error) {
      writeJson(res, 400, { error: error.message });
      return;
    }

    const text = typeof body.text === "string" ? body.text : "";

    if (!text.trim()) {
      writeJson(res, 400, { error: "TEXT_REQUIRED" });
      return;
    }

    const delayMs = normalizeDelayMs(body.delayMs, 3000);
    const submit = body.submit !== false;

    try {
      await pasteTextIntoFocusedWindow(text, delayMs, submit);
      writeJson(res, 200, { ok: true, delayMs, submit });
    } catch (error) {
      writeJson(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/relay/two-agents-to-focused-window") {
    let body;

    try {
      body = await collectRequestBody(req);
    } catch (error) {
      writeJson(res, 400, { error: error.message });
      return;
    }

    const question =
      typeof body.question === "string" && body.question.trim()
        ? body.question.trim()
        : "Briefly report what you can do next and what is currently blocking you.";
    const delayMs = normalizeDelayMs(body.delayMs, 5000);
    const timeoutMs = normalizeTimeoutMs(body.timeoutMs, 120000);
    const selectedAgents = selectRelayAgents(body.agentIds);

    if (selectedAgents.length < 2) {
      writeJson(res, 409, { error: "TWO_AGENTS_REQUIRED" });
      return;
    }

    try {
      const results = [];

      for (const agent of selectedAgents) {
        results.push(await askAgentAndWait(agent.agentId, question, timeoutMs));
      }

      const text = formatRelayMessage(question, results);
      await pasteTextIntoFocusedWindow(text, delayMs);

      writeJson(res, 200, {
        ok: true,
        delayMs,
        timeoutMs,
        question,
        agents: results.map((result) => ({
          agentId: result.agent.agentId,
          site: result.agent.site,
          browser: result.agent.browser,
          title: result.agent.title
        }))
      });
    } catch (error) {
      writeJson(res, 500, { error: error.message });
    }
    return;
  }

  if (parts[0] === "api" && parts[1] === "agents" && parts[2]) {
    const agentId = decodeURIComponent(parts[2]);

    if (req.method === "GET" && parts.length === 3) {
      const agent = getAgentSnapshot(agentId);

      if (!agent) {
        writeJson(res, 404, { error: "AGENT_NOT_FOUND" });
        return;
      }

      writeJson(res, 200, agent);
      return;
    }

    if (req.method === "GET" && parts[3] === "wait") {
      const agent = getAgentSnapshot(agentId);

      if (!agent) {
        writeJson(res, 404, { error: "AGENT_NOT_FOUND" });
        return;
      }

      const timeoutMs = Math.min(
        Math.max(Number(url.searchParams.get("timeoutMs")) || 60000, 1000),
        300000
      );
      const since = Number(url.searchParams.get("since")) || Date.now();

      try {
        const snapshot = await waitForAgentReply(
          agentId,
          agent.lastText || "",
          timeoutMs,
          since
        );
        writeJson(res, 200, { ok: true, agent: snapshot });
      } catch (error) {
        writeJson(res, 408, { error: "TIMEOUT", agent: getAgentSnapshot(agentId) });
      }
      return;
    }

    if (req.method === "POST" && parts[3] === "send") {
      const agent = getAgentSnapshot(agentId);

      if (!agent) {
        writeJson(res, 404, { error: "AGENT_NOT_FOUND" });
        return;
      }

      let body;

      try {
        body = await collectRequestBody(req);
      } catch (error) {
        writeJson(res, 400, { error: error.message });
        return;
      }

      const text = typeof body.text === "string" ? body.text.trim() : "";
      const mode = typeof body.mode === "string" ? body.mode.trim() || "default" : "default";
      const useToolsMenu = Boolean(body.useToolsMenu);

      if (!text) {
        writeJson(res, 400, { error: "TEXT_REQUIRED" });
        return;
      }

      const inspection = inspectOutgoingText(text);

      if (!inspection.ok) {
        writeJson(res, 400, {
          error: inspection.code,
          reason: inspection.reason,
          inspection
        });
        return;
      }

      let delivered;

      try {
        delivered = sendCommandToAgent(agentId, text, mode, useToolsMenu);
      } catch (error) {
        writeJson(res, 400, {
          error: error.code || error.message || "SEND_BLOCKED",
          inspection: error.inspection || null
        });
        return;
      }

      if (delivered === 0) {
        writeJson(res, 409, { error: "AGENT_NOT_CONNECTED" });
        return;
      }

      const shouldWait = Boolean(body.waitForReply);

      if (!shouldWait) {
        writeJson(res, 200, {
          ok: true,
          delivered,
          agent: getAgentSnapshot(agentId)
        });
        return;
      }

      const timeoutMs = Math.min(
        Math.max(Number(body.timeoutMs) || 120000, 1000),
        300000
      );
      const minTimestamp = Date.now();

      try {
        const snapshot = await waitForAgentReply(
          agentId,
          agent.lastText || "",
          timeoutMs,
          minTimestamp
        );
        writeJson(res, 200, {
          ok: true,
          delivered,
          agent: snapshot
        });
      } catch (error) {
        writeJson(res, 408, {
          error: "TIMEOUT",
          delivered,
          agent: getAgentSnapshot(agentId)
        });
      }
      return;
    }

    if (req.method === "POST" && parts[3] === "ensure-start") {
      const agent = getAgentSnapshot(agentId);

      if (!agent) {
        writeJson(res, 404, { error: "AGENT_NOT_FOUND" });
        return;
      }

      const delivered = ensureAgentGeneration(agentId);

      if (delivered === 0) {
        writeJson(res, 409, { error: "AGENT_NOT_CONNECTED" });
        return;
      }

      writeJson(res, 200, {
        ok: true,
        delivered,
        agent: getAgentSnapshot(agentId)
      });
      return;
    }

    if (req.method === "POST" && parts[3] === "diagnose-slash") {
      const agent = getAgentSnapshot(agentId);

      if (!agent) {
        writeJson(res, 404, { error: "AGENT_NOT_FOUND" });
        return;
      }

      const delivered = diagnoseSlashMenu(agentId);

      if (delivered === 0) {
        writeJson(res, 409, { error: "AGENT_NOT_CONNECTED" });
        return;
      }

      writeJson(res, 200, {
        ok: true,
        delivered,
        agent: getAgentSnapshot(agentId)
      });
      return;
    }

    if (req.method === "POST" && parts[3] === "observe-input") {
      const agent = getAgentSnapshot(agentId);

      if (!agent) {
        writeJson(res, 404, { error: "AGENT_NOT_FOUND" });
        return;
      }

      let body;

      try {
        body = await collectRequestBody(req);
      } catch (error) {
        writeJson(res, 400, { error: error.message });
        return;
      }

      const text = typeof body.text === "string" ? body.text : "";
      const waitMs = Number(body.waitMs) || 1800;

      if (!text) {
        writeJson(res, 400, { error: "TEXT_REQUIRED" });
        return;
      }

      const delivered = observeRawText(agentId, text, waitMs);

      if (delivered === 0) {
        writeJson(res, 409, { error: "AGENT_NOT_CONNECTED" });
        return;
      }

      writeJson(res, 200, {
        ok: true,
        delivered,
        agent: getAgentSnapshot(agentId)
      });
      return;
    }
  }

  if (tryServeDashboard(req, res, pathname)) {
    return;
  }

  writeJson(res, 404, { error: "NOT_FOUND" });
}

wss.on("connection", (ws, request) => {
  const clientId = nextClientId++;

  ws.meta = {
    id: clientId,
    role: "unknown",
    agentIds: new Set()
  };

  console.log(
    `[connect] client=${clientId} ip=${request.socket.remoteAddress || "unknown"}`
  );

  sendJson(ws, {
    type: "SERVER_READY",
    clientId
  });

  ws.on("message", (rawMessage) => {
    const message = safeParse(rawMessage);

    if (!message || typeof message.type !== "string") {
      console.log(`[warn] client=${clientId} invalid JSON message`);
      return;
    }

    switch (message.type) {
      case "REGISTER_CLIENT": {
        ws.meta.role = message.clientType || "unknown";
        appendLog("events", {
          source: "server",
          event: "register_client",
          clientId,
          role: ws.meta.role
        });
        console.log(
          `[register-client] client=${clientId} role=${ws.meta.role}`
        );

        if (ws.meta.role === "dashboard") {
          replayStateToDashboard(ws);
          requestAgentStateSync();
        }
        break;
      }

      case "REGISTER_AGENT": {
        const agent = updateAgentRegistration(message);

        if (!agent) {
          return;
        }

        ws.meta.agentIds.add(agent.agentId);
        appendLog("events", {
          source: "server",
          event: "register_agent",
          clientId,
          agentId: agent.agentId,
          site: agent.site,
          title: agent.title,
          url: agent.url
        });

        console.log(
          `[register-agent] client=${clientId} agent=${agent.agentId} site=${agent.site || "unknown"}`
        );

        broadcast({
          type: "AGENT_REGISTERED",
          clientId,
          agentId: agent.agentId,
          connected: true,
          browser: agent.browser,
          firstSeenAt: agent.firstSeenAt,
          lastSeenAt: agent.lastSeenAt,
          offlineSince: null,
          site: agent.site,
          title: agent.title,
          url: agent.url,
          tabId: agent.tabId,
          busy: Boolean(agent.busy),
          composerMode: agent.composerMode || "default"
        });
        break;
      }

      case "UNREGISTER_AGENT": {
        const agentId = message.agentId;

        if (!agentId) {
          return;
        }

        ws.meta.agentIds.delete(agentId);
        const previous = agentState.get(agentId);

        if (previous) {
          agentState.set(agentId, {
            ...previous,
            offlineSince: Date.now()
          });
          persistAgentState();
          pushActivity({
            kind: "status",
            agentId,
            site: previous.site || null,
            title: previous.title || null,
            text: "Tab went offline."
          });
        }

        console.log(`[unregister-agent] client=${clientId} agent=${agentId}`);
        appendLog("events", {
          source: "server",
          event: "unregister_agent",
          clientId,
          agentId
        });

        broadcast({
          type: "UNREGISTER_AGENT",
          agentId
        });
        break;
      }

      case "TEXT_UPDATE": {
        const agent = updateAgentText(message);
        appendLog("text-updates", {
          source: "server",
          clientId,
          agentId: message.agentId || null,
          site: agent?.site || message.site || null,
          title: agent?.title || message.title || null,
          textLength: (message.text || "").length,
          preview: (message.text || "").slice(0, 500)
        });

        console.log(
          `[text-update] client=${clientId} agent=${message.agentId || "unknown"}`
        );

        broadcast({
          type: "TEXT_UPDATE",
          agentId: message.agentId || null,
          connected: true,
          browser: agent?.browser || message.browser || "Unknown",
          firstSeenAt: agent?.firstSeenAt || null,
          lastSeenAt: agent?.lastSeenAt || null,
          offlineSince: null,
          site: agent?.site || message.site || null,
          text: message.text || "",
          url: agent?.url || message.url || null,
          title: agent?.title || message.title || null,
          busy: Boolean(agent?.busy ?? message.busy),
          composerMode: agent?.composerMode || message.composerMode || "default",
          timestamp: agent?.timestamp || Date.now()
        });
        break;
      }

      case "SEND_TO_AGENT": {
        const agentId = message.agentId;

        if (!agentId) {
          return;
        }

        const text = message.text || "";
        const mode = typeof message.mode === "string" ? message.mode : "default";
        const inspection = inspectOutgoingText(text);

        if (!inspection.ok) {
          appendLog("events", {
            source: "server",
            event: "send_to_agent_blocked",
            clientId,
            agentId,
            mode,
            inspection
          });
          console.log(
            `[send-to-agent-blocked] from=${clientId} agent=${agentId} code=${inspection.code}`
          );
          return;
        }

        const delivered = sendCommandToAgent(agentId, text, mode);

        console.log(
          `[send-to-agent] from=${clientId} agent=${agentId} delivered=${delivered}`
        );
        appendLog("events", {
          source: "server",
          event: "send_to_agent",
          clientId,
          agentId,
          delivered
        });
        break;
      }

      case "LOG_EVENT": {
        appendLog("bridge-debug", {
          source: message.source || "unknown",
          clientId,
          agentId: message.agentId || null,
          browser: message.browser || null,
          site: message.site || null,
          tabId: message.tabId || null,
          url: message.url || null,
          title: message.title || null,
          event: message.event || "log_event",
          details: message.details || {}
        });
        break;
      }

      default: {
        console.log(
          `[warn] client=${clientId} unsupported type=${message.type}`
        );
      }
    }
  });

  ws.on("close", () => {
    console.log(`[disconnect] client=${clientId} role=${ws.meta.role}`);

    if (ws.meta.role === "extension-background") {
      ws.meta.agentIds.forEach((agentId) => {
        const previous = agentState.get(agentId);

        if (previous) {
          agentState.set(agentId, {
            ...previous,
            offlineSince: Date.now()
          });
          pushActivity({
            kind: "status",
            agentId,
            site: previous.site || null,
            title: previous.title || null,
            text: "Tab disconnected."
          });
        }

        broadcast({
          type: "UNREGISTER_AGENT",
          agentId
        });
      });

      if (ws.meta.agentIds.size > 0) {
        persistAgentState();
      }
    }
  });

  ws.on("error", (error) => {
    console.log(`[error] client=${clientId} message=${error.message}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`BROAGENTS dashboard is running on http://127.0.0.1:${PORT}`);
  console.log(`BROAGENTS WebSocket server is running on ws://localhost:${PORT}`);
  console.log(`BROAGENTS project root: ${PROJECT_ROOT}`);
  console.log(
    `[state] restored ${agentState.size} agent(s) from ${AGENT_STATE_PATH}`
  );
});
