// index.js — siyuan-memory 插件入口（OpenCode V2：默认导出 { id, setup }）。
//
// 1. 注册 6 个跨项目记忆工具（mem_save / mem_progress / mem_search /
//    mem_read / mem_list / mem_delete），底层走思源 agent-memory notebook
//    （经 mcptool 代理的 siyuan-mcp-* 工具，见 mcp.js）。
// 2. 系统提示注入：每个会话首次模型调用时，把 agent-memory 的标题级记忆索引
//    推进系统提示（渐进披露：索引只含标题/类型/描述，全文靠 mem_read）。
//
// 安全设计（载入不影响 opencode 正常会话）：
//   1. setup 阶段零网络 I/O、零文件写入——MCP 连接是懒初始化（首次工具
//      调用 / 首次注入才发生），思源 / 代理离线时加载不受影响。
//   2. setup 全程 try/catch：任何异常只 console.error，绝不向
//      PluginSupervisor 抛。
//   3. API 漂移防御：ctx.tool.transform / ctx.session.hook 不存在（版本
//      差异）时静默跳过对应功能，插件降级但不影响会话。
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
      const injected = new Set(); // 成功注入的 sessionID
      const failed = new Set(); // 注入失败过、本进程内不再重试的 sessionID
      const candidates = slugCandidates(ctx.location?.directory);
      await ctx.session.hook("context", async (event) => {
        const sid = event?.sessionID;
        if (!sid || injected.has(sid) || failed.has(sid)) return;
        try {
          // 10s 上限：思源挂着时不拖死首轮模型调用
          const index = await buildMemoryIndex(client, {
            timeoutMs: 10_000,
            projectCandidates: candidates,
          });
          if (!index) return; // 空库不注入
          event.system.push({ type: "text", text: index });
          injected.add(sid);
          console.log(`[siyuan-memory] 已注入记忆索引到会话 ${sid}`);
        } catch (err) {
          failed.add(sid ?? "?");
          console.error(`[siyuan-memory] 记忆索引注入失败（本会话不再重试）：${err.message}`);
        }
      });
    } catch (err) {
      // 加载期任何失败都不外抛——最坏结果是本插件的工具/注入缺席，
      // 不影响 opencode 会话与其它插件。
      console.error("[siyuan-memory] 插件初始化失败：", err);
    }
  },
};
