const BRIDGE_STATE_KEY = "__AI_TABS_BRIDGE_STATE__";
const CONTENT_SCRIPT_VERSION = "broagents-extension-2026-03-18-24";
const USER_LABEL = "\u0412\u044b:\n";
const CHATGPT_LABEL = "ChatGPT:\n";
const GEMINI_LABEL = "Gemini:\n";
const CHAT_SEPARATOR = "\n\n--------------------\n\n";
const SEND_LABEL_RU = "\u041e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c";

if (window[BRIDGE_STATE_KEY]?.observer) {
  window[BRIDGE_STATE_KEY].observer.disconnect();
}

if (window[BRIDGE_STATE_KEY]?.pollInterval) {
  clearInterval(window[BRIDGE_STATE_KEY].pollInterval);
}

if (window[BRIDGE_STATE_KEY]?.heartbeatInterval) {
  clearInterval(window[BRIDGE_STATE_KEY].heartbeatInterval);
}

if (window[BRIDGE_STATE_KEY]?.messageListener) {
  chrome.runtime.onMessage.removeListener(window[BRIDGE_STATE_KEY].messageListener);
}

window[BRIDGE_STATE_KEY] = {
  observer: null,
  messageListener: null,
  pollInterval: null,
  heartbeatInterval: null,
  lastSentText: "",
  lastPrepareAt: 0
};

function detectSite() {
  const hostname = window.location.hostname;
  if (hostname.includes("chatgpt.com")) return "chatgpt";
  if (hostname.includes("gemini.google.com")) return "gemini";
  return "unknown";
}

function sendRuntimeMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        console.debug("[AI Bridge]", chrome.runtime.lastError.message);
      }
    });
  } catch (error) {}
}

function sendRuntimeMessageAsync(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            reason: chrome.runtime.lastError.message || "runtime_message_failed"
          });
          return;
        }

        resolve(response || { ok: false, reason: "empty_response" });
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: error?.message || "runtime_message_exception"
      });
    }
  });
}

function logBridge(event, details = {}) {
  sendRuntimeMessage({
    type: "LOG_EVENT",
    event,
    details: {
      site: detectSite(),
      url: window.location.href,
      title: document.title,
      visibilityState: document.visibilityState,
      ...details
    }
  });
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function dispatchInputEvents(element, text) {
  try {
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: "insertText"
      })
    );
  } catch (error) {
    element.dispatchEvent(new Event("beforeinput", { bubbles: true, cancelable: true }));
  }

  try {
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: text,
        inputType: "insertText"
      })
    );
  } catch (error) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function placeCaretAtEnd(element) {
  if (!(element instanceof HTMLElement) || !element.isContentEditable) {
    return;
  }

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function setTextIntoField(element, text) {
  if (!element) {
    return false;
  }

  element.focus();

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

    if (valueSetter) {
      valueSetter.call(element, text);
    } else {
      element.value = text;
    }

    dispatchInputEvents(element, text);
    return true;
  }

  if (element.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.deleteContents();
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;

    if (typeof document.execCommand === "function") {
      try {
        inserted = document.execCommand("insertText", false, text);
      } catch (error) {
        inserted = false;
      }
    }

    if (!inserted) {
      element.textContent = text;
    }

    placeCaretAtEnd(element);
    dispatchInputEvents(element, text);
    return true;
  }

  return false;
}

function getFieldText(element) {
  if (!element) {
    return "";
  }

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return String(element.value || "");
  }

  if (element.isContentEditable) {
    return String(element.textContent || "");
  }

  return "";
}

function getKeyboardMetaForChar(char) {
  if (char === "/") {
    return { key: "/", code: "Slash", keyCode: 191, which: 191 };
  }

  if (char === " ") {
    return { key: " ", code: "Space", keyCode: 32, which: 32 };
  }

  const upper = String(char || "").toUpperCase();
  const isLatinLetter = /^[A-Z]$/.test(upper);

  if (isLatinLetter) {
    const keyCode = upper.charCodeAt(0);
    return {
      key: String(char || ""),
      code: `Key${upper}`,
      keyCode,
      which: keyCode
    };
  }

  return {
    key: String(char || ""),
    code: "",
    keyCode: 0,
    which: 0
  };
}

function dispatchKeyboardTextEvent(element, type, meta) {
  try {
    element.dispatchEvent(
      new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: meta.key,
        code: meta.code,
        keyCode: meta.keyCode,
        which: meta.which
      })
    );
  } catch (error) {}
}

async function typeTextIntoFieldLikeUser(element, text, delayMs = 45) {
  if (!element) {
    return false;
  }

  const targetText = String(text || "");

  if (!setTextIntoField(element, "")) {
    return false;
  }

  let composed = "";

  for (const char of targetText) {
    const meta = getKeyboardMetaForChar(char);
    dispatchKeyboardTextEvent(element, "keydown", meta);
    dispatchKeyboardTextEvent(element, "keypress", meta);

    composed += char;

    if (!setTextIntoField(element, composed)) {
      return false;
    }

    dispatchKeyboardTextEvent(element, "keyup", meta);

    if (delayMs > 0) {
      await wait(delayMs);
    }
  }

  return true;
}

function getChatInput(site) {
  const selectorsBySite = {
    chatgpt: [
      "#prompt-textarea",
      'div[contenteditable="true"][id="prompt-textarea"]',
      'div[contenteditable="true"][data-testid="composer-input"]',
      'textarea[data-testid="prompt-textarea"]'
    ],
    gemini: [
      "rich-textarea .ql-editor",
      'rich-textarea div[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label]',
      "textarea"
    ]
  };

  const selectors = selectorsBySite[site] || [];
  for (const selector of selectors) {
    const element = document.querySelector(selector);

    if (element) {
      return element;
    }
  }

  return null;
}

function getSendButton(site) {
  const selectorsBySite = {
    chatgpt: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]'
    ],
    gemini: [
      ".send-button",
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      `button[aria-label*="${SEND_LABEL_RU}"]`,
      'button[mattooltip*="Send"]'
    ]
  };

  const selectors = selectorsBySite[site] || [];
  return selectors.map((selector) => document.querySelector(selector)).find(Boolean) || null;
}

function clickSendButton(site) {
  const button = getSendButton(site);

  if (!button) {
    return false;
  }

  const disabled =
    button.disabled ||
    button.getAttribute("aria-disabled") === "true" ||
    button.getAttribute("data-disabled") === "true";

  if (disabled) {
    return false;
  }

  button.click();
  return true;
}

function dispatchEnter(element) {
  if (!element) {
    return false;
  }

  element.focus();

  const eventOptions = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  };

  element.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
  element.dispatchEvent(new KeyboardEvent("keypress", eventOptions));
  element.dispatchEvent(new KeyboardEvent("keyup", eventOptions));

  return true;
}

function dispatchEscape(element) {
  if (!element) {
    return false;
  }

  const eventOptions = {
    bubbles: true,
    cancelable: true,
    key: "Escape",
    code: "Escape",
    keyCode: 27,
    which: 27
  };

  element.dispatchEvent(new KeyboardEvent("keydown", eventOptions));
  element.dispatchEvent(new KeyboardEvent("keyup", eventOptions));

  return true;
}

function isVisibleElement(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();

  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.pointerEvents !== "none" &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function getElementUiLabel(element) {
  if (!(element instanceof HTMLElement)) {
    return "";
  }

  return (
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.getAttribute("mattooltip") ||
    element.innerText ||
    ""
  )
    .trim()
    .toLowerCase();
}

function looksLikeStopButton(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const text = getElementUiLabel(element);
  const dataTestId = (element.getAttribute("data-testid") || "").toLowerCase();
  const dataTest = (element.getAttribute("data-test-id") || "").toLowerCase();
  const classes = Array.from(element.classList || []).join(" ").toLowerCase();

  return (
    text.includes("stop") ||
    text.includes("останов") ||
    dataTestId.includes("stop") ||
    dataTest.includes("stop") ||
    classes.includes("stop")
  );
}

function isSiteBusy(site) {
  const selectorsBySite = {
    chatgpt: [
      'button[data-testid*="stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[title*="Stop"]',
      'button[title*="stop"]'
    ],
    gemini: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[aria-label*="Останов"]',
      'button[title*="Stop"]',
      'button[title*="stop"]',
      'button[mattooltip*="Stop"]',
      'button[mattooltip*="stop"]',
      'button[mattooltip*="Останов"]',
      'button[data-test-id*="stop"]',
      'button[data-testid*="stop"]'
    ]
  };

  const selectors = selectorsBySite[site] || [];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));

    for (const element of elements) {
      if (isVisibleElement(element) && looksLikeStopButton(element)) {
        return true;
      }
    }
  }

  return false;
}

