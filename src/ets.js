#!/usr/bin/env node
/**
 * ets.js — 讯飞E听说（ETS）PC 5.7.9 本地作业工具
 *
 * 原理：ETSShell 是 CEF 壳，发布版把远程调试端口留在 127.0.0.1:10086（免认证）。
 * 本工具连上该端口，在页面上下文里复用应用自带的 EtsHelper 签名插件与 XHR，
 * 直接调用 api.ets100.com 的业务接口。
 *
 * 命令：
 *   node ets.js status                  连接/登录状态、账号信息
 *   node ets.js list [--status 1|2|3]   作业列表（1待做 2已完成 3逾期）
 *   node ets.js show <作业id>           作业结构：类型/题量/set/entity/当前分
 *   node ets.js do <作业id> [选项]      首提提交（满分）
 *   node ets.js do --todo [选项]        所有待做+逾期作业逐个首提
 *   node ets.js time <作业id> <秒>      改学习时长
 *   node ets.js raw <路径> ['{json}']   调试：直接发一个业务请求
 *   node ets.js doctor                  诊断：以太 / ETS 安装目录 / 调试端口文件
 *
 * 全局参数： --ets-dir "<ETS 安装目录>"（装在非默认位置时指定） --json（机器可读输出）
 *
 * do 选项： --pct 100 | --time 120 | --dry | --soft | --force
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const DEFAULT_PORT = 10086;

/* ---------------------------------- CDP ---------------------------------- */

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

/* --------------------------- 定位 ETS 安装目录 --------------------------- */
/* 任何人的安装位置都可能不同：依次尝试 命令行/环境变量 → 运行中的进程 →
   注册表卸载项 → 常见路径 → 各盘符根目录。找不到也不致命，端口扫描仍可工作。 */

function cliValue(name) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : null;
}
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

function runPowerShell(script, timeoutMs) {
  try {
    const out = execFileSync("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: timeoutMs || 8000, windowsHide: true });
    return String(out || "").trim();
  } catch (e) { return ""; }
}

function etsFromProcess() {
  const out = runPowerShell("(Get-Process ETSShell -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)", 8000);
  const p = out.split(/\r?\n/)[0].trim();
  return p ? path.dirname(p) : null;
}

function etsFromRegistry() {
  const ps = [
    "$keys='HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*';",
    "Get-ItemProperty $keys -ErrorAction SilentlyContinue |",
    "Where-Object { $_.DisplayName -match 'E听说|E-Listening|ETS' -and $_.InstallLocation } |",
    "Select-Object -ExpandProperty InstallLocation -Unique"
  ].join(" ");
  return runPowerShell(ps, 10000).split(/\r?\n/).map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function commonPaths() {
  const out = [];
  const push = (p) => { if (p) out.push(p); };
  for (const env of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA", "APPDATA"]) {
    const base = process.env[env];
    if (base) { push(path.join(base, "ETS")); push(path.join(base, "Programs", "ETS")); }
  }
  push(process.env.ETS_DIR);
  const drives = [];
  for (const d of "CDEFGHIJKL") if (exists(d + ":\\")) drives.push(d + ":\\");
  for (const root of drives) {
    push(path.join(root, "ETS"));
    push(path.join(root, "Program Files", "ETS"));
    push(path.join(root, "Program Files (x86)", "ETS"));
    push(path.join(root, "AppGallery", "ETS"));
  }
  return out;
}

let ETS_DIR = "";
let ETS_DIR_SOURCE = "";
function resolveEtsDir() {
  if (ETS_DIR) return ETS_DIR;
  const manual = cliValue("ets-dir") || process.env.ETS_DIR;
  const cands = [];
  if (manual) cands.push([manual, "manual"]);
  const fromProc = etsFromProcess(); if (fromProc) cands.push([fromProc, "running-process"]);
  for (const d of etsFromRegistry()) cands.push([d, "registry"]);
  for (const d of commonPaths()) cands.push([d, "common-path"]);
  for (const [c, src] of cands) {
    if (!c) continue;
    const dir = c.replace(/[\\/]+$/, "");
    if (exists(path.join(dir, "ETSShell.exe")) || exists(path.join(dir, "Ets.exe"))) {
      ETS_DIR = dir; ETS_DIR_SOURCE = src; return dir;
    }
  }
  return "";
}

function devtoolsPortFile(dir) {
  if (!dir) return null;
  const direct = path.join(dir, "temp", "Cache_ETSShell", "DevToolsActivePort");
  if (exists(direct)) return direct;
  try {
    for (const name of fs.readdirSync(dir)) {
      const q = path.join(dir, name, "DevToolsActivePort");
      if (exists(q)) return q;
    }
  } catch (e) {}
  return null;
}

async function findPort() {
  const dir = resolveEtsDir();
  const file = devtoolsPortFile(dir);
  const candidates = [];
  if (file) {
    try {
      const t = fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim();
      if (/^\d+$/.test(t)) candidates.push(Number(t));
    } catch (e) {}
  }
  for (let p = DEFAULT_PORT; p <= DEFAULT_PORT + 20; p++) if (!candidates.includes(p)) candidates.push(p);
  for (const p of candidates) {
    try { await httpGet("http://127.0.0.1:" + p + "/json/version"); return p; } catch (e) {}
  }
  throw new Error(
    "没连上 ETS 的调试端口。请先启动「讯飞E听说」客户端并登录；" +
    "若装在非默认位置，加参数 --ets-dir \"D:\\你的\\ETS\"；仍失败就重启一次客户端。"
  );
}

class Session {
  constructor(ws) { this.ws = ws; this.seq = 1; this.pending = new Map(); }

  static async connect() {
    const port = await findPort();
    const list = JSON.parse(await httpGet("http://127.0.0.1:" + port + "/json/list"));
    const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!pages.length) throw new Error("调试端口在，但没有页面目标（ETS 窗口可能还没加载完）");
    let ws = null, page = null;
    for (const p of pages) {
      try { ws = await openWs(p.webSocketDebuggerUrl); page = p; break; } catch (e) {}
    }
    if (!ws) throw new Error("调试端口在，但页面连不上（ETS 可能正在切换页面或已退出）。重启 ETS 后再试。");
    const s = new Session(ws);
    s.page = page;
    s.port = port;
    ws.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && s.pending.has(m.id)) {
        const { resolve, reject } = s.pending.get(m.id);
        s.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error).slice(0, 300)));
        else resolve(m.result);
      }
    });
    return s;
  }

  evaluate(expression) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("页面执行超时（60s）")); }
      }, 60000);
      if (timer.unref) timer.unref();
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({
        id, method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true,
                  allowUnsafeEvalBlockedByCSP: true, userGesture: true }
      }));
    });
  }

  /* 在页面里跑一段 async 函数体，返回 JS 值 */
  async run(fnBody, args) {
    const expr = "(async function(" + (args ? Object.keys(args).join(",") : "") + "){" + fnBody + "})(" +
      (args ? Object.values(args).map((v) => JSON.stringify(v)).join(",") : "") + ")";
    const r = await this.evaluate(expr);
    if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    const v = r && r.result;
    if (v && v.subtype === "error") throw new Error(v.description || "page error");
    return v ? v.value : undefined;
  }

  close() { try { this.ws.close(); } catch (e) {} }
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error("ws connect timeout")); }, 8000);
    ws.addEventListener("open", () => { clearTimeout(t); resolve(ws); }, { once: true });
    ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error("ws error")); }, { once: true });
  });
}

