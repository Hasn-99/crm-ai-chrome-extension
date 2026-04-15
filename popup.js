let currentRecord = null;
let currentMessageType = "email";
let timelineVisible = false;

(async function init() {
  if (new URLSearchParams(location.search).get("mode") === "full") {
    document.body.classList.add("full-window-mode");
  }
  bindEvents();
  await loadSavedApiKey();
  await loadCustomer();
  if (!currentRecord) await refreshFromPage();
})();

function bindEvents() {
  document.getElementById("generateEmail").addEventListener("click", () => generateMessage("email"));
  document.getElementById("generateText").addEventListener("click", () => generateMessage("sms"));
  document.getElementById("generateNote").addEventListener("click", () => generateMessage("note"));
  document.getElementById("analyzeBtn").addEventListener("click", analyzeCustomer);
  document.getElementById("saveMessage").addEventListener("click", saveMessage);
  document.getElementById("copyMessage").addEventListener("click", copyMessage);
  document.getElementById("refreshData").addEventListener("click", refreshFromPage);
  document.getElementById("logInteraction").addEventListener("click", logInteraction);
  document.getElementById("apiKey").addEventListener("change", saveApiKey);
  document.getElementById("toggleTimeline").addEventListener("click", toggleTimeline);
  document.getElementById("clearCurrentCustomer").addEventListener("click", clearCurrentCustomer);
}

async function loadSavedApiKey() {
  const result = await chrome.storage.local.get(["groqApiKey"]);
  if (result.groqApiKey) document.getElementById("apiKey").value = result.groqApiKey;
}

async function saveApiKey() {
  const key = document.getElementById("apiKey").value.trim();
  if (key) await chrome.storage.local.set({ groqApiKey: key });
}

async function loadCustomer() {
  const response = await chrome.runtime.sendMessage({ action: "getCurrentCustomer" });
  currentRecord = response?.data || null;
  renderCustomer();
}

function renderCustomer() {
  const customerBlock = document.getElementById("customerBlock");
  const memoryBlock = document.getElementById("memoryBlock");
  const profileBlock = document.getElementById("profileBlock");
  const badge = document.getElementById("customerBadge");
  const statusSelect = document.getElementById("currentStatus");

  if (!currentRecord || !currentRecord.customer) {
    customerBlock.innerText = "No customer detected.\nOpen an eLead customer page and press ↻ Refresh.";
    memoryBlock.innerText = "No customer in memory.";
    profileBlock.innerText = "Profile insights will appear here.";
    badge.textContent = "";
    statusSelect.value = "";
    document.getElementById("timelineBlock").innerHTML = "";
    return;
  }

  const c = currentRecord.customer || {};
  const p = currentRecord.profile || {};
  const totalInteractions = (currentRecord.interactions || []).length;
  const msgCount = currentRecord.messages?.length || 0;
  const firstSeen = formatShortDate(currentRecord.firstSeen);
  const lastSeen = formatShortDate(currentRecord.lastSeen);

  customerBlock.innerText =
    `Name: ${c.fullName || "-"}\n` +
    `Phone: ${c.phone || "-"}\n` +
    `Email: ${c.email || "-"}\n` +
    `Vehicle: ${c.vehicle || "-"}\n` +
    `Trade-In: ${c.tradeInVehicle || "-"}`;

  badge.textContent = p.stageLabel || (totalInteractions <= 1 ? "New Customer" : "Returning Customer");
  badge.className = "badge " + badgeClassForStage(p.stage);

  memoryBlock.innerText =
    `First Contact: ${firstSeen}\n` +
    `Last Seen: ${lastSeen}\n` +
    `Current Status: ${p.stageLabel || "Unknown"}\n` +
    `Total Interactions: ${totalInteractions}\n` +
    `Messages Generated: ${msgCount}`;

  profileBlock.innerText =
    `Vehicles: ${(p.vehiclesOfInterest || []).join(", ") || "None"}\n` +
    `Behavior: ${(p.behaviorTags || []).join(", ") || "None"}\n` +
    `Objections: ${(p.objections || []).join(", ") || "None"}\n` +
    `Next Direction: ${p.lastRecommendedAction || "No recommendation yet."}`;

  statusSelect.value = p.currentStatus || p.stage || "";
  renderTimeline();
}

