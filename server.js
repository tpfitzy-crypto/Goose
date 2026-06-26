import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchPregameOdds } from "./odds-provider.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = join(__dirname, "data");
const DB_FILE = join(DATA_DIR, "db.json");
const PUBLIC_DIR = join(__dirname, "public");
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";
const PORT = Number(process.env.PORT || 3000);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

async function ensureDb() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DB_FILE)) {
    const adminPassword = hashPassword("admin123");
    await writeFile(DB_FILE, JSON.stringify({
      users: [
        { id: "u_admin", name: "Admin", email: "admin@example.com", passwordHash: adminPassword, role: "admin", createdAt: new Date().toISOString() }
      ],
      events: sampleEvents(),
      picks: []
    }, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  if (!db.events.some((event) => event.week === weekKey())) {
    db.events.push(...sampleEvents());
    await writeDb(db);
  }
  return db;
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const attempted = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === attempted.length && timingSafeEqual(expected, attempted);
}

function sign(value) {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
}

function makeSession(user) {
  const payload = Buffer.from(JSON.stringify({ userId: user.id, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function parseSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  const [payload, signature] = match[1].split(".");
  if (!payload || !signature || sign(payload) !== signature) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

async function currentUser(req) {
  const session = parseSession(req);
  if (!session) return null;
  const db = await readDb();
  const user = db.users.find((item) => item.id === session.userId);
  return user ? publicUser(user) : null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

async function readJson(req) {
