const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "..", "config", "scenario-packs.json");

function loadScenarioPacks() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      runModes: Array.isArray(parsed.runModes) ? parsed.runModes : [],
      packs: Array.isArray(parsed.packs) ? parsed.packs : []
    };
  } catch (error) {
    return {
      runModes: [],
      packs: []
    };
  }
}

module.exports = {
  loadScenarioPacks
};