/* ------------------------- 页面内注入的 ETS 运行库 ------------------------- */

const BOOT = String.raw`(function(){
  if (window.__ETS && window.__ETS.v === 3) return 3;
  function call(plugin, method, pl, ms){
    return new Promise(function(res){
      var g = cef.message.createGuid() + '@' + method, done = false;
      try { cef.message.setMessageCallback(g, function(r){ if(done) return; done = true;
        try{ cef.message.removeMessageCallback(g); }catch(e){} res(r); }); } catch(e){ return res('__ERR__'+e.message); }
      setTimeout(function(){ if(!done){ done = true; try{ cef.message.removeMessageCallback(g); }catch(e){} res('__TIMEOUT__'); } }, ms || 8000);
      try { cef.message.sendMessage(g, plugin, method, typeof pl === 'string' ? pl : JSON.stringify(pl)); }
      catch(e){ if(!done){ done = true; res('__ERR__'+e.message); } }
    });
  }
  function b64(s){ return btoa(unescape(encodeURIComponent(s))); }
  function token(){
    try {
      var raw = localStorage.getItem('userInfo') || '';
      var m = raw.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (m) return m[0];
    } catch(e){}
    return '';
  }
  function user(){
    try {
      var ui = JSON.parse(localStorage.getItem('userInfo') || '{}').userInfo || {};
      return ui;
    } catch(e){ return {}; }
  }
  async function sign(body, t){
    var s = await call('EtsHelper', 'encode_api_body_v2', { body: body, time: String(t) });
    try { var j = JSON.parse(s); if (j && j.sign) return j; } catch(e){}
    var v = await call('EtsHelper', 'encode_api_body', { body: body, time: String(t) });
    if (typeof v === 'string' && /^[a-f0-9]{32}$/i.test(v)) return { sign: v, pid: 'grlx', sign_version: '1' };
    return null;
  }
  function post(url, payload){
    return new Promise(function(res){
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.timeout = 30000;
      try { x.setRequestHeader('Content-Type', 'application/json'); } catch(e){}
      x.onload = function(){ res({ status: x.status, text: String(x.responseText || '') }); };
      x.onerror = function(){ res({ status: -1, text: 'network_error' }); };
      x.ontimeout = function(){ res({ status: -2, text: 'timeout' }); };
      x.send(JSON.stringify(payload));
    });
  }
  async function raw(path, params){
    var tk = token();
    var p = Object.assign({ sign_response: 1, sn: 'test', system: 4, global_client_version: '5.7.9' }, params || {});
    if (tk && !p.token) p.token = tk;
    var ap = path.charAt(0) === '/' ? path : '/' + path;
    var body = b64(JSON.stringify([{ r: ap, params: p }]));
    var t = Date.now();
    var sg = await sign(body, t);
    if (!sg) return { status: -9, text: 'sign_failed' };
    var head = { version: '1.0', sign: sg.sign, pid: sg.pid, time: String(t), time_second: t };
    if (sg.key_id) head.key_id = sg.key_id;
    if (sg.sign_version) head.sign_version = sg.sign_version;
    var r = await post('https://api.ets100.com' + ap, { body: body, head: head });
    r.signed_by = sg.pid;
    return r;
  }
  window.__ETS = { v: 3, token: token, user: user, raw: raw,
    api: async function(path, params){
      var r = await raw(path, params);
      var data = null;
      try { data = JSON.parse(r.text); } catch(e){}
      return { status: r.status, data: data, raw: r.text };
    } };
  return 3;
})()`;