function getSendButton(site) {
  const selectorsBySite = {
    chatgpt: [
      'button[data-testid="send-button"]',
      `button[aria-label*="${SEND_LABEL_RU}"]`,
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button[title*="Send"]',
      'button[title*="send"]'
    ],
    gemini: [
      ".send-button",
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      `button[aria-label*="${SEND_LABEL_RU}"]`,
      'button[mattooltip*="Send"]'
    ]
  };

  const selectors = selectorsBySite[site] || [];
  const candidates = selectors.flatMap((selector) =>
    Array.from(document.querySelectorAll(selector))
  );

  return (
    candidates.find(
      (element) => isVisibleElement(element) && !looksLikeStopButton(element)
    ) || null
  );
}

function looksLikeStopButton(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const text = getElementUiLabel(element);
  const dataTestId = (element.getAttribute("data-testid") || "").toLowerCase();
  const dataTest = (element.getAttribute("data-test-id") || "").toLowerCase();
  const classes = Array.from(element.classList || []).join(" ").toLowerCase();

  return (
    text.includes("stop") ||
    text.includes("останов") ||
    dataTestId.includes("stop") ||
    dataTest.includes("stop") ||
    classes.includes("stop")
  );
}

function isSiteBusy(site) {
  const selectorsBySite = {
    chatgpt: [
      'button[data-testid*="stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[title*="Stop"]',
      'button[title*="stop"]'
    ],
    gemini: [
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[aria-label*="Останов"]',
      'button[title*="Stop"]',
      'button[title*="stop"]',
      'button[mattooltip*="Stop"]',
      'button[mattooltip*="stop"]',
      'button[mattooltip*="Останов"]',
      'button[data-test-id*="stop"]',
      'button[data-testid*="stop"]'
    ]
  };

  const selectors = selectorsBySite[site] || [];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));

    for (const element of elements) {
      if (isVisibleElement(element) && looksLikeStopButton(element)) {
        return true;
      }
    }
  }

  return false;
}

function closeObstructiveUi(site) {
  const selectorsBySite = {
    chatgpt: [
      'button[aria-label="Close"]',
      'button[aria-label*="close" i]',
      'button[data-testid*="close"]',
      '[role="dialog"] button',
      'button svg'
    ],
    gemini: [
      'button[aria-label="Close"]',
      'button[aria-label*="close" i]',
      '[role="dialog"] button',
      'mat-dialog-container button',
      'button[mat-dialog-close]'
    ]
  };

  const selectors = selectorsBySite[site] || [];
  let closedCount = 0;

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector)).slice(0, 12);

    for (const element of elements) {
      const button =
        element instanceof HTMLButtonElement
          ? element
          : element.closest?.("button");

      if (!button || !isVisibleElement(button)) {
        continue;
      }

      const buttonText = (button.innerText || button.getAttribute("aria-label") || "").trim();
      const looksLikeClose =
        /close|dismiss|got it|not now|skip|later|understood|ok|cancel|x|закрыть|понятно|не сейчас|пропустить/i.test(
          buttonText
        ) || button.querySelector('svg, [data-testid*="close"]');

      if (!looksLikeClose) {
        continue;
      }

      try {
        button.click();
        closedCount += 1;
      } catch (error) {
      }
    }
  }

  if (closedCount > 0) {
    logBridge("content.popup_closed", { closedCount });
  }

  return closedCount;
}

function prepareComposer(site) {
  closeObstructiveUi(site);
  window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });

  const input = getChatInput(site);

  if (!input) {
    logBridge("content.prepare.no_input");
    return null;
  }

  try {
    input.focus();
    input.click?.();
  } catch (error) {
  }

  logBridge("content.prepare.ready", {
    inputTag: input.tagName,
    contentEditable: Boolean(input.isContentEditable)
  });

  return input;
}

function getSlashCommandForMode(site, requestedMode) {
  if (site !== "chatgpt") {
    return "";
  }

  if (requestedMode === "web_search") {
    return "/search";
  }

  if (requestedMode === "agent_mode") {
    return "/agent";
  }

  if (requestedMode === "deep_research") {
    return "/Deepresearch";
  }

  return "";
}

function buildOutgoingTextForMode(site, text, requestedMode, options = {}) {
  const normalizedText = String(text || "").trim();
  const preferPlainText = Boolean(options.preferPlainText);
  const slashCommand = getSlashCommandForMode(site, requestedMode);

  if (preferPlainText || !slashCommand || !normalizedText) {
    return {
      text: normalizedText,
      usedSlashCommand: false,
      slashCommand: "",
      commandText: ""
    };
  }

  const lowerText = normalizedText.toLowerCase();
  const lowerSlash = slashCommand.toLowerCase();

  if (lowerText.startsWith(lowerSlash)) {
    return {
      text: normalizedText,
      usedSlashCommand: true,
      slashCommand,
      commandText: slashCommand
    };
  }

  return {
    text: `${slashCommand} ${normalizedText}`.trim(),
    usedSlashCommand: true,
    slashCommand,
    commandText: slashCommand
  };
}

async function activateSlashCommandForMode(site, input, requestedMode, slashCommand) {
  if (!slashCommand) {
    return {
      ok: false,
      activeMode: "default",
      reason: "SLASH_COMMAND_EMPTY"
    };
  }

  logBridge("content.mode.slash_command_inline", {
    requestedMode,
    slashCommand
  });

  return {
    ok: true,
    activeMode: requestedMode,
    reason: `slash_command_inline:${slashCommand}`
  };
}

async function insertTextAndSend(text, options = {}) {
  const site = detectSite();
  const requestedMode = typeof options.mode === "string" ? options.mode : "default";
  const useToolsMenu = Boolean(options.useToolsMenu);
  const outgoingText = buildOutgoingTextForMode(site, text, requestedMode, {
    preferPlainText: useToolsMenu
  });
  const prepared = prepareComposer(site);
  const input = prepared?.input;
  let modeResult = null;

  if (prepared?.busy) {
    logBridge("content.send.blocked_busy");
    return { ok: false, reason: "AGENT_BUSY" };
  }

  if (!input) {
    console.debug("[AI Bridge] Input field not found", site);
    return { ok: false, reason: "INPUT_NOT_FOUND" };
  }

  if (useToolsMenu) {
    modeResult = await ensureComposerMode(site, requestedMode);
  } else if (outgoingText.usedSlashCommand) {
    modeResult = await activateSlashCommandForMode(
      site,
      input,
      requestedMode,
      outgoingText.commandText || outgoingText.slashCommand
    );
  } else if (requestedMode === "default" || requestedMode === "extended_thinking") {
    modeResult = await ensureComposerMode(site, requestedMode);
  } else {
    modeResult = {
      ok: false,
      activeMode: findComposerMode(site),
      reason: "MODE_REQUIRES_COMMAND_PATH"
    };
  }

  if (!modeResult.ok) {
    logBridge("content.mode.not_available", {
      requestedMode,
      modeReason: modeResult.reason || "unknown"
    });
    return {
      ok: false,
      reason: modeResult.reason || "MODE_NOT_AVAILABLE",
      activeMode: modeResult.activeMode || "default"
    };
  }

  const inserted = setTextIntoField(input, outgoingText.text);

  if (!inserted) {
    console.debug("[AI Bridge] Failed to insert text", site);
    logBridge("content.send.insert_failed");
    return { ok: false, reason: "INSERT_FAILED" };
  }

  logBridge("content.send.inserted", {
    textLength: outgoingText.text.length,
    requestedMode,
    activeMode: modeResult.activeMode || "default",
    usedSlashCommand: outgoingText.usedSlashCommand,
    slashCommand: outgoingText.slashCommand || ""
  });

  await wait(250);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (clickSendButton(site)) {
      logBridge("content.send.button_clicked", { attempt: attempt + 1 });
      const generationStarted = await waitForGenerationStart(site);
      return {
        ok: true,
        method: "button",
        generationStarted,
        activeMode: modeResult.activeMode || requestedMode,
        modeReason: modeResult.reason || "selected"
      };
    }

    await wait(150);
  }

  dispatchEnter(input);
  logBridge("content.send.enter_fallback");
  const generationStarted = await waitForGenerationStart(site);
  return {
    ok: true,
    method: "enter",
    generationStarted,
    activeMode: modeResult.activeMode || requestedMode,
    modeReason: modeResult.reason || "selected"
  };
}

