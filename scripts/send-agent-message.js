const {
  extractLatestReplyText,
  getAgent,
  sendText,
  waitForReply
} = require("./lib/agent-bridge");
const fs = require("fs");

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/send-agent-message.js --agent <agentId> [--mode default|web_search|deep_research|agent_mode] [--text \"...\"] [--stdin] [--file <path>] [--wait]",
      "",
      "Examples:",
      "  node scripts/send-agent-message.js --agent chatgpt-123 --file .\\message.txt --wait",
      "  node scripts/send-agent-message.js --agent chatgpt-123 --file .\\message.txt --mode deep_research --wait"
    ].join("\n")
  );
}

function parseArgs(argv) {
  const options = {
    agentId: "",
    mode: "default",
    text: "",
    readFromStdin: false,
    filePath: "",
    waitForReply: false,
    timeoutMs: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--agent") {
      options.agentId = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (arg === "--mode") {
      options.mode = argv[index + 1] || "default";
      index += 1;
      continue;
    }

    if (arg === "--text") {
      options.text = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (arg === "--stdin") {
      options.readFromStdin = true;
      continue;
    }

    if (arg === "--file") {
      options.filePath = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (arg === "--wait") {
      options.waitForReply = true;
      continue;
    }

    if (arg === "--timeout") {
      const value = Number(argv[index + 1] || "");
      if (Number.isFinite(value) && value > 0) {
        options.timeoutMs = value;
      }
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
  }

  return options;
}

function readStdinUtf8() {
  return new Promise((resolve, reject) => {
    let chunks = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      chunks += chunk;
    });
    process.stdin.on("end", () => resolve(chunks));
    process.stdin.on("error", reject);
  });
}

function readFileUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (
    options.help ||
    !options.agentId ||
    (!options.text && !options.readFromStdin && !options.filePath)
  ) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  let sourceText = options.text;

  if (options.filePath) {
    sourceText = readFileUtf8(options.filePath);
  } else if (options.readFromStdin) {
    sourceText = await readStdinUtf8();
  }

  const text = String(sourceText || "").trim();

  if (!text) {
    throw new Error("EMPTY_TEXT");
  }

  const beforeSnapshot = await getAgent(options.agentId);
  const previousReply = extractLatestReplyText(beforeSnapshot);
  const sendResult = await sendText(options.agentId, text, {
    mode: options.mode
  });

  const summary = {
    ok: true,
    agentId: options.agentId,
    requestedMode: options.mode,
    delivered: sendResult.delivered,
    before: {
      busy: Boolean(beforeSnapshot.busy),
      composerMode: beforeSnapshot.composerMode || "default",
      latestReply: previousReply
    }
  };

  if (!options.waitForReply) {
    const afterSnapshot = await getAgent(options.agentId);
    summary.after = {
      busy: Boolean(afterSnapshot.busy),
      composerMode: afterSnapshot.composerMode || "default",
      latestReply: extractLatestReplyText(afterSnapshot)
    };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const result = await waitForReply(options.agentId, {
    previousReply,
    timeoutMs: options.timeoutMs
  });

  summary.after = {
    busy: Boolean(result.agent.busy),
    composerMode: result.agent.composerMode || "default",
    latestReply: result.latestReply
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error?.message || String(error)
      },
      null,
      2
    )
  );
  process.exit(1);
});
