// index.js — siyuan-memory 插件入口（OpenCode V2：默认导出 { id, setup }）。
//
// 1. 注册 6 个跨项目记忆工具（mem_save / mem_progress / mem_search /
//    mem_read / mem_list / mem_delete），底层走思源 agent-memory notebook
//    （经 alltool 代理的 siyuan-mcp-* 工具，见 mcp.js）。
// 2. 系统提示注入：每个会话首次模型调用时，把 agent-memory 的标题级记忆索引
//    推进系统提示（渐进披露：索引只含标题/类型/描述，全文靠 mem_read）。
// 3. git commit 提醒：订阅公开事件流，检测到 shell 工具的 git commit 成功后，
//    在下次模型调用时经 context hook 注入一句「考虑用 mem_progress 更新
//    progress 快照」的提醒（nudge，不强制；模型自行判断要不要更新）。
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

// 判断一条 shell 命令是否执行了 git commit（commit 提醒 nudge 用）。
// 按 shell 操作符（| / || / && / ;）和换行分段逐段判断，避免 `git log | grep commit`
// 这类管道误判；段内要求首 token 是 git 且 commit 为独立 token
// （`git log --grep=commit` 不误判）。覆盖 `git -C <path> commit` /
// `git -c x=y commit` / `git --no-verify commit` 等前置 flag 写法。
// 换行也作分段符：shell 工具常以多行脚本形式跑命令，`git commit` 往往独占一行，
// 若不分换行，它会和前面的行粘在同一段、段首 token 不是 git 而漏检（2026-09-29 实测）。
function isGitCommitCommand(cmd) {
  if (typeof cmd !== "string") return false;
  return cmd
    .split(/\||\|\||&&|;|\r?\n/)
    .some((seg) => {
      const toks = seg.trim().split(/\s+/).filter(Boolean);
      return toks[0] === "git" && toks.includes("commit");
    });
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
          // 用 event.messages 注入一条 system 角色消息（不用 event.system）：
          // system 提示数组的改动在本 setup 里对模型不可见（2026-09-29 验证：push/unshift
          // 都看不到 nudge），而对话历史里的消息一定会被渲染进模型上下文。Message.system
          // 就是为「在对话时间线上插入 operator 指令」设计的机制（见 @opencode/ai messages.ts）。
          const nudgeText =
            `刚完成 git commit（${cmdSnippet}）。若本次改动值得记录，请用 mem_progress 更新当前项目的 progress 工作状态快照` +
            "（推荐四段：## 当前状态 / ## 已完成 / ## 下一步 / ## 关键上下文）。";
          event.messages.push({ role: "system", content: [{ type: "text", text: nudgeText }] });
          console.log(`[siyuan-memory] 已向会话 ${sid} 注入 commit 提醒（messages）`);
        }
      });

      // git commit 检测：订阅公开事件流，检测 shell 工具的 git commit 成功，
      // 标记对应 session 待提醒（由上方 context hook 在下次模型调用时注入）。
      // 事件类型与载荷结构见 opencode 源码 packages/schema/src/session-event.ts
      // （v2.0.18 实测）：工具事件类型是 session.tool.*（非 session.next.tool.*），
      // 载荷嵌在 event.data 里；工具名只在 session.tool.input.started 的 data.name，
      // 需按 data.id（工具调用 ID）关联到 called / success / failed。
      let cleanup = () => {};
      if (typeof ctx.event?.subscribe === "function") {
        const controller = new AbortController();
        const shellCallIDs = new Set(); // shell 工具调用 ID（来自 input.started 的 data.name）
        const pendingCommits = new Map(); // callID -> { sessionID, cmd }
        const SHELL_TOOLS = new Set(["shell", "bash"]);
        void (async () => {
          try {
            for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
              try {
                const type = event?.type;
                const d = event?.data;
                if (type === "session.tool.input.started") {
                  // 工具名只在 input.started 的 data.name；记录 shell 工具调用 ID
                  if (d?.id && d?.name && SHELL_TOOLS.has(d.name)) {
                    shellCallIDs.add(d.id);
                  }
                } else if (type === "session.tool.called") {
                  // 入参在 data.input；仅对 shell 工具检查 git commit
                  if (
                    d?.id &&
                    shellCallIDs.has(d.id) &&
                    isGitCommitCommand(d.input?.command)
                  ) {
                    pendingCommits.set(d.id, {
                      sessionID: d.sessionID,
                      cmd: String(d.input?.command ?? "").slice(0, 80),
                    });
                  }
                } else if (type === "session.tool.success") {
                  const entry = d?.id ? pendingCommits.get(d.id) : undefined;
                  if (entry) {
                    pendingCommits.delete(d.id);
                    pendingReminder.set(entry.sessionID, entry.cmd);
                  }
                  if (d?.id) shellCallIDs.delete(d.id);
                } else if (type === "session.tool.failed") {
                  if (d?.id) {
                    pendingCommits.delete(d.id);
                    shellCallIDs.delete(d.id);
                  }
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
        console.error("[siyuan-memory] ctx.event.subscribe 不可用（API 漂移？），跳过 commit 提醒");
      }

      return cleanup;
    } catch (err) {
      // 加载期任何失败都不外抛——最坏结果是本插件的工具/注入缺席，
      // 不影响 opencode 会话与其它插件。
      console.error("[siyuan-memory] 插件初始化失败：", err);
    }
  },
};
