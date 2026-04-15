function extractFromProcessActivity(text) {
  const headerMatch = text.match(/Process Activity([\s\S]*?)(?:Current Activity|Next Activity)/i);
  const section = headerMatch ? headerMatch[1] : text.slice(0, 2500);

  const readField = (label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = section.match(new RegExp(escaped + String.raw`:\s*([^\n\r]+)`, "i"));
    return match ? match[1].trim() : "";
  };

  return {
    fullName: readField("Name"),
    homePhone: readField("Home Phone"),
    cellPhone: readField("Cell Phone"),
    workPhone: readField("Work Phone"),
    email: readField("Email"),
    address: readField("Address"),
    wantedVehicle: readField("Wanted Vehicle"),
    tradeInVehicle: readField("Trade-In Vehicle")
  };
}

function fallbackRead(text, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = text.match(new RegExp(escaped + String.raw`:\s*([^\n\r]+)`, "i"));
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

function cleanName(value) {
  const v = String(value || "").trim();
  if (!v || /manager override/i.test(v)) return "";
  return v;
}

function queryCustomerNameFromDom() {
  const candidates = Array.from(document.querySelectorAll("body *"))
    .map(el => (el.innerText || "").trim())
    .filter(Boolean)
    .filter(v => /name:/i.test(v) && !/manager override/i.test(v))
    .slice(0, 80);

  for (const value of candidates) {
    const match = value.match(/Name:\s*([^\n\r]+)/i);
    if (match && match[1] && !/manager override/i.test(match[1])) return match[1].trim();
  }
  return "";
}

function extractCustomerData() {
  const text = document.body.innerText || "";
  const p = extractFromProcessActivity(text);

  const fullName = cleanName(queryCustomerNameFromDom() || p.fullName || fallbackRead(text, ["Name"]));
  const phone = p.cellPhone || p.homePhone || p.workPhone || fallbackRead(text, ["Cell #", "Home #", "Work #", "Cell Phone", "Home Phone", "Work Phone"]);
  const email = p.email || fallbackRead(text, ["Preferred Email", "Email"]);
  const address = p.address || fallbackRead(text, ["Address"]);
  const vehicle = p.wantedVehicle || fallbackRead(text, ["Wanted Vehicle", "Vehicle"]);
  const tradeInVehicle = p.tradeInVehicle || fallbackRead(text, ["Trade-In Vehicle", "Trade"]);
  const opportunityId = (location.href.match(/IDID=(\d+)/i) || [])[1] || (location.href.match(/PID=(\d+)/i) || [])[1] || "";

  const activityLines = [];
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/Text Message|Email|Call|Manual Email|Outbound Call|Send Email|Service Reminder|Appointment Set|Showroom Visit|Note/i.test(line)) {
      activityLines.push(line);
    }
  }

  if (!fullName && !phone && !email) return null;

  const identity = phone
    ? `phone_${phone.replace(/\D/g, "")}`
    : email
      ? `email_${email.toLowerCase()}`
      : `name_${fullName.toLowerCase().replace(/\s+/g, "_")}`;

  return {
    customerId: identity,
    customer: { fullName, phone, email, address, vehicle, tradeInVehicle, opportunityId },
    activityLines: activityLines.slice(0, 25),
    pageUrl: location.href,
    detectedAt: new Date().toISOString()
  };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getCurrentPageCustomer") {
    sendResponse({ data: extractCustomerData() });
    return true;
  }
  return false;
});

function sendCustomerData() {
  const data = extractCustomerData();
  if (!data) return;
  chrome.runtime.sendMessage({ action: "customerDetected", data });
}

function burstRefresh() {
  const delays = [150, 400, 800, 1400];
  for (const delay of delays) setTimeout(sendCustomerData, delay);
}

function ensureFloatingLauncher() {
  if (document.getElementById("crm-memory-fab")) return;

  const fab = document.createElement("button");
  fab.id = "crm-memory-fab";
  fab.type = "button";
  fab.textContent = "AI";
  fab.title = "Open CRM Memory Copilot";
  Object.assign(fab.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    width: "58px",
    height: "58px",
    borderRadius: "999px",
    border: "none",
    background: "linear-gradient(135deg, #1a4fc7, #7c3aed)",
    color: "#fff",
    fontWeight: "800",
    fontSize: "16px",
    boxShadow: "0 10px 24px rgba(26,79,199,.35)",
    cursor: "pointer",
    zIndex: "2147483646"
  });

  let opening = false;
  fab.addEventListener("click", async () => {
    if (opening) return;
    opening = true;
    fab.style.opacity = "0.72";
    try {
      const data = extractCustomerData();
      if (data?.customerId) {
        await chrome.runtime.sendMessage({ action: "customerDetected", data }).catch(() => null);
      }
      await chrome.runtime.sendMessage({ action: "openFullCopilot" }).catch(() => null);
    } finally {
      setTimeout(() => {
        opening = false;
        fab.style.opacity = "1";
      }, 700);
    }
  });

  document.documentElement.appendChild(fab);
  makeDraggable(fab);
}

function makeDraggable(element) {
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
  element.addEventListener("pointerdown", (e) => {
    dragging = true;
    element.setPointerCapture(e.pointerId);
    const rect = element.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    element.style.left = `${rect.left}px`;
    element.style.top = `${rect.top}px`;
    element.style.right = "auto";
    element.style.bottom = "auto";
  });
  element.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const left = startLeft + (e.clientX - startX);
    const top = startTop + (e.clientY - startY);
    element.style.left = `${Math.max(8, left)}px`;
    element.style.top = `${Math.max(8, top)}px`;
  });
  element.addEventListener("pointerup", () => { dragging = false; });
}

function updateMiniStatus() {}

window.addEventListener("load", () => { burstRefresh(); ensureFloatingLauncher(); updateMiniStatus(); });
document.addEventListener("DOMContentLoaded", () => { burstRefresh(); ensureFloatingLauncher(); updateMiniStatus(); });

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    burstRefresh();
    setTimeout(updateMiniStatus, 300);
  }
}).observe(document, { childList: true, subtree: true });
