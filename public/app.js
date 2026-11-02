const $ = (sel) => document.querySelector(sel);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const toCents = (v) => Math.round(Number(v || 0) * 100);
const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

let token = null;
try { token = localStorage.getItem("ownerToken"); } catch {}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { signOut(); throw new Error("Signed out"); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 3500);
}

// ---------- sign in ----------

function signOut() {
  try { localStorage.removeItem("ownerToken"); } catch {}
  token = null;
  $("#app").hidden = true;
  $("#signin").hidden = false;
}

$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("#token").value.trim();
  const res = await fetch("/api/agents", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    $("#signin-error").textContent = "That token didn't work.";
    $("#signin-error").hidden = false;
    return;
  }
  try { localStorage.setItem("ownerToken", token); } catch {}
  start();
});

// ---------- tabs ----------

document.querySelectorAll("nav button").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== `tab-${btn.dataset.tab}`));
    refresh();
  }),
);

// ---------- approvals ----------

async function renderApprovals() {
  const all = await api("GET", "/api/requests");
  const pending = all.filter((r) => r.status === "pending");
  const count = $("#pending-count");
  count.textContent = pending.length;
  count.hidden = pending.length === 0;

  $("#pending-list").innerHTML = pending.length
    ? pending
        .map(
          (r) => `
      <div class="card request">
        <div class="meta">${esc(r.agentName)} wants to spend</div>
        <div class="amount">${usd(r.amountCents)}</div>
        <div class="merchant">at ${esc(r.merchant)}${r.category ? ` · ${esc(r.category)}` : ""}</div>
        <p class="reason">"${esc(r.reason)}"</p>
        ${r.riskFlags.filter((f) => f.level !== "info").map((f) => `<div class="flag ${f.level}">${f.level === "high" ? "⚠️" : "⚡"} ${esc(f.message)}</div>`).join("")}
        ${r.riskFlags.filter((f) => f.level === "info").map((f) => `<div class="flag info">${esc(f.message)}</div>`).join("")}
        <div class="actions">
          <button class="deny" data-deny="${r.id}">Deny</button>
          <button class="approve" data-approve="${r.id}" data-passkey="${r.needsPasskey}">${r.needsPasskey ? "Approve with Face ID" : "Approve"}</button>
        </div>
        <div class="meta" style="margin-top:10px">Expires ${when(r.expiresAt)}</div>
      </div>`,
        )
        .join("")
    : `<div class="empty">Nothing waiting for you.</div>`;

  const recent = all.filter((r) => r.status !== "pending").slice(0, 15);
  $("#recent-list").innerHTML = recent.length
    ? `<div class="card">${recent
        .map(
          (r) => `
      <div class="line">
        <div><strong>${usd(r.amountCents)}</strong> at ${esc(r.merchant)}<div class="muted" style="font-size:.85rem">${esc(r.agentName)} · ${when(r.createdAt)}</div></div>
        <div class="status ${r.status}">${r.status.replace("_", " ")}</div>
      </div>`,
        )
        .join("")}</div>`
    : `<div class="empty">No purchases yet.</div>`;
}

document.addEventListener("click", async (e) => {
  const approveId = e.target.dataset?.approve;
  const denyId = e.target.dataset?.deny;
  if (!approveId && !denyId) return;
  e.target.disabled = true;
  try {
    if (approveId) {
      let body;
      if (e.target.dataset.passkey === "true") {
        const optionsJSON = await api("POST", `/api/requests/${approveId}/approve/options`);
        body = { passkey: await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON }) };
      }
      const res = await api("POST", `/api/requests/${approveId}/approve`, body);
      toast(res.request.status === "approved" ? "Approved. A one-time card was sent to the agent." : `Blocked: ${res.request.decisionReason}`);
    } else {
      await api("POST", `/api/requests/${denyId}/deny`);
      toast("Denied.");
    }
  } catch (err) {
    toast(err.name === "NotAllowedError" ? "Cancelled." : err.message);
  }
  refresh();
});

// ---------- agents ----------

async function renderAgents() {
  const agents = await api("GET", "/api/agents");
  $("#agent-list").innerHTML = agents.length
    ? agents
        .map((a) => {
          const pct = a.monthlyBudgetCents ? Math.min(100, (a.spentThisMonthCents / a.monthlyBudgetCents) * 100) : 100;
          return `
      <div class="card">
        <div class="agent-head">
          <strong>${esc(a.name)}</strong>
          <button class="ghost" data-toggle="${a.id}" data-active="${a.active}">${a.active ? "Pause" : "Resume"}</button>
        </div>
        <div class="meter"><div style="width:${pct}%"></div></div>
        <div class="muted" style="font-size:.85rem">${usd(a.spentThisMonthCents)} of ${usd(a.monthlyBudgetCents)} spent this month${a.active ? "" : " · paused"}</div>
        <dl class="rules">
          <dt>Max per purchase</dt><dd>${usd(a.perPurchaseCapCents)}</dd>
          <dt>Auto-approve up to</dt><dd>${usd(a.autoApproveUnderCents)}</dd>
          <dt>Categories</dt><dd>${a.allowedCategories.length ? esc(a.allowedCategories.join(", ")) : "Any"}</dd>
          <dt>Blocked stores</dt><dd>${a.blockedMerchants.length ? esc(a.blockedMerchants.join(", ")) : "None"}</dd>
        </dl>
      </div>`;
        })
        .join("")
    : `<div class="empty">No agents yet. Add one to get a key for it.</div>`;
}