async function diagnoseSlashMenu() {
  const site = detectSite();
  const prepared = prepareComposer(site);
  const input = prepared?.input;

  if (prepared?.busy) {
    return {
      ok: false,
      reason: "AGENT_BUSY",
      busy: true
    };
  }

  if (!input) {
    return {
      ok: false,
      reason: "INPUT_NOT_FOUND",
      busy: false
    };
  }

  const inserted = await typeTextIntoFieldLikeUser(input, "/");

  if (!inserted) {
    return {
      ok: false,
      reason: "SLASH_INSERT_FAILED",
      busy: false
    };
  }

  await wait(350);

  const menuState = await waitForPopupMenuV2([], 1200);
  const items = listElementSummariesV2(menuState.items, 20);

  logBridge("content.slash_menu.diagnosed", {
    opened: menuState.opened,
    rootCount: menuState.roots.length,
    itemCount: menuState.items.length,
    items
  });

  setTextIntoField(input, "");
  await wait(100);
  dispatchEscape(input);

  return {
    ok: true,
    opened: menuState.opened,
    rootCount: menuState.roots.length,
    itemCount: menuState.items.length,
    items,
    visibilityState: document.visibilityState
  };
}

async function observeRawTextInComposer(text, waitMs = 1800) {
  const site = detectSite();
  const prepared = prepareComposer(site);
  const input = prepared?.input;

  if (prepared?.busy) {
    return {
      ok: false,
      reason: "AGENT_BUSY",
      busy: true
    };
  }

  if (!input) {
    return {
      ok: false,
      reason: "INPUT_NOT_FOUND",
      busy: false
    };
  }

  const inserted = await typeTextIntoFieldLikeUser(input, String(text || ""));

  if (!inserted) {
    return {
      ok: false,
      reason: "TEXT_INSERT_FAILED",
      busy: false
    };
  }

  const delayMs = Math.min(Math.max(Number(waitMs) || 1800, 100), 5000);
  await wait(delayMs);

  const menuState = await waitForPopupMenuV2([], 800);
  const items = listElementSummariesV2(menuState.items, 20);
  const currentText = getFieldText(input);

  logBridge("content.raw_text.observed", {
    observedText: String(text || ""),
    currentText,
    opened: menuState.opened,
    rootCount: menuState.roots.length,
    itemCount: menuState.items.length,
    items
  });

  return {
    ok: true,
    currentText,
    opened: menuState.opened,
    rootCount: menuState.roots.length,
    itemCount: menuState.items.length,
    items,
    visibilityState: document.visibilityState
  };
}

async function waitForGenerationStart(site) {
  if (isSiteBusy(site)) {
    logBridge("content.send.generation_started", { immediate: true });
    return true;
  }

  const startedAt = Date.now();

  while (Date.now() - startedAt < 3500) {
    await wait(250);

    if (isSiteBusy(site)) {
      logBridge("content.send.generation_started", {
        immediate: false,
        waitedMs: Date.now() - startedAt
      });
      return true;
    }
  }

  logBridge("content.send.generation_not_started");
  return false;
}

async function ensureGenerationStarted() {
  const site = detectSite();

  if (isSiteBusy(site)) {
    logBridge("content.send.ensure_started_already_busy");
    return { ok: true, started: true, reason: "already_busy" };
  }

  const input = getChatInput(site);
  const inputText = getFieldText(input);

  if (!input || !inputText) {
    logBridge("content.send.ensure_no_pending_text");
    return { ok: false, started: false, reason: "NO_PENDING_TEXT" };
  }

  try {
    input.focus();
  } catch (error) {
  }

  await wait(150);

  if (clickSendButton(site)) {
    logBridge("content.send.ensure_button_clicked");
    const started = await waitForGenerationStart(site);
    return { ok: started, started, reason: started ? "button" : "button_no_start" };
  }

  dispatchEnter(input);
  logBridge("content.send.ensure_enter_fallback");
  const started = await waitForGenerationStart(site);
  return { ok: started, started, reason: started ? "enter" : "enter_no_start" };
}

function observeNewMessages() {
  const site = detectSite();

  const observer = new MutationObserver(() => {
    setTimeout(() => {
      flushChatSnapshot(site);
    }, 800);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window[BRIDGE_STATE_KEY].observer = observer;
}

function collectChatHistory(site) {
  const history = [];

  if (site === "chatgpt") {
    const nodes = document.querySelectorAll("[data-message-author-role]");
    nodes.forEach((node) => {
      const role = node.getAttribute("data-message-author-role");
      const text = (node.innerText || "").trim();
      if (text) {
        history.push((role === "user" ? USER_LABEL : CHATGPT_LABEL) + text);
      }
    });
  } else if (site === "gemini") {
    const nodes = document.querySelectorAll(
      'user-query, model-response, [data-test-id="user-query"], [data-test-id="response-text"], message-content, .model-response-text'
    );

    nodes.forEach((node) => {
      const tag = node.tagName.toLowerCase();
      const isUser =
        tag === "user-query" ||
        node.getAttribute("data-test-id") === "user-query";
      const text = (node.innerText || node.textContent || "").trim();

      if (text && text.length > 1) {
        history.push((isUser ? USER_LABEL : GEMINI_LABEL) + text);
      }
    });
  }

  return history.slice(-6).join(CHAT_SEPARATOR);
}

function flushChatSnapshot(site = detectSite()) {
  const text = collectChatHistory(site);

  if (!text || text === window[BRIDGE_STATE_KEY].lastSentText) {
    return;
  }

  window[BRIDGE_STATE_KEY].lastSentText = text;

  sendRuntimeMessage({
    type: "TEXT_UPDATE",
    site,
    text,
    url: window.location.href,
    title: document.title,
    state: getAgentUiState(site)
  });
}

function startPolling() {
  if (window[BRIDGE_STATE_KEY].pollInterval) {
    clearInterval(window[BRIDGE_STATE_KEY].pollInterval);
  }

  window[BRIDGE_STATE_KEY].pollInterval = setInterval(() => {
    flushChatSnapshot();
  }, 2000);
}

function registerAgent() {
  sendRuntimeMessage({
    type: "REGISTER_AGENT",
    site: detectSite(),
    url: window.location.href,
    title: document.title,
    state: getAgentUiState()
  });
}

function sendHeartbeat() {
  sendRuntimeMessage({
    type: "AGENT_HEARTBEAT",
    site: detectSite(),
    url: window.location.href,
    title: document.title,
    state: getAgentUiState()
  });
}

function startHeartbeat() {
  if (window[BRIDGE_STATE_KEY].heartbeatInterval) {
    clearInterval(window[BRIDGE_STATE_KEY].heartbeatInterval);
  }

  sendHeartbeat();

  window[BRIDGE_STATE_KEY].heartbeatInterval = setInterval(() => {
    sendHeartbeat();
  }, 15000);
}

// Override the earlier helpers with stricter versions so we only touch
// the real composer and explicit close buttons.
function getChatInput(site) {
  const selectorsBySite = {
    chatgpt: [
      '#prompt-textarea[contenteditable="true"]',
      'form #prompt-textarea[contenteditable="true"]',
      'div[contenteditable="true"][id="prompt-textarea"]',
      'div[contenteditable="true"][data-testid="composer-input"]',
      'textarea[data-testid="prompt-textarea"]'
    ],
    gemini: [
      "rich-textarea .ql-editor",
      'rich-textarea div[contenteditable="true"]',
      '.ql-editor[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][aria-label]',
      "textarea"
    ]
  };

  const selectors = selectorsBySite[site] || [];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));

    for (const element of elements) {
      if (isVisibleElement(element) && !looksLikeStopButton(element)) {
        return element;
      }
    }
  }

  return null;
}

