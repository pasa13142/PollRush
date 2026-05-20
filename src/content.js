"use strict";

(() => {
  const STORAGE_KEYS = {
    armed: "waPollAutoVoter.armed"
  };

  const RESULT = Object.freeze({
    PRIMARY_VOTED: "primary_voted",
    SECONDARY_VOTED: "secondary_voted",
    SOURCE_VOTED: "source_voted",
    SKIPPED_NO_INDEX: "skipped_no_index",
    SKIPPED_NOT_NEW: "skipped_not_new",
    SKIPPED_DUPLICATE: "skipped_duplicate",
    BLOCKED_INDEX_REQUIRED: "blocked_index_required",
    ATTEMPT_FAILED: "attempt_failed",
    DISARMED: "disarmed"
  });

  const CHAT_CONTAINER_SELECTORS = [
    "main div[data-testid='conversation-panel-messages']",
    "main div[data-testid='conversation-panel-body']",
    "#main div[data-testid='conversation-panel-messages']",
    "#main"
  ];

  const MESSAGE_ROOT_SELECTORS = [
    "[data-id]",
    "[data-testid='msg-container']",
    "[data-testid*='msg-container']",
    "div[role='row']"
  ];

  const OPTION_QUERY =
    "[role='radio'], [role='checkbox'], [aria-checked='true'], [aria-checked='false'], [data-testid*='poll-option'], [data-testid*='poll_option']";
  const MESSAGE_SCAN_QUERY =
    "[data-id], [data-testid='msg-container'], [data-testid*='msg-container'], div[role='row']";
  const RECENT_MESSAGE_SCAN_LIMIT = 16;
  const SUCCESS_FINGERPRINT_TTL_MS = 10 * 60 * 1000;
  const MAX_TRACKED_KEYS = 2000;

  const state = {
    armed: false,
    primaryIndex: null,
    secondaryIndex: null,
    sourceModeEnabled: false,
    sourceText: "",
    waitingForIndex: false,
    lastResult: RESULT.DISARMED,
    lastLatencyMs: null,
    lastPollKey: null,
    lastUsedIndex: null,
    lastUpdatedAt: Date.now()
  };

  /** @type {MutationObserver | null} */
  let observer = null;
  /** @type {Element | null} */
  let observedChatContainer = null;
  let activeChatSignature = "";
  let chatSwitchIgnoreUntilMs = 0;

  /** @type {Set<string>} */
  const baselinePollKeys = new Set();
  /** @type {Set<string>} */
  const processedPollKeys = new Set();
  /** @type {Map<string, number>} */
  const successfulPollFingerprints = new Map();
  /** @type {WeakSet<Element>} */
  let baselinePollRoots = new WeakSet();

  function addTrackedKey(set, key) {
    if (!key) {
      return;
    }

    set.add(key);
    if (set.size <= MAX_TRACKED_KEYS) {
      return;
    }

    const first = set.values().next().value;
    if (first) {
      set.delete(first);
    }
  }

  function clearTrackedKeys() {
    baselinePollKeys.clear();
    processedPollKeys.clear();
    successfulPollFingerprints.clear();
    baselinePollRoots = new WeakSet();
  }

  function parsePositiveIndex(value) {
    if (value === undefined || value === null || value === "") {
      return null;
    }

    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return null;
    }

    return parsed;
  }

  function isElement(node) {
    return node instanceof Element;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function isInteractionAllowed() {
    // Popup focus can temporarily steal page focus; visibility is the hard gate.
    return document.visibilityState === "visible";
  }

  function setLastResult(result, details = {}) {
    state.lastResult = result;
    state.lastPollKey = details.pollKey || state.lastPollKey || null;
    state.lastUsedIndex = Number.isInteger(details.usedIndex) ? details.usedIndex : null;
    state.lastLatencyMs = Number.isFinite(details.latencyMs)
      ? Math.round(details.latencyMs * 100) / 100
      : null;
    state.lastUpdatedAt = Date.now();
  }

  function getActiveChatContainer() {
    for (const selector of CHAT_CONTAINER_SELECTORS) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }

    return null;
  }

  function readActiveChatSignature() {
    const selectedChatItem = document.querySelector("#pane-side [aria-selected='true']");
    const selectedChatId =
      selectedChatItem?.getAttribute("data-id") ||
      selectedChatItem?.getAttribute("data-testid") ||
      selectedChatItem?.id ||
      selectedChatItem?.querySelector("a[href]")?.getAttribute("href") ||
      "unknown-chat";
    return `${window.location.pathname}${window.location.hash}|${selectedChatId}`;
  }

  function buildDomPath(node, root) {
    const parts = [];
    let current = node;

    while (current && current !== root && current.parentElement) {
      const parent = current.parentElement;
      const index = Array.prototype.indexOf.call(parent.children, current);
      parts.push(`${current.tagName.toLowerCase()}:${index}`);
      current = parent;
    }

    return parts.reverse().join("/");
  }

  function getMessageRoot(element) {
    const activeContainer = getActiveChatContainer();
    const container =
      observedChatContainer && observedChatContainer.contains(element)
        ? observedChatContainer
        : activeContainer && activeContainer.contains(element)
          ? activeContainer
          : null;

    if (!container || !container.contains(element)) {
      return null;
    }

    for (const selector of MESSAGE_ROOT_SELECTORS) {
      const root = element.closest(selector);
      if (root && container.contains(root)) {
        return root;
      }
    }

    return null;
  }

  function resolveClickableOption(optionNode, messageRoot) {
    if (optionNode.matches("button, [role='radio'], [role='checkbox']")) {
      return optionNode;
    }

    if (optionNode.matches("[data-testid*='poll-option'], [data-testid*='poll_option']")) {
      return optionNode;
    }

    if (optionNode.matches("[aria-checked]") && isPollishOptionNode(optionNode, messageRoot)) {
      return optionNode;
    }

    let current = optionNode;

    while (current && current !== messageRoot) {
      if (current.matches("button, [role='radio'], [role='checkbox']")) {
        return current;
      }
      current = current.parentElement;
    }

    return optionNode;
  }

  function isPollishOptionNode(optionNode, messageRoot) {
    const testId = (optionNode.getAttribute("data-testid") || "").toLowerCase();
    if (testId.includes("poll-option") || testId.includes("poll_option")) {
      return true;
    }

    const pollOptionAncestor = optionNode.closest("[data-testid*='poll-option'], [data-testid*='poll_option']");
    return Boolean(pollOptionAncestor && messageRoot.contains(pollOptionAncestor));
  }

  function resolveOptionContainer(optionNode, clickableNode, messageRoot) {
    let current = clickableNode || optionNode;

    while (current && current !== messageRoot) {
      if (current.matches("[data-testid*='poll-option'], [data-testid*='poll_option']")) {
        return current;
      }

      current = current.parentElement;
    }

    return clickableNode || optionNode;
  }

  function isNestedOptionContainer(container, seenContainers) {
    for (const seenContainer of seenContainers) {
      if (seenContainer !== container && seenContainer.contains(container)) {
        return true;
      }
    }

    return false;
  }

  function removeNestedOptionContainers(container, seenContainers, seenClickables, options) {
    for (const seenContainer of Array.from(seenContainers)) {
      if (seenContainer !== container && container.contains(seenContainer)) {
        seenContainers.delete(seenContainer);

        const nestedOptionIndex = options.findIndex((option) => option.container === seenContainer);
        if (nestedOptionIndex !== -1) {
          seenClickables.delete(options[nestedOptionIndex].clickable);
          options.splice(nestedOptionIndex, 1);
        }
      }
    }
  }

  function isPollishOption(optionNode, clickableNode, messageRoot) {
    const role = clickableNode.getAttribute("role");
    if (role === "radio" || role === "checkbox") {
      return true;
    }

    if (
      (clickableNode.hasAttribute("aria-checked") || optionNode.hasAttribute("aria-checked")) &&
      (isPollishOptionNode(clickableNode, messageRoot) || isPollishOptionNode(optionNode, messageRoot))
    ) {
      return true;
    }

    const clickableTestId = (clickableNode.getAttribute("data-testid") || "").toLowerCase();
    const optionTestId = (optionNode.getAttribute("data-testid") || "").toLowerCase();
    if (
      clickableTestId.includes("poll-option") ||
      clickableTestId.includes("poll_option") ||
      optionTestId.includes("poll-option") ||
      optionTestId.includes("poll_option")
    ) {
      return true;
    }

    return isPollishOptionNode(optionNode, messageRoot) || isPollishOptionNode(clickableNode, messageRoot);
  }

  function compareDocumentPosition(a, b) {
    if (a === b) {
      return 0;
    }

    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }

    return 0;
  }

  function normalizePollOptions(options) {
    const normalized = [];
    const seenClickables = new Set();

    for (const option of options.sort((left, right) => compareDocumentPosition(left.container, right.container))) {
      if (seenClickables.has(option.clickable)) {
        continue;
      }

      seenClickables.add(option.clickable);
      normalized.push(option.clickable);
    }

    return normalized;
  }

  function extractPollOptions(messageRoot) {
    if (!messageRoot) {
      return [];
    }

    const options = [];
    const seenClickables = new Set();
    const seenContainers = new Set();

    for (const option of messageRoot.querySelectorAll(OPTION_QUERY)) {
      const clickable = resolveClickableOption(option, messageRoot);
      if (!clickable) {
        continue;
      }

      if (!isPollishOption(option, clickable, messageRoot)) {
        continue;
      }

      const container = resolveOptionContainer(option, clickable, messageRoot);
      if (!container || isNestedOptionContainer(container, seenContainers)) {
        continue;
      }

      if (clickable.getAttribute("aria-disabled") === "true") {
        continue;
      }

      if (clickable.hasAttribute("disabled")) {
        continue;
      }

      if (!isVisible(clickable)) {
        continue;
      }

      removeNestedOptionContainers(container, seenContainers, seenClickables, options);

      if (seenClickables.has(clickable) || seenContainers.has(container)) {
        continue;
      }

      options.push({ container, clickable });
      seenClickables.add(clickable);
      seenContainers.add(container);
    }

    return normalizePollOptions(options);
  }

  function extractOptionLabel(element) {
    const aria = element.getAttribute("aria-label");
    if (aria && aria.trim()) {
      return aria.trim();
    }

    const title = element.getAttribute("title");
    if (title && title.trim()) {
      return title.trim();
    }

    return element.textContent?.replace(/\s+/g, " ").trim() || "";
  }

  function buildPollFingerprint(pollOptions) {
    return pollOptions
      .map((node, index) => `${index + 1}:${extractOptionLabel(node).toLowerCase()}`)
      .join("|")
      .slice(0, 400);
  }

  function pruneSuccessfulFingerprints(nowMs) {
    for (const [fingerprint, timestamp] of successfulPollFingerprints.entries()) {
      if (nowMs - timestamp > SUCCESS_FINGERPRINT_TTL_MS) {
        successfulPollFingerprints.delete(fingerprint);
      }
    }
  }

  function isOptionAlreadySelected(optionNode) {
    if (!optionNode) {
      return false;
    }

    if (optionNode.getAttribute("aria-checked") === "true") {
      return true;
    }

    const nestedSelected = optionNode.querySelector("[aria-checked='true']");
    return Boolean(nestedSelected);
  }

  function buildPollKey(messageRoot, pollOptions) {
    const dataId = messageRoot.getAttribute("data-id");
    if (dataId) {
      return `data-id:${dataId}`;
    }

    const messageId = messageRoot.getAttribute("id");
    if (messageId) {
      return `id:${messageId}`;
    }

    const testId = messageRoot.getAttribute("data-testid");
    if (testId && testId !== "msg-container") {
      return `testid:${testId}`;
    }

    const container = observedChatContainer || getActiveChatContainer();
    const path = buildDomPath(messageRoot, container || document.body);
    const optionSignature = pollOptions
      .map((node) => extractOptionLabel(node))
      .join("|")
      .slice(0, 140);

    return `fallback:${activeChatSignature}:${path}:${optionSignature}`;
  }

  function dispatchFastClick(target) {
    target.click();
  }

  function selectOptionByIndex(options, index) {
    if (!Number.isInteger(index) || index < 1) {
      return null;
    }

    const zeroBased = index - 1;
    return options[zeroBased] || null;
  }

  function normalizeForSourceMatch(value) {
    return String(value || "")
      .toLocaleLowerCase("tr-TR")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .trim();
  }

  function levenshteinDistance(left, right) {
    if (left === right) {
      return 0;
    }

    if (!left) {
      return right.length;
    }

    if (!right) {
      return left.length;
    }

    const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
    const current = new Array(right.length + 1);

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      current[0] = leftIndex;

      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        current[rightIndex] = Math.min(
          previous[rightIndex] + 1,
          current[rightIndex - 1] + 1,
          previous[rightIndex - 1] + substitutionCost
        );
      }

      for (let index = 0; index < previous.length; index += 1) {
        previous[index] = current[index];
      }
    }

    return previous[right.length];
  }

  function calculateSourceMatchScore(source, candidate) {
    if (!source || !candidate) {
      return Number.POSITIVE_INFINITY;
    }

    const distance = levenshteinDistance(source, candidate);
    const extraLength = Math.max(0, candidate.length - source.length);
    const missingLength = Math.max(0, source.length - candidate.length);
    const prefixPenalty = candidate.startsWith(source) ? 0 : 2;

    return distance + extraLength * 2 + missingLength + prefixPenalty;
  }

  function selectOptionBySource(options, sourceText) {
    const source = normalizeForSourceMatch(sourceText);
    if (!source) {
      return null;
    }

    let bestMatch = null;

    options.forEach((option, index) => {
      const candidate = normalizeForSourceMatch(extractOptionLabel(option));
      const score = calculateSourceMatchScore(source, candidate);

      if (!bestMatch || score < bestMatch.score) {
        bestMatch = {
          option,
          index: index + 1,
          score
        };
      }
    });

    return bestMatch?.option
      ? {
          option: bestMatch.option,
          index: bestMatch.index
        }
      : null;
  }

  /**
   * @typedef {Object} PollEventRecord
   * @property {string} pollKey
   * @property {number} detectedAtMs
   * @property {number=} clickedAtMs
   * @property {string} outcome
   * @property {number=} usedIndex
   * @property {number=} latencyMs
   */

  function processPollCandidate(messageRoot, detectedAtMs) {
    const options = extractPollOptions(messageRoot);
    if (options.length < 2) {
      return;
    }

    pruneSuccessfulFingerprints(performance.now());
    const pollFingerprint = buildPollFingerprint(options);

    const pollKey = buildPollKey(messageRoot, options);
    if (!pollKey) {
      return;
    }

    if (baselinePollRoots.has(messageRoot)) {
      addTrackedKey(baselinePollKeys, pollKey);
      setLastResult(RESULT.SKIPPED_NOT_NEW, { pollKey });
      return;
    }

    if (successfulPollFingerprints.has(pollFingerprint)) {
      setLastResult(RESULT.SKIPPED_DUPLICATE, { pollKey });
      return;
    }

    if (baselinePollKeys.has(pollKey)) {
      setLastResult(RESULT.SKIPPED_NOT_NEW, { pollKey });
      return;
    }

    if (processedPollKeys.has(pollKey)) {
      setLastResult(RESULT.SKIPPED_DUPLICATE, { pollKey });
      return;
    }

    if (performance.now() < chatSwitchIgnoreUntilMs) {
      addTrackedKey(baselinePollKeys, pollKey);
      setLastResult(RESULT.SKIPPED_NOT_NEW, { pollKey });
      return;
    }

    if (!isInteractionAllowed()) {
      addTrackedKey(baselinePollKeys, pollKey);
      setLastResult(RESULT.SKIPPED_NOT_NEW, { pollKey });
      return;
    }

    if (state.sourceModeEnabled && !state.sourceText.trim()) {
      addTrackedKey(processedPollKeys, pollKey);
      setLastResult(RESULT.BLOCKED_INDEX_REQUIRED, { pollKey });
      return;
    }

    if (!state.sourceModeEnabled && (state.waitingForIndex || !Number.isInteger(state.primaryIndex))) {
      addTrackedKey(processedPollKeys, pollKey);
      setLastResult(RESULT.BLOCKED_INDEX_REQUIRED, { pollKey });
      return;
    }

    let target = null;
    let outcome = RESULT.SKIPPED_NO_INDEX;
    let usedIndex = null;

    if (state.sourceModeEnabled) {
      const sourceMatch = selectOptionBySource(options, state.sourceText);
      if (sourceMatch) {
        target = sourceMatch.option;
        outcome = RESULT.SOURCE_VOTED;
        usedIndex = sourceMatch.index;
      }
    } else {
      const primaryOption = selectOptionByIndex(options, state.primaryIndex);
      const secondaryOption = Number.isInteger(state.secondaryIndex)
        ? selectOptionByIndex(options, state.secondaryIndex)
        : null;

      if (primaryOption) {
        target = primaryOption;
        outcome = RESULT.PRIMARY_VOTED;
        usedIndex = state.primaryIndex;
      } else if (secondaryOption) {
        target = secondaryOption;
        outcome = RESULT.SECONDARY_VOTED;
        usedIndex = state.secondaryIndex;
      }
    }

    if (!target) {
      addTrackedKey(processedPollKeys, pollKey);
      setLastResult(RESULT.SKIPPED_NO_INDEX, { pollKey });
      return;
    }

    // We mark the poll as processed before click to ensure single-attempt semantics.
    addTrackedKey(processedPollKeys, pollKey);

    if (isOptionAlreadySelected(target)) {
      successfulPollFingerprints.set(pollFingerprint, performance.now());
      setLastResult(RESULT.SKIPPED_DUPLICATE, { pollKey, usedIndex });
      return;
    }

    try {
      dispatchFastClick(target);
      const clickedAtMs = performance.now();
      successfulPollFingerprints.set(pollFingerprint, clickedAtMs);

      /** @type {PollEventRecord} */
      const eventRecord = {
        pollKey,
        detectedAtMs,
        clickedAtMs,
        outcome,
        usedIndex,
        latencyMs: clickedAtMs - detectedAtMs
      };

      setLastResult(eventRecord.outcome, {
        pollKey: eventRecord.pollKey,
        usedIndex: eventRecord.usedIndex,
        latencyMs: eventRecord.latencyMs
      });
    } catch (error) {
      console.warn("WA Poll Auto-Voter click failed", error);
      setLastResult(RESULT.ATTEMPT_FAILED, {
        pollKey,
        usedIndex,
        latencyMs: performance.now() - detectedAtMs
      });
    }
  }

  function collectCandidateMessageRoots(node, sink) {
    if (!isElement(node)) {
      return;
    }

    const directRoot = getMessageRoot(node);
    if (directRoot) {
      sink.add(directRoot);
    }

    if (node.matches(OPTION_QUERY)) {
      const rootFromOption = getMessageRoot(node);
      if (rootFromOption) {
        sink.add(rootFromOption);
      }
    }

    for (const pollish of node.querySelectorAll(OPTION_QUERY)) {
      const root = getMessageRoot(pollish);
      if (root) {
        sink.add(root);
      }
    }
  }

  function getRecentMessageRoots(container) {
    const roots = Array.from(container.querySelectorAll(MESSAGE_SCAN_QUERY));
    if (roots.length <= RECENT_MESSAGE_SCAN_LIMIT) {
      return roots;
    }
    return roots.slice(roots.length - RECENT_MESSAGE_SCAN_LIMIT);
  }

  function addRecentPollCandidates(sink) {
    const container = observedChatContainer || getActiveChatContainer();
    if (!container) {
      return;
    }

    for (const messageRoot of getRecentMessageRoots(container)) {
      if (messageRoot.querySelector(OPTION_QUERY)) {
        sink.add(messageRoot);
      }
    }
  }

  function getNewestCandidate(candidates) {
    let newestCandidate = null;

    for (const candidate of candidates) {
      if (!newestCandidate || compareDocumentPosition(newestCandidate, candidate) < 0) {
        newestCandidate = candidate;
      }
    }

    return newestCandidate;
  }

  function handleMutations(mutations) {
    if (!state.armed) {
      return;
    }

    const detectedAtMs = performance.now();
    const candidates = new Set();

    for (const mutation of mutations) {
      for (const addedNode of mutation.addedNodes) {
        collectCandidateMessageRoots(addedNode, candidates);
      }
    }

    // Fallback scan protects against DOM variants where mutation targets miss option nodes.
    addRecentPollCandidates(candidates);

    const newestCandidate = getNewestCandidate(candidates);
    if (newestCandidate) {
      processPollCandidate(newestCandidate, detectedAtMs);
    }
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    observedChatContainer = null;
  }

  function ensureObserver() {
    if (!state.armed) {
      stopObserver();
      return;
    }

    const container = getActiveChatContainer();
    if (!container) {
      return;
    }

    if (observer && observedChatContainer === container) {
      return;
    }

    stopObserver();

    observer = new MutationObserver(handleMutations);
    observer.observe(container, {
      childList: true,
      subtree: true
    });

    observedChatContainer = container;
  }

  function captureBaselinePolls() {
    const container = getActiveChatContainer();
    if (!container) {
      return;
    }

    const messageRoots = new Set();
    for (const optionNode of container.querySelectorAll(OPTION_QUERY)) {
      const root = getMessageRoot(optionNode);
      if (root) {
        messageRoots.add(root);
      }
    }

    for (const messageRoot of messageRoots) {
      const options = extractPollOptions(messageRoot);
      if (options.length < 2) {
        continue;
      }
      const key = buildPollKey(messageRoot, options);
      baselinePollRoots.add(messageRoot);
      addTrackedKey(baselinePollKeys, key);
    }
  }

  function fallbackTailScan() {
    if (!state.armed) {
      return;
    }

    const candidates = new Set();
    addRecentPollCandidates(candidates);
    if (!candidates.size) {
      return;
    }

    const detectedAtMs = performance.now();
    const newestCandidate = getNewestCandidate(candidates);
    if (newestCandidate) {
      processPollCandidate(newestCandidate, detectedAtMs);
    }
  }

  function persistArmedState(armed) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEYS.armed]: Boolean(armed) }, resolve);
    });
  }

  function disarmRuntime() {
    state.armed = false;
    state.primaryIndex = null;
    state.secondaryIndex = null;
    state.sourceModeEnabled = false;
    state.sourceText = "";
    state.waitingForIndex = false;
    setLastResult(RESULT.DISARMED);

    clearTrackedKeys();
    stopObserver();
  }

  function armRuntime({ primaryIndex, secondaryIndex, sourceModeEnabled, sourceText }) {
    const wasArmed = state.armed;
    const wasWaitingForIndex = state.waitingForIndex;

    state.armed = true;
    state.primaryIndex = primaryIndex;
    state.secondaryIndex = secondaryIndex;
    state.sourceModeEnabled = Boolean(sourceModeEnabled);
    state.sourceText = String(sourceText || "").trim();
    state.waitingForIndex = state.sourceModeEnabled ? !state.sourceText : !Number.isInteger(primaryIndex);

    if (!wasArmed) {
      clearTrackedKeys();
      activeChatSignature = readActiveChatSignature();
      chatSwitchIgnoreUntilMs = performance.now() + 150;
      captureBaselinePolls();
    }

    if (wasWaitingForIndex && !state.waitingForIndex) {
      chatSwitchIgnoreUntilMs = performance.now() + 150;
      captureBaselinePolls();
    }

    if (state.waitingForIndex) {
      setLastResult(RESULT.BLOCKED_INDEX_REQUIRED);
    }

    ensureObserver();
  }

  function buildStatusPayload() {
    return {
      armed: state.armed,
      waitingForIndex: state.waitingForIndex,
      sourceModeEnabled: state.sourceModeEnabled,
      sourceText: state.sourceText,
      lastResult: state.lastResult,
      lastLatencyMs: state.lastLatencyMs,
      lastPollKey: state.lastPollKey,
      lastUsedIndex: state.lastUsedIndex,
      isVisible: document.visibilityState === "visible",
      isFocused: document.hasFocus(),
      trackedPollCount: processedPollKeys.size,
      baselinePollCount: baselinePollKeys.size,
      updatedAt: state.lastUpdatedAt
    };
  }

  async function handleSetConfiguration(payload) {
    const desiredArmed = Boolean(payload?.armed);

    if (!desiredArmed) {
      disarmRuntime();
      await persistArmedState(false);
      return buildStatusPayload();
    }

    const primaryIndex = parsePositiveIndex(payload?.primaryIndex);
    const secondaryIndex = parsePositiveIndex(payload?.secondaryIndex);
    const sourceModeEnabled = Boolean(payload?.sourceModeEnabled);
    const sourceText = String(payload?.sourceText || "").trim();

    armRuntime({
      primaryIndex,
      secondaryIndex,
      sourceModeEnabled,
      sourceText
    });

    await persistArmedState(true);
    return buildStatusPayload();
  }

  function checkChatSwitch() {
    if (!state.armed) {
      return;
    }

    const signature = readActiveChatSignature();
    if (signature === activeChatSignature) {
      return;
    }

    activeChatSignature = signature;
    clearTrackedKeys();
    chatSwitchIgnoreUntilMs = performance.now() + 600;
    captureBaselinePolls();
  }

  function bootstrapListeners() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "GET_STATUS") {
        sendResponse({ ok: true, status: buildStatusPayload() });
        return;
      }

      if (message?.type === "SET_CONFIGURATION") {
        handleSetConfiguration(message.payload)
          .then((status) => {
            sendResponse({ ok: true, status });
          })
          .catch((error) => {
            sendResponse({
              ok: false,
              error: error instanceof Error ? error.message : String(error)
            });
          });
        return true;
      }

      sendResponse({ ok: false, error: "Unknown message type." });
    });

    window.setInterval(() => {
      if (!state.armed) {
        return;
      }
      checkChatSwitch();
      ensureObserver();
      fallbackTailScan();
    }, 250);

    document.addEventListener("visibilitychange", () => {
      if (!state.armed) {
        return;
      }
      checkChatSwitch();
      ensureObserver();
    });

    window.addEventListener("focus", () => {
      if (!state.armed) {
        return;
      }
      checkChatSwitch();
      ensureObserver();
    });
  }

  function restoreArmStateFromStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEYS.armed], (result) => {
        const shouldArm = Boolean(result?.[STORAGE_KEYS.armed]);

        if (shouldArm) {
          state.armed = true;
          state.primaryIndex = null;
          state.secondaryIndex = null;
          state.sourceModeEnabled = false;
          state.sourceText = "";
          state.waitingForIndex = true;
          setLastResult(RESULT.BLOCKED_INDEX_REQUIRED);

          clearTrackedKeys();
          activeChatSignature = readActiveChatSignature();
          chatSwitchIgnoreUntilMs = performance.now() + 400;
          captureBaselinePolls();
          ensureObserver();
        } else {
          disarmRuntime();
        }

        resolve();
      });
    });
  }

  async function initialize() {
    activeChatSignature = readActiveChatSignature();
    bootstrapListeners();
    await restoreArmStateFromStorage();
  }

  initialize().catch((error) => {
    console.error("WA Poll Auto-Voter initialization failed", error);
  });
})();
