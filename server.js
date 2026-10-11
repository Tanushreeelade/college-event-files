require("dotenv").config();
const express = require("express");
const mysql = require("mysql2/promise");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DB_NAME = process.env.DB_NAME || "college_events";
const KEYWORD = (process.env.STUDENT_EMAIL_KEYWORD || "viva").toLowerCase();
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@viva.edu").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@123";
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("JWT_SECRET missing in .env - using a temporary one (logins reset on restart).");
}
let pool;

const dbConfig = () => ({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  // Hosted databases (Aiven, Railway, etc.) usually need SSL: set DB_SSL=true
  ...(process.env.DB_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {}),
});

const SEED_EVENTS = [
  ["Tech Fest Hackathon", "24-hour coding marathon. Build, break and ship with your team.", "2026-11-14", "Main Auditorium", "Technical"],
  ["Cultural Night", "Dance, music and drama performances by students.", "2026-11-20", "Open Air Theatre", "Cultural"],
  ["Inter-Department Sports Meet", "Cricket, football, kabaddi and track events.", "2026-11-25", "College Ground", "Sports"],
  ["Coding Contest", "Solve algorithmic problems and win prizes.", "2026-12-02", "Computer Lab 2", "Technical"],
  ["Robotics Workshop", "Hands-on session on building line-follower robots.", "2026-12-08", "Electronics Lab", "Workshop"],
  ["Art & Photography Exhibition", "Showcase your paintings, sketches and photographs.", "2026-12-15", "Seminar Hall", "Cultural"],
];

