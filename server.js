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
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function requireUser(user, res) {
  if (user) return true;
  json(res, 401, { error: "Login required" });
  return false;
}

function requireAdmin(user, res) {
  if (user?.role === "admin") return true;
  json(res, 403, { error: "Admin access required" });
  return false;
}

function weekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function settlePick(pick, event) {
  if (event.status !== "final" || pick.result !== "pending") return pick;
  const selectedWon = event.winner === pick.selection;
  const stake = Number(pick.stake);
  return { ...pick, result: selectedWon ? "win" : "loss", points: selectedWon ? stake : -stake };
}

function applySettlements(db) {
  db.picks = db.picks.map((pick) => {
    const event = db.events.find((item) => item.id === pick.eventId);
    return event ? settlePick(pick, event) : pick;
  });
}

function leaderboard(db, week = weekKey()) {
  applySettlements(db);
  return db.users
    .filter((user) => user.role !== "admin")
    .map((user) => {
      const picks = db.picks.filter((pick) => pick.userId === user.id && pick.week === week);
      return {
        userId: user.id,
        name: user.name,
        points: picks.reduce((sum, pick) => sum + Number(pick.points || 0), 0),
        wins: picks.filter((pick) => pick.result === "win").length,
        losses: picks.filter((pick) => pick.result === "loss").length,
        pending: picks.filter((pick) => pick.result === "pending").length
      };
    })
    .sort((a, b) => b.points - a.points);
}

