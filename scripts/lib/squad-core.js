const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const STATE_PATH = path.join(DATA_DIR, "squad-state.json");

const DEFAULT_STATE = {
  version: 1,
  goals: [
    {
      id: "goal-1",
      title: "Сбор средств на ИИ-лабораторию",
      priority: 1,
      status: "active"
    },
    {
      id: "goal-2",
      title: "Сбор средств на ИИ-тела",
      priority: 2,
      status: "planned"
    },
    {
      id: "goal-3",
      title: "Сбор средств на межпланетные корабли, ИИ корабля и сквад роботов",
      priority: 3,
      status: "planned"
    }
  ],
  queue: [],
  runs: [],
  notifications: [],
  lastUpdatedAt: null
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function looksLikeMojibake(value) {
  return typeof value === "string" && /[ÐÑ]/.test(value);
}

function tryRepairMojibake(value) {
  if (!looksLikeMojibake(value)) {
    return value;
  }

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    return /[А-Яа-яЁё]/.test(repaired) ? repaired : value;
  } catch (error) {
    return value;
  }
}

function repairDeep(value) {
  if (typeof value === "string") {
    return tryRepairMojibake(value);
  }

  if (Array.isArray(value)) {
    return value.map(repairDeep);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, repairDeep(nested)])
    );
  }

  return value;
}

function loadSquadState() {
  ensureDataDir();

  if (!fs.existsSync(STATE_PATH)) {
    const initial = deepClone(DEFAULT_STATE);
    initial.lastUpdatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(initial, null, 2), "utf8");
    return initial;
  }

  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = repairDeep(JSON.parse(raw));
    return {
      ...deepClone(DEFAULT_STATE),
      ...parsed
    };
  } catch (error) {
    const fallback = deepClone(DEFAULT_STATE);
    fallback.lastUpdatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, JSON.stringify(fallback, null, 2), "utf8");
    return fallback;
  }
}

function saveSquadState(state) {
  ensureDataDir();
  const next = repairDeep({
    ...state,
    lastUpdatedAt: new Date().toISOString()
  });
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

function makeId(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${stamp}-${random}`;
}

function hashText(text) {
  return crypto.createHash("sha1").update(String(text || ""), "utf8").digest("hex");
}

function createRun(state, input) {
  const run = {
    id: makeId("RUN"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: input.title || "Без названия",
    objective: input.objective || "",
    mode: input.mode || "checked",
    status: "active",
    context: input.context || "",
    steps: [],
    result: null,
    blocker: null
  };

  state.runs.push(run);
  return run;
}

function addStep(run, input) {
  const step = {
    id: makeId("STEP"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    role: input.role || "executor",
    type: input.type || "task",
    title: input.title || "Step",
    objective: input.objective || "",
    status: input.status || "pending",
    handoff: input.handoff || null,
    output: input.output || null,
    notes: input.notes || ""
  };

  run.steps.push(step);
  run.updatedAt = new Date().toISOString();
  return step;
}

function updateStep(run, stepId, patch) {
  const step = run.steps.find((item) => item.id === stepId);

  if (!step) {
    throw new Error(`STEP_NOT_FOUND_${stepId}`);
  }

  Object.assign(step, patch, {
    updatedAt: new Date().toISOString()
  });
  run.updatedAt = new Date().toISOString();
  return step;
}

function setRunStatus(run, status, extra = {}) {
  Object.assign(run, extra, {
    status,
    updatedAt: new Date().toISOString()
  });
  return run;
}

function addQueueItem(state, input) {
  const item = {
    id: makeId("TASK"),
    createdAt: new Date().toISOString(),
    title: input.title || "Task",
    objective: input.objective || "",
    priority: input.priority || "normal",
    status: "queued",
    source: input.source || "user",
    notes: input.notes || ""
  };

  state.queue.push(item);
  return item;
}

function updateQueueItem(state, itemId, patch) {
  const item = state.queue.find((entry) => entry.id === itemId);

  if (!item) {
    throw new Error(`QUEUE_ITEM_NOT_FOUND_${itemId}`);
  }

  Object.assign(item, patch, {
    updatedAt: new Date().toISOString()
  });

  return item;
}

function getOpenQueueItems(state) {
  return state.queue.filter(
    (item) => item.status === "queued" || item.status === "active"
  );
}

function getNextQueueItem(state) {
  return getOpenQueueItems(state)[0] || null;
}

function getRecentNotifications(state, limit = 8) {
  return [...(state.notifications || [])].slice(-limit).reverse();
}

function recordNotification(state, input) {
  const key = input.key || hashText(input.text || "");
  const already = state.notifications.find((item) => item.key === key);

  if (already) {
    return {
      notification: already,
      duplicate: true
    };
  }

  const notification = {
    key,
    createdAt: new Date().toISOString(),
    kind: input.kind || "info",
    channel: input.channel || "inbox",
    text: input.text || "",
    relatedRunId: input.relatedRunId || null,
    relatedStepId: input.relatedStepId || null
  };

  state.notifications.push(notification);

  if (state.notifications.length > 300) {
    state.notifications.splice(0, state.notifications.length - 300);
  }

  return {
    notification,
    duplicate: false
  };
}

function getActiveRun(state) {
  return [...state.runs]
    .reverse()
    .find((run) => run.status === "active" || run.status === "blocked") || null;
}

function summarizeRun(run) {
  if (!run) {
    return "Активного прогона сейчас нет.";
  }

  const lastStep = [...run.steps].reverse()[0] || null;
  const lines = [
    `Прогон: ${run.title}`,
    `Статус: ${run.status}`
  ];

  if (run.objective) {
    lines.push(`Цель: ${run.objective}`);
  }

  if (lastStep) {
    lines.push(`Последний шаг: ${lastStep.title}`);
    lines.push(`Статус шага: ${lastStep.status}`);
  }

  if (run.blocker) {
    lines.push(`Блокер: ${run.blocker}`);
  }

  if (run.result) {
    lines.push(`Итог: ${run.result}`);
  }

  return lines.join("\n");
}

function summarizeQueueItem(item) {
  if (!item) {
    return "Открытых задач в очереди сейчас нет.";
  }

  const lines = [
    `Следующая задача: ${item.title}`,
    `Приоритет: ${item.priority}`,
    `Статус: ${item.status}`
  ];

  if (item.objective) {
    lines.push(`Суть: ${item.objective}`);
  }

  if (item.notes) {
    lines.push(`Заметки: ${item.notes}`);
  }

  return lines.join("\n");
}

module.exports = {
  STATE_PATH,
  loadSquadState,
  saveSquadState,
  createRun,
  addStep,
  updateStep,
  setRunStatus,
  addQueueItem,
  updateQueueItem,
  getOpenQueueItems,
  getNextQueueItem,
  getRecentNotifications,
  recordNotification,
  getActiveRun,
  summarizeRun,
  summarizeQueueItem,
  hashText,
  makeId
};
