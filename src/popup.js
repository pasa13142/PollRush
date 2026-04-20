"use strict";

const elements = {
  primaryIndex: document.getElementById("primaryIndex"),
  secondaryIndex: document.getElementById("secondaryIndex"),
  armUpdateButton: document.getElementById("armUpdateButton"),
  disarmButton: document.getElementById("disarmButton"),
  errorText: document.getElementById("errorText"),
  armedState: document.getElementById("armedState"),
  lastResult: document.getElementById("lastResult"),
  lastLatency: document.getElementById("lastLatency"),
  focusVisibility: document.getElementById("focusVisibility")
};

/** @type {number|null} */
let activeTabId = null;
let refreshIntervalId = null;

function isWhatsAppWebUrl(url) {
  return typeof url === "string" && url.startsWith("https://web.whatsapp.com/");
}

function showError(message) {
  elements.errorText.textContent = message || "";
}

function parsePositiveInt(raw, required) {
  const normalized = String(raw ?? "").trim();
  if (!normalized) {
    return required ? null : undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function setControlsEnabled(enabled) {
  elements.primaryIndex.disabled = !enabled;
  elements.secondaryIndex.disabled = !enabled;
  elements.armUpdateButton.disabled = !enabled;
  elements.disarmButton.disabled = !enabled;
}

function renderStatus(status) {
  const armed = Boolean(status?.armed);
  const waitingForIndex = Boolean(status?.waitingForIndex);

  elements.armedState.textContent = armed
    ? waitingForIndex
      ? "Armed (index required)"
      : "Armed"
    : "Disarmed";

  elements.lastResult.textContent = status?.lastResult || "-";

  if (typeof status?.lastLatencyMs === "number" && Number.isFinite(status.lastLatencyMs)) {
    elements.lastLatency.textContent = `${status.lastLatencyMs.toFixed(2)} ms`;
  } else {
    elements.lastLatency.textContent = "-";
  }

  const focused = Boolean(status?.isFocused);
  const visible = Boolean(status?.isVisible);
  elements.focusVisibility.textContent = `${focused ? "focused" : "not-focused"} / ${visible ? "visible" : "hidden"}`;

  elements.disarmButton.disabled = !armed;
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendMessageToActiveTab(message) {
  if (activeTabId === null) {
    throw new Error("No active tab available.");
  }

  try {
    const response = await chrome.tabs.sendMessage(activeTabId, message);
    if (!response?.ok) {
      throw new Error(response?.error || "Unknown content script error.");
    }
    return response.status;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    throw new Error(messageText || "Failed to communicate with content script.");
  }
}

async function refreshStatus() {
  try {
    const status = await sendMessageToActiveTab({ type: "GET_STATUS" });
    renderStatus(status);
    showError("");
  } catch (error) {
    renderStatus({
      armed: false,
      waitingForIndex: false,
      lastResult: "-",
      lastLatencyMs: null,
      isFocused: false,
      isVisible: false
    });
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function onArmOrUpdate() {
  const primaryIndex = parsePositiveInt(elements.primaryIndex.value, true);
  const secondaryIndex = parsePositiveInt(elements.secondaryIndex.value, false);

  if (primaryIndex === null) {
    showError("Primary index is required and must be >= 1.");
    return;
  }

  if (secondaryIndex === null) {
    showError("Secondary index must be empty or >= 1.");
    return;
  }

  showError("");

  try {
    const status = await sendMessageToActiveTab({
      type: "SET_CONFIGURATION",
      payload: {
        armed: true,
        primaryIndex,
        secondaryIndex
      }
    });
    renderStatus(status);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function onDisarm() {
  showError("");

  try {
    const status = await sendMessageToActiveTab({
      type: "SET_CONFIGURATION",
      payload: {
        armed: false
      }
    });
    renderStatus(status);
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

async function initializePopup() {
  elements.armUpdateButton.addEventListener("click", onArmOrUpdate);
  elements.disarmButton.addEventListener("click", onDisarm);

  const tab = await getActiveTab();
  if (!tab?.id || !isWhatsAppWebUrl(tab.url)) {
    setControlsEnabled(false);
    renderStatus({
      armed: false,
      waitingForIndex: false,
      lastResult: "-",
      lastLatencyMs: null,
      isFocused: false,
      isVisible: false
    });
    showError("Open WhatsApp Web in the active tab first.");
    return;
  }

  activeTabId = tab.id;
  setControlsEnabled(true);
  await refreshStatus();

  refreshIntervalId = window.setInterval(() => {
    refreshStatus().catch(() => {
      // Keep popup responsive even if tab messaging temporarily fails.
    });
  }, 1000);

  window.addEventListener("unload", () => {
    if (refreshIntervalId !== null) {
      window.clearInterval(refreshIntervalId);
      refreshIntervalId = null;
    }
  });
}

initializePopup().catch((error) => {
  showError(error instanceof Error ? error.message : String(error));
  setControlsEnabled(false);
});