function getSendButton(site) {
  const selectorsBySite = {
    chatgpt: [
      'button[data-testid="send-button"]',
      'form button[aria-label*="Send"]',
      'form button[aria-label*="send"]'
    ],
    gemini: [
      ".send-button",
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      `button[aria-label*="${SEND_LABEL_RU}"]`,
      'button[mattooltip*="Send"]'
    ]
  };

  const selectors = selectorsBySite[site] || [];

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));

    for (const element of elements) {
      if (isVisibleElement(element) && !looksLikeStopButton(element)) {
        return element;
      }
    }
  }

  return null;
}

function getFieldText(element) {
  if (!element) {
    return "";
  }

  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    return String(element.value || "").trim();
  }

  if (element instanceof HTMLElement) {
    return String(element.innerText || element.textContent || "").trim();
  }

  return "";
}

const MODE_LABELS = {
  chatgpt: {
    default: [],
    web_search: ["search the web", "web search", "search web", "поиск в сети"],
    deep_research: ["deep research", "глубокое исследование"],
    extended_thinking: [
      "extended thinking",
      "thinking",
      "reason",
      "reasoning",
      "think longer",
      "deeper thinking",
      "расширенное размышление",
      "глубокое мышление"
    ],
    agent_mode: ["agent mode", "режим агента"]
  }
};

const CHATGPT_MORE_LABELS = ["more", "больше"];
const CHATGPT_REASONING_BUTTON_LABELS = [
  "thinking",
  "reason",
  "reasoning",
  "think",
  "размыш",
  "мышл",
  "расширенн"
];
const CHATGPT_MENU_BUTTON_LABELS = [
  "attach",
  "upload",
  "photo",
  "photos",
  "file",
  "files",
  "tools",
  "more tools",
  "plus",
  "добав",
  "загруз",
  "фото",
  "файлы",
  "инстру"
];

function normalizeUiText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function getClickableLabel(element) {
  if (!(element instanceof HTMLElement)) {
    return "";
  }

  return normalizeUiText(
    element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.innerText ||
      element.textContent ||
      ""
  );
}

function elementMatchesAnyLabel(element, variants) {
  const label = getClickableLabel(element);

  if (!label || !Array.isArray(variants) || variants.length === 0) {
    return false;
  }

  return variants.some((variant) => label.includes(normalizeUiText(variant)));
}

function getComposerScope(site) {
  const input = getChatInput(site);

  if (!(input instanceof HTMLElement)) {
    return document.body;
  }

  const explicitScopes = uniqueElementsV2([
    input.closest?.('[data-testid*="composer"]'),
    input.closest?.('[class*="composer"]'),
    input.closest?.("form"),
    input.parentElement
  ]).filter(Boolean);

  for (const candidate of explicitScopes) {
    const hasPlusButton = candidate.querySelector?.('button[data-testid="composer-plus-btn"]');
    const hasSendButton =
      candidate.querySelector?.('button[data-testid="send-button"]') ||
      candidate.querySelector?.(`button[aria-label*="${SEND_LABEL_RU}"]`) ||
      candidate.querySelector?.('button[aria-label*="Send"]');
    const textLength = normalizeUiText(candidate.textContent || "").length;

    if ((hasPlusButton || hasSendButton) && textLength > 0 && textLength < 1200) {
      return candidate;
    }
  }

  let current = input;

  while (current && current !== document.body) {
    const hasPlusButton = current.querySelector?.('button[data-testid="composer-plus-btn"]');
    const hasSendButton =
      current.querySelector?.('button[data-testid="send-button"]') ||
      current.querySelector?.(`button[aria-label*="${SEND_LABEL_RU}"]`) ||
      current.querySelector?.('button[aria-label*="Send"]');

    if (hasPlusButton || hasSendButton) {
      return current;
    }

    current = current.parentElement;
  }

  return input.closest?.("form") || input.parentElement || document.body;
}

function getVisibleClickables(scope = document) {
  return Array.from(
    scope.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')
  ).filter((element) => isVisibleElement(element));
}

function findComposerMode(site) {
  const modeLabels = MODE_LABELS[site];

  if (!modeLabels) {
    return "default";
  }

  const scope = getComposerScope(site);
  const nodes = getVisibleClickables(scope);

  for (const [mode, labels] of Object.entries(modeLabels)) {
    if (mode === "default") {
      continue;
    }

    if (nodes.some((element) => elementMatchesAnyLabel(element, labels))) {
      return mode;
    }
  }

  return "default";
}

function clickFirstElementByLabels(labels, scope = document) {
  const elements = getVisibleClickables(scope);
  const element = elements.find(
    (candidate) =>
      !looksLikeStopButton(candidate) &&
      !elementMatchesAnyLabel(candidate, ["send", "отправить"]) &&
      elementMatchesAnyLabel(candidate, labels)
  );

  if (!element) {
    return false;
  }

  try {
    element.click();
    return true;
  } catch (error) {
    return false;
  }
}

function clickChatGptMenuButton() {
  const site = detectSite();
  const scope = getComposerScope(site);
  const candidates = getVisibleClickables(scope);
  const button = candidates.find((element) => {
    if (looksLikeStopButton(element)) {
      return false;
    }

    const ariaHasPopup = normalizeUiText(element.getAttribute("aria-haspopup") || "");

    return (
      elementMatchesAnyLabel(element, CHATGPT_MENU_BUTTON_LABELS) ||
      ariaHasPopup === "menu"
    );
  });

  if (!button) {
    return false;
  }

  try {
    button.click();
    return true;
  } catch (error) {
    return false;
  }
}

function clickChatGptReasoningButton() {
  const site = detectSite();
  const scope = getComposerScope(site);
  const candidates = getVisibleClickables(scope);
  const button = candidates.find((element) => {
    if (looksLikeStopButton(element)) {
      return false;
    }

    if (elementMatchesAnyLabel(element, ["send", "отправить"])) {
      return false;
    }

    return elementMatchesAnyLabel(element, CHATGPT_REASONING_BUTTON_LABELS);
  });

  if (!button) {
    return false;
  }

  try {
    button.click();
    return true;
  } catch (error) {
    return false;
  }
}

async function ensureComposerMode(site, requestedMode = "default") {
  const normalizedMode = MODE_LABELS[site]?.[requestedMode] ? requestedMode : "default";

  if (site !== "chatgpt") {
    return {
      ok: normalizedMode === "default",
      activeMode: "default",
      reason: normalizedMode === "default" ? "default" : "UNSUPPORTED_SITE"
    };
  }

  const currentMode = findComposerMode(site);

  if (normalizedMode === "default") {
    return {
      ok: true,
      activeMode: currentMode,
      reason: currentMode === "default" ? "default" : "mode_left_as_is"
    };
  }

  if (currentMode === normalizedMode) {
    return { ok: true, activeMode: currentMode, reason: "already_selected" };
  }

  if (normalizedMode === "extended_thinking") {
    if (!clickChatGptReasoningButton()) {
      return { ok: false, activeMode: currentMode, reason: "REASONING_BUTTON_NOT_FOUND" };
    }

    await wait(250);

    const directLabels = MODE_LABELS.chatgpt[normalizedMode] || [];

    if (clickFirstElementByLabels(directLabels)) {
      await wait(500);
      return {
        ok: true,
        activeMode: findComposerMode(site) || normalizedMode,
        reason: "selected_reasoning"
      };
    }

    return { ok: false, activeMode: currentMode, reason: "REASONING_ITEM_NOT_FOUND" };
  }

  if (!clickChatGptMenuButton()) {
    return { ok: false, activeMode: currentMode, reason: "MENU_BUTTON_NOT_FOUND" };
  }

  await wait(250);

  const directLabels = MODE_LABELS.chatgpt[normalizedMode] || [];

  if (clickFirstElementByLabels(directLabels)) {
    await wait(500);
    return {
      ok: true,
      activeMode: findComposerMode(site) || normalizedMode,
      reason: "selected_direct"
    };
  }

  if (clickFirstElementByLabels(CHATGPT_MORE_LABELS)) {
    await wait(250);

    if (clickFirstElementByLabels(directLabels)) {
      await wait(500);
      return {
        ok: true,
        activeMode: findComposerMode(site) || normalizedMode,
        reason: "selected_nested"
      };
    }
  }

  return { ok: false, activeMode: currentMode, reason: "MODE_ITEM_NOT_FOUND" };
}