/* -------------------------------- 业务层 -------------------------------- */

let session = null; // 当前 CDP 会话（供命令函数引用）

const nowStr = () => {
  const d = new Date(), z = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + " " +
    z(d.getHours()) + ":" + z(d.getMinutes()) + ":" + z(d.getSeconds());
};
const statusName = { 1: "待做", 2: "已完成", 3: "逾期", 4: "全部" };
const randHex16 = () => Array.from({ length: 16 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");

class Ets {
  constructor(session) { this.s = session; }

  async boot() {
    const cur = await this.evaluateRaw("(window.__ETS && window.__ETS.v) || 0");
    if (cur === 3) return;
    const hasCef = await this.evaluateRaw("(typeof cef === 'object' && !!cef.message)");
    if (!hasCef) throw new Error("页面里没有 cef 桥：ETS 窗口可能还在加载，或当前页面不是 ETS");
    const res = await this.s.evaluate(BOOT);
    if (res && res.exceptionDetails) throw new Error("注入失败: " + JSON.stringify(res.exceptionDetails).slice(0, 300));
  }

  async evaluateRaw(expr) {
    const r = await this.s.evaluate(expr);
    if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    const v = r && r.result;
    return v ? v.value : undefined;
  }

  async api(path, params) { return this.s.run("return await window.__ETS.api(P,PAR);", { P: path, PAR: params || {} }); }
  async raw(path, params) { return this.s.run("return await window.__ETS.raw(P,PAR);", { P: path, PAR: params || {} }); }
  async who() { return this.s.run("return { url: location.href, user: window.__ETS.user(), token: (window.__ETS.token()||'').slice(0,24) };", {}); }

  unwrap(res, what) {
    if (!res) throw new Error(what + "：没有响应");
    if (res.status === -9) throw new Error(what + "：签名失败（EtsHelper 不可用）");
    if (!res.data) throw new Error(what + "：响应不是 JSON（status " + res.status + "）：" + String(res.raw).slice(0, 120));
    const o = Array.isArray(res.data) ? res.data[0] : res.data;
    if (!o) throw new Error(what + "：空响应");
    return o;
  }

  async list(status) {
    const u = await this.s.run("return window.__ETS.user();", {});
    if (!u || !u.parent_id) throw new Error("账号信息没读到，请确认已登录 ETS 学生端");
    const r = await this.api("g/homework/list", {
      parent_account_id: u.parent_id, offset: 0, limit: 500, status: status,
      version: 11, check_pass: 1, show_old_homework: 1,
      get_all_count: 1, get_to_do_count: 1, get_to_overtime_count: 1,
      get_to_do_list: 1, get_to_overtime_list: 1, get_audio_task: 1,
    });
    const o = this.unwrap(r, "作业列表");
    if (o.code !== 0) throw new Error("作业列表失败：" + o.code + " " + (o.msg || ""));
    const b = o.body || {};
    const out = [];
    const keys = (status === undefined || status === null || Number(status) === 4)
      ? ["data", "to_do_list", "to_over_time_list", "to_overtime_list", "expire_list"]
      : ["data"];
    for (const k of keys) { if (Array.isArray(b[k])) out.push(...b[k]); }
    const seen = new Set(), rows = [];
    for (const h of out) {
      if (!h || seen.has(h.id)) continue;
      seen.add(h.id);
      rows.push(h);
    }
    const cnt = Number(b.all_count || b.total || b.count || 0) || rows.length;
    return { raw: b, rows, count: cnt };
  }

  async struct(id, rid) {
    const r = await this.api("m/homework/struct", { id: Number(id), resource_id: String(rid), version: 2 });
    const o = this.unwrap(r, "作业结构");
    if (o.code !== 0) throw new Error("作业结构失败：" + o.code + " " + (o.msg || ""));
    return o.body || {};
  }

  async info(id, rid) {
    const r = await this.api("m/homework/info", { homework_id: Number(id), resource_id: String(rid), version: 2 });
    const o = this.unwrap(r, "作业详情");
    if (o.code !== 0) throw new Error("作业详情失败：" + o.code + " " + (o.msg || ""));
    return o.body || {};
  }

  /* 读出作业的可提交条目；返回 {kind, sets:[{set_id,order,items:[{entity_id,order}]}]} */
  async items(id, rid) {
    const st = await this.struct(id, rid);
    const sets = [];
    for (const key of ["audio", "dub", "combination", "composition"]) {
      const arr = st[key];
      if (!Array.isArray(arr) || !arr.length) continue;
      for (const s of arr) {
        const contents = s.contents || [];
        sets.push({
          type: key,
          set_id: String(s.set_id || ""),
          set_name: s.set_name || "",
          template: s.template || null,
          items: contents.map((c, i) => ({
            entity_id: String(c.real_id || ""),
            code_id: c.code_id || "",
            order: i + 1,
          })),
        });
      }
    }
    return { kind: sets.length ? (sets[0].type === "audio" ? "read_chapter" : sets[0].type) : "unknown", sets, struct: st };
  }

  /* 分数明细：按该条目满分（item total_point）折算，默认 5 分制短文朗读 */
  detail5(pct, soft, totalPoint) {
    const full = Number(totalPoint) > 0 ? Number(totalPoint) : 5;
    const base = Math.min(full, Math.max(0, (full * pct) / 100));
    const acc = soft ? Math.min(full, Math.max(0, base - 0.01 - Math.random() * 0.12)) : base;
    const flu = soft ? Math.min(full, Math.max(0, base - 0.02 - Math.random() * 0.18)) : base;
    const integ = base;
    const std = soft ? Math.min(full, Math.max(0, base - 0.005 - Math.random() * 0.06)) : base;
    const total = Number((soft ? Math.min(acc, flu, std) : base).toFixed(2));
    return {
      accuracy_score: acc.toFixed(4), fluency_score: flu.toFixed(4),
      integrity_score: integ.toFixed(4), standard_score: std.toFixed(4),
      total_score: total, real_score: total, category: "read_chapter", rate_scale: 0,
    };
  }

  /* 全部作业行（含 plat_data：item_id / item_code / item_type / item_orders），带缓存 */
  async homeworkRows() {
    if (this._rows) return this._rows;
    const all = [];
    for (const st of [1, 2, 3]) {
      const { rows } = await this.list(st);
      for (const h of rows) if (!all.find((x) => String(x.id) === String(h.id))) all.push(h);
    }
    this._rows = all;
    return all;
  }

  async homeworkRow(id) {
    const rows = await this.homeworkRows();
    return rows.find((x) => String(x.id) === String(id)) || null;
  }

  /* 从 plat_data 解析出可提交条目：{item_id,item_code,item_type,total_point,orders:[{order,total_point}]} */
  static platItems(row) {
    if (!row) return [];
    let pd = row.plat_data;
    if (typeof pd === "string") { try { pd = JSON.parse(pd); } catch (e) { pd = []; } }
    if (!Array.isArray(pd)) return [];
    return pd.filter((x) => x && x.item_id).map((x) => {
      const orders = Array.isArray(x.item_orders) ? x.item_orders : [];
      return {
        item_id: String(x.item_id), item_code: String(x.item_code || ""),
        item_type: x.item_type, total_point: Number(x.total_point || 0),
        orders: orders.length ? orders.map((o) => ({ order: o.order, total_point: Number(o.total_point || x.total_point || 0) }))
                              : [{ order: 1, total_point: Number(x.total_point || 0) }],
      };
    });
  }

  /* 提交一条（新协议：item_id / item_code / item_type / item_order，set_id 与 entity_id 留空） */
  async submitChapterOne(id, rid, meta, order, totalPoint, pct, soft) {
    const det = this.detail5(pct, soft, totalPoint);
    const params = {
      resource_id: String(rid), real_score: det.total_score, score: det.total_score,
      set_id: "", entity_id: "", order: String(order),
      serial_id: "", mistake_id: 0, upload_file_id: "", upload_file_url: "", spx_file_url: "",
      mark_trace_id: "", detail_file_id: "", detail_file_url: "",
      score_detail: JSON.stringify(det),
      item_id: meta.item_id, item_code: meta.item_code, item_order: order, item_type: meta.item_type,
      version: "2", auto_submit: 1, correct: 0, graduation: 0, source: 1, mark_service: 1, seq_id: "",
      homework_id: String(id), exam_id: null, client_time: nowStr(),
    };
    const r = await this.api("m/audio/sync-v2", params);
    return this.unwrap(r, "提交 item " + meta.item_id + " order " + order);
  }

  /* 逐句跟读（item_type=2）：一次批量提交全部句子，走 m/audio/batch-sync-v2 */
  async submitChapterBatch(id, rid, meta, orders, pct, soft) {
    const info = orders.map((od) => {
      const det = this.detail5(pct, soft, od.total_point);
      return {
        detail_file_id: "", detail_file_url: "", upload_file_id: "", upload_file_url: "",
        spx_file_url: "", mark_trace_id: "", order: od.order, item_order: od.order,
        real_score: det.total_score, score: det.total_score, score_detail: JSON.stringify(det),
        entity_id: "", mark_service: 1, client_time: nowStr(),
        item_id: meta.item_id, item_code: meta.item_code, item_type: meta.item_type,
      };
    });
    const params = {
      resource_id: String(rid), id: String(id), homework_id: String(id), set_id: "", info,
      seq_id: randHex16(), version: 2,
      item_id: meta.item_id, item_code: meta.item_code, item_type: meta.item_type,
      source: 1, mark_service: 1, mistake_id: 0,
    };
    const r = await this.api("m/audio/batch-sync-v2", params);
    return this.unwrap(r, "批量提交 item " + meta.item_id);
  }

  /* 试卷型（听说专项 / fc=36 等）：plat_data 为空，按 set + entity 逐题上报。
     与朗读题的区别：不带 item_*，必须带 first_column_id / question_type_score / rate_scale，
     set_id 用 "100" + homework_id，每题的 order 从 1 开始，score_detail.category = simple_expression。 */
  async submitPaperOne(id, rid, setKey, entityId, qScore, pct, soft, fc) {
    const full = Number(qScore) || 0;
    let score = full;
    if (pct < 100) score = Math.round(full * pct) / 100;
    if (soft) score = Math.max(0, Math.round((score - Math.random() * 0.02) * 100) / 100);
    const det = {
      accuracy_score: "0", fluency_score: "0", integrity_score: "0", standard_score: "0",
      total_score: score, real_score: score, category: "simple_expression", rate_scale: 0,
    };
    const params = {
      resource_id: String(rid), real_score: score, score: score,
      set_id: setKey, entity_id: String(entityId), order: "1",
      mistake_id: "", upload_file_id: "", upload_file_url: "", spx_file_url: "",
      mark_trace_id: "", detail_file_id: "", detail_file_url: "",
      score_detail: JSON.stringify(det),
      exam_id: null, homework_id: String(id),
      first_column_id: String(fc || "36"), question_type_score: String(full),
      rate_scale: 0, client_time: nowStr(), mark_service: 1, version: "2",
    };
    const r = await this.api("m/audio/sync-v2", params);
    return this.unwrap(r, "试卷提交 entity " + entityId);
  }

  /* 试卷结构里的题目实体（audio / dub / composition / combination 四类） */
  static paperEntities(struct) {
    const out = [];
    for (const k of ["audio", "dub", "composition", "combination"]) {
      for (const s of (struct && struct[k]) || []) {
        for (const c of s.contents || []) {
          out.push({
            entity_id: String(c.real_id), code_id: c.code_id,
            set_id: String(s.set_id), name: c.first_type_name || s.set_name || "",
          });
        }
      }
    }
    return out;
  }

  async submitWords(id, rid, words, pct) {
    const score = pct >= 100 ? 100 : Math.round(pct);
    const detail = words.map((q) => ({
      word_id: q.word_id, question_id: q.id,
      score_rate: score / 100, audio_file_id_str: "", audio_url: "",
      xml_file_id_str: "", xml_url: "",
      score_detail: JSON.stringify({ choose: "", score: score }), client_time: nowStr(),
    }));
    const r = await this.api("g/homework/score-sync", {
      detail, homework_id: Number(id), resource_id: String(rid), type: 6, mark_service: 1, seq_id: "", use_time: 0,
    });
    return this.unwrap(r, "单词作业提交");
  }

  async setTime(id, rid, sec) {
    const r = await this.api("m/homework/set-use-time", { homework_id: Number(id), resource_id: String(rid), use_time: Number(sec), version: 2, correct: 0 });
    return this.unwrap(r, "改时长");
  }

  /* 单词类作业结构 */
  async words(id, rid) {
    const info = await this.info(id, rid);
    const fc = (info.entity_info && info.entity_info[0] && info.entity_info[0].first_column_id) || 0;
    for (const f of [fc, 0]) {
      const r = await this.api("g/homework/struct", { id: Number(id), resource_id: String(rid), first_column_id: String(f || "") });
      const o = Array.isArray(r.data) ? r.data[0] : null;
      if (o && o.code === 0 && o.body && Array.isArray(o.body.word_question) && o.body.word_question.length) {
        return o.body.word_question;
      }
    }
    return [];
  }
}

/* -------------------------------- CLI -------------------------------- */

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) return true;
  return v;
}
function has(name) { return process.argv.includes("--" + name); }

