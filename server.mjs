import http from "node:http";
import { openDatabase } from "./lib/database.mjs";
import {
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import * as game from "./public/engine.mjs";
const ROOT = dirname(fileURLToPath(import.meta.url));
if (process.env.LOAD_ENV !== "0" && existsSync(resolve(ROOT, ".env")))
  process.loadEnvFile(resolve(ROOT, ".env"));
const PORT = Number(process.env.PORT || 3000),
  HOST = process.env.HOST || "127.0.0.1";
const db = await openDatabase();
const { get, all, run, tx } = db;
const now = () => Date.now(),
  hash = (s) => createHash("sha256").update(s).digest("hex");
function fail(message, status = 400) {
  throw Object.assign(Error(message), {
    status,
  });
}
async function audit(actor, action, target, detail) {
  await run(
    "INSERT INTO audit(actor,action,target,detail,created) VALUES(?,?,?,?,?)",
    actor,
    action,
    target,
    JSON.stringify(detail),
    now(),
  );
}
async function account(id, user = null, kind = "table") {
  await run(
    "INSERT INTO accounts VALUES(?,?,?,0) ON CONFLICT DO NOTHING",
    id,
    user,
    kind,
  );
  return id;
}
async function balance(id) {
  return (
    (await get("SELECT balance FROM accounts WHERE id=?", id))?.balance || 0
  );
}
async function ledger(key, type, actor, reason, deltas) {
  const entries = Object.entries(deltas).filter(([, v]) => v !== 0);
  if (!entries.length) return;
  if (entries.reduce((s, [, v]) => s + v, 0) !== 0)
    throw Error("账本分录不平衡");
  if (await get("SELECT id FROM transactions WHERE business_key=?", key))
    fail("重复资产业务");
  const id = randomUUID();
  await run(
    "INSERT INTO transactions VALUES(?,?,?,?,?,?)",
    id,
    key,
    type,
    actor,
    reason,
    now(),
  );
  for (const [acc, amount] of entries) {
    const a = await get("SELECT * FROM accounts WHERE id=?", acc);
    if (!a) throw Error("账户不存在");
    const next = a.balance + amount;
    if (
      !Number.isSafeInteger(next) ||
      !Number.isSafeInteger(amount) ||
      (a.kind !== "system" && next < 0)
    )
      fail("可用金币不足");
    await run("UPDATE accounts SET balance=? WHERE id=?", next, acc);
    await run(
      "INSERT INTO entries(tx_id,account_id,amount,balance_after) VALUES(?,?,?,?)",
      id,
      acc,
      amount,
      next,
    );
  }
}
const wallet = (id) => "w:" + id,
  table = (r, u) => `t:${r}:${u}`,
  pot = (h) => "p:" + h;
function password(p) {
  if (typeof p !== "string" || p.length < 8 || p.length > 128)
    fail("密码需为 8～128 个字符");
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(p, salt, 64).toString("hex");
}
function matches(p, stored) {
  if (typeof p !== "string" || p.length > 128) return false;
  const [s, h] = stored.split(":");
  return timingSafeEqual(Buffer.from(h, "hex"), scryptSync(p, s, 64));
}
function credentials(b) {
  if (
    typeof b.username !== "string" ||
    !/^[a-zA-Z0-9_]{3,24}$/.test(b.username)
  )
    fail("用户名需为 3～24 位字母、数字或下划线");
  if (
    typeof b.nickname !== "string" ||
    !b.nickname.trim() ||
    b.nickname.trim().length > 16
  )
    fail("昵称需为 1～16 个字符");
}
async function makeUser(b, role) {
  credentials(b);
  const pw = password(b.password),
    id = randomUUID();
  if (
    await get("SELECT id FROM users WHERE username=?", b.username.toLowerCase())
  )
    fail("用户名已被使用");
  await run(
    "INSERT INTO users VALUES(?,?,?,?,?,0,?)",
    id,
    b.username.toLowerCase(),
    b.nickname.trim(),
    pw,
    role,
    now(),
  );
  await account(wallet(id), id, "wallet");
  const initial = Number(
    (await get("SELECT value FROM settings WHERE key='initial'")).value,
  );
  await ledger("initial:" + id, "initial", id, "注册初始金币", {
    system: -initial,
    [wallet(id)]: initial,
  });
  await audit(id, "register", id, {
    role,
  });
  return await get("SELECT * FROM users WHERE id=?", id);
}
async function rooms() {
  return (await all("SELECT state FROM rooms")).map((r) => JSON.parse(r.state));
}
async function save(r) {
  r.updated = now();
  await run(
    "INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
    r.id,
    r.code,
    JSON.stringify(r),
  );
}
async function mine(id) {
  return (await rooms()).find((r) => r.seats.some((s) => s.id === id));
}
async function requireRoom(u) {
  const r = await mine(u.id);
  if (!r) fail("你还没有加入房间");
  return r;
}
async function changeHand(r, next, key, type, actor) {
  const deltas = {};
  for (const p of next.players)
    deltas[table(r.id, p.id)] = p.chips - (await balance(table(r.id, p.id)));
  await account(pot(next.id), null, "pot");
  deltas[pot(next.id)] = next.pot - (await balance(pot(next.id)));
  await ledger(key, type, actor, `房间 ${r.code} · 第 ${r.handNo} 局`, deltas);
  r.game = next;
  r.seats.forEach((s) => {
    const p = next.players.find((p) => p.id === s.id);
    if (p) s.chips = p.chips;
  });
  if (next.status !== "playing") {
    await run(
      "INSERT INTO history VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,created=excluded.created",
      next.id,
      JSON.stringify(next),
      now(),
    );
    r.seats.forEach((s) => (s.ready = false));
    r.countdown = null;
    for (const s of [...r.seats])
      if (
        s.leaving ||
        (await get("SELECT disabled FROM users WHERE id=?", s.id))?.disabled
      )
        await release(r, s.id);
  }
}
async function release(r, id) {
  const a = table(r.id, id),
    amount = await balance(a);
  await ledger("leave:" + randomUUID(), "leave", id, `离开房间 ${r.code}`, {
    [a]: -amount,
    [wallet(id)]: amount,
  });
  r.seats = r.seats.filter((s) => s.id !== id);
  if (r.host === id) r.host = r.seats[0]?.id || null;
  r.countdown = null;
}
async function leaveRoom(r, id) {
  if (r.game?.status === "playing") {
    r.seats.find((s) => s.id === id).leaving = true;
    const next = game.leave(r.game, id);
    await changeHand(r, next, "fold-leave:" + randomUUID(), "game", id);
  } else await release(r, id);
  await save(r);
}
async function voidHand(r, actor, reason) {
  if (r.game?.status !== "playing") return;
  const s = structuredClone(r.game);
  for (const p of s.players) p.chips += p.contribution;
  s.pot = 0;
  s.status = "voided";
  s.actor = null;
  s.deadline = 0;
  s.version++;
  s.logs.push("本局撤销 · 已退回本局全部投入");
  await changeHand(r, s, "void:" + s.id, "void", actor);
  await audit(actor, "void", r.id, {
    reason,
  });
  await save(r);
}
// A single process owns this local database. Unfinished games are refunded on restart.
await tx(async () => {
  for (const r of await rooms()) {
    await voidHand(r, null, "服务重启");
    for (const s of [...r.seats]) await release(r, s.id);
    await run("DELETE FROM rooms WHERE id=?", r.id);
  }
  await run("DELETE FROM sessions WHERE expires<?", now());
});
async function checkBooks() {
  const bad = await all(
    "SELECT a.id,a.balance,COALESCE(SUM(e.amount),0) AS actual FROM accounts a LEFT JOIN entries e ON a.id=e.account_id GROUP BY a.id HAVING a.balance<>COALESCE(SUM(e.amount),0)",
  );
  const unbalanced = await all(
    "SELECT tx_id FROM entries GROUP BY tx_id HAVING SUM(amount)<>0",
  );
  if (bad.length || unbalanced.length) throw Error("资产核对失败，停止启动");
}
await checkBooks();
const streams = new Set(),
  disconnected = new Map(),
  limits = new Map();
function notify() {
  for (const s of streams) s.res.write("event: changed\ndata: {}\n\n");
}
async function invalidateSessions(id) {
  await run("DELETE FROM sessions WHERE user_id=?", id);
  for (const s of [...streams])
    if (s.user === id) {
      s.res.write("event: revoked\ndata: {}\n\n");
      s.res.end();
    }
}
async function login(u, res, req) {
  const token = randomBytes(32).toString("hex");
  await tx(async () => {
    const latest = await get("SELECT * FROM users WHERE id=?", u.id);
    if (!latest || latest.disabled || latest.password !== u.password)
      fail("账号状态已更新，请重新登录", 401);
    await invalidateSessions(u.id);
    await run(
      "INSERT INTO sessions VALUES(?,?,?)",
      hash(token),
      u.id,
      now() + 7 * 86400000,
    );
  });
  res.setHeader(
    "Set-Cookie",
    `zjh_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800${process.env.COOKIE_SECURE === "1" ? "; Secure" : ""}`,
  );
  disconnected.delete(u.id);
}
async function auth(req) {
  const token = (req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("zjh_session="))
    ?.slice(12);
  if (!token) return null;
  return await get(
    "SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token=? AND s.expires>?",
    hash(token),
    now(),
  );
}
async function safeUser(u) {
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname,
    role: u.role,
    balance: await balance(wallet(u.id)),
    disabled: !!u.disabled,
  };
}
function roomView(r, id) {
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    host: r.host,
    handNo: r.handNo,
    countdown: r.countdown,
    seats: r.seats,
    game: game.view(r.game, id),
  };
}
async function state(u) {
  return {
    me: await safeUser(u),
    room: roomView(await mine(u.id), u.id),
    serverTime: now(),
  };
}
function limit(key, max, window = 60000) {
  const old = limits.get(key);
  if (!old || old.start + window < now()) {
    limits.set(key, {
      start: now(),
      count: 1,
    });
    return;
  }
  if (++old.count > max) fail("操作过于频繁，请稍后重试", 429);
}
async function body(req) {
  let buf = "";
  for await (const chunk of req) {
    buf += chunk;
    if (Buffer.byteLength(buf) > 16384) fail("请求过大", 413);
  }
  try {
    return JSON.parse(buf || "{}");
  } catch {
    fail("无效 JSON");
  }
}
function local(req) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket.remoteAddress,
  );
}
function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function admin(u) {
  if (u.role !== "admin") fail("需要管理员权限", 403);
}
async function historyFor(id) {
  return (
    await all(
      "SELECT state,created FROM history ORDER BY created DESC LIMIT 300",
    )
  )
    .map((h) => ({
      s: JSON.parse(h.state),
      created: h.created,
    }))
    .filter((h) => h.s.players.some((p) => p.id === id))
    .slice(0, 50)
    .map((h) => ({
      ...game.view(h.s, id),
      created: h.created,
    }));
}
async function getLedger(id) {
  return await all(
    `SELECT e.amount,e.balance_after,a.kind,t.type,t.reason,t.created FROM entries e JOIN accounts a ON a.id=e.account_id JOIN transactions t ON t.id=e.tx_id WHERE a.user_id=? ORDER BY e.id DESC LIMIT 100`,
    id,
  );
}
async function mutation(path, b, u, req, res) {
  if (path === "/api/logout") {
    await invalidateSessions(u.id);
    res.setHeader(
      "Set-Cookie",
      "zjh_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    );
    return {};
  }
  if (path === "/api/password") {
    if (!matches(b.current, u.password)) fail("当前密码错误");
    await run(
      "UPDATE users SET password=? WHERE id=?",
      password(b.password),
      u.id,
    );
    await invalidateSessions(u.id);
    return {
      signedOut: true,
    };
  }
  if (path === "/api/rooms/create") {
    if (await mine(u.id)) fail("请先退出当前房间");
    let code;
    do {
      code = String(randomInt(100000, 1000000));
    } while (await get("SELECT id FROM rooms WHERE code=?", code));
    const r = {
      id: randomUUID(),
      code,
      host: u.id,
      seats: [],
      game: null,
      handNo: 0,
      countdown: null,
    };
    await join(r, u, b.buyin);
    await save(r);
    return {};
  }
  if (path === "/api/rooms/join") {
    if (await mine(u.id)) fail("你已在房间中");
    const row = await get(
      "SELECT state FROM rooms WHERE code=?",
      String(b.code),
    );
    if (!row) fail("房间不存在");
    const r = JSON.parse(row.state);
    if (r.game?.status === "playing") fail("牌局进行中，请稍后加入");
    if (r.seats.length >= 6) fail("房间已满");
    await join(r, u, b.buyin);
    r.countdown = null;
    await save(r);
    return {};
  }
  if (path === "/api/rooms/leave") {
    const r = await requireRoom(u);
    await leaveRoom(r, u.id);
    return {};
  }
  if (path === "/api/rooms/ready") {
    const r = await requireRoom(u);
    if (r.game?.status === "playing") fail("牌局进行中");
    const s = r.seats.find((s) => s.id === u.id);
    if (s.chips < 200) fail("至少需要 200 桌上金币，请补充");
    s.ready = !s.ready;
    r.countdown =
      r.seats.length >= 2 && r.seats.every((s) => s.ready)
        ? now() + 3000
        : null;
    await save(r);
    return {};
  }
  if (path === "/api/rooms/topup") {
    const r = await requireRoom(u);
    if (r.game?.status === "playing") fail("请在局间补充金币");
    const n = amount(b.amount, 1, 10000),
      s = r.seats.find((s) => s.id === u.id);
    if (s.chips + n > 10000) fail("桌上金币不能超过 10,000");
    await ledger("topup:" + b.requestId, "topup", u.id, "补充桌上金币", {
      [wallet(u.id)]: -n,
      [table(r.id, u.id)]: n,
    });
    s.chips += n;
    s.ready = false;
    r.countdown = null;
    await save(r);
    return {};
  }
  if (path === "/api/game/action") {
    const r = await requireRoom(u),
      s = r.game;
    if (
      !s ||
      s.id !== b.handId ||
      s.version !== b.version ||
      s.turnId !== b.turnId
    )
      fail("牌局状态已更新，请重试", 409);
    if (s.deadline <= now()) fail("本轮操作已超时", 409);
    let next;
    try {
      next = game.act(s, u.id, b.type, b.payload || {});
    } catch (e) {
      fail(e.message);
    }
    await changeHand(
      r,
      next,
      "action:" + u.id + ":" + b.requestId,
      "game",
      u.id,
    );
    await save(r);
    return {};
  }
  if (path.startsWith("/api/admin/")) {
    admin(u);
    if (path === "/api/admin/adjust") {
      const target = await get("SELECT * FROM users WHERE id=?", b.userId);
      if (!target) fail("成员不存在");
      if (target.role === "admin") fail("此版本不允许调整管理员资产");
      const n = amount(b.amount, -100000, 100000);
      if (!n) fail("金额不能为 0");
      if (
        typeof b.reason !== "string" ||
        b.reason.trim().length < 2 ||
        b.reason.length > 200
      )
        fail("请填写 2～200 字的调账原因");
      await ledger(
        "adjust:" + u.id + ":" + b.requestId,
        "adjust",
        u.id,
        b.reason.trim(),
        {
          system: -n,
          [wallet(target.id)]: n,
        },
      );
      await audit(u.id, "adjust", target.id, {
        amount: n,
        reason: b.reason.trim(),
      });
      return {};
    }
    if (path === "/api/admin/status") {
      const target = await get("SELECT * FROM users WHERE id=?", b.userId);
      if (!target || target.role === "admin") fail("只能操作普通成员");
      if (typeof b.disabled !== "boolean") fail("无效状态");
      await run(
        "UPDATE users SET disabled=? WHERE id=?",
        Number(b.disabled),
        target.id,
      );
      if (b.disabled) {
        await invalidateSessions(target.id);
        const r = await mine(target.id);
        if (r) {
          if (r.game?.status === "playing") {
            r.seats.find((s) => s.id === target.id).leaving = true;
            await save(r);
          } else {
            await release(r, target.id);
            await save(r);
          }
        }
      }
      await audit(u.id, "status", target.id, {
        disabled: b.disabled,
      });
      return {};
    }
    if (path === "/api/admin/reset-password") {
      const target = await get("SELECT * FROM users WHERE id=?", b.userId);
      if (!target || target.role === "admin") fail("只能重置普通成员密码");
      await run(
        "UPDATE users SET password=? WHERE id=?",
        password(b.password),
        target.id,
      );
      await invalidateSessions(target.id);
      await audit(u.id, "reset-password", target.id, {});
      return {};
    }
    if (path === "/api/admin/settings") {
      const n = amount(b.initial, 0, 100000);
      await run("UPDATE settings SET value=? WHERE key='initial'", String(n));
      await audit(u.id, "initial-setting", null, {
        initial: n,
      });
      return {};
    }
    if (path === "/api/admin/void") {
      const row = await get("SELECT state FROM rooms WHERE id=?", b.roomId);
      if (!row) fail("房间不存在");
      if (typeof b.reason !== "string" || b.reason.trim().length < 2)
        fail("请填写撤销原因");
      const r = JSON.parse(row.state);
      await voidHand(r, u.id, b.reason.slice(0, 200));
      return {};
    }
  }
  fail("接口不存在", 404);
}
function amount(n, min, max) {
  if (!Number.isSafeInteger(n) || n < min || n > max)
    fail(`请输入 ${min}～${max} 之间的整数`);
  return n;
}
async function join(r, u, n = 2000) {
  n = amount(n, 200, 10000);
  const acc = await account(table(r.id, u.id), u.id);
  await ledger("join:" + randomUUID(), "join", u.id, `进入房间 ${r.code}`, {
    [wallet(u.id)]: -n,
    [acc]: n,
  });
  r.seats.push({
    id: u.id,
    name: u.nickname,
    chips: n,
    ready: false,
    leaving: false,
  });
}
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  try {
    const url = new URL(req.url, "http://localhost"),
      path = url.pathname;
    if (path.startsWith("/api/")) {
      if (req.method === "POST") {
        if (
          req.headers.origin !== `http://${req.headers.host}` &&
          req.headers.origin !== `https://${req.headers.host}`
        )
          fail("请求来源不受信任", 403);
        if (!String(req.headers["content-type"]).startsWith("application/json"))
          fail("请使用 JSON 请求", 415);
        limit(req.socket.remoteAddress + ":write", 400);
      }
      if (path === "/api/bootstrap" && req.method === "GET")
        return json(res, 200, {
          setup: !(await get("SELECT id FROM users LIMIT 1")),
          local: local(req),
        });
      if (path === "/api/setup" && req.method === "POST") {
        if (!local(req)) fail("首次管理员只能在服务器本机创建", 403);
        const b = await body(req);
        const u = await tx(async () => {
          if (await get("SELECT id FROM users LIMIT 1")) fail("系统已经初始化");
          return await makeUser(b, "admin");
        });
        await login(u, res, req);
        return json(res, 200, await state(u));
      }
      if (
        ["/api/login", "/api/register"].includes(path) &&
        req.method === "POST"
      ) {
        limit(req.socket.remoteAddress + ":auth", 20);
        const b = await body(req);
        let u;
        if (!(await get("SELECT id FROM users LIMIT 1")))
          fail("请先在本机初始化管理员");
        if (path === "/api/register")
          u = await tx(async () => await makeUser(b, "member"));
        else {
          u = await get(
            "SELECT * FROM users WHERE username=?",
            String(b.username).toLowerCase(),
          );
          if (!u || !matches(b.password, u.password))
            fail("用户名或密码错误", 401);
        }
        if (u.disabled) fail("账号已被禁用", 403);
        await login(u, res, req);
        notify();
        return json(res, 200, await state(u));
      }
      const u = await auth(req);
      if (!u) fail("请先登录", 401);
      if (u.disabled) fail("账号已被禁用", 403);
      if (path === "/api/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: changed\ndata: {}\n\n");
        const stream = {
          user: u.id,
          res,
        };
        streams.add(stream);
        disconnected.delete(u.id);
        req.on("close", () => {
          streams.delete(stream);
          if (![...streams].some((s) => s.user === u.id))
            disconnected.set(u.id, now());
        });
        return;
      }
      if (req.method === "GET") {
        if (path === "/api/state") return json(res, 200, await state(u));
        if (path === "/api/ledger")
          return json(res, 200, await getLedger(u.id));
        if (path === "/api/history")
          return json(res, 200, await historyFor(u.id));
        if (path === "/api/admin") {
          admin(u);
          return json(res, 200, {
            users: await Promise.all(
              (await all("SELECT * FROM users ORDER BY created DESC")).map(
                safeUser,
              ),
            ),
            rooms: (await rooms())
              .filter((r) => r.seats.length)
              .map((r) => ({
                id: r.id,
                code: r.code,
                count: r.seats.length,
                status: r.game?.status || "waiting",
              })),
            audit: await all(
              "SELECT a.*,u.nickname AS actor_name FROM audit a LEFT JOIN users u ON a.actor=u.id ORDER BY a.id DESC LIMIT 100",
            ),
            initial: Number(
              (await get("SELECT value FROM settings WHERE key='initial'"))
                .value,
            ),
          });
        }
        if (path === "/api/admin/ledger") {
          admin(u);
          return json(
            res,
            200,
            await getLedger(url.searchParams.get("userId")),
          );
        }
        fail("接口不存在", 404);
      }
      if (req.method !== "POST") fail("不支持此方法", 405);
      const b = await body(req);
      const current = await auth(req);
      if (!current || current.disabled) fail("登录会话已失效", 401);
      if (typeof b.requestId !== "string" || !/^[\w-]{8,80}$/.test(b.requestId))
        fail("缺少有效请求编号");
      const signature = JSON.stringify({
        path,
        b,
      });
      const result = await tx(async () => {
        const active = await auth(req);
        if (!active || active.disabled) fail("登录会话已失效", 401);
        const previous = await get(
          "SELECT * FROM commands WHERE user_id=? AND request_id=?",
          u.id,
          b.requestId,
        );
        if (previous) {
          if (previous.payload !== signature)
            fail("请求编号已被其他操作使用", 409);
          return JSON.parse(previous.result);
        }
        const result = await mutation(path, b, u, req, res);
        await run(
          "INSERT INTO commands VALUES(?,?,?,?)",
          u.id,
          b.requestId,
          signature,
          JSON.stringify(result),
        );
        return result;
      });
      notify();
      return json(res, 200, result);
    }
    if (!["GET", "HEAD"].includes(req.method)) fail("不支持此方法", 405);
    const allowed = new Set([
      "/",
      "/index.html",
      "/app.mjs",
      "/engine.mjs",
      "/style.css",
      "/sw.js",
      "/manifest.webmanifest",
      "/icon.svg",
    ]);
    if (!allowed.has(path)) fail("页面不存在", 404);
    const file = resolve(
      ROOT,
      "public",
      path === "/" ? "index.html" : path.slice(1),
    );
    if (!existsSync(file)) fail("文件不存在", 404);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".webmanifest": "application/manifest+json",
    };
    res.writeHead(200, {
      "Content-Type": types[extname(file)],
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent)
      json(res, e.status || 500, {
        error: e.status ? e.message : "服务器处理失败，请稍后重试",
      });
    else res.end();
  }
});
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    let changed = false;
    await tx(async () => {
      for (const r of await rooms()) {
        let dirty = false;
        if (
          r.countdown &&
          r.countdown <= now() &&
          r.seats.length >= 2 &&
          r.seats.every((s) => s.ready)
        ) {
          r.handNo++;
          const s = game.start(r.seats, {
            dealer: (r.handNo - 1) % r.seats.length,
            deck: game.shuffle(randomInt),
          });
          await changeHand(r, s, "start:" + s.id, "ante", null);
          r.countdown = null;
          dirty = true;
        }
        if (r.game?.status === "playing") {
          const actor = r.game.actor,
            disabled = (
              await get("SELECT disabled FROM users WHERE id=?", actor)
            )?.disabled;
          if (r.game.deadline <= now() || disabled) {
            const s = game.act(r.game, actor, "fold");
            await changeHand(
              r,
              s,
              "timeout:" + r.game.id + ":" + r.game.turnId,
              "timeout",
              actor,
            );
            dirty = true;
          }
        }
        for (const s of [...r.seats])
          if (
            disconnected.has(s.id) &&
            disconnected.get(s.id) + 60000 < now() &&
            !s.leaving
          ) {
            await leaveRoom(r, s.id);
            dirty = true;
          }
        if (!r.seats.length) {
          await run("DELETE FROM rooms WHERE id=?", r.id);
          changed = true;
          continue;
        }
        if (r.game?.status !== "playing" && r.updated + 1800000 < now()) {
          for (const s of [...r.seats]) await release(r, s.id);
          await run("DELETE FROM rooms WHERE id=?", r.id);
          changed = true;
          continue;
        }
        if (dirty) {
          await save(r);
          changed = true;
        }
      }
    });
    if (changed) notify();
  } catch (e) {
    console.error("房间调度失败", e);
  } finally {
    ticking = false;
  }
}, 500).unref();
setInterval(() => {
  for (const s of streams) s.res.write(": heartbeat\n\n");
  for (const [k, v] of limits) if (v.start + 60000 < now()) limits.delete(k);
}, 15000).unref();
server.listen(PORT, HOST, () =>
  console.log(
    `炸金花本地服务已启动：http://${HOST}:${PORT}\n数据库：${db.kind}\n首次访问页面可创建管理员。`,
  ),
);
function shutdown() {
  for (const s of streams) s.res.end();
  server.close(async () => {
    await db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