function getAgentUiState(site = detectSite()) {
  return {
    busy: isSiteBusy(site),
    composerMode: findComposerMode(site),
    contentVersion: CONTENT_SCRIPT_VERSION
  };
}

const MODE_LABELS_V2 = {
  chatgpt: {
    default: [],
    web_search: [
      "search the web",
      "web search",
      "search web",
      "\u043f\u043e\u0438\u0441\u043a \u0432 \u0441\u0435\u0442\u0438"
    ],
    deep_research: [
      "deep research",
      "\u0433\u043b\u0443\u0431\u043e\u043a\u043e\u0435 \u0438\u0441\u0441\u043b\u0435\u0434\u043e\u0432\u0430\u043d\u0438\u0435",
      "\u043f\u043e\u043b\u0443\u0447\u0438\u0442\u044c \u043f\u043e\u0434\u0440\u043e\u0431\u043d\u044b\u0439 \u043e\u0442\u0447\u0435\u0442",
      "\u043f\u043e\u0434\u0440\u043e\u0431\u043d\u044b\u0439 \u043e\u0442\u0447\u0435\u0442",
      "get detailed report",
      "detailed report"
    ],
    extended_thinking: [
      "extended thinking",
      "thinking",
      "reason",
      "reasoning",
      "think longer",
      "deeper thinking",
      "\u0440\u0430\u0441\u0448\u0438\u0440\u0435\u043d\u043d\u043e\u0435 \u0440\u0430\u0437\u043c\u044b\u0448\u043b\u0435\u043d\u0438\u0435",
      "\u0433\u043b\u0443\u0431\u043e\u043a\u043e\u0435 \u043c\u044b\u0448\u043b\u0435\u043d\u0438\u0435"
    ],
    agent_mode: ["agent mode", "\u0440\u0435\u0436\u0438\u043c \u0430\u0433\u0435\u043d\u0442\u0430"]
  }
};

const CHATGPT_MORE_LABELS_V2 = ["more", "\u0431\u043e\u043b\u044c\u0448\u0435"];
const CHATGPT_REASONING_BUTTON_LABELS_V2 = [
  "thinking",
  "reason",
  "reasoning",
  "think",
  "\u0440\u0430\u0437\u043c\u044b\u0448",
  "\u043c\u044b\u0441\u043b",
  "\u0440\u0430\u0441\u0448\u0438\u0440\u0435\u043d\u043d"
];
const CHATGPT_MENU_BUTTON_LABELS_V2 = [
  "attach",
  "upload",
  "photo",
  "photos",
  "file",
  "files",
  "tools",
  "more tools",
  "plus",
  "\u0434\u043e\u0431\u0430\u0432",
  "\u0437\u0430\u0433\u0440\u0443\u0437",
  "\u0444\u043e\u0442\u043e",
  "\u0444\u0430\u0439\u043b\u044b",
  "\u0438\u043d\u0441\u0442\u0440\u0443"
];
const CHATGPT_POPUP_ROOT_SELECTORS_V2 = [
  '[data-radix-popper-content-wrapper]',
  '[data-radix-menu-content]',
  '[data-slot*="popover"]',
  '[role="menu"]',
  '[role="dialog"]',
  '[role="listbox"]'
];
const EXTENDED_CLICKABLE_SELECTOR_V2 = [
  "button",
  "[role=\"button\"]",
  "[role=\"menuitem\"]",
  "[role=\"menuitemcheckbox\"]",
  "[role=\"option\"]",
  "[role=\"listitem\"]",
  "a",
  "[data-radix-collection-item]"
].join(", ");

function uniqueElementsV2(elements) {
  return Array.from(new Set(elements.filter(Boolean)));
}

function isDomPresentElementV2(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function getVisibleClickablesV2(scope = document) {
  const allowHiddenLayout = document.visibilityState === "hidden";
  return Array.from(scope.querySelectorAll(EXTENDED_CLICKABLE_SELECTOR_V2)).filter((element) =>
    allowHiddenLayout ? isDomPresentElementV2(element) : isVisibleElement(element)
  );
}

function getComposerPlaceholderTextV2(site) {
  const input = getChatInput(site);
  const scope = getComposerScope(site);
  const placeholderCandidates = [
    input?.getAttribute?.("placeholder") || "",
    input?.getAttribute?.("aria-placeholder") || "",
    input?.getAttribute?.("aria-label") || "",
    input?.getAttribute?.("title") || "",
    scope?.querySelector?.("[data-placeholder]")?.getAttribute?.("data-placeholder") || "",
    scope?.querySelector?.("[placeholder]")?.getAttribute?.("placeholder") || "",
    scope?.querySelector?.("[aria-placeholder]")?.getAttribute?.("aria-placeholder") || "",
    scope?.querySelector?.("[aria-label]")?.getAttribute?.("aria-label") || "",
    scope?.querySelector?.("[title]")?.getAttribute?.("title") || ""
  ];

  return normalizeUiText(placeholderCandidates.join(" "));
}

function getElementEventPointV2(element) {
  if (!(element instanceof HTMLElement)) {
    return {
      clientX: 0,
      clientY: 0,
      screenX: 0,
      screenY: 0
    };
  }

  const rect = element.getBoundingClientRect();
  const clientX = Math.round(rect.left + Math.max(rect.width / 2, 1));
  const clientY = Math.round(rect.top + Math.max(rect.height / 2, 1));

  return {
    clientX,
    clientY,
    screenX: clientX,
    screenY: clientY
  };
}

function getElementCenterPointV2(element) {
  return getElementEventPointV2(element);
}

async function requestDebuggerClickForElementV2(element) {
  if (!(element instanceof HTMLElement)) {
    return { ok: false, reason: "INVALID_ELEMENT" };
  }

  const point = getElementCenterPointV2(element);

  return sendRuntimeMessageAsync({
    type: "DEBUGGER_MOUSE_CLICK",
    x: point.clientX,
    y: point.clientY
  });
}

function activateElementV2(element, options = {}) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const usePointer = options.pointer !== false;
  const useKeyboard = Boolean(options.keyboard);
  const useClick = options.click !== false;

  try {
    element.scrollIntoView?.({ block: "center", inline: "center" });
  } catch (error) {}

  try {
    element.focus?.();
  } catch (error) {}

  const point = getElementEventPointV2(element);

  if (usePointer) {
    const mouseSequence = [
      ["pointerover", PointerEvent],
      ["mouseover", MouseEvent],
      ["pointerenter", PointerEvent],
      ["mouseenter", MouseEvent],
      ["pointermove", PointerEvent],
      ["mousemove", MouseEvent],
      ["pointerdown", PointerEvent],
      ["mousedown", MouseEvent],
      ["pointerup", PointerEvent],
      ["mouseup", MouseEvent]
    ];

    for (const [type, EventCtor] of mouseSequence) {
      try {
        element.dispatchEvent(
          new EventCtor(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerType: "mouse",
            isPrimary: true,
            button: 0,
            buttons: 1,
            ...point
          })
        );
      } catch (error) {}
    }
  }

  if (useKeyboard) {
    for (const key of ["Enter", " "]) {
      const code = key === " " ? "Space" : "Enter";
      const keyCode = key === " " ? 32 : 13;

      try {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key,
            code,
            keyCode,
            which: keyCode
          })
        );
        element.dispatchEvent(
          new KeyboardEvent("keyup", {
            bubbles: true,
            cancelable: true,
            key,
            code,
            keyCode,
            which: keyCode
          })
        );
      } catch (error) {}
    }
  }

  if (useClick) {
    try {
      element.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 0,
          buttons: 1,
          ...point
        })
      );
    } catch (error) {}

    try {
      element.click();
    } catch (error) {}
  }

  return true;
}

function getComposerSnapshotV2(site) {
  const input = getChatInput(site);
  const scope = getComposerScope(site);
  const placeholderCandidates = uniqueElementsV2([
    input,
    ...Array.from(scope.querySelectorAll("[placeholder], [aria-placeholder], [aria-label], [title]"))
  ])
    .map((element) =>
      normalizeUiText(
        element?.getAttribute?.("placeholder") ||
          element?.getAttribute?.("aria-placeholder") ||
          element?.getAttribute?.("aria-label") ||
          element?.getAttribute?.("title") ||
          ""
      )
    )
    .filter(Boolean)
    .slice(0, 12);
  const buttons = getVisibleClickablesV2(scope)
    .map((element) => summarizeElementV2(element))
    .filter(Boolean)
    .slice(0, 18);

  return {
    inputText: getFieldText(input).slice(0, 400),
    inputPlaceholder: getComposerPlaceholderTextV2(site),
    placeholderCandidates,
    scopeText: normalizeUiText(
      [scope?.innerText || "", scope?.textContent || ""].join(" ")
    ).slice(0, 400),
    buttons
  };
}