/* ------------------------------ JSON 输出模式 ------------------------------ */
/* 加 --json 时：stdout 只输出一个 JSON 对象，人类可读日志全部转到 stderr，
   供 Web 控制台（webui/server.js）解析。 */

const JSON_MODE = has("json");
function emitJson(o) { process.stdout.write(JSON.stringify(o)); }
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function normRow(h) {
  h = h || {};
  return {
    id: h.id, name: h.name || h.title || "", resource_id: h.resource_id,
    set_id: h.set_id || "", complete: h.complete, point: h.point, avg_point: h.avg_point,
    use_time: h.use_time, status: h.status, expire: h.expire, overtime: h.overtime,
    item_id: h.item_id, item_type: h.item_type, total_point: h.total_point,
    pass_line: h.pass_line, create_time: h.create_time,
    first_column_id: h.first_column_id || (h.first_column_id === 0 ? 0 : ""),
    plat_data: typeof h.plat_data === "string" ? safeParse(h.plat_data) : h.plat_data,
  };
}

function line() { console.log("-".repeat(72)); }

function fmtHw(h) {
  const done = h.complete === undefined ? "" : h.complete + "%";
  const pt = h.point !== undefined ? h.point : h.avg_point;
  const flags = [];
  if (h.expire == 1 || h.overtime == 1) flags.push("逾期");
  return [
    String(h.id).padEnd(10),
    (h.name || h.title || "").slice(0, 28).padEnd(30),
    ("资源" + (h.resource_id || "?")).padEnd(8),
    (done || "-").padStart(6),
    (pt !== undefined && pt !== null ? String(pt) : "-").padStart(6),
    flags.join(","),
  ].join(" ");
}

