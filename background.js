let currentCustomer = null;
let currentCustomerId = null;

chrome.runtime.onInstalled.addListener(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}
});
chrome.runtime.onStartup.addListener(async () => {
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); } catch (e) {}
  await hydrateCurrentCustomer();
});

async function hydrateCurrentCustomer() {
  if (!currentCustomerId) {
    const state = await chrome.storage.local.get(["activeCustomerId"]);
    currentCustomerId = state.activeCustomerId || null;
  }
  if (currentCustomerId) {
    const result = await chrome.storage.local.get([currentCustomerId]);
    currentCustomer = result[currentCustomerId] || null;
  }
}

async function setCurrentCustomer(record) {
  currentCustomer = record || null;
  currentCustomerId = record?.customerId || null;
  await chrome.storage.local.set({ activeCustomerId: currentCustomerId || "" });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "customerDetected") {
    upsertCustomer(request.data)
      .then(async r => { await setCurrentCustomer(r); sendResponse({ success: true, data: r }); })
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (request.action === "getCurrentCustomer") {
    hydrateCurrentCustomer().then(() => sendResponse({ data: currentCustomer })).catch(() => sendResponse({ data: currentCustomer }));
    return true;
  }
  if (request.action === "clearCurrentCustomer") {
    setCurrentCustomer(null).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (request.action === "openSidePanel") {
    openSidePanelForSender(sender).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (request.action === "openFullCopilot") {
    openFullCopilotWindow(sender).then(() => sendResponse({ success: true })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (request.action === "generateAIMessage") {
    generateAIMessage(request.payload).then(r => sendResponse({ success: true, result: r })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (request.action === "saveGeneratedMessage") {
    saveGeneratedMessage(request.customerId, request.messageType, request.message, request.userInstruction).then(async r => { await setCurrentCustomer(r); sendResponse({ success: true, data: r }); }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (request.action === "logInteraction") {
    logInteraction(request.customerId, request.interaction).then(async r => { await setCurrentCustomer(r); sendResponse({ success: true, data: r }); }).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (request.action === "analyzeCustomer") {
    analyzeCustomer(request.payload).then(r => sendResponse({ success: true, result: r })).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  return false;
});

async function openFullCopilotWindow(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) throw new Error("No active CRM tab found.");
  const url = chrome.runtime.getURL(`popup.html?crmTabId=${tabId}&mode=full`);
  await chrome.windows.create({ url, type: "popup", width: 520, height: 940 });
}

async function openSidePanelForSender(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) throw new Error("No active CRM tab found.");
  await chrome.sidePanel.setOptions({ tabId, path: "popup.html", enabled: true });
  if (chrome.sidePanel.open) await chrome.sidePanel.open({ tabId });
}

function uniquePush(list, value) {
  if (!value) return list;
  const normalized = String(value).trim();
  if (!normalized) return list;
  if (!list.some(v => String(v).toLowerCase() === normalized.toLowerCase())) list.push(normalized);
  return list;
}

function inferTags(text) {
  const t = String(text || "").toLowerCase();
  const tags = [];
  if (/price|payment|monthly|apr|rate|lease|finance/.test(t)) tags.push("payment-focused");
  if (/trade|appraisal/.test(t)) tags.push("trade-in");
  if (/visit|showroom|came in|in person|test drive/.test(t)) tags.push("visited-showroom");
  if (/wife|husband|family|kids/.test(t)) tags.push("family-decision");
  if (/compare|shopping|other dealer|toyota|nissan|mazda|kia|hyundai|ford|chevy/.test(t)) tags.push("shopping-around");
  if (/no response|didn't answer|did not answer|left voicemail|voicemail/.test(t)) tags.push("hard-to-reach");
  if (/appointment|coming in|be here|saturday|tomorrow|today|call me back|coming back/.test(t)) tags.push("appointment-interest");
  if (/interested|loved|likes|liked|strong|hot lead/.test(t)) tags.push("engaged");
  return tags;
}

function inferVehicles(text) {
  const matches = String(text || "").match(/\b(civic|accord|cr-v|crv|hr-v|hrv|pilot|passport|odyssey|ridgeline|prologue)\b/gi) || [];
  return [...new Set(matches.map(v => v.toUpperCase().replace("CRV", "CR-V").replace("HRV", "HR-V")))];
}

function inferStage(record) {
  if (record.profile?.currentStatus) return record.profile.currentStatus;
  const interactions = record.interactions || [];
  const allText = interactions.map(i => `${i.label || ""} ${i.notes || ""} ${i.outcome || ""}`).join(" \n ").toLowerCase();
  if (/sold|delivered|bought|purchased/.test(allText)) return "sold";
  if (/lost lead|dead lead|not interested|bought elsewhere/.test(allText)) return "lost";
  if (/appointment|be here|coming in|coming back/.test(allText)) return "appointment_pending";
  if (/test drive|showroom|came in|visited/.test(allText)) return "visited";
  if (/responded|replied|called back|texted back|engaged/.test(allText)) return "engaged";
  if (interactions.length <= 1) return "new_lead";
  if (/no response|voicemail|left message/.test(allText)) return "follow_up_needed";
  return "working";
}

function stageLabel(stage) {
  return ({
    new_lead: "New Lead",
    working: "Working",
    engaged: "Engaged",
    visited: "Visited",
    appointment_pending: "Appointment Pending",
    follow_up_needed: "Follow Up Needed",
    sold: "Sold",
    lost: "Lost"
  })[stage] || stage || "Unknown";
}

function buildProfile(record) {
  const customer = record.customer || {};
  const profile = record.profile || { vehiclesOfInterest: [], behaviorTags: [], objections: [], preferredChannels: [] };
  profile.vehiclesOfInterest = profile.vehiclesOfInterest || [];
  profile.behaviorTags = profile.behaviorTags || [];
  profile.objections = profile.objections || [];
  profile.preferredChannels = profile.preferredChannels || [];

  uniquePush(profile.vehiclesOfInterest, customer.vehicle);
  uniquePush(profile.vehiclesOfInterest, customer.tradeInVehicle ? `Trade: ${customer.tradeInVehicle}` : "");

  for (const interaction of record.interactions || []) {
    const combined = `${interaction.label || ""} ${interaction.notes || ""} ${interaction.outcome || ""}`;
    inferVehicles(combined).forEach(v => uniquePush(profile.vehiclesOfInterest, v));
    inferTags(combined).forEach(tag => uniquePush(profile.behaviorTags, tag));

    if (/text|sms/i.test(interaction.type)) uniquePush(profile.preferredChannels, "text");
    if (/email/i.test(interaction.type)) uniquePush(profile.preferredChannels, "email");
    if (/visit_phone|call/i.test(interaction.type)) uniquePush(profile.preferredChannels, "call");

    const lower = combined.toLowerCase();
    if (/payment too high|higher payment|lower payment|budget/.test(lower)) uniquePush(profile.objections, "payment");
    if (/price too high|expensive/.test(lower)) uniquePush(profile.objections, "price");
    if (/shopping around|other dealer|comparing/.test(lower)) uniquePush(profile.objections, "comparing dealers");
    if (/need to talk to wife|need to talk to husband|need to think/.test(lower)) uniquePush(profile.objections, "decision pending");
  }

  profile.stage = inferStage(record);
  profile.stageLabel = stageLabel(profile.stage);
  profile.lastRecommendedAction = profile.stage === "appointment_pending"
    ? "Confirm the return time and keep the message short."
    : profile.stage === "visited"
      ? "Reference the visit, answer the open objection, and ask for the next step."
      : profile.stage === "engaged"
        ? "Send a direct follow-up tied to the exact vehicle and concern."
        : profile.stage === "follow_up_needed"
          ? "Use a soft re-engagement message with one clear next step."
          : profile.stage === "lost"
            ? "Do not pressure. Send one final light check-in only if needed."
            : profile.stage === "sold"
              ? "Switch to thank-you / retention follow-up."
              : "Introduce yourself, confirm vehicle interest, and ask one simple question.";

  record.profile = profile;
  return record;
}

async function upsertCustomer(payload) {
  const key = payload.customerId;
  const result = await chrome.storage.local.get([key]);
  const existing = result[key];
  const now = new Date().toISOString();
  const record = existing || {
    customerId: key,
    customer: payload.customer,
    firstSeen: now,
    lastSeen: now,
    interactions: [],
    messages: [],
    activitySnapshots: [],
    profile: { vehiclesOfInterest: [], behaviorTags: [], objections: [], preferredChannels: [] }
  };

  record.customer = { ...(record.customer || {}), ...(payload.customer || {}) };
  record.lastSeen = now;
  record.activitySnapshots.push({ detectedAt: payload.detectedAt, activityLines: payload.activityLines || [], pageUrl: payload.pageUrl || "" });
  if (record.activitySnapshots.length > 20) record.activitySnapshots = record.activitySnapshots.slice(-20);
  if (!record.interactions) record.interactions = [];
  if (!existing) {
    record.interactions.push({
      id: Date.now(),
      type: "first_contact",
      label: "First Contact Detected",
      notes: `Customer first seen in CRM. Vehicle of interest: ${payload.customer?.vehicle || "unknown"}`,
      createdAt: now
    });
  }

  buildProfile(record);
  await chrome.storage.local.set({ [key]: record });
  return record;
}

async function logInteraction(customerId, interaction) {
  const result = await chrome.storage.local.get([customerId]);
  const record = result[customerId];
  if (!record) throw new Error("Customer not found.");
  if (!record.interactions) record.interactions = [];
  record.interactions.push({
    id: Date.now(),
    type: interaction.type,
    label: interaction.label || interaction.type,
    notes: interaction.notes || "",
    outcome: interaction.outcome || "",
    createdAt: new Date().toISOString()
  });
  if (interaction.currentStatus) {
    record.profile = record.profile || {};
    record.profile.currentStatus = interaction.currentStatus;
  }
  if (record.interactions.length > 150) record.interactions = record.interactions.slice(-150);
  record.lastSeen = new Date().toISOString();
  buildProfile(record);
  await chrome.storage.local.set({ [customerId]: record });
  return record;
}

async function saveGeneratedMessage(customerId, messageType, message, userInstruction) {
  const result = await chrome.storage.local.get([customerId]);
  const record = result[customerId];
  if (!record) throw new Error("Customer not found.");
  const now = new Date().toISOString();
  record.messages.push({ type: messageType, message, userInstruction, createdAt: now });
  if (record.messages.length > 80) record.messages = record.messages.slice(-80);
  if (!record.interactions) record.interactions = [];

  const interactionType = messageType === "email" ? "email" : messageType === "sms" ? "sms" : "note";
  const interactionLabel = messageType === "email" ? "Email Saved" : messageType === "sms" ? "Text Saved" : "Note Saved";

  record.interactions.push({
    id: Date.now(),
    type: interactionType,
    label: interactionLabel,
    notes: `${userInstruction ? "[Instruction: " + userInstruction + "] " : ""}${message.substring(0, 240)}${message.length > 240 ? "..." : ""}`,
    createdAt: now
  });

  if (record.interactions.length > 150) record.interactions = record.interactions.slice(-150);
  record.lastSeen = now;
  buildProfile(record);
  await chrome.storage.local.set({ [customerId]: record });
  return record;
}

function buildFullContext(record) {
  const c = record.customer || {};
  const p = record.profile || {};
  const allInteractions = (record.interactions || []).map((e, i) => {
    const dt = new Date(e.createdAt);
    const d = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const t = dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
    return `[${i + 1}] ${d} ${t} — ${e.label}\n    ${e.notes || "No details"}${e.outcome ? "\n    Outcome: " + e.outcome : ""}`;
  }).join("\n\n");

  const recentMessages = (record.messages || []).slice(-5).map((m, i) =>
    `${i + 1}. [${m.type.toUpperCase()}] ${new Date(m.createdAt).toLocaleDateString()}\n   ${m.message.substring(0, 150)}...`
  ).join("\n\n");

  const recentActivity = ((record.activitySnapshots || []).at(-1)?.activityLines || []).join("\n");
  const firstSeen = record.firstSeen ? new Date(record.firstSeen).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "Unknown";
  const lastSeen = record.lastSeen ? new Date(record.lastSeen).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "Unknown";

  return {
    customerSection: `Customer:\n- Name: ${c.fullName || ""}\n- Phone: ${c.phone || ""}\n- Email: ${c.email || ""}\n- Address: ${c.address || ""}\n- Primary Vehicle Interest: ${c.vehicle || ""}\n- Trade-In: ${c.tradeInVehicle || ""}\n- Opportunity ID: ${c.opportunityId || ""}\n- First Contact: ${firstSeen}\n- Last Seen: ${lastSeen}\n- Current Stage: ${p.stageLabel || p.stage || "unknown"}\n- Vehicles Mentioned: ${(p.vehiclesOfInterest || []).join(", ") || "None"}\n- Behavior Tags: ${(p.behaviorTags || []).join(", ") || "None"}\n- Objections: ${(p.objections || []).join(", ") || "None"}\n- Suggested Direction: ${p.lastRecommendedAction || "None"}\n- Total Interactions: ${(record.interactions || []).length}`,
    allInteractions,
    recentMessages,
    recentActivity
  };
}

function buildPrompt(record, userInstruction, messageType) {
  const ctx = buildFullContext(record);
  const taskLine = messageType === "note"
    ? "Write one internal CRM note based on the full customer timeline and latest scenario."
    : `Write one ${messageType} for this customer using the full timeline, not just the latest note.`;

  const rules = messageType === "note"
    ? [
        "- Write as a dealership CRM note, not a customer-facing message",
        "- Merge the latest scenario with the customer history",
        "- Mention exact vehicle interest and objection when relevant",
        "- Be concise, clear, and factual",
        "- Mention next step when relevant",
        "- Output only the final note"
      ]
    : [
        "- Do not sound robotic or generic",
        "- Use the unified history of visits, notes, texts, emails, and CRM activity",
        "- Never reset the conversation like this is first contact if they already visited or replied",
        "- Mention only vehicles that fit the known history",
        "- If they are payment-focused, trade-focused, or comparing dealers, reflect that naturally",
        "- For SMS, keep it concise",
        `- Output only the final ${messageType}`
      ];

  return `You are an automotive sales follow-up assistant for a Honda dealership.\n\n${taskLine}\n\n${ctx.customerSection}\n\nFULL CUSTOMER TIMELINE:\n${ctx.allInteractions || "None recorded yet."}\n\nRecent CRM Activity:\n${ctx.recentActivity || "None."}\n\nPrevious Generated Messages:\n${ctx.recentMessages || "None."}\n\nSalesperson instruction / latest scenario:\n${userInstruction || (messageType === "note" ? "Write a clean CRM note." : "Write a professional natural follow-up.")}\n\nRules:\n${rules.join("\n")}`.trim();
}

function buildAnalystPrompt(record, userInstruction) {
  const ctx = buildFullContext(record);
  return `You are an expert automotive sales coach for a Honda dealership.\n\nAnalyze this customer's COMPLETE timeline and recommend the next best step.\n\n${ctx.customerSection}\n\nCOMPLETE INTERACTION HISTORY:\n${ctx.allInteractions || "No interactions recorded yet."}\n\nRecent eLead CRM Activity:\n${ctx.recentActivity || "None."}\n\n${userInstruction ? "Latest salesperson note: " + userInstruction : ""}\n\nProvide your analysis in this exact format:\n\n## Customer Summary\n[2-3 sentences: who they are, what they want, and where they are in the buying journey]\n\n## Timeline Insight\n[What the timeline shows across notes, visits, texts, emails, and calls]\n\n## Behavior Pattern\n[Patterns noticed: responsive? price-sensitive? researching? urgent?]\n\n## NEXT STEP — What To Do Right Now\n[Specific concrete action with channel and angle]\n\n## Recommended Message Angle\n[What the next message should focus on]\n\n## Follow-Up Plan (Next 7 Days)\n[Day 1, Day 3, Day 7 — specific actions]\n\n## Signals & Risks\n[Buying signals and possible loss risks]\n\nBe direct, practical, and specific.`.trim();
}

async function callGroq(apiKey, systemPrompt, userPrompt, temperature = 0.5, max_tokens = 900) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature,
      max_tokens
    })
  });
  if (!response.ok) {
    const e = await response.text();
    throw new Error(`Groq error: ${response.status} ${e}`);
  }
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("AI returned an empty response.");
  return text;
}

async function analyzeCustomer({ customerId, userInstruction, apiKey }) {
  const result = await chrome.storage.local.get([customerId]);
  const record = result[customerId];
  if (!record) throw new Error("Customer not found in memory.");
  const prompt = buildAnalystPrompt(record, userInstruction);
  return callGroq(apiKey, "You are a sharp automotive sales coach. Analyze customer history and give precise actionable next steps.", prompt, 0.45, 900);
}

async function generateAIMessage({ customerId, userInstruction, messageType, apiKey }) {
  const result = await chrome.storage.local.get([customerId]);
  const record = result[customerId];
  if (!record) throw new Error("Customer not found in memory.");
  const prompt = buildPrompt(record, userInstruction, messageType);
  return callGroq(apiKey, "You write strong, natural automotive sales follow-ups that respect the customer's real history.", prompt, messageType === "sms" ? 0.55 : 0.45, messageType === "sms" ? 220 : 500);
}
