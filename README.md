# opencode-siyuan-memory

OpenCode V2 跨项目记忆插件：以思源（SiYuan）`agent-memory` notebook 作为跨项目记忆后端，提供 6 个 `mem_*` 工具 + 系统提示自动注入标题级记忆索引。

## 功能

- **6 个记忆工具**：`mem_save` / `mem_progress` / `mem_search` / `mem_read` / `mem_list` / `mem_delete`
- **工作状态延续**：`mem_progress` 把阶段性成果 / 进度 / 下一步写成 `<project>/progress` 快照（覆盖写，永远一份）。阶段性工作做到检查点时更新它，新会话 `mem_read` 就能接上当前状态继续推进
- **自动注入**：每个会话首次模型调用时，把 agent-memory 全量记忆的**标题级索引**（标题 / memtype / 一句话描述）自动注入系统提示——模型开对话就能看到有哪些记忆，需要全文时再 `mem_read` 拉取（渐进披露，token 开销可控）
- **跨项目**：记忆按 `<project-slug>/<记忆名>` 存思源，任何项目的会话都能搜到
- **零硬编码凭据**：mcptool 端点与 Bearer token 运行时从 `opencode.json` 读取，token 轮换自动跟随

## 要求

- OpenCode V2（插件 API：`ctx.tool.transform` / `ctx.session.hook`）
- `opencode.json` 已配置 `mcp.servers.mcptool`（暴露 `siyuan-mcp-*` 工具的远程 MCP 代理）
- 思源实例上存在 `agent-memory` notebook

## 安装

把本目录拷到全局插件目录：

```
~/.config/opencode/plugins/siyuan-memory/
```

服务对插件目录有 watcher，改文件即热重载，无需重启。回退 = 删掉该目录，无残留状态。

## 工具清单

| 工具 | 用途 |
|---|---|
| `mem_save` | 存一条记忆（`file_name` = `<project>/<记忆名>`，末段即 doc 标题；同名覆盖） |
| `mem_progress` | 记录 / 更新项目「工作状态」快照（`<project>/progress`，覆盖写，永远一份；跨会话延续用） |
| `mem_search` | 全文搜索（可选按 project 过滤） |
| `mem_read` | 读一条记忆全文 |
| `mem_list` | 列出记忆（标题 / 类型 / 描述） |
| `mem_delete` | 删除一条记忆 |

## 工作原理

插件绕过 opencode 的 MCP 层，用纯 `fetch` 直连 mcptool 代理说 MCP streamable-HTTP JSON-RPC（无 MCP SDK 依赖）：

1. `initialize` 拿 `Mcp-Session-Id`（懒初始化：首次工具调用 / 首次注入才连）
2. 调 `siyuan-mcp-*` 工具（`notebook` / `document` / `sql` / `search` / `attr` / `export`）读写 agent-memory notebook
3. 记忆布局 `/<project-slug>/<记忆名>`（末段 = doc 标题 = hpath 末段）；属性 `memtype` / `project` / `description` 落在 `blocks.ial`（SiYuan 保留键 `type` 不可用，故用 `memtype`）

> **mcptool 代理 = [MCPHub](https://github.com/samanhappy/mcphub)**（自托管 MCP 网关）：本机 MCP 工具统一经它的**分组路由**接入（`/mcp/{group}` 等稳定端点）。插件连到对应 group 端点、经网关发 `tools/call`（MCP 协议调工具的标准 JSON-RPC 方法）调 `siyuan-mcp-*` 工具；若 siyuan-mcp 直连（不经网关）则用不到经网关这一步。

### 注入设计

- `ctx.session.hook("context")`：会话**首次**模型调用时拉标题级索引（一条 SQL），push 进 `event.system`
- 按 sessionID 去重；注入失败（思源离线 / 超时）标记该会话、本进程内不再重试——避免思源挂着时每轮模型调用都等 10s
- 注入单独 10s 超时；失败静默跳过，不影响会话；服务重启后恢复

## 安全设计

- **加载期零 I/O**：MCP 连接懒初始化，思源 / 代理离线时加载不受影响
- **setup 全程 try/catch**：任何异常只 `console.error`，绝不向 PluginSupervisor 抛
- **工具 executor 全部内部 catch**：失败返回错误文本，不产生未处理 rejection
- **API 漂移防御**：`ctx.tool.transform` / `ctx.session.hook` 不存在时静默跳过对应功能，插件降级不炸会话

## License

[MIT](./LICENSE)