function renderTimeline() {
  const container = document.getElementById("timelineBlock");
  if (!currentRecord?.interactions?.length) {
    container.innerHTML = "<p style='color:#888;font-size:11px;padding:6px 0'>No interactions logged yet.</p>";
    return;
  }
  const items = [...currentRecord.interactions].reverse();
  container.innerHTML = items.map(e => {
    const dt = new Date(e.createdAt);
    const dateStr = dt.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " + dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    const notes = e.notes ? `<div class="t-notes">${escHtml(trimText(e.notes, 150))}</div>` : "";
    const outcome = e.outcome ? `<div class="t-outcome">→ ${escHtml(trimText(e.outcome, 100))}</div>` : "";
    return `<div class="timeline-item">
      <div class="t-dot ${e.type}"></div>
      <div class="t-content">
        <span class="t-label">${escHtml(e.label || e.type)}</span><span class="t-date">${dateStr}</span>
        ${notes}${outcome}
      </div>
    </div>`;
  }).join("");
}

function toggleTimeline() {
  timelineVisible = !timelineVisible;
  const block = document.getElementById("timelineBlock");
  const btn = document.getElementById("toggleTimeline");
  block.classList.toggle("hidden", !timelineVisible);
  btn.textContent = timelineVisible ? "Hide History" : "View History";
}

function escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function trimText(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function formatShortDate(value) {
  return value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "unknown";
}

function badgeClassForStage(stage) {
  if (["sold", "engaged", "appointment_pending", "visited"].includes(stage)) return "badge-green";
  if (["follow_up_needed", "working"].includes(stage)) return "badge-blue";
  return "badge-orange";
}

function getCrmTabIdFromUrl() {
  const params = new URLSearchParams(location.search);
  const raw = params.get("crmTabId");
  const id = raw ? Number(raw) : NaN;
  return Number.isFinite(id) ? id : null;
}

async function refreshFromPage() {
  const pinnedTabId = getCrmTabIdFromUrl();
  let tabId = pinnedTabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id || null;
  }
  if (!tabId) return;

  const res = await chrome.tabs.sendMessage(tabId, { action: "getCurrentPageCustomer" }).catch(() => null);
  if (res?.data) {
    await chrome.runtime.sendMessage({ action: "customerDetected", data: res.data });
  }
  await loadCustomer();
}

async function clearCurrentCustomer() {
  await chrome.runtime.sendMessage({ action: "clearCurrentCustomer" }).catch(() => null);
  currentRecord = null;
  renderCustomer();
}

async function logInteraction() {
  if (!currentRecord) {
    alert("No customer loaded. Refresh first.");
    return;
  }

  const type = document.getElementById("interactionType").value;
  const notes = document.getElementById("interactionNotes").value.trim();
  const currentStatus = document.getElementById("currentStatus").value;

  if (!notes) {
    alert("Write the latest update before saving.");
    return;
  }

  const typeLabels = {
    visit_inperson: "In-Person Visit",
    visit_phone: "Phone Call",
    email: "Email",
    sms: "Text/SMS",
    note: "Internal Note",
    lead: "Lead / Internet"
  };

  const btn = document.getElementById("logInteraction");
  const original = btn.textContent;
  btn.textContent = "Saving...";
  btn.disabled = true;

  const response = await chrome.runtime.sendMessage({
    action: "logInteraction",
    customerId: currentRecord.customerId,
    interaction: {
      type,
      label: typeLabels[type] || type,
      notes,
      outcome: currentStatus ? `Status updated to ${currentStatus.replaceAll("_", " ")}` : "",
      currentStatus
    }
  });

  btn.textContent = original;
  btn.disabled = false;

  if (!response?.success) {
    alert(response?.error || "Save failed.");
    return;
  }

  currentRecord = response.data;
  document.getElementById("interactionNotes").value = "";

  if (!timelineVisible) {
    timelineVisible = true;
    document.getElementById("timelineBlock").classList.remove("hidden");
    document.getElementById("toggleTimeline").textContent = "Hide History";
  }

  renderCustomer();
  showSavedFeedback("logInteraction", "✅ Saved!");
}

