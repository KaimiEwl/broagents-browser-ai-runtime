import { useEffect, useMemo, useRef, useState } from "react";
import { getRolePrompt } from "./rolePrompts";

const WS_URL = "ws://localhost:8080";
const HTTP_URL = "http://localhost:8080";
const RECONNECT_DELAY_MS = 2000;
const ROLE_STORAGE_KEY = "agent-sreda-role-assignments";
const ROLE_ORDER = ["researcher", "critic", "synthesizer"];
const ROLE_META = {
  researcher: {
    label: "Исследователь",
    shortLabel: "R",
    color: "#2563eb",
    description: "Ищет варианты и собирает факты."
  },
  critic: {
    label: "Критик",
    shortLabel: "C",
    color: "#f59e0b",
    description: "Ищет слабые места и риски."
  },
  synthesizer: {
    label: "Синтезатор",
    shortLabel: "S",
    color: "#10b981",
    description: "Собирает итог и рекомендует действие."
  }
};
const SEND_MODE_META = {
  default: {
    label: "Обычный",
    description: "Просто отправить сообщение как есть."
  },
  web_search: {
    label: "Поиск в сети",
    description: "Попробовать включить web search перед отправкой."
  },
  deep_research: {
    label: "Глубокое исследование",
    description: "Попробовать включить deep research."
  },
  extended_thinking: {
    label: "Глубокое мышление",
    description: "Попробовать включить расширенное размышление."
  },
  agent_mode: {
    label: "Режим агента",
    description: "Попробовать переключить вкладку в agent mode."
  }
};

function normalizeBrowser(browser) {
  if (!browser || browser === "Unknown" || browser === "Browser") {
    return "Chrome";
  }

  return browser;
}

function normalizeSite(site) {
  if (site === "chatgpt") {
    return "ChatGPT";
  }

  if (site === "gemini") {
    return "Gemini";
  }

  return site || "Unknown";
}

function getAvailableSendModes(agent) {
  if (agent?.site === "chatgpt") {
    return ["default", "web_search", "deep_research", "extended_thinking", "agent_mode"];
  }

  return ["default"];
}