async function cmdStatus(ets) {
  const w = await ets.who();
  console.log("调试端口   : " + session.port + "（已连接）");
  console.log("页面       : " + w.url);
  console.log("签名 token : " + (w.token ? w.token + "...（有效）" : "缺失 —— 请在 ETS 里登录"));
  if (w.user && w.user.name) {
    console.log("账号       : " + w.user.name + "  学校：" + (w.user.school_name || "-") + "  班级：" + (w.user.class_name || "-"));
    console.log("账号参数   : parent_id=" + w.user.parent_id + "  id=" + w.user.id);
  }
  const t = await ets.api("system/time", {});
  const o = ets.unwrap(t, "服务端时间");
  console.log("服务端时间 : " + (o.body && o.body.date ? o.body.date : JSON.stringify(o.body)));
  console.log("链路       : 正常（签名 + 请求都通了）");
}

async function cmdList(ets, statusArg) {
  const want = statusArg !== undefined ? Number(statusArg) : 1;
  const statuses = want === 4 ? [1, 2, 3] : [want];
  for (const st of statuses) {
    const { rows } = await ets.list(st);
    line();
    console.log("【" + (statusName[st] || st) + "】共 " + rows.length + " 条");
    line();
    console.log("ID         名称                           资源     完成   分数   ");
    for (const h of rows.slice(0, 40)) console.log(fmtHw(h));
    if (rows.length > 40) console.log("… 还有 " + (rows.length - 40) + " 条");
  }
}