function showSavedFeedback(btnId, msg) {
  const btn = document.getElementById(btnId);
  const orig = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = orig; }, 1800);
}

async function generateMessage(messageType) {
  if (!currentRecord) { alert("No customer loaded."); return; }
  const apiKey = document.getElementById("apiKey").value.trim();
  const instruction = document.getElementById("instruction").value.trim();
  if (!apiKey) { alert("Paste your Groq API key first."); return; }
  await saveApiKey();

  currentMessageType = messageType;
  const output = document.getElementById("output");
  const analysisOutput = document.getElementById("analysisOutput");
  analysisOutput.classList.add("hidden");
  output.classList.remove("hidden");
  output.value = "Generating...";
  document.getElementById("outputLabel").textContent = "AI Writing Output";
  const badge = document.getElementById("outputTypeBadge");
  badge.textContent = messageType.toUpperCase();
  badge.className = "badge badge-blue";

  const response = await chrome.runtime.sendMessage({
    action: "generateAIMessage",
    payload: { customerId: currentRecord.customerId, userInstruction: instruction, messageType, apiKey }
  });

  if (!response?.success) {
    output.value = `Error: ${response?.error || "Unknown error"}`;
    return;
  }
  output.value = response.result;
}

async function analyzeCustomer() {
  if (!currentRecord) { alert("No customer loaded."); return; }
  const apiKey = document.getElementById("apiKey").value.trim();
  const instruction = document.getElementById("instruction").value.trim();
  if (!apiKey) { alert("Paste your Groq API key first."); return; }
  await saveApiKey();

  const output = document.getElementById("output");
  const analysisOutput = document.getElementById("analysisOutput");
  output.classList.add("hidden");
  analysisOutput.classList.remove("hidden");
  analysisOutput.innerHTML = "<em style='color:#888'>🔍 Analyzing full customer history...</em>";
  document.getElementById("outputLabel").textContent = "AI Analysis";
  const badge = document.getElementById("outputTypeBadge");
  badge.textContent = "ANALYST";
  badge.className = "badge";
  badge.style.background = "#ede9fe";
  badge.style.color = "#5b21b6";

  const response = await chrome.runtime.sendMessage({
    action: "analyzeCustomer",
    payload: { customerId: currentRecord.customerId, userInstruction: instruction, apiKey }
  });

  if (!response?.success) {
    analysisOutput.innerHTML = `<span style="color:red">Error: ${response?.error || "Unknown error"}</span>`;
    return;
  }

  const html = response.result
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\n/g, '<br>');
  analysisOutput.innerHTML = html;
}

async function saveMessage() {
  if (!currentRecord) { alert("No customer loaded."); return; }
  const output = document.getElementById("output");
  if (output.classList.contains("hidden")) { alert("Generate the writing first — then save."); return; }
  const message = output.value.trim();
  const instruction = document.getElementById("instruction").value.trim();
  if (!message) { alert("No message to save."); return; }

  const response = await chrome.runtime.sendMessage({
    action: "saveGeneratedMessage",
    customerId: currentRecord.customerId,
    messageType: currentMessageType,
    message,
    userInstruction: instruction
  });

  if (!response?.success) { alert(response?.error || "Save failed."); return; }
  currentRecord = response.data;
  renderCustomer();
  showSavedFeedback("saveMessage", "✅ Saved!");
}

async function copyMessage() {
  const analysisOutput = document.getElementById("analysisOutput");
  const output = document.getElementById("output");
  const text = !analysisOutput.classList.contains("hidden") ? analysisOutput.innerText : output.value.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  showSavedFeedback("copyMessage", "✅ Copied!");
}