function inspectOutgoingText(text) {
  const value = String(text || "").trim();

  if (!value) {
    return {
      ok: false,
      code: "EMPTY_TEXT"
    };
  }

  const hasCyrillic = /[А-Яа-яЁё]/.test(value);
  const hasLatin = /[A-Za-z]/.test(value);
  const questionCount = (value.match(/\?/g) || []).length;
  const replacementCharCount = (value.match(/\uFFFD/g) || []).length;
  const mojibakeMatches = value.match(/[ÐÑ][^\s]{0,2}/g) || [];
  const stripped = value.replace(/[?\s.,!;:()"'`«»\-–—_\/\\[\]{}0-9]+/g, "");
  const onlyQuestionsAndPunctuation = stripped.length === 0;

  if (replacementCharCount > 0) {
    return {
      ok: false,
      code: "TEXT_CORRUPTED_REPLACEMENT_CHAR"
    };
  }

  if (mojibakeMatches.length >= 3) {
    return {
      ok: false,
      code: "TEXT_CORRUPTED_MOJIBAKE"
    };
  }

  if (questionCount >= 5 && onlyQuestionsAndPunctuation && !hasCyrillic && !hasLatin) {
    return {
      ok: false,
      code: "TEXT_CORRUPTED_QUESTION_MARKS"
    };
  }

  return {
    ok: true,
    code: "OK"
  };
}

function isGenericTitle(agent) {
  const title = (agent.title || "").trim().toLowerCase();
  const site = (agent.site || "").trim().toLowerCase();

  if (!title) {
    return true;
  }

  return title === site || title === "chatgpt" || title === "google gemini";
}

function getSessionLabel(agent) {
  if (!agent.url) {
    return `tab ${String(agent.tabId || "").slice(-4) || "----"}`;
  }

  try {
    const url = new URL(agent.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const lastPart = parts[parts.length - 1] || "";

    if (agent.site === "chatgpt" && parts[0] === "c" && lastPart) {
      return `chat ${lastPart.slice(-6)}`;
    }

    if (agent.site === "gemini" && parts[0] === "app" && lastPart && lastPart !== "app") {
      return `session ${lastPart.slice(-6)}`;
    }

    if (url.pathname === "/" || url.pathname === "/app") {
      return `tab ${String(agent.tabId || "").slice(-4) || "----"}`;
    }

    return `${parts[0] || "tab"} ${String(agent.tabId || "").slice(-4) || "----"}`;
  } catch (error) {
    return `tab ${String(agent.tabId || "").slice(-4) || "----"}`;
  }
}

function getReadableTitle(agent) {
  if (!isGenericTitle(agent)) {
    return agent.title;
  }

  return getSessionLabel(agent);
}

function toAgentMap(items) {
  const next = {};

  for (const item of items) {
    if (!item || !item.agentId) {
      continue;
    }

    next[item.agentId] = {
      agentId: item.agentId,
      connected: Boolean(item.connected),
      browser: normalizeBrowser(item.browser),
      firstSeenAt: item.firstSeenAt || null,
      lastSeenAt: item.lastSeenAt || null,
      offlineSince: item.offlineSince || null,
      site: item.site || "unknown",
      title: item.title || "",
      url: item.url || "",
      tabId: item.tabId || null,
      busy: Boolean(item.busy),
      composerMode: item.composerMode || "default",
      lastText: item.lastText || "",
      timestamp: item.timestamp || null
    };
  }

  return next;
}

function formatConnectionStatus(status) {
  if (status === "connected") {
    return "connected";
  }

  if (status === "reconnecting") {
    return "reconnecting";
  }

  if (status === "error") {
    return "error";
  }

  return "disconnected";
}

function trimSnippet(text, limit = 220) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 1).trim()}...`;
}

function isRootSessionUrl(agent) {
  if (!agent?.url) {
    return false;
  }

  try {
    const url = new URL(agent.url);

    if (agent.site === "chatgpt") {
      return url.pathname === "/";
    }

    if (agent.site === "gemini") {
      return url.pathname === "/app";
    }

    return false;
  } catch (error) {
    return false;
  }
}

function getAgentReadiness(agent) {
  const warnings = agent?.transcriptHealth?.warnings || [];
  const hasWarnings = warnings.length > 0;
  const isFreshCandidate =
    Boolean(agent?.connected) && !agent?.hasText && isRootSessionUrl(agent);

  if (isFreshCandidate) {
    return {
      tone: "fresh",
      label: "fresh candidate",
      details: "Good for the next attended consultation run."
    };
  }

  if (hasWarnings) {
    return {
      tone: "dirty",
      label: "needs attention",
      details: warnings.join(", ")
    };
  }

  if (agent?.connected) {
    return {
      tone: "ready",
      label: "ready",
      details: "Connected and usable."
    };
  }

  return {
    tone: "offline",
    label: "offline",
    details: "Snapshot only."
  };
}

function analyzeTranscriptHealth(text) {
  const raw = String(text || "");
  const warnings = [];

  if (!raw.trim()) {
    return {
      tone: "clean",
      warnings
    };
  }

  if (/\?{5,}/.test(raw)) {
    warnings.push("битая кодировка");
  }

  if (/Кажется, сообщение отправилось не полностью/i.test(raw)) {
    warnings.push("обрыв контекста");
  }

  if (/You stopped this response/i.test(raw)) {
    warnings.push("ответ был остановлен");
  }

  const duplicateFragments = raw
    .split(/\n-{5,}\n/g)
    .map((item) => item.trim())
    .filter(Boolean);

  if (duplicateFragments.length >= 2) {
    const last = duplicateFragments[duplicateFragments.length - 1];
    const previous = duplicateFragments[duplicateFragments.length - 2];

    if (last && previous && last === previous) {
      warnings.push("повтор того же ответа");
    }
  }

  if (raw.length > 12000) {
    warnings.push("слишком длинная история");
  }

  return {
    tone: warnings.length > 0 ? "warning" : "clean",
    warnings
  };
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString();
}

function getStoredRoleAssignments() {
  try {
    const raw = window.localStorage.getItem(ROLE_STORAGE_KEY);

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function extractLatestAssistantReply(text) {
  const raw = String(text || "").trim();

  if (!raw) {
    return "";
  }

  const blocks = raw
    .split(/\n-{5,}\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const labels = ["ChatGPT:\n", "Gemini:\n"];

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];

    for (const label of labels) {
      if (block.startsWith(label)) {
        return block.slice(label.length).trim();
      }
    }
  }

  return raw;
}

function getCardReplyPreview(text, limit = 900) {
  const latestReply = extractLatestAssistantReply(text);
  const source = latestReply || String(text || "").trim();

  if (!source) {
    return "";
  }

  if (source.length <= limit) {
    return source;
  }

  return `${source.slice(0, limit).trim()}\n\n...`;
}

function getRolePriority(agent) {
  if (agent.readiness?.tone === "ready") {
    return 0;
  }

  if (agent.readiness?.tone === "dirty") {
    return 1;
  }

  if (agent.readiness?.tone === "fresh") {
    return 2;
  }

  return 3;
}

function getSuggestedRoleAssignments(agentList, currentAssignments) {
  const connectedAgents = [...agentList]
    .filter((agent) => agent.connected)
    .sort((left, right) => {
      const leftPriority = getRolePriority(left);
      const rightPriority = getRolePriority(right);

      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }

      return (left.firstSeenAt || 0) - (right.firstSeenAt || 0);
    });

  const allowedAgents = new Map(connectedAgents.map((agent) => [agent.agentId, agent]));
  const nextAssignments = {};
  const usedRoles = new Set();

  for (const role of ROLE_ORDER) {
    const existingAgentId = Object.keys(currentAssignments).find(
      (agentId) =>
        currentAssignments[agentId] === role && allowedAgents.has(agentId)
    );

    if (!existingAgentId) {
      continue;
    }

    nextAssignments[existingAgentId] = role;
    usedRoles.add(role);
    allowedAgents.delete(existingAgentId);
  }

  for (const role of ROLE_ORDER) {
    if (usedRoles.has(role)) {
      continue;
    }

    const nextAgent = Array.from(allowedAgents.values())[0];

    if (!nextAgent) {
      break;
    }

    nextAssignments[nextAgent.agentId] = role;
    usedRoles.add(role);
    allowedAgents.delete(nextAgent.agentId);
  }

  return nextAssignments;
}

function getNextRole(role) {
  if (role === "researcher") {
    return "critic";
  }

  if (role === "critic") {
    return "synthesizer";
  }

  return null;
}

function buildPacketSection(title, items) {
  const list = (Array.isArray(items) ? items : [items])
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  if (list.length === 0) {
    return [];
  }

  return ["", `${title}:`, ...list.map((item) => `- ${item}`)];
}

function buildRoleHandoff({ sourceAgent, sourceRole, targetRole, reply }) {
  const sourceLabel = ROLE_META[sourceRole]?.label || "Источник";
  const targetLabel = ROLE_META[targetRole]?.label || "Следующий шаг";
  const compactReply = trimSnippet(reply, 900);
  const packetId = `${sourceRole || "source"}-${targetRole || "target"}-${String(
    sourceAgent?.agentId || "agent"
  ).slice(-6)}`;

  const lines = [
    "Пакет передачи:",
    `- ID: ${packetId}`,
    `- роль отправителя: ${sourceLabel}`,
    `- твоя роль: ${targetLabel}`,
    "- факт: ты отдельный чат и не видишь файлы проекта напрямую",
    "- факт: опирайся только на этот пакет и текст ниже",
    "- важно: отвечай коротко, по делу и без воды"
  ];

  if (sourceRole === "researcher" && targetRole === "critic") {
    return [
      ...lines,
      ...buildPacketSection("Что нужно сделать", [
        "Быстро проверь идею ниже.",
        "Найди слабые места, спорные места и что надо уточнить перед следующим шагом."
      ]),
      ...buildPacketSection("Что нужно вернуть", [
        "3 коротких пункта: риск, что уточнить, что оставить."
      ]),
      ...buildPacketSection("Материал от исследователя", compactReply)
    ].join("\n");
  }

  if (sourceRole === "critic" && targetRole === "synthesizer") {
    return [
      ...lines,
      ...buildPacketSection("Что нужно сделать", [
        "Собери финальный вывод по материалу после критики.",
        "Выбери, что берем в работу сейчас и почему."
      ]),
      ...buildPacketSection("Что нужно вернуть", [
        "3 коротких блока: решение, почему сейчас, ожидаемый эффект."
      ]),
      ...buildPacketSection("Материал после критики", compactReply)
    ].join("\n");
  }

  return [
    ...lines,
    ...buildPacketSection("Что нужно сделать", [
      "Продолжи работу по материалу ниже.",
      "Верни полезный следующий результат без пересказа всей истории."
    ]),
    ...buildPacketSection("Что нужно вернуть", [
      "Короткий практичный следующий результат."
    ]),
    ...buildPacketSection("Материал", compactReply)
  ].join("\n");
}

function App() {
  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [agents, setAgents] = useState({});
  const [activity, setActivity] = useState([]);
  const [squad, setSquad] = useState({
    activeRun: null,
    nextTask: null,
    notifications: [],
    goals: [],
    queue: [],
    lastUpdatedAt: null
  });
  const [drafts, setDrafts] = useState({});
  const [sendModes, setSendModes] = useState({});
  const [routeTargets, setRouteTargets] = useState({});
  const [roleAssignments, setRoleAssignments] = useState(() => getStoredRoleAssignments());
  const [hideOfflineAgents, setHideOfflineAgents] = useState(false);
  const [showArchiveTabs, setShowArchiveTabs] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [scenarioPacks, setScenarioPacks] = useState({
    runModes: [],
    packs: []
  });

  const mergeAgent = (currentAgents, partialAgent) => {
    const current = currentAgents[partialAgent.agentId] || {};

    return {
      ...currentAgents,
      [partialAgent.agentId]: {
        agentId: partialAgent.agentId,
        connected: partialAgent.connected ?? current.connected ?? false,
        browser: normalizeBrowser(partialAgent.browser || current.browser),
        firstSeenAt: partialAgent.firstSeenAt ?? current.firstSeenAt ?? Date.now(),
        lastSeenAt: partialAgent.lastSeenAt ?? current.lastSeenAt ?? null,
        offlineSince: partialAgent.offlineSince ?? current.offlineSince ?? null,
        site: partialAgent.site || current.site || "unknown",
        title: partialAgent.title ?? current.title ?? "",
        url: partialAgent.url ?? current.url ?? "",
        tabId: partialAgent.tabId ?? current.tabId ?? null,
        busy: partialAgent.busy ?? current.busy ?? false,
        composerMode: partialAgent.composerMode || current.composerMode || "default",
        lastText: partialAgent.lastText ?? current.lastText ?? "",
        timestamp: partialAgent.timestamp ?? current.timestamp ?? null
      }
    };
  };

  const loadAgents = async () => {
    try {
      const response = await fetch(`${HTTP_URL}/api/agents`);
      const payload = await response.json();

      if (!response.ok || !Array.isArray(payload.agents)) {
        return;
      }

      setAgents((currentAgents) => {
        const nextAgents = { ...currentAgents };
        const incomingAgents = toAgentMap(payload.agents);

        for (const incomingAgent of Object.values(incomingAgents)) {
          const currentAgent = currentAgents[incomingAgent.agentId];
          nextAgents[incomingAgent.agentId] = {
            ...currentAgent,
            ...incomingAgent,
            firstSeenAt:
              incomingAgent.firstSeenAt || currentAgent?.firstSeenAt || Date.now(),
            lastText:
              incomingAgent.lastText || currentAgent?.lastText || ""
          };
        }

        return nextAgents;
      });
    } catch (error) {
      // Keep current UI state on transient API failures.
    }
  };

  const loadActivity = async () => {
    try {
      const response = await fetch(`${HTTP_URL}/api/activity?limit=24`);
      const payload = await response.json();

      if (!response.ok || !Array.isArray(payload.activity)) {
        return;
      }

      setActivity(payload.activity);
    } catch (error) {
      // Keep current UI state on transient API failures.
    }
  };

  const loadSquad = async () => {
    try {
      const response = await fetch(`${HTTP_URL}/api/squad/state`);
      const payload = await response.json();

      if (!response.ok) {
        return;
      }

      setSquad({
        activeRun: payload.activeRun || null,
        nextTask: payload.nextTask || null,
        notifications: Array.isArray(payload.notifications)
          ? payload.notifications
          : [],
        goals: Array.isArray(payload.goals) ? payload.goals : [],
        queue: Array.isArray(payload.queue) ? payload.queue : [],
        lastUpdatedAt: payload.lastUpdatedAt || null
      });
    } catch (error) {
      // Keep current UI state on transient API failures.
    }
  };

  const loadScenarioPacks = async () => {
    try {
      const response = await fetch(`${HTTP_URL}/api/scenario-packs`);
      const payload = await response.json();

      if (!response.ok) {
        return;
      }

      setScenarioPacks({
        runModes: Array.isArray(payload.runModes) ? payload.runModes : [],
        packs: Array.isArray(payload.packs) ? payload.packs : []
      });
    } catch (error) {
      // Keep current UI state on transient API failures.
    }
  };

  const triggerSync = async () => {
    setSyncing(true);

    try {
      await fetch(`${HTTP_URL}/api/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      });
      await loadAgents();
      await loadActivity();
      await loadSquad();
    } catch (error) {
      // Ignore transient sync failures in the MVP UI.
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    let disposed = false;

    const connect = () => {
      if (disposed) {
        return;
      }

      setConnectionStatus((currentStatus) =>
        currentStatus === "connected" ? "reconnecting" : "connecting"
      );

      const socket = new WebSocket(WS_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        if (disposed) {
          return;
        }

        setConnectionStatus("connected");
        socket.send(
          JSON.stringify({
            type: "REGISTER_CLIENT",
            clientType: "dashboard"
          })
        );
        loadAgents();
        loadActivity();
        loadSquad();
        loadScenarioPacks();
      };

      socket.onmessage = (event) => {
        let message = null;

        try {
          message = JSON.parse(event.data);
        } catch (error) {
          return;
        }

        if (!message || typeof message.type !== "string") {
          return;
        }

        if (message.type === "AGENT_REGISTERED") {
          setAgents((currentAgents) =>
            mergeAgent(currentAgents, {
              agentId: message.agentId,
              connected: message.connected,
              browser: message.browser,
              site: message.site,
              title: message.title,
              url: message.url,
              tabId: message.tabId,
              busy: message.busy,
              composerMode: message.composerMode
            })
          );
          return;
        }

        if (message.type === "UNREGISTER_AGENT") {
          setAgents((currentAgents) => {
            const currentAgent = currentAgents[message.agentId];

            if (!currentAgent) {
              return currentAgents;
            }

            return {
              ...currentAgents,
              [message.agentId]: {
                ...currentAgent,
                connected: false,
                offlineSince: Date.now()
              }
            };
          });
          return;
        }

        if (message.type === "ACTIVITY_EVENT" && message.activity) {
          setActivity((currentActivity) => {
            const nextActivity = [...currentActivity, message.activity];
            const deduped = [];
            const seenIds = new Set();

            for (let index = Math.max(0, nextActivity.length - 40); index < nextActivity.length; index += 1) {
              const item = nextActivity[index];

              if (!item || seenIds.has(item.id)) {
                continue;
              }

              seenIds.add(item.id);
              deduped.push(item);
            }

            return deduped;
          });
          return;
        }

        if (message.type === "TEXT_UPDATE") {
          setAgents((currentAgents) =>
            mergeAgent(currentAgents, {
              agentId: message.agentId,
              connected: message.connected,
              browser: message.browser,
              firstSeenAt: message.firstSeenAt,
              lastSeenAt: message.lastSeenAt,
              offlineSince: message.offlineSince,
              site: message.site,
              title: message.title,
              url: message.url,
              busy: message.busy,
              composerMode: message.composerMode,
              lastText: message.text || "",
              timestamp: message.timestamp || Date.now()
            })
          );
        }
      };

      socket.onclose = () => {
        if (disposed) {
          return;
        }

        setConnectionStatus("disconnected");

        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }

        reconnectTimerRef.current = setTimeout(() => {
          connect();
        }, RECONNECT_DELAY_MS);
      };

      socket.onerror = () => {
        if (disposed) {
          return;
        }

        setConnectionStatus("error");
      };
    };

    loadAgents();
    loadSquad();
    loadScenarioPacks();
    connect();

    return () => {
      disposed = true;

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }

      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      loadSquad();
      loadScenarioPacks();
    }, 5000);

    return () => clearInterval(timer);
  }, []);

  const allAgents = useMemo(
    () =>
      Object.values(agents).map((agent) => ({
        ...agent,
        displayName: `${normalizeSite(agent.site)} ${normalizeBrowser(agent.browser)} - ${getReadableTitle(agent)}`
      })),
    [agents]
  );

  const agentStatuses = useMemo(() => {
    const timing = {};

    for (const item of activity) {
      if (!item?.agentId) {
        continue;
      }

      if (!timing[item.agentId]) {
        timing[item.agentId] = {
          lastRequestAt: 0,
          lastReplyAt: 0
        };
      }

      const stamp = new Date(item.time || 0).getTime() || 0;

      if (item.kind === "request") {
        timing[item.agentId].lastRequestAt = Math.max(
          timing[item.agentId].lastRequestAt,
          stamp
        );
      }

      if (item.kind === "reply") {
        timing[item.agentId].lastReplyAt = Math.max(
          timing[item.agentId].lastReplyAt,
          stamp
        );
      }
    }

    const nextStatuses = {};

    for (const agent of Object.values(agents)) {
      const timingInfo = timing[agent.agentId] || {
        lastRequestAt: 0,
        lastReplyAt: 0
      };

      if (!agent.connected) {
        nextStatuses[agent.agentId] = {
          tone: "disconnected",
          label: "disconnected"
        };
        continue;
      }

      if (agent.busy) {
        nextStatuses[agent.agentId] = {
          tone: "processing",
          label:
            agent.composerMode === "deep_research"
              ? "researching"
              : agent.composerMode === "extended_thinking"
                ? "thinking"
              : agent.composerMode === "agent_mode"
                ? "agent mode"
                : "processing"
        };
        continue;
      }

      if (
        timingInfo.lastRequestAt > 0 &&
        timingInfo.lastRequestAt > timingInfo.lastReplyAt
      ) {
        nextStatuses[agent.agentId] = {
          tone: "processing",
          label: "processing"
        };
        continue;
      }

      nextStatuses[agent.agentId] = {
        tone: "idle",
        label: "idle"
      };
    }

    return nextStatuses;
  }, [activity, agents]);

  const agentList = useMemo(() => {
    const entries = Object.values(agents).map((agent) => {
      const siteLabel = normalizeSite(agent.site);
      const browserLabel = normalizeBrowser(agent.browser);
      const readableTitle = getReadableTitle(agent);
      const hasText = Boolean((agent.lastText || "").trim());
      const shortTab = String(agent.tabId || "").slice(-4) || "----";
      const firstSeenAt = agent.firstSeenAt || Number.MAX_SAFE_INTEGER;
      const offlineSince = agent.offlineSince || null;

      return {
        ...agent,
        connected: Boolean(agent.connected),
        transcriptHealth: analyzeTranscriptHealth(agent.lastText || ""),
        uiStatus: agentStatuses[agent.agentId] || {
          tone: agent.connected ? "idle" : "disconnected",
          label: agent.connected ? "idle" : "disconnected"
        },
        browser: browserLabel,
        siteLabel,
        readableTitle,
        hasText,
        shortTab,
        firstSeenAt,
        offlineSince,
        readiness: null,
        displayName: `${siteLabel} ${browserLabel} - ${readableTitle}`,
        subtitle: `tab ${shortTab}${agent.timestamp ? ` - updated ${new Date(agent.timestamp).toLocaleTimeString()}` : ""}${offlineSince ? ` - offline ${new Date(offlineSince).toLocaleTimeString()}` : ""}`
      };
    });

    for (const entry of entries) {
      entry.readiness = getAgentReadiness(entry);
    }

    entries.sort((left, right) => {
      if (left.firstSeenAt !== right.firstSeenAt) {
        return left.firstSeenAt - right.firstSeenAt;
      }

      return (left.tabId || 0) - (right.tabId || 0);
    });

    if (hideOfflineAgents) {
      return entries.filter((agent) => agent.connected);
    }

    return entries;
  }, [agents, agentStatuses, hideOfflineAgents]);

  const agentPoolSummary = useMemo(() => {
    const freshCandidates = agentList.filter(
      (agent) => agent.readiness?.tone === "fresh"
    );
    const dirtyAgents = agentList.filter(
      (agent) => agent.readiness?.tone === "dirty"
    );
    const readyAgents = agentList.filter(
      (agent) => agent.readiness?.tone === "ready"
    );

    return {
      total: agentList.length,
      freshCandidates,
      dirtyAgents,
      readyAgents
    };
  }, [agentList]);

  const displayedAgentList = useMemo(() => {
    if (showArchiveTabs) {
      return agentList;
    }

    const featuredFreshIds = new Set(
      agentPoolSummary.freshCandidates.slice(0, 3).map((agent) => agent.agentId)
    );

    return agentList.filter((agent) => {
      if (!agent.connected) {
        return false;
      }

      if (agent.readiness?.tone === "dirty" || agent.readiness?.tone === "ready") {
        return true;
      }

      if (roleAssignments[agent.agentId]) {
        return true;
      }

      return featuredFreshIds.has(agent.agentId);
    });
  }, [agentList, agentPoolSummary, roleAssignments, showArchiveTabs]);

  useEffect(() => {
    setRoleAssignments((currentAssignments) =>
      getSuggestedRoleAssignments(agentList, currentAssignments)
    );
  }, [agentList]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        ROLE_STORAGE_KEY,
        JSON.stringify(roleAssignments)
      );
    } catch (error) {
      // Ignore local storage failures in the dashboard.
    }
  }, [roleAssignments]);

  const timelineItems = useMemo(
    () =>
      [...activity]
        .filter((item) => item.kind === "request" || item.kind === "reply")
        .sort((left, right) => new Date(right.time) - new Date(left.time))
        .slice(0, 10)
        .map((item) => {
          const agent = item.agentId ? agents[item.agentId] : null;
          const site = normalizeSite(agent?.site || item.site);
          const title = getReadableTitle({
            site: agent?.site || item.site || "",
            title: agent?.title || item.title || "",
            url: agent?.url || "",
            tabId: agent?.tabId || null
          });

          return {
            ...item,
            displayName: title ? `${site} - ${title}` : site,
            preview: trimSnippet(item.text, item.kind === "request" ? 180 : 220)
          };
        }),
    [activity, agents]
  );

  const runCard = useMemo(() => {
    const run = squad.activeRun;

    if (!run) {
      return null;
    }

    const steps = Array.isArray(run.steps) ? run.steps : [];
    const currentStep =
      [...steps].reverse().find((item) => item.status === "active") ||
      [...steps].reverse()[0] ||
      null;

    return {
      ...run,
      currentStep
    };
  }, [squad]);

  const summary = useMemo(() => {
    const requests = timelineItems.filter((item) => item.kind === "request").slice(0, 3);
    const replies = timelineItems.filter((item) => item.kind === "reply").slice(0, 3);
    const takeaway = replies[0]?.preview || "";

    return {
      requests,
      replies,
      takeaway
    };
  }, [timelineItems]);

  const agentByRole = useMemo(() => {
    const map = {};

    for (const agent of agentList) {
      const role = roleAssignments[agent.agentId];

      if (role && !map[role] && agent.connected) {
        map[role] = agent;
      }
    }

    return map;
  }, [agentList, roleAssignments]);

  const sendToAgent = (agentId, text, mode = "default") => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    socket.send(
      JSON.stringify({
        type: "SEND_TO_AGENT",
        agentId,
        text,
        mode
      })
    );

    return true;
  };

  const handleDraftChange = (agentId, value) => {
    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [agentId]: value
    }));
  };

  const handleSendModeChange = (agentId, value) => {
    setSendModes((currentModes) => ({
      ...currentModes,
      [agentId]: value || "default"
    }));
  };

  const handleRouteTargetChange = (agentId, value) => {
    setRouteTargets((currentTargets) => ({
      ...currentTargets,
      [agentId]: value
    }));
  };

  const handleRoleChange = (agentId, value) => {
    setRoleAssignments((currentAssignments) => ({
      ...currentAssignments,
      [agentId]: value || undefined
    }));
  };

  const handleInsertRolePrompt = (agentId) => {
    const role = roleAssignments[agentId];
    const prompt = buildRolePrompt(role, runCard);

    if (!prompt) {
      return;
    }

    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [agentId]: prompt
    }));
  };

  const handleSend = (agentId) => {
    const text = (drafts[agentId] || "").trim();
    const mode = sendModes[agentId] || "default";

    if (!text) {
      return;
    }

    const inspection = inspectOutgoingText(text);

    if (!inspection.ok) {
      window.alert(
        "Сообщение похоже на битый текст и не будет отправлено. Проверь кодировку или вставь текст заново."
      );
      return;
    }

    const sent = sendToAgent(agentId, text, mode);

    if (!sent) {
      return;
    }

    setDrafts((currentDrafts) => ({
      ...currentDrafts,
      [agentId]: ""
    }));
  };

  const handleForwardLastAnswer = (sourceAgentId) => {
    const sourceRole = roleAssignments[sourceAgentId];
    const nextRole = getNextRole(sourceRole);
    const suggestedTargetId = nextRole ? agentByRole[nextRole]?.agentId || "" : "";
    const targetAgentId = routeTargets[sourceAgentId] || suggestedTargetId;
    const sourceAgent = agents[sourceAgentId];
    const targetRole = roleAssignments[targetAgentId];
    const latestReply = extractLatestAssistantReply(sourceAgent?.lastText || "");

    if (!targetAgentId || !latestReply) {
      return;
    }

    const handoffText = buildRoleHandoff({
      sourceAgent,
      sourceRole,
      targetRole,
      reply: latestReply
    });

    sendToAgent(targetAgentId, handoffText);
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        backgroundColor: "#0f172a",
        color: "#e2e8f0",
        fontFamily: "Segoe UI, sans-serif"
      }}
    >
      <div
        style={{
          maxWidth: "1520px",
          margin: "0 auto",
          padding: "24px"
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "16px",
            marginBottom: "24px",
            flexWrap: "wrap"
          }}
        >
          <div>
            <h1
              style={{
                margin: "0 0 8px",
                fontSize: "28px",
                color: "#f8fafc"
              }}
            >
              Multi-Agent Dashboard
            </h1>
            <div
              style={{
                fontSize: "14px",
                color: "#94a3b8"
              }}
            >
              WebSocket: {WS_URL}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              flexWrap: "wrap"
            }}
          >
            <button
              type="button"
              onClick={() => setHideOfflineAgents((current) => !current)}
              style={{
                border: "1px solid #334155",
                borderRadius: "10px",
                padding: "10px 12px",
                backgroundColor: "#111827",
                color: "#e2e8f0",
                fontSize: "13px",
                cursor: "pointer"
              }}
            >
              {hideOfflineAgents ? "Show offline agents" : "Hide offline agents"}
            </button>
            <button
              type="button"
              onClick={triggerSync}
              style={{
                border: "1px solid #2563eb",
                borderRadius: "10px",
                padding: "10px 12px",
                backgroundColor: "#1d4ed8",
                color: "#ffffff",
                fontSize: "13px",
                fontWeight: 700,
                cursor: "pointer"
              }}
            >
              {syncing ? "Syncing..." : "Refresh agents"}
            </button>
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "999px",
                fontSize: "13px",
                fontWeight: 700,
                backgroundColor:
                  connectionStatus === "connected"
                    ? "#14532d"
                    : connectionStatus === "reconnecting"
                      ? "#92400e"
                      : "#7f1d1d",
                color: "#ffffff"
              }}
            >
              {formatConnectionStatus(connectionStatus)}
            </div>
          </div>
        </div>

        {agentList.length === 0 ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: "80px 24px",
              border: "1px dashed #334155",
              borderRadius: "16px",
              backgroundColor: "#0f172a"
            }}
          >
            <style>{`
              @keyframes radar-pulse {
                0% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.7); transform: scale(0.95); }
                70% { box-shadow: 0 0 0 20px rgba(37, 99, 235, 0); transform: scale(1); }
                100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); transform: scale(0.95); }
              }
            `}</style>
            <div
              style={{
                width: "24px",
                height: "24px",
                borderRadius: "50%",
                backgroundColor: "#3b82f6",
                animation: "radar-pulse 2s infinite"
              }}
            />
            <div
              style={{
                marginTop: "24px",
                fontSize: "16px",
                fontWeight: 600,
                color: "#f8fafc"
              }}
            >
              No connected tabs found.
            </div>
            <div
              style={{
                marginTop: "8px",
                fontSize: "14px",
                color: "#64748b"
              }}
            >
              Open ChatGPT or Gemini with the extension enabled, then press Refresh agents.
            </div>
          </div>
        ) : (
          <>
            <section
              style={{
                marginBottom: "22px",
                padding: "18px",
                borderRadius: "18px",
                border: "1px solid #1e293b",
                backgroundColor: "#111827",
                boxShadow: "0 12px 30px rgba(0, 0, 0, 0.18)"
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "12px",
                  flexWrap: "wrap",
                  alignItems: "center"
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#f8fafc"
                    }}
                  >
                    Agent pool summary
                  </div>
                  <div
                    style={{
                      marginTop: "6px",
                      fontSize: "13px",
                      color: "#94a3b8"
                    }}
                  >
                    BROAGENTS now works only with already opened chats. If fewer tabs are open, reuse them and reassign roles instead of creating new ones.
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "10px",
                    flexWrap: "wrap"
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setShowArchiveTabs((current) => !current)}
                    style={{
                      border: "1px solid #334155",
                      borderRadius: "10px",
                      padding: "10px 14px",
                      backgroundColor: showArchiveTabs ? "#1d4ed8" : "#1e293b",
                      color: "#ffffff",
                      fontSize: "13px",
                      fontWeight: 700,
                      cursor: "pointer"
                    }}
                  >
                    {showArchiveTabs ? "Hide extra tabs" : "Show all tabs"}
                  </button>
                </div>
              </div>

              <div
                style={{
                  marginTop: "16px",
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: "12px"
                }}
              >
                {[
                  {
                    label: "Fresh candidates",
                    value: agentPoolSummary.freshCandidates.length,
                    color: "#22c55e"
                  },
                  {
                    label: "Ready tabs",
                    value: agentPoolSummary.readyAgents.length,
                    color: "#3b82f6"
                  },
                  {
                    label: "Need attention",
                    value: agentPoolSummary.dirtyAgents.length,
                    color: "#f59e0b"
                  },
                  {
                    label: "Total tabs",
                    value: agentPoolSummary.total,
                    color: "#94a3b8"
                  }
                ].map((item) => (
                  <div
                    key={item.label}
                    style={{
                      padding: "14px",
                      borderRadius: "14px",
                      backgroundColor: "#0f172a",
                      border: "1px solid #223046"
                    }}
                  >
                    <div style={{ fontSize: "12px", color: "#94a3b8", textTransform: "uppercase" }}>
                      {item.label}
                    </div>
                    <div style={{ marginTop: "8px", fontSize: "28px", fontWeight: 800, color: item.color }}>
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>

              <div
                style={{
                  marginTop: "16px",
                  display: "grid",
                  gridTemplateColumns: "minmax(280px, 1fr) minmax(280px, 1fr)",
                  gap: "12px"
                }}
              >
                <div
                  style={{
                    padding: "14px",
                    borderRadius: "14px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #223046"
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                    Best tabs for the next useful run
                  </div>
                  <div style={{ marginTop: "12px", display: "grid", gap: "8px" }}>
                    {agentPoolSummary.freshCandidates.length === 0 ? (
                      <div style={{ fontSize: "13px", color: "#64748b" }}>
                        No fresh candidate tabs yet.
                      </div>
                    ) : (
                      agentPoolSummary.freshCandidates.slice(0, 4).map((item) => (
                        <div key={item.agentId} style={{ fontSize: "13px", color: "#e2e8f0" }}>
                          - {item.displayName}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div
                  style={{
                    padding: "14px",
                    borderRadius: "14px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #223046"
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                    Current recommendation
                  </div>
                  <div
                    style={{
                      marginTop: "12px",
                      fontSize: "13px",
                      color: "#e2e8f0",
                      lineHeight: 1.6
                    }}
                  >
                    {agentList.length >= 3
                      ? "Enough tabs are already open. Reassign roles and work with the current chats."
                      : "Fewer than three tabs are open. Keep working with the existing chats and reassign roles instead of opening new ones from the dashboard."}
                  </div>
                  <div
                    style={{
                      marginTop: "10px",
                      fontSize: "12px",
                      color: "#94a3b8"
                    }}
                  >
                    Showing {displayedAgentList.length} useful tabs out of {agentList.length}.
                  </div>
                </div>
              </div>
            </section>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
                gap: "16px",
                alignItems: "stretch"
              }}
            >
              {displayedAgentList.map((agent) => {
                const assignedRole = roleAssignments[agent.agentId] || "";
                const nextRole = getNextRole(assignedRole);
                const suggestedTarget = nextRole ? agentByRole[nextRole] || null : null;
                const availableTargets = allAgents.filter(
                  (targetAgent) =>
                    targetAgent.agentId !== agent.agentId && targetAgent.connected
                );
                const hasWarnings = agent.transcriptHealth.warnings.length > 0;
                const hasUrl = Boolean(agent.url);
                const replyPreview = getCardReplyPreview(agent.lastText);
                const collapsiblePanelStyle = {
                  marginTop: "12px",
                  padding: "12px 14px",
                  borderRadius: "14px",
                  border: "1px solid #223046",
                  background:
                    "linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(2, 6, 23, 0.96))"
                };
                const collapsibleSummaryStyle = {
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "12px",
                  color: "#e2e8f0",
                  fontSize: "13px",
                  fontWeight: 700
                };
                const panelBodyStyle = {
                  marginTop: "12px",
                  padding: "12px",
                  borderRadius: "12px",
                  border: "1px solid #334155",
                  backgroundColor: "#0f172a"
                };

                return (
                  <section
                    key={agent.agentId}
                    style={{
                      minWidth: 0,
                      width: "100%",
                      height: "100%",
                      display: "grid",
                      gridTemplateRows:
                        "minmax(238px, auto) minmax(134px, auto) minmax(162px, auto) minmax(252px, auto) minmax(172px, auto)",
                      gap: "14px",
                      padding: "18px",
                      borderRadius: "18px",
                      border: "1px solid #1e293b",
                      backgroundColor: "#111827",
                      boxShadow: "0 12px 30px rgba(0, 0, 0, 0.22)"
                    }}
                  >
                    <div
                      style={{
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column"
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "8px",
                          alignItems: "center",
                          marginBottom: "8px"
                        }}
                      >
                      <div
                        style={{
                          fontSize: "18px",
                          fontWeight: 700,
                          color: "#f8fafc"
                        }}
                      >
                        {agent.displayName}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "4px 8px",
                          borderRadius: "999px",
                          backgroundColor: "#0b1220",
                          border: "1px solid #223046"
                        }}
                      >
                        <span
                          style={{
                            width: "10px",
                            height: "10px",
                            borderRadius: "50%",
                            backgroundColor:
                              agent.uiStatus.tone === "processing"
                                ? "#f59e0b"
                                : agent.uiStatus.tone === "idle"
                                  ? "#22c55e"
                                  : "#64748b",
                            boxShadow:
                              agent.uiStatus.tone === "processing"
                                ? "0 0 10px rgba(245, 158, 11, 0.65)"
                                : agent.uiStatus.tone === "idle"
                                  ? "0 0 10px rgba(34, 197, 94, 0.55)"
                                  : "none"
                          }}
                        />
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 700,
                            textTransform: "uppercase",
                            color: "#cbd5e1"
                          }}
                        >
                          {agent.uiStatus.label}
                        </span>
                      </div>
                        <span
                          style={{
                            padding: "4px 8px",
                            borderRadius: "999px",
                            backgroundColor: agent.connected
                              ? agent.hasText
                                ? "#0f766e"
                                : "#1d4ed8"
                              : "#475569",
                            color: "#ffffff",
                            fontSize: "11px",
                            fontWeight: 700,
                            textTransform: "uppercase"
                          }}
                        >
                          {agent.connected
                            ? agent.hasText
                              ? "online"
                              : "online empty"
                            : "offline snapshot"}
                        </span>
                        <span
                          style={{
                            padding: "4px 8px",
                            borderRadius: "999px",
                            backgroundColor:
                              agent.readiness?.tone === "fresh"
                                ? "rgba(34, 197, 94, 0.18)"
                                : agent.readiness?.tone === "dirty"
                                  ? "rgba(245, 158, 11, 0.18)"
                                  : agent.readiness?.tone === "ready"
                                    ? "rgba(59, 130, 246, 0.18)"
                                    : "rgba(100, 116, 139, 0.18)",
                            color:
                              agent.readiness?.tone === "fresh"
                                ? "#86efac"
                                : agent.readiness?.tone === "dirty"
                                  ? "#fcd34d"
                                  : agent.readiness?.tone === "ready"
                                    ? "#93c5fd"
                                    : "#cbd5e1",
                            fontSize: "11px",
                            fontWeight: 700,
                            textTransform: "uppercase"
                          }}
                        >
                          {agent.readiness?.label || "unknown"}
                        </span>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            padding: "4px 8px",
                            borderRadius: "999px",
                            backgroundColor: "#0b1220",
                            border: "1px solid #223046"
                          }}
                        >
                          <span
                            style={{
                              width: "10px",
                              height: "10px",
                              borderRadius: "50%",
                              backgroundColor:
                                ROLE_META[assignedRole]?.color || "#64748b"
                            }}
                          />
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              color: "#e2e8f0"
                            }}
                          >
                            {ROLE_META[assignedRole]?.label || "Роль не выбрана"}
                          </span>
                        </div>
                        {agent.composerMode && agent.composerMode !== "default" ? (
                          <span
                            style={{
                              padding: "4px 8px",
                              borderRadius: "999px",
                              backgroundColor: "rgba(14, 116, 144, 0.18)",
                              color: "#67e8f9",
                              fontSize: "11px",
                              fontWeight: 700,
                              textTransform: "uppercase"
                            }}
                          >
                            {SEND_MODE_META[agent.composerMode]?.label || agent.composerMode}
                          </span>
                        ) : null}
                      </div>
                      <div
                        style={{
                          fontSize: "13px",
                          color: "#94a3b8",
                          wordBreak: "break-word"
                        }}
                      >
                        {agent.subtitle}
                      </div>
                      <div
                        style={{
                          marginTop: "6px",
                          fontSize: "12px",
                          color:
                            agent.readiness?.tone === "fresh"
                              ? "#86efac"
                              : agent.readiness?.tone === "dirty"
                                ? "#fcd34d"
                                : "#64748b"
                        }}
                      >
                        {agent.readiness?.details}
                      </div>
                      <div
                        style={{
                          marginTop: "8px",
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "10px",
                          alignItems: "center"
                        }}
                      >
                        <select
                          value={assignedRole}
                          onChange={(event) =>
                            handleRoleChange(agent.agentId, event.target.value)
                          }
                          style={{
                            minHeight: "38px",
                            padding: "8px 10px",
                            borderRadius: "10px",
                            border: "1px solid #334155",
                            backgroundColor: "#020617",
                            color: "#f8fafc",
                            fontSize: "13px"
                          }}
                        >
                          <option value="">Выбери роль</option>
                          {ROLE_ORDER.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_META[role].label}
                            </option>
                          ))}
                        </select>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#94a3b8"
                          }}
                        >
                          {ROLE_META[assignedRole]?.description || "Назначь постоянную роль для этого окна."}
                        </div>
                      </div>
                    </div>

                    <div style={collapsiblePanelStyle}>
                      <div style={collapsibleSummaryStyle}>
                        <span>Session details</span>
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            color: hasWarnings ? "#fcd34d" : "#94a3b8"
                          }}
                        >
                          {hasWarnings ? "attention" : "clear"}
                        </span>
                      </div>
                      <div
                        style={{
                          ...panelBodyStyle,
                          minHeight: "82px",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "center"
                        }}
                      >
                        <div
                          style={{
                            marginBottom: hasWarnings || hasUrl ? "10px" : "0",
                            fontSize: "12px",
                            color: "#94a3b8"
                          }}
                        >
                          Live state: {agent.busy ? "busy" : "idle"}
                          {agent.composerMode && agent.composerMode !== "default"
                            ? ` · mode: ${SEND_MODE_META[agent.composerMode]?.label || agent.composerMode}`
                            : ""}
                        </div>
                        {hasWarnings ? (
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "8px",
                              alignItems: "center"
                            }}
                          >
                            <div
                              style={{
                                padding: "4px 8px",
                                borderRadius: "999px",
                                backgroundColor: "rgba(245, 158, 11, 0.15)",
                                border: "1px solid rgba(245, 158, 11, 0.35)",
                                color: "#fde68a",
                                fontSize: "11px",
                                fontWeight: 700,
                                textTransform: "uppercase"
                              }}
                            >
                              Needs reset
                            </div>
                            <div
                              style={{
                                fontSize: "12px",
                                color: "#fcd34d"
                              }}
                            >
                              {agent.transcriptHealth.warnings.join(", ")}
                            </div>
                          </div>
                        ) : (
                          <div
                            style={{
                              fontSize: "12px",
                              color: "#94a3b8"
                            }}
                          >
                            No obvious transcript issues in this tab.
                          </div>
                        )}
                        {hasUrl ? (
                          <div
                            style={{
                              marginTop: "12px",
                              fontSize: "12px",
                              color: "#64748b",
                              wordBreak: "break-all"
                            }}
                          >
                            {agent.url}
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <div style={collapsiblePanelStyle}>
                      <div style={collapsibleSummaryStyle}>
                        <span>Latest reply</span>
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            color: replyPreview ? "#94a3b8" : "#64748b"
                          }}
                        >
                          {replyPreview ? "visible" : "empty"}
                        </span>
                      </div>
                      <div
                        style={{
                          ...panelBodyStyle,
                          minHeight: "96px",
                          maxHeight: "220px",
                          overflowY: "auto",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                          color: "#e2e8f0",
                          fontSize: "14px",
                          lineHeight: 1.5
                        }}
                      >
                        {replyPreview || "No reply yet."}
                      </div>
                    </div>

                    <div>
                      <div
                        style={{
                          marginBottom: "8px",
                          fontSize: "13px",
                          fontWeight: 700,
                          color: "#cbd5e1"
                        }}
                      >
                        Send message
                      </div>
                      <div
                        style={{
                          marginBottom: "10px",
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "10px",
                          alignItems: "center"
                        }}
                      >
                        <select
                          value={sendModes[agent.agentId] || "default"}
                          onChange={(event) =>
                            handleSendModeChange(agent.agentId, event.target.value)
                          }
                          style={{
                            minHeight: "38px",
                            padding: "8px 10px",
                            borderRadius: "10px",
                            border: "1px solid #334155",
                            backgroundColor: "#020617",
                            color: "#f8fafc",
                            fontSize: "13px"
                          }}
                        >
                          {getAvailableSendModes(agent).map((mode) => (
                            <option key={mode} value={mode}>
                              {SEND_MODE_META[mode]?.label || mode}
                            </option>
                          ))}
                        </select>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#94a3b8"
                          }}
                        >
                          {SEND_MODE_META[sendModes[agent.agentId] || "default"]?.description}
                        </div>
                      </div>
                      <textarea
                        value={drafts[agent.agentId] || ""}
                        onChange={(event) =>
                          handleDraftChange(agent.agentId, event.target.value)
                        }
                        placeholder="Type a message for this exact tab..."
                        style={{
                          width: "100%",
                          minHeight: "140px",
                          height: "140px",
                          resize: "none",
                          padding: "12px",
                          borderRadius: "12px",
                          border: "1px solid #334155",
                          backgroundColor: "#020617",
                          color: "#f8fafc",
                          fontSize: "14px",
                          boxSizing: "border-box",
                          outline: "none"
                        }}
                      />
                      <div
                        style={{
                          marginTop: "10px",
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "10px"
                        }}
                      >
                        <button
                          type="button"
                          disabled={!agent.connected}
                          onClick={() => handleSend(agent.agentId)}
                          style={{
                            border: "none",
                            borderRadius: "10px",
                            padding: "10px 14px",
                            backgroundColor: agent.connected ? "#2563eb" : "#475569",
                            color: "#ffffff",
                            fontSize: "14px",
                            fontWeight: 700,
                            cursor: agent.connected ? "pointer" : "not-allowed",
                            opacity: agent.connected ? 1 : 0.6
                          }}
                        >
                          Send
                        </button>
                        <button
                          type="button"
                          disabled={!agent.connected || !roleAssignments[agent.agentId]}
                          onClick={() => handleInsertRolePrompt(agent.agentId)}
                          style={{
                            border: "1px solid #334155",
                            borderRadius: "10px",
                            padding: "10px 14px",
                            backgroundColor:
                              !agent.connected || !roleAssignments[agent.agentId]
                                ? "#111827"
                                : "#1e293b",
                            color: "#e2e8f0",
                            fontSize: "14px",
                            fontWeight: 700,
                            cursor:
                              !agent.connected || !roleAssignments[agent.agentId]
                                ? "not-allowed"
                                : "pointer",
                            opacity:
                              !agent.connected || !roleAssignments[agent.agentId]
                                ? 0.6
                                : 1
                          }}
                        >
                          Insert role prompt
                        </button>
                      </div>
                    </div>

                    <div style={collapsiblePanelStyle}>
                      <div style={collapsibleSummaryStyle}>
                        <span>Forward handoff</span>
                        <span
                          style={{
                            fontSize: "11px",
                            fontWeight: 600,
                            color: availableTargets.length > 0 ? "#94a3b8" : "#64748b"
                          }}
                        >
                          {availableTargets.length > 0 ? "optional" : "unavailable"}
                        </span>
                      </div>
                      <div
                        style={{
                          ...panelBodyStyle,
                          minHeight: "106px",
                          display: "flex",
                          flexDirection: "column",
                          justifyContent: "space-between",
                          gap: "10px"
                        }}
                      >
                        <select
                          value={routeTargets[agent.agentId] || ""}
                          onChange={(event) =>
                            handleRouteTargetChange(agent.agentId, event.target.value)
                          }
                          style={{
                            flex: "1 1 220px",
                            minHeight: "42px",
                            padding: "10px 12px",
                            borderRadius: "10px",
                            border: "1px solid #334155",
                            backgroundColor: "#020617",
                            color: "#f8fafc",
                            fontSize: "14px"
                          }}
                        >
                          <option value="">Choose target tab</option>
                          {availableTargets.map((targetAgent) => (
                            <option key={targetAgent.agentId} value={targetAgent.agentId}>
                              {targetAgent.displayName}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={
                            !agent.connected ||
                            availableTargets.length === 0 ||
                            !(routeTargets[agent.agentId] || suggestedTarget?.agentId) ||
                            !extractLatestAssistantReply(agent.lastText || "")
                          }
                          onClick={() => handleForwardLastAnswer(agent.agentId)}
                          style={{
                            border: "none",
                            borderRadius: "10px",
                            padding: "10px 14px",
                            backgroundColor:
                              !agent.connected ||
                              availableTargets.length === 0 ||
                              !(routeTargets[agent.agentId] || suggestedTarget?.agentId) ||
                              !extractLatestAssistantReply(agent.lastText || "")
                                ? "#475569"
                                : "#0f766e",
                            color: "#ffffff",
                            fontSize: "14px",
                            fontWeight: 700,
                            cursor:
                              !agent.connected ||
                              availableTargets.length === 0 ||
                              !(routeTargets[agent.agentId] || suggestedTarget?.agentId) ||
                              !extractLatestAssistantReply(agent.lastText || "")
                                ? "not-allowed"
                                : "pointer"
                          }}
                        >
                          Forward
                        </button>
                      </div>
                      <div
                        style={{
                          marginTop: "8px",
                          fontSize: "12px",
                          color: "#94a3b8"
                        }}
                      >
                        {suggestedTarget
                          ? `Подсказка: после роли "${ROLE_META[assignedRole]?.label}" логично отправлять в "${ROLE_META[nextRole]?.label}" — ${suggestedTarget.displayName}.`
                          : "Подсказка: для финальной роли автоматический следующий адресат не нужен."}
                      </div>
                    </div>
                  </section>
                );
              })}
            </div>

            <section
              style={{
                marginTop: "22px",
                padding: "18px",
                borderRadius: "18px",
                border: "1px solid #1e293b",
                backgroundColor: "#111827",
                boxShadow: "0 12px 30px rgba(0, 0, 0, 0.18)"
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "12px",
                  flexWrap: "wrap",
                  alignItems: "center",
                  marginBottom: "16px"
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#f8fafc"
                    }}
                  >
                    Squad inbox
                  </div>
                  <div
                    style={{
                      marginTop: "6px",
                      fontSize: "13px",
                      color: "#94a3b8"
                    }}
                  >
                    Reliable internal notifications. Works without window focus, keyboard injection, or external clicks.
                  </div>
                </div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#64748b"
                  }}
                >
                  {squad.lastUpdatedAt
                    ? `Updated ${formatDateTime(squad.lastUpdatedAt)}`
                    : "No squad state yet"}
                </div>
              </div>

              <div
                style={{
                  marginTop: "16px",
                  display: "grid",
                  gridTemplateColumns: "minmax(320px, 1.3fr) minmax(320px, 1fr)",
                  gap: "14px"
                }}
              >
                <div
                  style={{
                    padding: "14px",
                    borderRadius: "14px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #223046"
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                    Current run
                  </div>
                  {runCard ? (
                    <div style={{ marginTop: "12px", display: "grid", gap: "12px" }}>
                      <div>
                        <div style={{ fontSize: "18px", fontWeight: 700, color: "#f8fafc" }}>
                          {runCard.title}
                        </div>
                        <div style={{ marginTop: "6px", fontSize: "13px", color: "#94a3b8" }}>
                          {runCard.objective}
                        </div>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                          gap: "10px"
                        }}
                      >
                        <div>
                          <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>
                            Status
                          </div>
                          <div style={{ marginTop: "4px", fontSize: "14px", color: "#e2e8f0" }}>
                            {runCard.status}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>
                            Current step
                          </div>
                          <div style={{ marginTop: "4px", fontSize: "14px", color: "#e2e8f0" }}>
                            {runCard.currentStep?.title || "No step"}
                          </div>
                        </div>
                        <div>
                          <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>
                            Next task
                          </div>
                          <div style={{ marginTop: "4px", fontSize: "14px", color: "#e2e8f0" }}>
                            {squad.nextTask?.title || "Queue is clear"}
                          </div>
                        </div>
                      </div>
                      {runCard.currentStep?.objective ? (
                        <div>
                          <div style={{ fontSize: "11px", color: "#64748b", textTransform: "uppercase" }}>
                            Step objective
                          </div>
                          <div style={{ marginTop: "4px", fontSize: "14px", color: "#e2e8f0", lineHeight: 1.5 }}>
                            {runCard.currentStep.objective}
                          </div>
                        </div>
                      ) : null}
                      {runCard.blocker ? (
                        <div
                          style={{
                            padding: "12px",
                            borderRadius: "12px",
                            backgroundColor: "rgba(127, 29, 29, 0.25)",
                            border: "1px solid rgba(248, 113, 113, 0.25)",
                            color: "#fecaca",
                            fontSize: "14px"
                          }}
                        >
                          Blocker: {runCard.blocker}
                        </div>
                      ) : null}
                      {runCard.result ? (
                        <div
                          style={{
                            padding: "12px",
                            borderRadius: "12px",
                            backgroundColor: "rgba(15, 118, 110, 0.18)",
                            border: "1px solid rgba(45, 212, 191, 0.2)",
                            color: "#ccfbf1",
                            fontSize: "14px",
                            lineHeight: 1.5
                          }}
                        >
                          Result: {runCard.result}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div style={{ marginTop: "12px", fontSize: "13px", color: "#64748b" }}>
                      No active run yet.
                    </div>
                  )}
                </div>

                <div
                  style={{
                    padding: "14px",
                    borderRadius: "14px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #223046"
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                    Inbox messages
                  </div>
                  <div style={{ marginTop: "12px", display: "grid", gap: "10px" }}>
                    {squad.notifications.length === 0 ? (
                      <div style={{ fontSize: "13px", color: "#64748b" }}>
                        No inbox messages yet.
                      </div>
                    ) : (
                      squad.notifications.map((item) => (
                        <div
                          key={item.key}
                          style={{
                            padding: "12px",
                            borderRadius: "12px",
                            backgroundColor: "#0b1220",
                            border: "1px solid #1f2d40"
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: "10px",
                              flexWrap: "wrap",
                              alignItems: "center"
                            }}
                          >
                            <div style={{ fontSize: "12px", color: "#93c5fd", textTransform: "uppercase", fontWeight: 700 }}>
                              {item.kind}
                            </div>
                            <div style={{ fontSize: "12px", color: "#64748b" }}>
                              {formatDateTime(item.createdAt)}
                            </div>
                          </div>
                          <div
                            style={{
                              marginTop: "8px",
                              fontSize: "13px",
                              lineHeight: 1.55,
                              color: "#e2e8f0",
                              whiteSpace: "pre-wrap"
                            }}
                          >
                            {item.text}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section
              style={{
                marginTop: "22px",
                padding: "18px",
                borderRadius: "18px",
                border: "1px solid #1e293b",
                backgroundColor: "#111827",
                boxShadow: "0 12px 30px rgba(0, 0, 0, 0.18)"
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "12px",
                  flexWrap: "wrap",
                  alignItems: "center"
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "20px",
                      fontWeight: 700,
                      color: "#f8fafc"
                    }}
                  >
                    Run modes and scenario packs
                  </div>
                  <div
                    style={{
                      marginTop: "6px",
                      fontSize: "13px",
                      color: "#94a3b8"
                    }}
                  >
                    Predefined workflow modes and early product scenarios. This keeps runs structured instead of improvising every handoff from scratch.
                  </div>
                </div>
              </div>

              <div
                style={{
                  marginTop: "16px",
                  display: "grid",
                  gridTemplateColumns: "minmax(280px, 0.9fr) minmax(360px, 1.1fr)",
                  gap: "14px"
                }}
              >
                <div
                  style={{
                    padding: "14px",
                    borderRadius: "14px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #223046"
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                    Run modes
                  </div>
                  <div style={{ marginTop: "12px", display: "grid", gap: "10px" }}>
                    {scenarioPacks.runModes.length === 0 ? (
                      <div style={{ fontSize: "13px", color: "#64748b" }}>
                        No run modes loaded yet.
                      </div>
                    ) : (
                      scenarioPacks.runModes.map((mode) => (
                        <div
                          key={mode.id}
                          style={{
                            padding: "12px",
                            borderRadius: "12px",
                            backgroundColor: "#0b1220",
                            border: "1px solid #1f2d40"
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: "10px",
                              flexWrap: "wrap",
                              alignItems: "center"
                            }}
                          >
                            <div style={{ fontSize: "15px", fontWeight: 700, color: "#f8fafc" }}>
                              {mode.title}
                            </div>
                            <div
                              style={{
                                padding: "4px 8px",
                                borderRadius: "999px",
                                backgroundColor: "#1e293b",
                                color: "#93c5fd",
                                fontSize: "11px",
                                fontWeight: 700,
                                textTransform: "uppercase"
                              }}
                            >
                              {mode.label}
                            </div>
                          </div>
                          <div style={{ marginTop: "8px", fontSize: "13px", color: "#cbd5e1", lineHeight: 1.5 }}>
                            {mode.description}
                          </div>
                          <div style={{ marginTop: "10px", fontSize: "12px", color: "#94a3b8" }}>
                            Best for: {mode.bestFor}
                          </div>
                          <div style={{ marginTop: "4px", fontSize: "12px", color: "#64748b" }}>
                            Participants: {mode.participants}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div
                  style={{
                    padding: "14px",
                    borderRadius: "14px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #223046"
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                    Scenario packs
                  </div>
                  <div style={{ marginTop: "12px", display: "grid", gap: "10px" }}>
                    {scenarioPacks.packs.length === 0 ? (
                      <div style={{ fontSize: "13px", color: "#64748b" }}>
                        No scenario packs loaded yet.
                      </div>
                    ) : (
                      scenarioPacks.packs.map((pack) => (
                        <div
                          key={pack.id}
                          style={{
                            padding: "12px",
                            borderRadius: "12px",
                            backgroundColor: "#0b1220",
                            border: "1px solid #1f2d40"
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: "10px",
                              flexWrap: "wrap",
                              alignItems: "center"
                            }}
                          >
                            <div style={{ fontSize: "15px", fontWeight: 700, color: "#f8fafc" }}>
                              {pack.title}
                            </div>
                            <div
                              style={{
                                padding: "4px 8px",
                                borderRadius: "999px",
                                backgroundColor: "#1e293b",
                                color: "#fcd34d",
                                fontSize: "11px",
                                fontWeight: 700,
                                textTransform: "uppercase"
                              }}
                            >
                              {pack.mode}
                            </div>
                          </div>
                          <div style={{ marginTop: "8px", fontSize: "13px", color: "#cbd5e1", lineHeight: 1.5 }}>
                            {pack.goal}
                          </div>
                          <div style={{ marginTop: "10px", fontSize: "12px", color: "#94a3b8", lineHeight: 1.5 }}>
                            Value: {pack.value}
                          </div>
                          <div style={{ marginTop: "10px", display: "grid", gap: "6px" }}>
                            {(pack.steps || []).map((step, index) => (
                              <div key={`${pack.id}-step-${index}`} style={{ fontSize: "12px", color: "#cbd5e1" }}>
                                {index + 1}. {step}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </section>

            <section
              style={{
                marginTop: "22px",
                padding: "18px",
                borderRadius: "18px",
                border: "1px solid #1e293b",
                backgroundColor: "#111827",
                boxShadow: "0 12px 30px rgba(0, 0, 0, 0.18)"
              }}
            >
              <div
                style={{
                  fontSize: "20px",
                  fontWeight: 700,
                  color: "#f8fafc"
                }}
              >
                Simple run summary
              </div>
              <div
                style={{
                  marginTop: "6px",
                  fontSize: "13px",
                  color: "#94a3b8"
                }}
              >
                A plain-English snapshot of what was asked, what came back, and the latest takeaway.
              </div>

              <div
                style={{
                  marginTop: "16px",
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
                  gap: "14px"
                }}
              >
                <div
                  style={{
                    padding: "14px",
                    borderRadius: "14px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #223046"
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                    Asked recently
                  </div>
                  <div style={{ marginTop: "10px", display: "grid", gap: "10px" }}>
                    {summary.requests.length === 0 ? (
                      <div style={{ fontSize: "13px", color: "#64748b" }}>
                        No recent requests yet.
                      </div>
                    ) : (
                      summary.requests.map((item) => (
                        <div key={item.id} style={{ fontSize: "13px", color: "#e2e8f0" }}>
                          <strong style={{ color: "#93c5fd" }}>{item.displayName}</strong>: {item.preview}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div
                  style={{
                    padding: "14px",
                    borderRadius: "14px",
                    backgroundColor: "#0f172a",
                    border: "1px solid #223046"
                  }}
                >
                  <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                    Replies
                  </div>
                  <div style={{ marginTop: "10px", display: "grid", gap: "10px" }}>
                    {summary.replies.length === 0 ? (
                      <div style={{ fontSize: "13px", color: "#64748b" }}>
                        No replies yet.
                      </div>
                    ) : (
                      summary.replies.map((item) => (
                        <div key={item.id} style={{ fontSize: "13px", color: "#e2e8f0" }}>
                          <strong style={{ color: "#86efac" }}>{item.displayName}</strong>: {item.preview}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div
                style={{
                  marginTop: "14px",
                  padding: "14px",
                  borderRadius: "14px",
                  background:
                    "linear-gradient(135deg, rgba(30,41,59,0.95), rgba(15,118,110,0.22))",
                  border: "1px solid #28445f"
                }}
              >
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                  Current takeaway
                </div>
                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "14px",
                    lineHeight: 1.6,
                    color: "#f8fafc"
                  }}
                >
                  {summary.takeaway || "Run a task and the latest conclusion will appear here."}
                </div>
              </div>

              <div style={{ marginTop: "16px" }}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#cbd5e1" }}>
                  Recent activity
                </div>
                <div style={{ marginTop: "10px", display: "grid", gap: "8px" }}>
                  {timelineItems.length === 0 ? (
                    <div style={{ fontSize: "13px", color: "#64748b" }}>
                      No activity yet.
                    </div>
                  ) : (
                    timelineItems.map((item) => (
                      <div
                        key={item.id}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "92px minmax(160px, 260px) 1fr",
                          gap: "12px",
                          alignItems: "start",
                          padding: "10px 12px",
                          borderRadius: "12px",
                          backgroundColor: "#0b1220",
                          border: "1px solid #1f2d40"
                        }}
                      >
                        <div style={{ fontSize: "12px", color: "#64748b" }}>
                          {new Date(item.time).toLocaleTimeString()}
                        </div>
                        <div style={{ fontSize: "13px", color: "#cbd5e1" }}>
                          {item.kind === "request"
                            ? "Asked"
                            : item.kind === "reply"
                              ? "Replied"
                              : "Status"}{" "}
                          - {item.displayName}
                        </div>
                        <div style={{ fontSize: "13px", color: "#e2e8f0" }}>
                          {item.preview || "No text."}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
