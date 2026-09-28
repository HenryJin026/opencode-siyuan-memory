// index.js — siyuan-memory 插件入口（OpenCode V2：默认导出 { id, setup }）。
//
// 1. 注册 6 个跨项目记忆工具（mem_save / mem_progress / mem_search /
//    mem_read / mem_list / mem_delete），底层走思源 agent-memory notebook
//    （经 mcptool 代理的 siyuan-mcp-* 工具，见 mcp.js）。
// 2. 系统提示注入：每个会话首次模型调用时，把 agent-memory 的标题级记忆索引
//    推进系统提示（渐进披露：索引只含标题/类型/描述，全文靠 mem_read）。
// 3. git commit 提醒：订阅公开事件流，检测到 shell 工具的 git commit 成功后，
//    在下次模型调用时经 context hook 注入一句「考虑用 mem_progress 更新
//    progress 快照」的提醒（nudge，不强制；模型自行判断要不要更新）。
// 4. 新增记忆补充注入：检测到本会话 mem_save 成功后，在下次模型调用时经
//    context hook 注入一行「本会话新增/更新记忆：…（mem_read 可读全文）」
//    的增量提示（只列增量、不重发全量索引；只覆盖本会话，不轮询其它会话）。
//
// 安全设计（载入不影响 opencode 正常会话）：
//   1. setup 阶段零网络 I/O、零文件写入——MCP 连接是懒初始化（首次工具
//      调用 / 首次注入才发生），思源 / 代理离线时加载不受影响。
//   2. setup 全程 try/catch：任何异常只 console.error，绝不向
//      PluginSupervisor 抛。
//   3. API 漂移防御：ctx.tool.transform / ctx.session.hook / ctx.event.subscribe
//      不存在（版本差异）时静默跳过对应功能，插件降级但不影响会话。
//   4. 工具 executor 全部内部 catch（见 tools.js），失败返回错误文本，
//      不产生未处理 rejection。
//   5. 注入失败（思源离线 / 超时）：该会话标记为 failed 不再重试——
//      避免每轮模型调用都等 10s 超时拖慢会话；本进程内不再注入，
//      服务重启后恢复。
//   6. 回退方案：删掉本目录（~/.config/opencode/plugins/siyuan-memory/）
//      即完全移除，无残留状态。

import { McpClient } from "./mcp.js";
import { buildMemTools, buildMemoryIndex } from "./tools.js";

// 从会话目录推导当前项目的 slug 候选（对齐迁移规则：末段 + 父段-末段，
// 覆盖消歧 slug，如 D:\...\GithubRes\ninfer → ["ninfer", "GithubRes-ninfer"]）。
// 全部候选在思源里都无记忆时，buildMemoryIndex 自动退回全量索引。
function slugCandidates(dir) {
  if (!dir || typeof dir !== "string") return [];
  const segs = dir.replace(/\\/g, "/").split("/").filter(Boolean);
  const last = segs[segs.length - 1];
  if (!last) return [];
  const out = [last];
  if (segs.length >= 2) out.push(`${segs[segs.length - 2]}-${last}`);
  return [...new Set(out)];
}

