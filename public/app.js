const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (d) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

let token = localStorage.getItem("token");
let user = JSON.parse(localStorage.getItem("user") || "null");
let events = [], myRegs = [], adminData = {}, currentTab = "regs", signup = false, regEvent = null;

async function api(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(true); }
  if (!res.ok) throw new Error(data.message || "Something went wrong.");
  return data;
}

function toast(msg, err) {
  const t = $("toast");
  t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
  setTimeout(() => (t.className = "toast"), 3200);
}

function go(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(view).classList.add("active");
  window.scrollTo(0, 0);
  if (view === "mine") loadMine();
  if (view === "dash") loadDash();
  if (view === "home") renderEvents();
}

function renderNav() {
  const n = $("navLinks"), h = $("heroBtns");
  if (!user) {
    n.innerHTML = `<a href="#" onclick="go('home');return false">Events</a>
      <a href="#contact">Contact</a>
      <button class="pill" onclick="openStudent(false)">Student Login</button>
      <button class="pill adm" onclick="go('admin')">Admin Login</button>`;
    h.innerHTML = `<button class="btn" onclick="openStudent(true)">Create Student Account</button>`;
  } else if (user.role === "admin") {
    n.innerHTML = `<span class="who">🛡️ ${esc(user.email)}</span>
      <button onclick="go('dash')">Dashboard</button><button onclick="logout()">Logout</button>`;
    h.innerHTML = `<button class="btn alt" onclick="go('dash')">Open Dashboard</button>`;
  } else {
    n.innerHTML = `<span class="who">👋 ${esc(user.name)}</span>
      <button onclick="go('home')">Events</button><button onclick="go('mine')">My Registrations</button>
      <button onclick="logout()">Logout</button>`;
    h.innerHTML = "";
  }
}

function openStudent(isSignup) { signup = !isSignup; toggleSignup(); go("student"); }
function toggleSignup() {
  signup = !signup;
  $("stName").style.display = signup ? "block" : "none";
  $("stName").required = signup;
  $("stTitle").textContent = signup ? "Create Student Account" : "Student Login";
  $("stBtn").textContent = signup ? "Sign Up" : "Login";
  $("stToggle").textContent = signup ? "Already have an account? Login" : "New student? Create account";
}

async function studentAuth(e) {
  e.preventDefault();
  try {
    const body = { email: $("stEmail").value, password: $("stPass").value };
    if (signup) body.name = $("stName").value;
    const d = await api(signup ? "/api/auth/signup" : "/api/auth/login", "POST", body);
    setSession(d); toast("Welcome, " + d.user.name + "!"); go("home");
  } catch (err) { toast(err.message, true); }
}

async function adminLogin(e) {
  e.preventDefault();
  try {
    const d = await api("/api/admin/login", "POST", { email: $("adEmail").value, password: $("adPass").value });
    setSession(d); toast("Admin logged in"); go("dash");
  } catch (err) { toast(err.message, true); }
}

function setSession(d) {
  token = d.token; user = d.user;
  localStorage.setItem("token", token); localStorage.setItem("user", JSON.stringify(user));
  renderNav();
}
function logout(silent) {
  token = null; user = null; myRegs = [];
  localStorage.removeItem("token"); localStorage.removeItem("user");
  renderNav(); go("home");
  if (!silent) toast("Logged out");
}

/* ---- events ---- */
async function loadEvents() {
  events = await api("/api/events");
  if (user && user.role === "student") myRegs = await api("/api/my-registrations").catch(() => []);
  renderEvents();
}
function renderEvents() {
  const ids = new Set(myRegs.map((r) => r.event_id));
  $("eventGrid").innerHTML = events.map((ev) => `
    <div class="card ev">
      <span class="tag">${esc(ev.category)}</span>
      <h3>${esc(ev.title)}</h3>
      <p>${esc(ev.description)}</p>
      <div class="meta">📅 ${esc(ev.event_date)} &nbsp;•&nbsp; 📍 ${esc(ev.venue)}</div>
      ${user && user.role === "admin" ? "" :
        ids.has(ev.id) ? `<button class="btn done">✓ Registered</button>`
        : `<button class="btn" onclick="startReg(${ev.id})">Register</button>`}
    </div>`).join("");
}

function startReg(id) {
  if (!user) { toast("Please log in with your college email first.", true); return openStudent(false); }
  regEvent = events.find((e) => e.id === id);
  $("mTitle").textContent = "Register: " + regEvent.title;
  $("mWho").textContent = `${user.name} (${user.email})`;
  $("modal").classList.add("open");
}
function closeModal() { $("modal").classList.remove("open"); }
async function submitReg(e) {
  e.preventDefault();
  try {
    await api("/api/register", "POST", { eventId: regEvent.id, phone: $("mPhone").value, department: $("mDept").value });
    closeModal(); toast("Registered for " + regEvent.title + " 🎉");
    e.target.reset(); await loadEvents();
  } catch (err) { toast(err.message, true); }
}