function summarizeElementV2(element) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  const className =
    typeof element.className === "string"
      ? element.className.slice(0, 180)
      : "";

  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || "",
    label: getClickableLabel(element).slice(0, 120),
    ariaHasPopup: element.getAttribute("aria-haspopup") || "",
    ariaChecked: element.getAttribute("aria-checked") || "",
    ariaSelected: element.getAttribute("aria-selected") || "",
    ariaExpanded: element.getAttribute("aria-expanded") || "",
    dataState: element.getAttribute("data-state") || "",
    dataHeadlessUiState: element.getAttribute("data-headlessui-state") || "",
    className,
    dataTestId:
      element.getAttribute("data-testid") ||
      element.getAttribute("data-test-id") ||
      ""
  };
}

function listElementSummariesV2(elements, limit = 12) {
  return uniqueElementsV2(elements)
    .map((element) => summarizeElementV2(element))
    .filter(Boolean)
    .slice(0, limit);
}

function getActivationDescendantsV2(element) {
  if (!(element instanceof HTMLElement)) {
    return [];
  }

  const descendants = Array.from(
    element.querySelectorAll(
      [
        "input",
        "label",
        "button",
        "[role]",
        "[aria-checked]",
        "[aria-selected]",
        "[data-state]",
        "[tabindex]",
        "label",
        "span",
        "div"
      ].join(", ")
    )
  ).filter((candidate) => {
    if (candidate.tagName === "INPUT" || candidate.tagName === "LABEL") {
      return true;
    }

    return document.visibilityState === "hidden"
      ? isDomPresentElementV2(candidate)
      : isVisibleElement(candidate);
  });

  return uniqueElementsV2(descendants).slice(0, 12);
}

function getVisiblePopupRootsV2() {
  const roots = [];

  for (const selector of CHATGPT_POPUP_ROOT_SELECTORS_V2) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (isVisibleElement(element)) {
        roots.push(element);
      }
    }
  }

  return uniqueElementsV2(roots);
}

function getPopupItemsV2(roots = getVisiblePopupRootsV2()) {
  return uniqueElementsV2(roots.flatMap((root) => getVisibleClickablesV2(root)));
}

function getModeSearchScopesV2(site, roots = getVisiblePopupRootsV2()) {
  return uniqueElementsV2([getComposerScope(site), ...roots]).filter(Boolean);
}

function getPopupMenuStateV2(targetLabels = []) {
  const labels = Array.isArray(targetLabels) ? targetLabels : [];
  const roots = getVisiblePopupRootsV2();
  const items = getPopupItemsV2(roots);
  const matchingItems = items.filter((element) => elementMatchesAnyLabel(element, labels));

  return {
    opened: roots.length > 0 || matchingItems.length > 0 || items.length > 0,
    roots,
    items,
    matchingItems
  };
}

function findMatchingElementV2(labels, scopes = [document]) {
  const scopeList = Array.isArray(scopes) ? scopes : [scopes];

  for (const scope of scopeList) {
    const element = getVisibleClickablesV2(scope).find(
      (candidate) =>
        !looksLikeStopButton(candidate) &&
        !elementMatchesAnyLabel(candidate, ["send", SEND_LABEL_RU]) &&
        elementMatchesAnyLabel(candidate, labels)
    );

    if (element) {
      return { element, scope };
    }
  }

  return null;
}

async function waitForPopupMenuV2(targetLabels = [], timeoutMs = 1200) {
  const startedAt = Date.now();
  let lastState = getPopupMenuStateV2(targetLabels);

  if (lastState.opened || timeoutMs <= 0) {
    return lastState;
  }

  while (Date.now() - startedAt < timeoutMs) {
    await wait(100);
    lastState = getPopupMenuStateV2(targetLabels);

    if (lastState.opened) {
      return lastState;
    }
  }

  return lastState;
}

function elementLooksSelectedV2(summary) {
  if (!summary) {
    return false;
  }

  const ariaChecked = normalizeUiText(summary.ariaChecked || "");
  const ariaSelected = normalizeUiText(summary.ariaSelected || "");
  const dataState = normalizeUiText(summary.dataState || "");
  const headlessUiState = normalizeUiText(summary.dataHeadlessUiState || "");
  const className = normalizeUiText(summary.className || "");
  const dataStateTokens = dataState
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const headlessUiTokens = headlessUiState
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  return (
    ariaChecked === "true" ||
    ariaChecked === "checked" ||
    ariaSelected === "true" ||
    dataStateTokens.includes("checked") ||
    dataStateTokens.includes("selected") ||
    dataStateTokens.includes("active") ||
    dataStateTokens.includes("on") ||
    headlessUiTokens.includes("selected") ||
    headlessUiTokens.includes("active") ||
    className.includes("selected") ||
    className.includes("active") ||
    className.includes("checked")
  );
}

function summarizeVerificationSignalsV2({ clickSummary, recheckSummary, menuClosedAfterClick }) {
  return {
    clickSummary,
    recheckSummary,
    menuClosedAfterClick,
    clickLooksSelected: elementLooksSelectedV2(clickSummary),
    recheckLooksSelected: elementLooksSelectedV2(recheckSummary)
  };
}

async function recheckMenuSelectionStateV2(site, requestedMode, labels) {
  const menuResult = await openChatGptModeMenuV2(site, "tools", labels);

  if (!menuResult.ok) {
    return {
      ok: false,
      reason: menuResult.reason || "RECHECK_MENU_OPEN_FAILED",
      summary: null
    };
  }

  const scopes = getModeSearchScopesV2(site, menuResult.menuState?.roots || []);
  const match = findMatchingElementV2(labels, scopes);
  const summary = summarizeElementV2(match?.element || null);

  logBridge("content.mode.recheck_menu_item", {
    requestedMode,
    item: summary
  });

  return {
    ok: Boolean(match?.element),
    reason: match?.element ? "item_found" : "item_missing",
    summary
  };
}

async function verifyComposerModeV2(site, requestedMode, reason, options = {}) {
  const toolModes = ["web_search", "deep_research", "agent_mode"];
  const verifyTimeoutMs = toolModes.includes(requestedMode) ? 3600 : 900;
  const startedAt = Date.now();
  let activeMode = findComposerMode(site);
  let success = activeMode === requestedMode;
  let verificationReason = success ? reason : "MODE_NOT_VERIFIED";
  const clickSummary = summarizeElementV2(options.clickedElement || null);
  let recheckSummary = null;

  while (!success && Date.now() - startedAt < verifyTimeoutMs) {
    await wait(180);
    activeMode = findComposerMode(site);
    success = activeMode === requestedMode;
  }

  if (!success && toolModes.includes(requestedMode)) {
    const menuClosedAfterClick = getVisiblePopupRootsV2().length === 0;
    const initialSignals = summarizeVerificationSignalsV2({
      clickSummary,
      recheckSummary,
      menuClosedAfterClick
    });

    logBridge("content.mode.verify_tool_signals", {
      requestedMode,
      reason,
      ...initialSignals
    });

    if (elementLooksSelectedV2(clickSummary) || menuClosedAfterClick) {
      const recheck = await recheckMenuSelectionStateV2(
        site,
        requestedMode,
        MODE_LABELS_V2.chatgpt[requestedMode] || []
      );

      recheckSummary = recheck.summary;

      if (elementLooksSelectedV2(recheckSummary)) {
        success = true;
        verificationReason = `${reason}_rechecked_menu_item`;
      }
    }
  }

  logBridge("content.mode.verify_after_click", {
    requestedMode,
    detectedModeAfter: activeMode,
    success,
    reason,
    clickSummary,
    recheckSummary,
    activatedTargets: Array.isArray(options.activatedTargets) ? options.activatedTargets : [],
    composerSnapshot: getComposerSnapshotV2(site)
  });

  return {
    ok: success,
    activeMode: success ? requestedMode : activeMode,
    reason: success ? verificationReason : "MODE_NOT_VERIFIED"
  };
}