document.addEventListener("click", async (e) => {
  const id = e.target.dataset?.toggle;
  if (!id) return;
  await api("PATCH", `/api/agents/${id}`, { active: e.target.dataset.active !== "true" });
  refresh();
});

$("#agent-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { agent, apiKey } = await api("POST", "/api/agents", {
      name: f.get("name"),
      monthlyBudgetCents: toCents(f.get("monthly")),
      perPurchaseCapCents: toCents(f.get("cap")),
      autoApproveUnderCents: toCents(f.get("auto")),
      allowedCategories: list(f.get("categories")),
      blockedMerchants: list(f.get("blocked")),
    });
    const config = {
      mcpServers: {
        "agent-wallet": {
          command: "npx",
          args: ["tsx", "/path/to/agent-wallet/src/mcp.ts"],
          env: { WALLET_URL: location.origin, WALLET_AGENT_KEY: apiKey },
        },
      },
    };
    const box = $("#new-key");
    box.innerHTML = `
      <strong>${esc(agent.name)} is ready.</strong>
      <p>Copy this key now. It won't be shown again.</p>
      <pre>${esc(apiKey)}</pre>
      <p class="muted">To connect Claude, add this to its MCP config:</p>
      <pre>${esc(JSON.stringify(config, null, 2))}</pre>
      <button class="ghost" id="copy-key">Copy key</button>`;
    box.hidden = false;
    $("#copy-key").onclick = () => navigator.clipboard.writeText(apiKey).then(() => toast("Key copied."));
    e.target.reset();
    $("#new-agent").open = false;
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- security ----------

async function renderSecurity() {
  const s = await api("GET", "/api/settings");
  const on = s.passkeyRequiredOverCents !== null;
  $("#security").innerHTML = s.passkeyCount
    ? `<strong>Face ID approvals</strong>
       <p class="muted">Risky purchases always need Face ID or your fingerprint.${on ? ` So does anything over ${usd(s.passkeyRequiredOverCents)}.` : ""}</p>
       <form id="passkey-form" class="row" style="align-items:end">
         <label>Also require it over ($)<input name="over" type="number" min="0" step="0.01" placeholder="Off" value="${on ? (s.passkeyRequiredOverCents / 100).toFixed(2) : ""}"></label>
         <button class="ghost" type="submit" style="margin-bottom:12px">Save</button>
       </form>
       <button class="ghost" id="add-passkey">Add another device</button>`
    : `<strong>Face ID approvals</strong>
       <p class="muted">Make big or risky purchases need Face ID or your fingerprint, so a stolen password alone can't approve them.</p>
       <button class="primary" id="add-passkey">Set up Face ID</button>`;
  $("#add-passkey").onclick = async () => {
    try {
      const optionsJSON = await api("POST", "/api/passkeys/register/options");
      const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON });
      await api("POST", "/api/passkeys/register/verify", response);
      toast("Face ID is set up.");
      renderSecurity();
    } catch (err) {
      toast(err.name === "NotAllowedError" ? "Cancelled." : err.message);
    }
  };
  const form = $("#passkey-form");
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = new FormData(form).get("over");
      await api("PATCH", "/api/settings", { passkeyRequiredOverCents: v === "" ? null : toCents(v) });
      toast("Saved.");
      renderSecurity();
    };
  }
}

// ---------- activity ----------

async function renderActivity() {
  const events = await api("GET", "/api/events");
  $("#event-list").innerHTML = events.length
    ? events.map((ev) => `<li>${esc(ev.message)}<time>${when(ev.createdAt)}</time></li>`).join("")
    : `<li class="empty">Nothing yet.</li>`;
}

// ---------- notifications ----------

function base64ToBytes(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function setupPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const reg = await navigator.serviceWorker.register("/sw.js");
  const existing = await reg.pushManager.getSubscription();
  const btn = $("#push-btn");
  if (existing) {
    await api("POST", "/api/push/subscribe", existing.toJSON());
    return;
  }
  btn.hidden = false;
  btn.onclick = async () => {
    try {
      const { publicKey } = await api("GET", "/api/push/key");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(publicKey) });
      await api("POST", "/api/push/subscribe", sub.toJSON());
      btn.hidden = true;
      toast("Notifications are on.");
    } catch (err) {
      toast(`Couldn't turn on notifications: ${err.message}`);
    }
  };
}

// ---------- live updates ----------

function listen() {
  const es = new EventSource(`/api/stream?token=${encodeURIComponent(token)}`);
  es.addEventListener("wallet", (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === "request_pending") toast(ev.message);
    refresh();
  });
}

async function refresh() {
  const tab = document.querySelector("nav button.active").dataset.tab;
  try {
    if (tab === "approvals") await renderApprovals();
    if (tab === "agents") await Promise.all([renderAgents(), renderSecurity()]);
    if (tab === "activity") await renderActivity();
    if (tab !== "approvals") await renderApprovals(); // keeps the badge current
  } catch (err) {
    if (err.message !== "Signed out") toast(err.message);
  }
}

function start() {
  $("#signin").hidden = true;
  $("#app").hidden = false;
  refresh();
  listen();
  setupPush().catch(() => {});
}

if (token) start();
else signOut();