async function cmdShow(ets, id, rid) {
  if (!rid) {
    const { rows } = await listAll(ets);
    const h = rows.find((x) => String(x.id) === String(id));
    if (!h) throw new Error("找不到作业 " + id + "，先跑 list");
    rid = h.resource_id;
    console.log("作业: " + h.name + "  资源 " + rid);
  }
  const info = await ets.info(id, rid);
  console.log("完成度: " + (info.complete || 0) + "%   得分: " + (info.point || 0) + "/" + (info.total_point || 100) +
    "   时长: " + (info.use_time || 0) + "s   状态: " + (info.status || "-"));
  const row = await ets.homeworkRow(id);
  const metas = Ets.platItems(row);
  if (metas.length) {
    console.log("提交条目（plat_data）:");
    for (const m of metas) {
      console.log("  item=" + m.item_id + " code=" + m.item_code + " type=" + m.item_type +
        " 满分=" + m.total_point + " orders=" + m.orders.map((o) => o.order + "(" + o.total_point + "分)").join(","));
    }
  }
  const it = await ets.items(id, rid);
  if (it.kind === "unknown") {
    const w = await ets.words(id, rid);
    console.log("类型: 单词/朗读单词（" + w.length + " 题）" + (w.length ? "" : "  ← 结构未取到"));
    for (const q of w.slice(0, 10)) console.log("  - " + (q.content || "") + " (" + (q.phonetics || q.phonics || "") + ") id=" + q.id + " word_id=" + q.word_id);
    if (w.length) console.log("\n该作业可直接: node ets.js do " + id + " --rid " + rid);
    return;
  }
  console.log("类型: " + it.kind + "  共 " + it.sets.reduce((n, s) => n + s.items.length, 0) + " 个可交条目");
  for (const s of it.sets) {
    console.log("  set " + s.set_id + "「" + s.set_name + "」 " + s.items.length + " 项");
    for (const i of s.items) console.log("     entity=" + i.entity_id + " order=" + i.order + " code=" + i.code_id);
  }
  console.log("\n提交: node ets.js do " + id + " --rid " + rid);
}

async function listAll(ets) {
  const all = { rows: [] };
  for (const st of [1, 2, 3]) {
    const { rows } = await ets.list(st);
    for (const h of rows) if (!all.rows.find((x) => String(x.id) === String(h.id))) all.rows.push(h);
  }
  return all;
}