async function initDatabase() {
  // On hosted databases the database already exists and CREATE DATABASE may be blocked
  try {
    const conn = await mysql.createConnection(dbConfig());
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\``);
    await conn.end();
  } catch (e) {
    if (process.env.DB_SSL !== "true") throw e;
    console.warn("Skipping CREATE DATABASE:", e.message);
  }

  pool = mysql.createPool({ ...dbConfig(), database: DB_NAME, waitForConnections: true, connectionLimit: 10 });

  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('student','admin') NOT NULL DEFAULT 'student',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(120) NOT NULL,
    description VARCHAR(300) NOT NULL,
    event_date VARCHAR(40) NOT NULL,
    venue VARCHAR(100) NOT NULL,
    category VARCHAR(40) NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS event_registrations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    event_id INT NOT NULL,
    phone VARCHAR(20) NOT NULL,
    department VARCHAR(100) NOT NULL,
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_registration (user_id, event_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS contact_messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM events");
  if (c === 0) {
    await pool.query("INSERT INTO events (title, description, event_date, venue, category) VALUES ?", [SEED_EVENTS]);
  }

  // Create / refresh the admin account from .env
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await pool.query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ('Administrator', ?, ?, 'admin')
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'admin'`,
    [ADMIN_EMAIL, hash]
  );
  console.log("Database ready. Admin login:", ADMIN_EMAIL);
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const studentEmailOk = (e) => emailOk(e) && e.toLowerCase().includes(KEYWORD);
const sign = (u) => jwt.sign({ id: u.id, name: u.name, email: u.email, role: u.role }, SECRET, { expiresIn: "8h" });

const auth = (role) => (req, res, next) => {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return res.status(401).json({ message: "Please log in first." });
  try {
    const p = jwt.verify(h.slice(7), SECRET);
    if (role && p.role !== role) return res.status(403).json({ message: "Access denied." });
    req.user = p;
    next();
  } catch {
    res.status(401).json({ message: "Session expired. Please log in again." });
  }
};

/* ---------- simple login rate limit (10 tries / 15 min per IP) ---------- */
const attempts = new Map();
const limiter = (req, res, next) => {
  const now = Date.now(), ip = req.ip;
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (list.length >= 10) return res.status(429).json({ message: "Too many attempts. Try again in 15 minutes." });
  list.push(now); attempts.set(ip, list);
  next();
};
app.set("trust proxy", 1);
app.use(["/api/auth/login", "/api/admin/login"], limiter);

/* ---------- AUTH ---------- */
app.post("/api/auth/signup", async (req, res) => {
  const name = (req.body.name || "").trim();
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  if (!name || !email || !password) return res.status(400).json({ message: "All fields are required." });
  if (!studentEmailOk(email))
    return res.status(400).json({ message: `Only college emails containing "${KEYWORD}" are allowed.` });
  if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [r] = await pool.execute("INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?, 'student')", [name, email, hash]);
    const user = { id: r.insertId, name, email, role: "student" };
    res.status(201).json({ token: sign(user), user });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "This email is already registered. Please log in." });
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  if (!studentEmailOk(email))
    return res.status(403).json({ message: `Only college emails containing "${KEYWORD}" can log in.` });
  try {
    const [rows] = await pool.execute("SELECT * FROM users WHERE email = ? AND role = 'student'", [email]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
      return res.status(401).json({ message: "Wrong email or password." });
    const u = rows[0];
    res.json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.post("/api/admin/login", async (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password || "";
  try {
    const [rows] = await pool.execute("SELECT * FROM users WHERE email = ? AND role = 'admin'", [email]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash)))
      return res.status(401).json({ message: "Wrong admin email or password." });
    const u = rows[0];
    res.json({ token: sign(u), user: { id: u.id, name: u.name, email: u.email, role: u.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

/* ---------- EVENTS & STUDENT ---------- */
app.get("/api/events", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM events ORDER BY event_date");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.get("/api/my-registrations", auth("student"), async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT r.id, r.event_id, e.title, e.event_date, e.venue, r.registered_at
       FROM event_registrations r JOIN events e ON e.id = r.event_id
       WHERE r.user_id = ? ORDER BY r.registered_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.post("/api/register", auth("student"), async (req, res) => {
  const { eventId, phone, department } = req.body;
  if (!eventId || !phone || !department) return res.status(400).json({ message: "All fields are required." });
  if (!/^[0-9+\-\s]{7,15}$/.test(phone)) return res.status(400).json({ message: "Enter a valid phone number." });
  try {
    await pool.execute("INSERT INTO event_registrations (user_id, event_id, phone, department) VALUES (?,?,?,?)",
      [req.user.id, eventId, phone.trim(), department.trim()]);
    res.status(201).json({ message: "Registration successful!" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "You are already registered for this event." });
    if (err.code === "ER_NO_REFERENCED_ROW_2") return res.status(404).json({ message: "Event not found." });
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.delete("/api/register/:eventId", auth("student"), async (req, res) => {
  try {
    await pool.execute("DELETE FROM event_registrations WHERE user_id = ? AND event_id = ?", [req.user.id, req.params.eventId]);
    res.json({ message: "Registration cancelled." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.post("/api/contact", async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ message: "All fields are required." });
  if (!emailOk(email)) return res.status(400).json({ message: "Invalid email address." });
  try {
    await pool.execute("INSERT INTO contact_messages (name, email, message) VALUES (?,?,?)", [name, email, message]);
    res.status(201).json({ message: "Thank you! Your message has been received." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

/* ---------- ADMIN ---------- */
app.get("/api/admin/stats", auth("admin"), async (req, res) => {
  try {
    const [[s]] = await pool.query("SELECT COUNT(*) AS students FROM users WHERE role='student'");
    const [[r]] = await pool.query("SELECT COUNT(*) AS registrations FROM event_registrations");
    const [[m]] = await pool.query("SELECT COUNT(*) AS messages FROM contact_messages");
    const [perEvent] = await pool.query(
      `SELECT e.id, e.title, COUNT(r.id) AS total FROM events e
       LEFT JOIN event_registrations r ON r.event_id = e.id GROUP BY e.id ORDER BY total DESC, e.title`);
    res.json({ students: s.students, registrations: r.registrations, messages: m.messages, events: perEvent.length, perEvent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

const REG_SQL = `SELECT r.id, u.name AS student_name, u.email, r.phone, r.department,
  e.title AS event_name, r.registered_at
  FROM event_registrations r JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id
  ORDER BY r.registered_at DESC`;

app.get("/api/admin/registrations", auth("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query(REG_SQL);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.get("/api/admin/registrations.csv", auth("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query(REG_SQL);
    const q = (v) => `"${String(v instanceof Date ? v.toISOString() : v ?? "").replace(/"/g, '""')}"`;
    const head = "ID,Student,Email,Phone,Department,Event,Registered At";
    const lines = rows.map((r) => [r.id, r.student_name, r.email, r.phone, r.department, r.event_name, r.registered_at].map(q).join(","));
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=registrations.csv");
    res.send([head, ...lines].join("\n"));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.get("/api/admin/students", auth("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.created_at, COUNT(r.id) AS events_registered
       FROM users u LEFT JOIN event_registrations r ON r.user_id = u.id
       WHERE u.role='student' GROUP BY u.id ORDER BY u.created_at DESC`);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

app.get("/api/admin/messages", auth("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM contact_messages ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error." });
  }
});

const PORT = process.env.PORT || 3000;
initDatabase()
  .then(() => app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`)))
  .catch((err) => {
    console.error("Could not connect to MySQL. Check your .env password and that MySQL is running.");
    console.error(err.message);
    process.exit(1);
  });
