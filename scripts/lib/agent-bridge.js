const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { assertValidReply } = require("./reply-validation");
const { assertSafeOutgoingText } = require("./outgoing-text-guard");

const baseUrl = process.env.AGENT_API_BASE_URL || "http://localhost:8080";
const defaultTimeoutMs = Number(process.env.AGENT_WAIT_TIMEOUT_MS || 180000);
const defaultPollMs = Number(process.env.AGENT_POLL_MS || 2000);
const defaultStableMs = Number(process.env.AGENT_STABLE_MS || 4000);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashText(text) {
  return crypto.createHash("sha1").update(String(text || ""), "utf8").digest("hex");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureCheckpointPath(checkpointPath) {
  ensureDir(path.dirname(checkpointPath));
}

function loadCheckpoints(checkpointPath) {
  ensureCheckpointPath(checkpointPath);

  if (!fs.existsSync(checkpointPath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  } catch (error) {
    return {};
  }
}

function saveCheckpoints(checkpointPath, checkpoints) {
  ensureCheckpointPath(checkpointPath);
  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoints, null, 2), "utf8");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = {};

  try {
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(payload.error || `HTTP_${response.status}`);
  }

  return payload;
}

function extractLatestReplyText(snapshot) {
  const text = typeof snapshot?.lastText === "string" ? snapshot.lastText.trim() : "";

  if (!text) {
    return "";
  }

  const blocks = text
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

  return text;
}

function defaultSortAgents(agents) {
  return [...agents].sort((left, right) => {
    if (left.site !== right.site) {
      if (left.site === "chatgpt") {
        return -1;
      }

      if (right.site === "chatgpt") {
        return 1;
      }
    }

    const leftSeen = Number(left.firstSeenAt || 0);
    const rightSeen = Number(right.firstSeenAt || 0);

    if (leftSeen !== rightSeen) {
      return leftSeen - rightSeen;
    }

    return String(left.agentId).localeCompare(String(right.agentId));
  });
}

async function getConnectedAgents(sorter = defaultSortAgents) {
  const payload = await fetchJson(`${baseUrl}/api/agents`);
  const connected = (payload.agents || []).filter((agent) => agent.connected);
  return sorter(connected);
}

async function getAgent(agentId) {
  return fetchJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}`);
}

async function sendText(agentId, text, { mode = "default", waitForReply = false } = {}) {
  assertSafeOutgoingText(text);
  return fetchJson(`${baseUrl}/api/agents/${encodeURIComponent(agentId)}/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify({
      text,
      mode,
      waitForReply
    })
  });
}

function promptAppearsInTranscript(snapshot, prompt, snippetLength = 160) {
  const transcript = typeof snapshot?.lastText === "string" ? snapshot.lastText : "";
  const promptSnippet = String(prompt || "").slice(0, snippetLength);

  if (!transcript || !promptSnippet) {
    return false;
  }

  return transcript.includes(promptSnippet);
}

async function waitForReply(
  agentId,
  {
    previousReply = "",
    expectedStart = "",
    timeoutMs = defaultTimeoutMs,
    pollMs = defaultPollMs,
    stableMs = defaultStableMs
  } = {}
) {
  const startedAt = Date.now();
  let candidateReply = "";
  let candidateSince = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await getAgent(agentId);
    const latestReply = extractLatestReplyText(snapshot);
    const prefixOkay = !expectedStart || latestReply.startsWith(expectedStart);

    if (latestReply && latestReply !== previousReply && prefixOkay) {
      if (latestReply !== candidateReply) {
        candidateReply = latestReply;
        candidateSince = Date.now();
      }

      if (Date.now() - candidateSince >= stableMs) {
        return {
          agent: snapshot,
          latestReply
        };
      }
    }

    await delay(pollMs);
  }

  throw new Error(`TIMEOUT_${expectedStart || agentId}`);
}

async function askAgentWithCheckpoint({
  agent,
  prompt,
  mode = "default",
  expectedStart,
  validationSpec,
  validationLabel,
  checkpointPath,
  pendingWaitMs = 45000
}) {
  const checkpoints = loadCheckpoints(checkpointPath);
  const checkpointKey = validationLabel || expectedStart || agent.agentId;
  const promptHash = hashText(prompt);
  const existingCheckpoint = checkpoints[checkpointKey];

  if (
    existingCheckpoint &&
    existingCheckpoint.agentId === agent.agentId &&
    existingCheckpoint.promptHash === promptHash
  ) {
    try {
      assertValidReply(existingCheckpoint.reply, validationSpec, `${checkpointKey}_CHECKPOINT`);
      return {
        agent: await getAgent(agent.agentId),
        latestReply: existingCheckpoint.reply,
        reused: true,
        source: "checkpoint"
      };
    } catch (error) {
      delete checkpoints[checkpointKey];
      saveCheckpoints(checkpointPath, checkpoints);
    }
  }

  const snapshot = await getAgent(agent.agentId);
  const before = extractLatestReplyText(snapshot);

  if (promptAppearsInTranscript(snapshot, prompt)) {
    try {
      assertValidReply(before, validationSpec, `${checkpointKey}_LIVE_REPLY`);
      checkpoints[checkpointKey] = {
        agentId: agent.agentId,
        promptHash,
        reply: before,
        savedAt: new Date().toISOString()
      };
      saveCheckpoints(checkpointPath, checkpoints);
      return {
        agent: snapshot,
        latestReply: before,
        reused: true,
        source: "live"
      };
    } catch (error) {
      try {
        const pendingResult = await waitForReply(agent.agentId, {
          previousReply: before,
          expectedStart,
          timeoutMs: pendingWaitMs
        });
        assertValidReply(
          pendingResult.latestReply,
          validationSpec,
          `${checkpointKey}_PENDING_REPLY`
        );
        checkpoints[checkpointKey] = {
          agentId: agent.agentId,
          promptHash,
          reply: pendingResult.latestReply,
          savedAt: new Date().toISOString()
        };
        saveCheckpoints(checkpointPath, checkpoints);
        return {
          ...pendingResult,
          pending: true,
          source: "pending"
        };
      } catch (pendingError) {
        // If the visible prompt still did not yield a valid reply, send once more below.
      }
    }
  }

  await sendText(agent.agentId, prompt, { mode });
  const result = await waitForReply(agent.agentId, {
    previousReply: before,
    expectedStart
  });

  assertValidReply(result.latestReply, validationSpec, validationLabel || expectedStart);

  checkpoints[checkpointKey] = {
    agentId: agent.agentId,
    promptHash,
    reply: result.latestReply,
    savedAt: new Date().toISOString()
  };
  saveCheckpoints(checkpointPath, checkpoints);

  return {
    ...result,
    source: "fresh"
  };
}

module.exports = {
  askAgentWithCheckpoint,
  assertSafeOutgoingText,
  defaultSortAgents,
  extractLatestReplyText,
  fetchJson,
  getAgent,
  getConnectedAgents,
  hashText,
  loadCheckpoints,
  promptAppearsInTranscript,
  saveCheckpoints,
  sendText,
  waitForReply
};