async function openChatGptModeMenuV2(site, kind, targetLabels) {
  const scope = getComposerScope(site);
  const candidates = getVisibleClickablesV2(scope);
  const plusButton = scope.querySelector('button[data-testid="composer-plus-btn"]');

  logBridge("content.mode.menu_button_candidates", {
    kind,
    candidates: listElementSummariesV2(candidates, 12)
  });

  const button = candidates.find((element) => {
    if (looksLikeStopButton(element)) {
      return false;
    }

    if (elementMatchesAnyLabel(element, ["send", SEND_LABEL_RU])) {
      return false;
    }

    const ariaHasPopup = normalizeUiText(element.getAttribute("aria-haspopup") || "");

    if (kind === "reasoning") {
      return elementMatchesAnyLabel(element, CHATGPT_REASONING_BUTTON_LABELS_V2);
    }

    if (plusButton && element === plusButton) {
      return true;
    }

    return (
      elementMatchesAnyLabel(element, CHATGPT_MENU_BUTTON_LABELS_V2) ||
      ariaHasPopup === "menu"
    );
  });

  if (!button) {
    return {
      ok: false,
      reason:
        kind === "reasoning" ? "REASONING_BUTTON_NOT_FOUND" : "MENU_BUTTON_NOT_FOUND"
    };
  }

  const relevantLabels = [
    ...targetLabels,
    ...CHATGPT_MORE_LABELS_V2,
    ...CHATGPT_REASONING_BUTTON_LABELS_V2,
    ...CHATGPT_MENU_BUTTON_LABELS_V2
  ];

  const buttonLooksOpen = () => {
    const expanded = normalizeUiText(button.getAttribute("aria-expanded") || "");
    const dataState = normalizeUiText(button.getAttribute("data-state") || "");
    return expanded === "true" || dataState === "open";
  };

  let menuState = getPopupMenuStateV2(relevantLabels);

  if (buttonLooksOpen() || menuState.opened) {
    logBridge("content.mode.menu_already_open", {
      kind,
      button: summarizeElementV2(button),
      rootCount: menuState.roots.length,
      itemCount: menuState.items.length
    });
  } else {
    const strategies = [
      {
        name: "dom_click_only",
        run: () => {
          try {
            button.focus?.();
          } catch (error) {}
          try {
            button.click();
          } catch (error) {}
        }
      },
      {
        name: "dom_pointer_click_attempt",
        run: () => {
          activateElementV2(button, { pointer: true, click: true, keyboard: false });
        }
      },
      {
        name: "keyboard_enter",
        run: () => {
          activateElementV2(button, { pointer: false, click: false, keyboard: true });
        }
      }
    ];

    let openedByStrategy = false;

    for (const strategy of strategies) {
      const beforeExpanded = button.getAttribute("aria-expanded") || "";
      const beforeState = button.getAttribute("data-state") || "";

      try {
        strategy.run();
      } catch (error) {
        logBridge("content.mode.menu_button_activation_error", {
          kind,
          strategy: strategy.name,
          error: String(error?.message || error || "unknown")
        });
        continue;
      }

      await wait(250);

      menuState = getPopupMenuStateV2(relevantLabels);
      const afterExpanded = button.getAttribute("aria-expanded") || "";
      const afterState = button.getAttribute("data-state") || "";
      const opened = buttonLooksOpen() || menuState.opened;

      logBridge("content.mode.menu_button_activation", {
        kind,
        button: {
          ...summarizeElementV2(button),
          ariaExpandedBefore: beforeExpanded,
          ariaExpandedAfter: afterExpanded,
          dataStateBefore: beforeState,
          dataStateAfter: afterState
        },
        activationType: strategy.name,
        opened,
        rootCount: menuState.roots.length,
        itemCount: menuState.items.length
      });

      if (opened) {
        openedByStrategy = true;
        break;
      }
    }

    if (!openedByStrategy) {
      menuState = await waitForPopupMenuV2(relevantLabels, 400);
    }
  }

  logBridge("content.mode.menu_open_result", {
    kind,
    opened: menuState.opened,
    rootCount: menuState.roots.length,
    itemCount: menuState.items.length,
    buttonExpanded: button.getAttribute("aria-expanded") || "",
    roots: listElementSummariesV2(menuState.roots, 6)
  });
  logBridge("content.mode.menu_items_visible", {
    kind,
    items: listElementSummariesV2(menuState.items, 18)
  });

  if (!menuState.opened) {
    return {
      ok: false,
      reason: kind === "reasoning" ? "REASONING_MENU_NOT_OPENED" : "MENU_NOT_OPENED"
    };
  }

  return { ok: true, menuState };
}

function findComposerMode(site) {
  const modeLabels = MODE_LABELS_V2[site];

  if (!modeLabels) {
    return "default";
  }

  const scopes = getModeSearchScopesV2(site, []);
  const nodes = uniqueElementsV2(scopes.flatMap((scope) => getVisibleClickablesV2(scope)));
  const input = getChatInput(site);
  const scope = getComposerScope(site);
  const contextText = normalizeUiText(
    [
      scope?.innerText || "",
      scope?.textContent || "",
      input?.getAttribute?.("placeholder") || "",
      input?.getAttribute?.("aria-placeholder") || "",
      input?.getAttribute?.("aria-label") || "",
      input?.getAttribute?.("title") || ""
    ].join(" ")
  );

  for (const [mode, labels] of Object.entries(modeLabels)) {
    if (mode === "default") {
      continue;
    }

    if (
      nodes.some((element) => elementMatchesAnyLabel(element, labels)) ||
      labels.some((label) => contextText.includes(normalizeUiText(label)))
    ) {
      return mode;
    }
  }

  return "default";
}

async function clickFirstElementByLabels(labels, scopes = [document]) {
  const match = findMatchingElementV2(labels, scopes);

  if (!match?.element) {
    return { ok: false, element: null, scope: null };
  }

  const activationTargets = uniqueElementsV2([
    match.element,
    ...getActivationDescendantsV2(match.element),
    match.element.querySelector?.("button, [role=\"button\"], [role=\"menuitemradio\"]"),
    match.element.firstElementChild instanceof HTMLElement ? match.element.firstElementChild : null,
    match.element.querySelector?.("span, div")
  ]);

  try {
    const matchRole = normalizeUiText(match.element.getAttribute("role") || "");

    for (const target of activationTargets) {
      const role = normalizeUiText(target?.getAttribute?.("role") || "");
      const tag = String(target?.tagName || "").toLowerCase();
      const useKeyboard =
        matchRole.includes("menuitem") ||
        role.includes("menuitem") ||
        role === "option" ||
        String(target?.getAttribute?.("tabindex") || "") === "0" ||
        tag === "input" ||
        tag === "label";

      activateElementV2(target, { pointer: true, click: true, keyboard: useKeyboard });
    }

    const debuggerClick = await requestDebuggerClickForElementV2(match.element);
    await wait(120);

    const activatedTargets = activationTargets.map((element) => summarizeElementV2(element));

    logBridge("content.mode.item_activation_attempt", {
      match: summarizeElementV2(match.element),
      activatedTargets,
      debuggerClick
    });

    return {
      ok: true,
      element: match.element,
      scope: match.scope,
      activatedTargets,
      debuggerClick
    };
  } catch (error) {
    return { ok: false, element: match.element, scope: match.scope, error };
  }
}

