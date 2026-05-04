const agentId = process.argv[2];
const baseUrl = process.env.AGENT_API_BASE_URL || "http://localhost:8080";

if (!agentId) {
  console.error("[ensure-agent-start] AGENT_ID_REQUIRED");
  process.exit(1);
}

async function main() {
  const response = await fetch(
    `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/ensure-start`,
    {
      method: "POST"
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `HTTP_${response.status}`);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(`[ensure-agent-start] ${error.message}`);
  process.exit(1);
});
