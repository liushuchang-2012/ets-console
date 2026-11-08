#!/usr/bin/env node
/**
 * ETS 控制台 —— 本地 Web UI（零依赖）
 * 用法: node webui/server.js [--open] [--port 5173]
 * 原理: 每个 API 请求 spawn 一次 ../ets.js <cmd> --json，把结果转成 JSON 给前端。
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WEBUI = __dirname;
const ROOT = path.resolve(__dirname, "..");
const ETS = [path.join(ROOT, "src", "ets.js"), path.join(ROOT, "ets.js")]
  .find((p) => { try { fs.accessSync(p); return true; } catch (e) { return false; } }) || path.join(ROOT, "ets.js");
const PORT = Number(process.env.PORT || 5173);
const MOCK = process.env.ETS_MOCK === "1";   // 仅供 UI 调试：不连 ETS，返回示例数据

/* ----------------------------- 演示数据 ----------------------------- */
function mockRow(id, name, rid, complete, point, use, status, over) {
  return { id, name, resource_id: String(rid), set_id: "844881", complete, point, avg_point: point,
    total_point: 100, use_time: use, status, expire: over ? 1 : 0, overtime: 0,
    item_id: "2f9915912c264cd7b0f13a614a865493", item_type: 1, pass_line: 0.92,
    plat_data: [{ item_code: "prod_uap_tbsc_2605220000009", item_orders: [{ total_point: 5, order: 1 }],
      item_id: "2f9915912c264cd7b0f13a614a865493", item_type: 1, lock: 0, total_point: 5 }] };
}
function mockRun(args) {
  const cmd = args[0];
  if (cmd === "all" || cmd === "status") {
    return { ok: true, port: 10086, url: "https://statics.ets100.com/ets-student-pc-web/index.html#/main/home",
      hasToken: true, user: { name: "示例同学", school_name: "示例中学", class_name: "3", parent_id: 100000, id: 100001 },
      serverTime: "2026-01-01 00:00:00",
      statuses: {
        1: [mockRow(110000003, "Unit 4 环保主题 朗读", 55, 0, 0, 0, 1, false), mockRow(110000002, "Unit 4 逐句跟读", 55, 0, 0, 0, 1, false)],
        2: [mockRow(109898657, "10月23日听说专项", 36, 100, 17.9, 240, 2, false), mockRow(109583126, "Unit 3 Reading for writing 短文朗读", 55, 100, 82, 169, 2, false)],
        3: [mockRow(103568147, "Unit 3 鲜活的历史 朗读", 55, 0, 0, 0, 3, true), mockRow(103568136, "Unit 1 少年中国说 朗读", 55, 0, 0, 0, 3, true)],
      } };
  }
  if (cmd === "show") {
    return { ok: true, id: String(args[1]), rid: args[3] || "55", info: { point: 0, total_point: 100, complete: 0, use_time: 0, status: 1 },
      row: mockRow(args[1], "Unit 4 环保主题 朗读", 55, 0, 0, 0, 1, false),
      metas: [{ item_id: "2f9915912c264cd7b0f13a614a865493", item_code: "prod_uap_tbsc_2605220000009", item_type: 1, total_point: 5, orders: [{ order: 1, total_point: 5 }] }],
      items: { kind: "read_chapter", sets: [{ set_id: "844881", set_name: "鲜活的历史", items: [{ entity_id: "912819", order: 1, code_id: "st1" }] }] } };
  }
  if (cmd === "do") {
    return { ok: true, results: [{ id: String(args[1] || "110000003"), rid: "55", name: "演示作业", ok: true, submitted: 1, point: 100, complete: 100 }],
      log: "作业 " + (args[1] || "110000003") + " (资源 55)\n  [提交] item=2f9915912c264cd7b0f13a614a865493 order=1 → code 0 point=5 avg=100 complete=100 pass=1 is_update=1\n  [时长] 设为 120s\n  [复查] 100/100 分，完成度 100%，时长 120s\n完成: 提交 1 个，跳过/失败 0 个" };
  }
  if (cmd === "time") return { ok: true, code: 0, body: { use_time: Number(args[2]) } };
  return { ok: true };
}

/* --------------------------- 调用 ets.js --------------------------- */

