require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 24) {
  console.error("请先在 .env 中设置至少 24 个字符的 JWT_SECRET。");
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.APP_ORIGIN || true } });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.APP_ORIGIN || true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const fs = require("fs");
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "qlink.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  avatar TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id INTEGER NOT NULL,
  addressee_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT DEFAULT 'member',
  PRIMARY KEY(group_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  recipient_id INTEGER,
  group_id INTEGER,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id);
`);

const onlineUsers = new Map();
const publicUser = (u) => ({ id: u.id, username: u.username, nickname: u.nickname, avatar: u.avatar || "", bio: u.bio || "" });
function sign(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "14d" });
}
function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  try {
    if (!token) throw new Error("missing");
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare("SELECT id, username, nickname, avatar, bio FROM users WHERE id=?").get(decoded.id);
    if (!user) throw new Error("missing user");
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "登录状态已失效，请重新登录。" });
  }
}
function cleanText(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}
function areFriends(a, b) {
  return !!db.prepare(`SELECT 1 FROM friendships
    WHERE status='accepted' AND
    ((requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?))`)
    .get(a, b, b, a);
}

app.post("/api/auth/register", async (req, res) => {
  const username = cleanText(req.body.username, 24).toLowerCase();
  const password = String(req.body.password || "");
  const nickname = cleanText(req.body.nickname, 24) || username;
  if (!/^[a-z0-9_]{4,24}$/.test(username)) return res.status(400).json({ error: "账号需为 4-24 位英文、数字或下划线。" });
  if (password.length < 8 || password.length > 72) return res.status(400).json({ error: "密码长度需要为 8-72 位。" });
  if (db.prepare("SELECT id FROM users WHERE username=?").get(username)) return res.status(409).json({ error: "这个账号已经被注册。" });
  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare("INSERT INTO users(username,password_hash,nickname) VALUES(?,?,?)").run(username, hash, nickname);
  const user = db.prepare("SELECT id,username,nickname,avatar,bio FROM users WHERE id=?").get(result.lastInsertRowid);
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const username = cleanText(req.body.username, 24).toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "账号或密码不正确。" });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get("/api/me", auth, (req, res) => res.json({ user: publicUser(req.user) }));
app.patch("/api/me", auth, (req, res) => {
  const nickname = cleanText(req.body.nickname, 24) || req.user.nickname;
  const bio = cleanText(req.body.bio, 100);
  const avatar = cleanText(req.body.avatar, 500);
  db.prepare("UPDATE users SET nickname=?, bio=?, avatar=? WHERE id=?").run(nickname, bio, avatar, req.user.id);
  const user = db.prepare("SELECT id,username,nickname,avatar,bio FROM users WHERE id=?").get(req.user.id);
  res.json({ user: publicUser(user) });
});

app.get("/api/users/search", auth, (req, res) => {
  const q = cleanText(req.query.q, 30);
  if (q.length < 2) return res.json({ users: [] });
  const users = db.prepare(`SELECT id,username,nickname,avatar,bio FROM users
    WHERE id != ? AND (username LIKE ? OR nickname LIKE ?) LIMIT 20`)
    .all(req.user.id, `%${q}%`, `%${q}%`);
  res.json({ users: users.map(publicUser) });
});

app.get("/api/friends", auth, (req, res) => {
  const rows = db.prepare(`SELECT u.id,u.username,u.nickname,u.avatar,u.bio,f.status,f.requester_id
    FROM friendships f JOIN users u
    ON u.id = CASE WHEN f.requester_id=? THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id=? OR f.addressee_id=?)`)
    .all(req.user.id, req.user.id, req.user.id);
  res.json({ friends: rows.map(r => ({ ...publicUser(r), status: r.status, incoming: r.requester_id !== req.user.id, online: onlineUsers.has(r.id) })) });
});

app.post("/api/friends/request", auth, (req, res) => {
  const targetId = Number(req.body.userId);
  if (!targetId || targetId === req.user.id || !db.prepare("SELECT id FROM users WHERE id=?").get(targetId)) return res.status(400).json({ error: "找不到这个用户。" });
  try {
    db.prepare("INSERT INTO friendships(requester_id,addressee_id,status) VALUES(?,?,'pending')").run(req.user.id, targetId);
  } catch {
    const existing = db.prepare("SELECT status FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)").get(req.user.id,targetId,targetId,req.user.id);
    return res.status(409).json({ error: existing?.status === "accepted" ? "你们已经是好友了。" : "好友申请已存在。" });
  }
  io.to(`user:${targetId}`).emit("friend:request", { from: publicUser(req.user) });
  res.json({ ok: true });
});

app.post("/api/friends/accept", auth, (req, res) => {
  const requesterId = Number(req.body.userId);
  const result = db.prepare("UPDATE friendships SET status='accepted' WHERE requester_id=? AND addressee_id=? AND status='pending'").run(requesterId, req.user.id);
  if (!result.changes) return res.status(404).json({ error: "没有找到待处理的好友申请。" });
  io.to(`user:${requesterId}`).emit("friend:accepted", { user: publicUser(req.user) });
  res.json({ ok: true });
});

app.delete("/api/friends/:id", auth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("DELETE FROM friendships WHERE (requester_id=? AND addressee_id=?) OR (requester_id=? AND addressee_id=?)").run(req.user.id,id,id,req.user.id);
  res.json({ ok: true });
});

app.get("/api/messages/:userId", auth, (req, res) => {
  const other = Number(req.params.userId);
  if (!areFriends(req.user.id, other)) return res.status(403).json({ error: "只有好友之间可以聊天。" });
  const messages = db.prepare(`SELECT m.id,m.sender_id,m.recipient_id,m.body,m.created_at,u.nickname,u.avatar
    FROM messages m JOIN users u ON u.id=m.sender_id
    WHERE m.group_id IS NULL AND
    ((m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?))
    ORDER BY m.id DESC LIMIT 100`).all(req.user.id,other,other,req.user.id).reverse();
  res.json({ messages });
});

app.post("/api/messages", auth, (req, res) => {
  const recipientId = Number(req.body.recipientId);
  const body = cleanText(req.body.body, 4000);
  if (!body) return res.status(400).json({ error: "消息不能为空。" });
  if (!areFriends(req.user.id, recipientId)) return res.status(403).json({ error: "只有好友之间可以聊天。" });
  const result = db.prepare("INSERT INTO messages(sender_id,recipient_id,body) VALUES(?,?,?)").run(req.user.id,recipientId,body);
  const message = db.prepare(`SELECT m.id,m.sender_id,m.recipient_id,m.body,m.created_at,u.nickname,u.avatar
    FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?`).get(result.lastInsertRowid);
  io.to(`user:${recipientId}`).emit("message:new", message);
  res.json({ message });
});

app.get("/api/groups", auth, (req, res) => {
  const groups = db.prepare(`SELECT g.id,g.name,g.owner_id,
    (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id=g.id) AS member_count
    FROM groups g JOIN group_members mine ON mine.group_id=g.id
    WHERE mine.user_id=? ORDER BY g.id DESC`).all(req.user.id);
  res.json({ groups });
});

app.post("/api/groups", auth, (req, res) => {
  const name = cleanText(req.body.name, 40);
  if (!name) return res.status(400).json({ error: "请填写群名称。" });
  const result = db.prepare("INSERT INTO groups(name,owner_id) VALUES(?,?)").run(name, req.user.id);
  db.prepare("INSERT INTO group_members(group_id,user_id,role) VALUES(?,?,'owner')").run(result.lastInsertRowid, req.user.id);
  res.json({ group: { id: result.lastInsertRowid, name, owner_id: req.user.id, member_count: 1 } });
});

app.post("/api/groups/:id/join", auth, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare("SELECT id FROM groups WHERE id=?").get(id)) return res.status(404).json({ error: "群聊不存在。" });
  db.prepare("INSERT OR IGNORE INTO group_members(group_id,user_id) VALUES(?,?)").run(id, req.user.id);
  res.json({ ok: true });
});

app.get("/api/groups/:id/messages", auth, (req, res) => {
  const id = Number(req.params.id);
  const member = db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(id,req.user.id);
  if (!member) return res.status(403).json({ error: "你不是这个群的成员。" });
  const messages = db.prepare(`SELECT m.id,m.sender_id,m.group_id,m.body,m.created_at,u.nickname,u.avatar
    FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.group_id=? ORDER BY m.id DESC LIMIT 100`).all(id).reverse();
  res.json({ messages });
});

app.post("/api/groups/:id/messages", auth, (req, res) => {
  const id = Number(req.params.id);
  const body = cleanText(req.body.body, 4000);
  if (!body) return res.status(400).json({ error: "消息不能为空。" });
  const member = db.prepare("SELECT 1 FROM group_members WHERE group_id=? AND user_id=?").get(id,req.user.id);
  if (!member) return res.status(403).json({ error: "你不是这个群的成员。" });
  const result = db.prepare("INSERT INTO messages(sender_id,group_id,body) VALUES(?,?,?)").run(req.user.id,id,body);
  const message = db.prepare(`SELECT m.id,m.sender_id,m.group_id,m.body,m.created_at,u.nickname,u.avatar
    FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?`).get(result.lastInsertRowid);
  const members = db.prepare("SELECT user_id FROM group_members WHERE group_id=?").all(id);
  for (const member of members) io.to(`user:${member.user_id}`).emit("group:message", message);
  res.json({ message });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare("SELECT id,username,nickname,avatar,bio FROM users WHERE id=?").get(decoded.id);
    if (!user) return next(new Error("unauthorized"));
    socket.user = user;
    next();
  } catch { next(new Error("unauthorized")); }
});
io.on("connection", socket => {
  const id = socket.user.id;
  socket.join(`user:${id}`);
  onlineUsers.set(id, socket.id);
  io.emit("presence:update", { userId: id, online: true });
  socket.on("disconnect", () => {
    if (onlineUsers.get(id) === socket.id) {
      onlineUsers.delete(id);
      io.emit("presence:update", { userId: id, online: false });
    }
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
server.listen(PORT, () => console.log(`Q-Link 已启动：http://localhost:${PORT}`));