async function doOne(ets, id, rid, opt) {
  const info = await ets.info(id, rid);
  const name = opt.name || String(id);
  if ((info.complete || 0) >= 100 && !opt.force) {
    console.log("  [跳过] " + id + " 已经提交完成（" + (info.point || 0) + " 分）。服务端会冻结分数，改不动。");
    console.log("         想直接交别的作业用 list 看 status=1/3 的。");
    return { skipped: true };
  }
  const it = await ets.items(id, rid);
  if (it.kind === "unknown") {
    const words = await ets.words(id, rid);
    if (!words.length) {
      console.log("  [跳过] " + id + " 结构里没有可提交条目（类型未知：" + (it.struct && Object.keys(it.struct).join(",")) + "）");
      return { skipped: true, reason: "unknown-type" };
    }
    if (opt.dry) { console.log("  [dry] " + id + " 单词作业 " + words.length + " 题 → score_rate=1"); return { dry: true }; }
    const r = await ets.submitWords(id, rid, words, opt.pct);
    console.log("  [提交] " + id + " 单词作业 " + words.length + " 题 → code " + r.code +
      " complete=" + (r.body && r.body.complete) + " rate=" + (r.body && r.body.score_rate));
    await ets.setTime(id, rid, opt.time);
    console.log("  [时长] 设为 " + opt.time + "s");
    return { ok: true };
  }

  // 新协议：按作业行里的 plat_data（item_id/item_code/item_type/item_orders）逐条目提交
  const row = await ets.homeworkRow(id);
  const metas = Ets.platItems(row);
  let submitted = 0;
  let lastPoint = null, lastComplete = null;   // 试卷型专用：info 有缓存，用它兜底
  if (metas.length) {
    for (const meta of metas) {
      if (meta.item_type === 2 && meta.orders.length > 1) {
        if (opt.dry) {
          console.log("  [dry] item=" + meta.item_id + " type=2 " + meta.orders.length + " 句 → batch-sync-v2 (" + opt.pct + "%)");
          continue;
        }
        const rb = await ets.submitChapterBatch(id, rid, meta, meta.orders, opt.pct, opt.soft);
        const bb = rb.body || {};
        console.log("  [提交] item=" + meta.item_id + " type=2 " + meta.orders.length + " 句 → code " + rb.code +
          " point=" + bb.point + " avg=" + bb.avg_point + " complete=" + bb.complete + " pass=" + bb.pass);
        submitted++;
        continue;
      }
      for (const od of meta.orders) {
        if (opt.dry) {
          const d = ets.detail5(opt.pct, opt.soft, od.total_point);
          console.log("  [dry] item=" + meta.item_id + " type=" + meta.item_type + " order=" + od.order +
            "/" + od.total_point + " → real_score=" + d.total_score + " (" + opt.pct + "%)");
          continue;
        }
        const r = await ets.submitChapterOne(id, rid, meta, od.order, od.total_point, opt.pct, opt.soft);
        if (r.code !== 0) { console.log("  [失败] code=" + r.code + " msg=" + (r.msg || "") + " sn=" + (r.sn || "") + "  raw=" + JSON.stringify(r).slice(0, 400)); continue; }
        const b = r.body || {};
        console.log("  [提交] item=" + meta.item_id + " order=" + od.order +
          " → code " + r.code + " point=" + b.point + " avg=" + b.avg_point + " complete=" + b.complete +
          " pass=" + b.pass + " is_update=" + b.is_update);
        submitted++;
      }
    }
  } else {
    // 试卷型（听说专项等）：作业行没有 plat_data，按 set + entity 逐题上报
    const ents = Ets.paperEntities(it.struct);
    const fc = String((row && row.first_column_id) || "36");
    const total = Number((row && row.total_point) || 0) || ents.length * 2;
    const per = ents.length ? Math.round((total / ents.length) * 100) / 100 : 0;
    const setKey = "100" + String(id);
    console.log("  [试卷型] " + ents.length + " 题，满分 " + total + "（每题 " + per + " 分），set=" + setKey + " fc=" + fc);
    if (!ents.length) console.log("  [警告] 试卷结构里没找到题目实体，先看 show 的输出");
    for (const e of ents) {
      if (opt.dry) { console.log("  [dry] entity=" + e.entity_id + " (" + e.name + ") → real_score=" + per + " (" + opt.pct + "%)"); continue; }
      const r = await ets.submitPaperOne(id, rid, setKey, e.entity_id, per, opt.pct, opt.soft, fc);
      const b = r.body || {};
      console.log("  [提交] entity=" + e.entity_id + " → code " + r.code + " point=" + b.point +
        " complete=" + b.complete + " is_update=" + b.is_update);
      if (r.code === 0) { submitted++; lastPoint = b.point; lastComplete = b.complete; }
    }
  }
  if (opt.dry) { console.log("  [dry] 未提交"); return { dry: true }; }
  const rt = await ets.setTime(id, rid, opt.time);
  console.log("  [时长] 设为 " + opt.time + "s → " + JSON.stringify(rt.body || {}));
  const after = await ets.info(id, rid);
  // 试卷型的 m/homework/info 有缓存（会停在首次提交的分数），优先用最后一次提交返回的进度
  const pvPoint = lastComplete != null ? lastPoint : after.point;
  const pvComplete = lastComplete != null ? lastComplete : after.complete;
  console.log("  [复查] " + (pvPoint || 0) + "/" + (after.total_point || 100) + " 分，完成度 " +
    (pvComplete || 0) + "%，时长 " + (after.use_time || 0) + "s");
  return { ok: true, submitted, point: pvPoint, complete: pvComplete };
}