async function handleApi(req, res, path) {
  const user = await currentUser(req);
  const db = await readDb();

  if (path === "/api/session" && req.method === "GET") return json(res, 200, { user });

  if (path === "/api/register" && req.method === "POST") {
    const body = await readJson(req);
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    if (!email || !name || String(body.password || "").length < 8) return json(res, 400, { error: "Name, email, and an 8+ character password are required" });
    if (db.users.some((item) => item.email === email)) return json(res, 409, { error: "Email already registered" });
    const created = { id: `u_${randomBytes(8).toString("hex")}`, name, email, passwordHash: hashPassword(body.password), role: "user", createdAt: new Date().toISOString() };
    db.users.push(created);
    await writeDb(db);
    return json(res, 201, { user: publicUser(created) }, { "set-cookie": `session=${makeSession(created)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` });
  }

  if (path === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const found = db.users.find((item) => item.email === String(body.email || "").trim().toLowerCase());
    if (!found || !verifyPassword(String(body.password || ""), found.passwordHash)) return json(res, 401, { error: "Invalid email or password" });
    return json(res, 200, { user: publicUser(found) }, { "set-cookie": `session=${makeSession(found)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` });
  }

  if (path === "/api/logout" && req.method === "POST") {
    return json(res, 200, { ok: true }, { "set-cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

  if (!requireUser(user, res)) return;

  if (path === "/api/events" && req.method === "GET") {
    return json(res, 200, { events: db.events.filter((event) => event.week === weekKey()).sort((a, b) => a.startsAt.localeCompare(b.startsAt)) });
  }

  if (path === "/api/picks" && req.method === "GET") {
    applySettlements(db);
    await writeDb(db);
    return json(res, 200, { picks: db.picks.filter((pick) => pick.userId === user.id && pick.week === weekKey()) });
  }

  if (path === "/api/picks" && req.method === "POST") {
    const body = await readJson(req);
    const event = db.events.find((item) => item.id === body.eventId);
    const stake = Number(body.stake);
    if (!event || event.status !== "open") return json(res, 400, { error: "This event is not open for picks" });
    const validSelections = event.drawOdds ? [event.awayTeam, event.homeTeam, "Draw"] : [event.awayTeam, event.homeTeam];
    if (!validSelections.includes(body.selection)) return json(res, 400, { error: "Selection must be one of the listed outcomes" });
    if (!Number.isInteger(stake) || stake < 1 || stake > 10) return json(res, 400, { error: "Stake must be a whole number from 1 to 10" });
    if (new Date(event.startsAt).getTime() <= Date.now()) return json(res, 400, { error: "Picks are closed for this event" });
    const existing = db.picks.find((pick) => pick.userId === user.id && pick.eventId === event.id);
    if (existing) return json(res, 409, { error: "You already made a pick for this event" });
    const pick = { id: `p_${randomBytes(8).toString("hex")}`, userId: user.id, eventId: event.id, week: event.week, sport: event.sport, selection: body.selection, stake, result: "pending", points: 0, placedAt: new Date().toISOString() };
    db.picks.push(pick);
    await writeDb(db);
    return json(res, 201, { pick });
  }

  if (path === "/api/leaderboard" && req.method === "GET") {
    return json(res, 200, { week: weekKey(), leaderboard: leaderboard(db) });
  }

  if (path === "/api/admin/summary" && req.method === "GET") {
    if (!requireAdmin(user, res)) return;
    return json(res, 200, { week: weekKey(), leaderboard: leaderboard(db), picks: db.picks, users: db.users.map(publicUser), events: db.events });
  }

  if (path === "/api/admin/events" && req.method === "POST") {
    if (!requireAdmin(user, res)) return;
    const body = await readJson(req);
    const event = db.events.find((item) => item.id === body.eventId);
    if (!event) return json(res, 404, { error: "Event not found" });
    const validWinners = event.drawOdds ? [event.awayTeam, event.homeTeam, "Draw"] : [event.awayTeam, event.homeTeam];
    if (!validWinners.includes(body.winner)) return json(res, 400, { error: "Winner must match a listed outcome" });
    event.status = "final";
    event.winner = body.winner;
    applySettlements(db);
    await writeDb(db);
    return json(res, 200, { event });
  }

  if (path === "/api/admin/sync-odds" && req.method === "POST") {
    if (!requireAdmin(user, res)) return;
    const incoming = await fetchPregameOdds({ apiKey: process.env.ODDS_API_KEY });
    const currentWeek = weekKey();
    for (const event of incoming) {
      event.week = currentWeek;
      const existing = db.events.find((item) => item.id === event.id);
      if (existing) Object.assign(existing, event, { status: existing.status, winner: existing.winner });
      else db.events.push(event);
    }
    await writeDb(db);
    return json(res, 200, { imported: incoming.length });
  }

  json(res, 404, { error: "Not found" });
}

async function serveStatic(req, res, path) {
  const requested = path === "/" ? "/index.html" : path;
  const file = resolve(PUBLIC_DIR, `.${requested}`);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": contentTypes[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function sampleEvents() {
  const week = weekKey();
  const today = new Date();
  const plus = (days, hour) => {
    const d = new Date(today);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  return [
    { id: "e_mlb_1", week, sport: "baseball", league: "MLB", awayTeam: "Boston", homeTeam: "New York", startsAt: plus(1, 19), market: "moneyline", awayOdds: "+115", homeOdds: "-135", status: "open", source: "sample" },
    { id: "e_mlb_2", week, sport: "baseball", league: "MLB", awayTeam: "Seattle", homeTeam: "Houston", startsAt: plus(2, 20), market: "moneyline", awayOdds: "-105", homeOdds: "-115", status: "open", source: "sample" },
    { id: "e_soc_1", week, sport: "soccer", league: "MLS", awayTeam: "Atlanta", homeTeam: "Miami", startsAt: plus(3, 18), market: "moneyline", awayOdds: "+210", homeOdds: "+125", drawOdds: "+235", status: "open", source: "sample" },
    { id: "e_soc_2", week, sport: "soccer", league: "EPL", awayTeam: "Arsenal", homeTeam: "Chelsea", startsAt: plus(4, 12), market: "moneyline", awayOdds: "+145", homeOdds: "+180", drawOdds: "+220", status: "open", source: "sample" }
  ];
}

await ensureDb();

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    return await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: "Server error" });
  }
}).listen(PORT, () => {
  console.log(`Weekly Lines running at http://localhost:${PORT}`);
  console.log("Seed admin: admin@example.com / admin123");
});