export default {
  id: "siyuan-memory",
  async setup(ctx) {
    try {
      if (!ctx || typeof ctx.tool?.transform !== "function") {
        console.error("[siyuan-memory] ctx.tool.transform 不可用（API 漂移？），跳过注册");
        return;
      }
      const client = new McpClient();
      const tools = buildMemTools(client);
      await ctx.tool.transform((editor) => {
        for (const def of Object.values(tools)) editor.add(def);
      });

      // 系统提示注入（每会话一次）
      if (typeof ctx.session?.hook !== "function") {
        console.error("[siyuan-memory] ctx.session.hook 不可用（API 漂移？），跳过注入");
        return;
      }
      const injected = new Set(); // 成功注入记忆索引的 sessionID
      const failed = new Set(); // 注入失败过、本进程内不再重试的 sessionID
      const pendingReminder = new Map(); // git commit 成功后待提醒：sessionID -> 命令摘要
      const pendingMemories = new Map(); // 本会话 mem_save 成功后待补充注入：sessionID -> Set<file_name>
      const candidates = slugCandidates(ctx.location?.directory);
      await ctx.session.hook("context", async (event) => {
        const sid = event?.sessionID;
        if (!sid) return;
        // 1. 记忆索引注入（每会话一次）
        if (!injected.has(sid) && !failed.has(sid)) {
          try {
            // 10s 上限：思源挂着时不拖死首轮模型调用
            const index = await buildMemoryIndex(client, {
              timeoutMs: 10_000,
              projectCandidates: candidates,
            });
            if (index) {
              event.system.push({ type: "text", text: index });
              injected.add(sid);
              console.log(`[siyuan-memory] 已注入记忆索引到会话 ${sid}`);
            }
          } catch (err) {
            failed.add(sid);
            console.error(`[siyuan-memory] 记忆索引注入失败（本会话不再重试）：${err.message}`);
          }
        }
        // 2. git commit 提醒注入（每次模型调用检查）
        const cmdSnippet = pendingReminder.get(sid);
        if (cmdSnippet !== undefined) {
          pendingReminder.delete(sid);
          event.system.push({
            type: "text",
            text:
              `刚完成 git commit（${cmdSnippet}）。若本次改动值得记录，请用 mem_progress 更新当前项目的 progress 工作状态快照` +
              "（推荐四段：## 当前状态 / ## 已完成 / ## 下一步 / ## 关键上下文）。",
          });
          console.log(`[siyuan-memory] 已向会话 ${sid} 注入 commit 提醒`);
        }
        // 3. 本会话新增记忆补充注入（每次模型调用检查）
        const memSet = pendingMemories.get(sid);
        if (memSet && memSet.size > 0) {
          pendingMemories.delete(sid);
          const list = [...memSet].join("、");
          event.system.push({
            type: "text",
            text: `本会话新增/更新记忆：${list}（可用 mem_read 读全文）`,
          });
          console.log(`[siyuan-memory] 已向会话 ${sid} 注入新增记忆提醒（${memSet.size} 条）`);
        }
      });

      // git commit 检测：订阅公开事件流，检测 shell 工具的 git commit 成功，
      // 标记对应 session 待提醒（由上方 context hook 在下次模型调用时注入）。
      // 事件类型见 opencode 源码 packages/schema/src/session-event.ts。
      let cleanup = () => {};
      if (typeof ctx.event?.subscribe === "function") {
        const controller = new AbortController();
        const pendingCommits = new Map(); // callID -> { sessionID, cmd }
        const pendingMemCalls = new Map(); // callID -> { sessionID, fileName }
        const SHELL_TOOLS = new Set(["shell", "bash"]);
        void (async () => {
          try {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
              try {
                const type = event?.type;
                if (type === "session.next.tool.called") {
                  if (
                    SHELL_TOOLS.has(event.tool) &&
                    typeof event.input?.command === "string" &&
                    /\bgit\s+commit(\s|$)/.test(event.input.command)
                  ) {
                    pendingCommits.set(event.callID, {
                      sessionID: event.sessionID,
                      cmd: event.input.command.slice(0, 80),
                    });
                  } else if (
                    event.tool === "mem_save" &&
                    typeof event.input?.file_name === "string"
                  ) {
                    pendingMemCalls.set(event.callID, {
                      sessionID: event.sessionID,
                      fileName: event.input.file_name,
                    });
                  }
                } else if (type === "session.next.tool.success") {
                  const entry = pendingCommits.get(event.callID);
                  if (entry) {
                    pendingCommits.delete(event.callID);
                    pendingReminder.set(entry.sessionID, entry.cmd);
                  }
                  const memEntry = pendingMemCalls.get(event.callID);
                  if (memEntry) {
                    pendingMemCalls.delete(event.callID);
                    let set = pendingMemories.get(memEntry.sessionID);
                    if (!set) {
                      set = new Set();
                      pendingMemories.set(memEntry.sessionID, set);
                    }
                    set.add(memEntry.fileName);
                  }
                } else if (type === "session.next.tool.failed") {
                  pendingCommits.delete(event.callID);
                  pendingMemCalls.delete(event.callID);
                }
              } catch (err) {
                console.error(`[siyuan-memory] 处理事件失败：${err.message}`);
              }
            }
          } catch (err) {
            console.error(`[siyuan-memory] 事件订阅结束：${err.message}`);
          }
        })();
        cleanup = () => controller.abort();
      } else {
        console.error("[siyuan-memory] ctx.event.subscribe 不可用（API 漂移？），跳过 commit 提醒与新增记忆补充注入");
      }

      return cleanup;
    } catch (err) {
      // 加载期任何失败都不外抛——最坏结果是本插件的工具/注入缺席，
      // 不影响 opencode 会话与其它插件。
      console.error("[siyuan-memory] 插件初始化失败：", err);
    }
  },
};