async function main() {
  const cmd = process.argv[2] || "status";
  const rest = process.argv.slice(3);

  /* doctor：不连 ETS，只报告环境（排查“为什么连不上”） */
  if (cmd === "doctor") {
    const dir = resolveEtsDir();
    const file = devtoolsPortFile(dir);
    const info = {
      ok: true,
      node: process.version,
      platform: process.platform + " " + (process.arch || ""),
      etsDir: dir || null,
      etsDirSource: dir ? (ETS_DIR_SOURCE || "auto-detect") : "not-found",
      devtoolsPortFile: file || null,
      hint: dir ? null : "没找到 ETS 安装目录；若客户端在跑，可加 --ets-dir \"安装目录\" 指定",
    };
    if (JSON_MODE) { emitJson(info); return; }
    console.log("Node          : " + info.node + "  (" + info.platform + ")");
    console.log("ETS 目录      : " + (info.etsDir || "未找到"));
    console.log("调试端口文件  : " + (info.devtoolsPortFile || "未找到（客户端没启动过？）"));
    if (info.hint) console.log("提示          : " + info.hint);
    return;
  }

  session = await Session.connect();
  const ets = new Ets(session);
  await ets.boot();
  if (JSON_MODE) console.log = (...a) => console.error(...a);

  const pct = Number(arg("pct", 100));
  const opt = {
    pct: Number.isFinite(pct) ? pct : 100,
    time: Number(arg("time", 120)),
    dry: has("dry"),
    soft: has("soft"),
    force: has("force"),
  };
  let result = { ok: true };

  if (cmd === "status") {
    if (JSON_MODE) {
      const w = await ets.who();
      const t = await ets.api("system/time", {});
      const o = ets.unwrap(t, "服务端时间");
      result = { ok: true, port: session.port, url: w.url, hasToken: !!w.token, user: w.user || null,
        serverTime: (o.body && o.body.date) || null, apiCode: o.code };
    } else await cmdStatus(ets);
  }
  else if (cmd === "list") {
    const wantArg = rest[0] !== undefined ? rest[0] : arg("status", undefined);
    if (JSON_MODE) {
      const want = wantArg !== undefined && wantArg !== true && wantArg !== null ? Number(wantArg) : 4;
      const statuses = want === 4 ? [1, 2, 3] : [want];
      const out = { ok: true, statuses: {} };
      for (const st of statuses) out.statuses[st] = (await ets.list(st)).rows.map(normRow);
      result = out;
    } else await cmdList(ets, wantArg);
  }
  else if (cmd === "all") {
    const w = await ets.who();
    let serverTime = null;
    try { const o = ets.unwrap(await ets.api("system/time", {}), "服务端时间"); serverTime = (o.body && o.body.date) || null; } catch (e) {}
    const statuses = { 1: [], 2: [], 3: [] };
    const counts = { 1: 0, 2: 0, 3: 0 };
    let listError = null;
    if (w.user && w.user.parent_id) {
      for (const st of [1, 2, 3]) {
        try { const rr = await ets.list(st); statuses[st] = rr.rows.map(normRow); counts[st] = rr.count; }
        catch (e) { listError = e.message; }
      }
    }
    result = { ok: true, port: session.port, url: w.url, hasToken: !!w.token, user: w.user || null,
      serverTime, needsLogin: !(w.user && w.user.parent_id), listError, statuses, counts };
    if (!JSON_MODE) { await cmdStatus(ets); await cmdList(ets, 4); }
  }
  else if (cmd === "show") {
    const id = rest[0];
    if (!id) throw new Error("用法: node ets.js show <作业id> [--rid 55]");
    let rid = arg("rid", null);
    if (!rid) { const all = await listAll(ets); const h = all.rows.find((x) => String(x.id) === String(id)); if (!h) throw new Error("找不到作业 " + id); rid = h.resource_id; }
    if (JSON_MODE) {
      const info = await ets.info(id, rid);
      const row = await ets.homeworkRow(id);
      const metas = Ets.platItems(row);
      const it = await ets.items(id, rid);
      let words = null;
      if (it.kind === "unknown") { try { words = await ets.words(id, rid); } catch (e) {} }
      result = { ok: true, id: String(id), rid: String(rid), info, metas, items: it, row: normRow(row), words };
    } else await cmdShow(ets, id, rid);
  }
  else if (cmd === "time") {
    const id = rest[0], sec = rest[1];
    if (!id || sec === undefined) throw new Error("用法: node ets.js time <作业id> <秒> [--rid 55]");
    let rid = arg("rid", null);
    if (!rid) { const all = await listAll(ets); const h = all.rows.find((x) => String(x.id) === String(id)); if (!h) throw new Error("找不到作业 " + id); rid = h.resource_id; }
    const r = await ets.setTime(id, rid, sec);
    result = { ok: r.code === 0, code: r.code, body: r.body, msg: r.msg };
    if (!JSON_MODE) console.log("use_time → " + JSON.stringify(r.body || {}));
  }
  else if (cmd === "do") {
    const target = has("todo") || rest[0] === "--todo" ? null : rest[0];
    const rid0 = arg("rid", null);
    console.log("模式: " + (target ? "单个作业 " + target : "全部待做/逾期") +
      "   目标分 " + opt.pct + "%   时长 " + opt.time + "s" + (opt.dry ? "   [dry-run]" : "") + (opt.soft ? "   [soft]" : ""));
    let todo = [];
    if (target) {
      let rid = rid0;
      if (!rid) { const all = await listAll(ets); const h = all.rows.find((x) => String(x.id) === String(target)); rid = h ? h.resource_id : null; }
      if (!rid) throw new Error("找不到作业 " + target + " 的资源号，请加 --rid");
      todo = [{ id: Number(target), resource_id: rid, name: "" }];
    } else {
      const st = new Map();
      for (const s of [1, 3]) { const r = await ets.list(s); for (const h of r.rows) st.set(String(h.id), h); }
      todo = [...st.values()];
    }
    const results = [];
    for (const h of todo) {
      line();
      console.log((h.name ? h.name + "  " : "") + "作业 " + h.id + " (资源 " + (h.resource_id || "-") + ")");
      try {
        const r = await doOne(ets, h.id, h.resource_id, Object.assign({ name: h.name }, opt));
        results.push(Object.assign({ id: String(h.id), rid: String(h.resource_id || ""), name: h.name || "" }, r));
      } catch (e) { console.log("  [失败] " + e.message); results.push({ id: String(h.id), rid: String(h.resource_id || ""), name: h.name || "", ok: false, error: e.message }); }
      await new Promise((r) => setTimeout(r, 800));
    }
    line();
    const okN = results.filter((r) => r.ok).length;
    const dryN = results.filter((r) => r.dry).length;
    console.log("完成: 提交 " + okN + " 个，跳过/失败 " + (results.length - okN - dryN) + " 个" + (dryN ? "（dry-run " + dryN + " 个）" : ""));
    result = todo.length ? { ok: okN > 0 || (dryN > 0 && results.length === dryN), dry: !!opt.dry, results }
      : { ok: false, error: "没有待做或逾期的作业。", results: [] };
  }
  else if (cmd === "raw") {
    const p = rest[0];
    let params = {};
    try { if (rest[1]) params = JSON.parse(rest[1]); } catch (e) { throw new Error("参数不是合法 JSON"); }
    const r = await ets.raw(p, params);
    result = { ok: true, status: r.status, text: String(r.text || "").slice(0, 20000) };
    if (!JSON_MODE) { console.log("status " + r.status + "  len " + String(r.text || "").length); console.log(String(r.text || "").slice(0, 4000)); }
  }
  else {
    if (!JSON_MODE) console.log("命令: status | list [1|2|3|4] | show <id> | do <id>|--todo [--pct --time --dry --soft --force] | time <id> <秒> | raw <path> [json] | all");
    result = { ok: false, error: "unknown command: " + cmd };
  }
  if (JSON_MODE) emitJson(result);
  session.close();
}

main().catch((e) => { console.error("错误: " + e.message); process.exit(1); });