async function ensureComposerMode(site, requestedMode = "default") {
  const normalizedMode = MODE_LABELS_V2[site]?.[requestedMode] ? requestedMode : "default";

  if (site !== "chatgpt") {
    return {
      ok: normalizedMode === "default",
      activeMode: "default",
      reason: normalizedMode === "default" ? "default" : "UNSUPPORTED_SITE"
    };
  }

  const currentMode = findComposerMode(site);
  const directLabels = MODE_LABELS_V2.chatgpt[normalizedMode] || [];

  logBridge("content.mode.start", {
    requestedMode: normalizedMode,
    currentMode,
    inputFound: Boolean(getChatInput(site))
  });

  if (normalizedMode === "default") {
    return {
      ok: true,
      activeMode: currentMode,
      reason: currentMode === "default" ? "default" : "mode_left_as_is"
    };
  }

  if (currentMode === normalizedMode) {
    return { ok: true, activeMode: currentMode, reason: "already_selected" };
  }

  const directInComposer = await clickFirstElementByLabels(directLabels, [getComposerScope(site)]);

  if (directInComposer.ok) {
    await wait(500);
    return verifyComposerModeV2(site, normalizedMode, "selected_direct_composer", {
      clickedElement: directInComposer.element
    });
  }

  const menuResult = await openChatGptModeMenuV2(
    site,
    normalizedMode === "extended_thinking" ? "reasoning" : "tools",
    directLabels
  );

  if (!menuResult.ok) {
    return {
      ok: false,
      activeMode: currentMode,
      reason: menuResult.reason || "MENU_OPEN_FAILED"
    };
  }

  let activeScopes = getModeSearchScopesV2(site, menuResult.menuState?.roots || []);
  let directSelection = await clickFirstElementByLabels(directLabels, activeScopes);

  if (directSelection.ok) {
    await wait(500);
    return verifyComposerModeV2(site, normalizedMode, "selected_direct", {
      clickedElement: directSelection.element
    });
  }

  logBridge("content.mode.selector_miss", {
    requestedMode: normalizedMode,
    stage: "DIRECT_ITEMS_EMPTY",
    visibleItems: listElementSummariesV2(
      getPopupItemsV2(menuResult.menuState?.roots || []),
      18
    )
  });

  const moreSelection = await clickFirstElementByLabels(CHATGPT_MORE_LABELS_V2, activeScopes);

  if (moreSelection.ok) {
    await wait(250);
    const nestedMenuState = await waitForPopupMenuV2(directLabels);

    logBridge("content.mode.more_open_result", {
      requestedMode: normalizedMode,
      opened: nestedMenuState.opened,
      items: listElementSummariesV2(nestedMenuState.items, 18)
    });

    activeScopes = getModeSearchScopesV2(site, nestedMenuState.roots || []);
    directSelection = await clickFirstElementByLabels(directLabels, activeScopes);

    if (directSelection.ok) {
      await wait(500);
      return verifyComposerModeV2(site, normalizedMode, "selected_nested", {
        clickedElement: directSelection.element
      });
    }
  }

  logBridge("content.mode.selector_miss", {
    requestedMode: normalizedMode,
    stage: "LABELS_MISMATCH",
    visibleItems: listElementSummariesV2(getPopupItemsV2(getVisiblePopupRootsV2()), 20)
  });

  return { ok: false, activeMode: currentMode, reason: "MODE_ITEM_NOT_FOUND" };
}

function closeObstructiveUi(site) {
  const selectorsBySite = {
    chatgpt: [
      '[role="dialog"] button[aria-label="Close"]',
      '[role="dialog"] button[aria-label*="close" i]',
      '[role="dialog"] button[data-testid*="close"]',
      '[role="dialog"] button[title*="close" i]',
      '[data-radix-popper-content-wrapper] button[aria-label="Close"]',
      '[data-radix-popper-content-wrapper] button[aria-label*="close" i]'
    ],
    gemini: [
      '[role="dialog"] button[aria-label="Close"]',
      '[role="dialog"] button[aria-label*="close" i]',
      'mat-dialog-container button[aria-label="Close"]',
      'mat-dialog-container button[aria-label*="close" i]',
      'button[mat-dialog-close]'
    ]
  };

  const selectors = selectorsBySite[site] || [];
  let closedCount = 0;

  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector)).slice(0, 12);

    for (const element of elements) {
      const button =
        element instanceof HTMLButtonElement
          ? element
          : element.closest?.("button");

      if (!button || !isVisibleElement(button)) {
        continue;
      }

      const buttonText = (
        button.innerText ||
        button.getAttribute("aria-label") ||
        button.getAttribute("title") ||
        ""
      ).trim();
      const normalizedText = buttonText.toLowerCase();
      const looksLikeClose =
        normalizedText === "close" ||
        normalizedText === "x" ||
        normalizedText === "закрыть" ||
        normalizedText.includes("close") ||
        normalizedText.includes("закры");

      if (!looksLikeClose) {
        continue;
      }

      try {
        button.click();
        closedCount += 1;
      } catch (error) {
      }
    }
  }

  if (closedCount > 0) {
    logBridge("content.popup_closed", { closedCount });
  }

  return closedCount;
}

function prepareComposer(site) {
  closeObstructiveUi(site);
  window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" });

  if (isSiteBusy(site)) {
    logBridge("content.prepare.busy");
    return {
      ok: false,
      busy: true,
      hasInput: Boolean(getChatInput(site)),
      site,
      input: null
    };
  }

  const input = getChatInput(site);

  if (!input) {
    logBridge("content.prepare.no_input");
    return {
      ok: false,
      busy: false,
      hasInput: false,
      site,
      input: null
    };
  }

  try {
    input.focus();
  } catch (error) {
  }

  logBridge("content.prepare.ready", {
    inputTag: input.tagName,
    contentEditable: Boolean(input.isContentEditable)
  });

  return {
    ok: true,
    busy: false,
    hasInput: true,
    site,
    input
  };
}

const messageListener = (message, _sender, sendResponse) => {
  if (message && message.type === "PREPARE_FOR_INPUT") {
    const site = detectSite();
    const prepared = prepareComposer(site);
    window[BRIDGE_STATE_KEY].lastPrepareAt = Date.now();
    sendResponse?.({
      ok: Boolean(prepared?.ok),
      busy: Boolean(prepared?.busy),
      hasInput: Boolean(prepared?.hasInput),
      site: prepared?.site || site,
      visibilityState: document.visibilityState
    });
    return;
  }

  if (message && message.type === "SEND_TO_AGENT") {
    insertTextAndSend(message.text || "", {
      mode: message.mode || "default",
      useToolsMenu: Boolean(message.useToolsMenu)
    })
      .then((result) => {
        sendResponse?.({
          ok: Boolean(result?.ok),
          ...(result || {}),
          visibilityState: document.visibilityState
        });
      })
      .catch((error) => {
        logBridge("content.send.exception", {
          message: error?.message || "unknown"
        });
        sendResponse?.({ ok: false, reason: "EXCEPTION" });
      });
    return;
  }

  if (message && message.type === "ENSURE_GENERATION_STARTED") {
    ensureGenerationStarted()
      .then((result) => {
        sendResponse?.({
          ok: Boolean(result?.ok),
          ...(result || {}),
          visibilityState: document.visibilityState
        });
      })
      .catch((error) => {
        logBridge("content.send.ensure_exception", {
          message: error?.message || "unknown"
        });
        sendResponse?.({ ok: false, started: false, reason: "EXCEPTION" });
      });
    return;
  }

  if (message && message.type === "DIAGNOSE_SLASH_MENU") {
    diagnoseSlashMenu()
      .then((result) => {
        sendResponse?.({
          ok: Boolean(result?.ok),
          ...(result || {}),
          visibilityState: document.visibilityState
        });
      })
      .catch((error) => {
        logBridge("content.slash_menu.exception", {
          message: error?.message || "unknown"
        });
        sendResponse?.({ ok: false, reason: "EXCEPTION" });
      });
    return;
  }

  if (message && message.type === "OBSERVE_RAW_TEXT") {
    observeRawTextInComposer(message.text || "", message.waitMs)
      .then((result) => {
        sendResponse?.({
          ok: Boolean(result?.ok),
          ...(result || {}),
          visibilityState: document.visibilityState
        });
      })
      .catch((error) => {
        logBridge("content.raw_text.exception", {
          message: error?.message || "unknown"
        });
        sendResponse?.({ ok: false, reason: "EXCEPTION" });
      });
    return;
  }

  if (message && message.type === "AI_BRIDGE_SYNC") {
    registerAgent();
    flushChatSnapshot();
    sendResponse?.({
      ok: true,
      contentVersion: CONTENT_SCRIPT_VERSION,
      site: detectSite(),
      state: getAgentUiState()
    });
    return;
  }

  if (message && message.type === "AI_BRIDGE_PING") {
    sendResponse?.({ ok: true, contentVersion: CONTENT_SCRIPT_VERSION });
  }
};

chrome.runtime.onMessage.addListener(messageListener);
window[BRIDGE_STATE_KEY].messageListener = messageListener;

registerAgent();
flushChatSnapshot();
observeNewMessages();
startPolling();
startHeartbeat();
