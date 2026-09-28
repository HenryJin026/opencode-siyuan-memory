// mcp.js — 极简 MCP streamable-HTTP 客户端（纯 fetch，无 MCP SDK 依赖）。
//
// 用途：让 siyuan-memory 插件绕过 opencode 的 MCP 层，直接对 mcptool 代理
// （opencode.json 里 mcp.servers.mcptool 配置的远程端点）发 JSON-RPC，
// 从而在插件里调用 siyuan-mcp-* 工具。
//
// 安全属性（保证不炸 opencode 会话）：
//   - 加载时零 I/O：本模块只在工具被调用时才读配置 / 发请求（懒初始化）。
//   - 每次请求都有超时上限（AbortController），并支持外部 signal 取消
//     （会话中断时 fetch 跟着停）。
//   - 所有失败都以 throw 表达，由 tools.js 的 executor 统一 catch 成
//     工具错误文本——绝不让未处理的 rejection 逃逸到 opencode 运行时。

import { readFileSync } from "node:fs";

const CONFIG_PATH = "C:/Users/HJ/.config/opencode/opencode.json";
const DEFAULT_TIMEOUT_MS = 30_000;

let rpcId = 0;

// 从全局 opencode.json 读 mcptool 端点 + 凭据（token 轮换后自动跟随，不硬编码）。
export function loadMcpConfig() {
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const s = cfg.mcp?.servers?.mcptool;
  if (!s?.url) throw new Error("mcptool: opencode.json 里找不到 mcp.servers.mcptool.url");
  const auth = s.headers?.Authorization;
  if (!auth) throw new Error("mcptool: opencode.json 里找不到 Authorization header");
  return { url: s.url, auth };
}

// MCP streamable-HTTP 响应是 SSE：`event: message\ndata: {json}\n\n`。
// 兼容纯 JSON 响应（部分实现）。
function parseBody(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload) return JSON.parse(payload);
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postJson(url, auth, method, params, sessionId, outerSignal, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`mcptool 请求超时（${timeoutMs}ms）`)), timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort();
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

export class McpClient {
  constructor() {
    this.sessionId = null;
    this.initPromise = null;
  }

  async _init(signal) {
    const { url, auth } = loadMcpConfig();
    const res = await postJson(
      url,
      auth,
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "opencode-siyuan-memory", version: "1.0.0" },
      },
      null,
      signal,
      DEFAULT_TIMEOUT_MS,
    );
    if (!res.ok) throw new Error(`mcptool initialize 失败：HTTP ${res.status}`);
    const sid = res.headers.get("mcp-session-id");
    await res.text(); // 排空 body
    if (!sid) throw new Error("mcptool initialize 未返回 Mcp-Session-Id");
    this.sessionId = sid;
  }

  // 懒初始化：首次工具调用才连代理；失败不缓存，下次调用自动重试。
  async ensureInit(signal) {
    if (this.sessionId) return;
    if (!this.initPromise) {
      this.initPromise = this._init(signal).finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  // 调用 mcptool 代理上的工具（如 siyuan-mcp-document），返回其文本结果。
  async callTool(name, args, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    await this.ensureInit(signal);
    const { url, auth } = loadMcpConfig();
    const res = await postJson(url, auth, "tools/call", { name, arguments: args }, this.sessionId, signal, timeoutMs);
    if (!res.ok) throw new Error(`mcptool ${name} 失败：HTTP ${res.status}`);
    const msg = parseBody(await res.text());
    if (!msg) throw new Error(`mcptool ${name}：响应无法解析`);
    if (msg.error) throw new Error(`mcptool ${name} 报错：${JSON.stringify(msg.error)}`);
    const content = msg.result?.content;
    if (Array.isArray(content)) return content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
    return msg.result === undefined ? "" : JSON.stringify(msg.result);
  }
}