function runEts(args, timeoutMs) {
  if (MOCK) {
    const d = mockRun(args);
    return Promise.resolve({ mock: true, ok: d.ok !== false, data: d, log: (d.log || "").replace(/\\n/g, "\n") });
  }
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [ETS, ...args, "--json"], { cwd: ROOT, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: e.message, log: "" });
    }
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, timeoutMs || 300000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message, log: err }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const text = out.trim();
      let data = null;
      try { data = JSON.parse(text); } catch (e) {
        const i = text.indexOf("{"), j = text.lastIndexOf("}");
        if (i >= 0 && j > i) { try { data = JSON.parse(text.slice(i, j + 1)); } catch (e2) {} }
      }
      const errLines = err.split(/\r?\n/).filter(Boolean);
      const tail = errLines.filter((l) => !l.startsWith("模式:")).slice(-1)[0] || "";
      const ok = code === 0 && !!data && data.ok !== false;
      resolve({
        ok, code, ms, data,
        error: ok ? null : (data && data.error) || tail || "执行失败（exit " + code + "）",
        log: errLines.join("\n"),
      });
    });
  });
}

/* 串行队列：同一时刻只跑一个 ets.js，避免多条 CDP 会话互相干扰 */
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

/* ------------------------------ HTTP ------------------------------ */

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}
function sendText(res, code, text, type) {
  res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const p = url.pathname;

  try {
    /* ---------- 静态 ---------- */
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return sendText(res, 200, fs.readFileSync(path.join(WEBUI, "index.html"), "utf8"), MIME[".html"]);
    }
    if (req.method === "GET" && p === "/api/ping") return send(res, 200, { ok: true, pid: process.pid });

    /* ---------- 数据 ---------- */
    if (req.method === "GET" && p === "/api/all") {
      return send(res, 200, await enqueue(() => runEts(["all"], 120000)));
    }
    if (req.method === "GET" && p === "/api/status") {
      return send(res, 200, await enqueue(() => runEts(["status"], 60000)));
    }
    if (req.method === "GET" && p === "/api/list") {
      const st = url.searchParams.get("status") || "4";
      return send(res, 200, await enqueue(() => runEts(["list", String(st)], 120000)));
    }
    if (req.method === "GET" && p === "/api/show") {
      const id = url.searchParams.get("id");
      const rid = url.searchParams.get("rid");
      if (!id) return send(res, 400, { ok: false, error: "缺少 id" });
      const args = ["show", String(id)];
      if (rid) args.push("--rid", String(rid));
      return send(res, 200, await enqueue(() => runEts(args, 120000)));
    }
    if (req.method === "POST" && p === "/api/do") {
      const b = await readBody(req);
      const args = ["do"];
      if (b.todo) args.push("--todo"); else { if (!b.id) return send(res, 400, { ok: false, error: "缺少 id" }); args.push(String(b.id)); }
      if (b.rid) args.push("--rid", String(b.rid));
      if (b.pct !== undefined) args.push("--pct", String(b.pct));
      if (b.time !== undefined) args.push("--time", String(b.time));
      if (b.dry) args.push("--dry");
      if (b.soft) args.push("--soft");
      if (b.force) args.push("--force");
      return send(res, 200, await enqueue(() => runEts(args, 1800000)));
    }
    if (req.method === "POST" && p === "/api/time") {
      const b = await readBody(req);
      if (!b.id || b.sec === undefined) return send(res, 400, { ok: false, error: "缺少 id/sec" });
      const args = ["time", String(b.id), String(b.sec)];
      if (b.rid) args.push("--rid", String(b.rid));
      return send(res, 200, await enqueue(() => runEts(args, 120000)));
    }
    if (req.method === "POST" && p === "/api/raw") {
      const b = await readBody(req);
      if (!b.path) return send(res, 400, { ok: false, error: "缺少 path" });
      return send(res, 200, await enqueue(() => runEts(["raw", String(b.path), JSON.stringify(b.params || {})], 120000)));
    }

    return sendText(res, 404, "not found");
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

server.on("error", (e) => {
  const addr = "http://127.0.0.1:" + PORT;
  if (e && e.code === "EADDRINUSE") {
    http.get(addr + "/api/ping", (res) => {
      res.resume();
      console.log("控制台已经在运行了 -> " + addr + "（直接打开浏览器）");
      if (process.argv.includes("--open")) {
        try { spawn("cmd", ["/c", "start", "", addr], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); } catch (e2) {}
      }
      process.exit(0);
    }).on("error", () => {
      console.error("端口 " + PORT + " 被别的程序占用了。可换个端口: set PORT=5200 && node webui\\server.js");
      process.exit(1);
    });
    return;
  }
  console.error("启动失败: " + String(e && e.message || e));
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = "http://127.0.0.1:" + PORT;
  console.log("ETS 控制台已启动: " + addr);
  console.log("提示: 需要先打开并登录「讯飞E听说」客户端。Ctrl+C 退出。");
  if (process.argv.includes("--open")) {
    try { spawn("cmd", ["/c", "start", "", addr], { windowsHide: true, detached: true, stdio: "ignore" }).unref(); } catch (e) {}
  }
});