async function loadMine() {
  try {
    myRegs = await api("/api/my-registrations");
    $("mineList").innerHTML = myRegs.length ? `<table><tr><th>Event</th><th>Date</th><th>Venue</th><th>Registered</th><th></th></tr>` +
      myRegs.map((r) => `<tr><td>${esc(r.title)}</td><td>${esc(r.event_date)}</td><td>${esc(r.venue)}</td><td>${fmt(r.registered_at)}</td>
      <td><button class="btn small danger" onclick="cancelReg(${r.event_id})">Cancel</button></td></tr>`).join("") + `</table>`
      : `<div class="empty">You haven't registered for any event yet.</div>`;
  } catch (err) { toast(err.message, true); }
}
async function cancelReg(id) {
  if (!confirm("Cancel this registration?")) return;
  try { await api("/api/register/" + id, "DELETE"); toast("Registration cancelled"); loadMine(); } catch (err) { toast(err.message, true); }
}

async function sendContact(e) {
  e.preventDefault();
  try {
    const d = await api("/api/contact", "POST", { name: $("cName").value, email: $("cEmail").value, message: $("cMsg").value });
    toast(d.message); e.target.reset();
  } catch (err) { toast(err.message, true); }
}

/* ---- admin dashboard ---- */
async function loadDash() {
  if (!user || user.role !== "admin") return go("admin");
  try {
    const [stats, regs, studs, msgs] = await Promise.all([
      api("/api/admin/stats"), api("/api/admin/registrations"), api("/api/admin/students"), api("/api/admin/messages"),
    ]);
    adminData = { regs, studs, msgs };
    $("stats").innerHTML = [["students", "Students signed up"], ["registrations", "Total registrations"], ["events", "Events"], ["messages", "Messages"]]
      .map(([k, l]) => `<div class="stat"><b>${stats[k]}</b><span>${l}</span></div>`).join("");
    const max = Math.max(1, ...stats.perEvent.map((p) => p.total));
    $("bars").innerHTML = stats.perEvent.map((p) => `<div class="bar-row"><span>${esc(p.title)}</span>
      <div class="bar"><i style="width:${(p.total / max) * 100}%"></i></div><b>${p.total}</b></div>`).join("");
    renderTab();
  } catch (err) { toast(err.message, true); }
}
function tab(t) {
  currentTab = t;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.t === t));
  $("search").style.display = t === "msgs" ? "none" : "block";
  renderTab();
}
function renderTab() {
  const q = $("search").value.toLowerCase();
  const filter = (rows) => rows.filter((r) => Object.values(r).join(" ").toLowerCase().includes(q));
  let html = "";
  if (currentTab === "regs") {
    const rows = filter(adminData.regs || []);
    html = rows.length ? `<table><tr><th>#</th><th>Student</th><th>Email</th><th>Phone</th><th>Department</th><th>Event</th><th>Registered</th></tr>` +
      rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.student_name)}</td><td>${esc(r.email)}</td><td>${esc(r.phone)}</td><td>${esc(r.department)}</td><td>${esc(r.event_name)}</td><td>${fmt(r.registered_at)}</td></tr>`).join("") + `</table>`
      : `<div class="empty">No registrations found.</div>`;
  } else if (currentTab === "studs") {
    const rows = filter(adminData.studs || []);
    html = rows.length ? `<table><tr><th>#</th><th>Name</th><th>Email</th><th>Events registered</th><th>Joined</th></tr>` +
      rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${r.events_registered}</td><td>${fmt(r.created_at)}</td></tr>`).join("") + `</table>`
      : `<div class="empty">No students found.</div>`;
  } else {
    const rows = adminData.msgs || [];
    html = rows.length ? `<table><tr><th>Name</th><th>Email</th><th>Message</th><th>Date</th></tr>` +
      rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td class="wrap">${esc(r.message)}</td><td>${fmt(r.created_at)}</td></tr>`).join("") + `</table>`
      : `<div class="empty">No messages yet.</div>`;
  }
  $("tabBody").innerHTML = html;
}
async function downloadCsv() {
  try {
    const res = await fetch("/api/admin/registrations.csv", { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) throw new Error("Download failed.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob()); a.download = "registrations.csv"; a.click();
  } catch (err) { toast(err.message, true); }
}

/* ---- start ---- */
renderNav();
loadEvents().then(() => go(user && user.role === "admin" ? "dash" : "home"));
