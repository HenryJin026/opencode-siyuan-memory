// tools.js — siyuan-memory 的 5 个 mem_* 工具定义（OpenCode V2 形状：
// { name, description, input: JSONSchema, execute(input, context) }）。
//
// 存储：思源 agent-memory notebook，经 mcptool 代理的 siyuan-mcp-* 工具。
// 布局：/<project-slug>/<记忆名>（记忆名 = doc 标题 = hpath 末段）。
// 属性：memtype（user/feedback/project/reference）+ project + description
//       落在 blocks.ial（SiYuan 保留键 type 不可用，故用 memtype）。
//
// 安全：每个 executor 都 try/catch，失败返回错误文本（工具级失败），
// 绝不向 opencode 运行时抛未处理异常。

const NB_NAME = "agent-memory";
const MEM_TYPES = ["user", "feedback", "project", "reference"];

// ---------- 底层 helper ----------

async function notebookId(client, signal) {
  const text = await client.callTool("siyuan-mcp-notebook", { action: "list" }, { signal });
  const m = text.split("\n").find((l) => l.includes(`- ${NB_NAME} (id:`));
  const id = m?.match(/\(id: ([0-9a-z-]+)/)?.[1];
  if (!id) throw new Error(`思源里找不到 notebook「${NB_NAME}」`);
  return id;
}

// 解析 siyuan-mcp-sql 的 markdown 表格结果 → 行对象数组。
function parseSqlTable(text) {
  if (!text || text.trim() === "no results") return [];
  const lines = text.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 3) return [];
  const cells = (l) =>
    l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
  const headers = cells(lines[0]);
  const rows = [];
  for (const line of lines.slice(2)) {
    if (cells(line).every((c) => /^-+$/.test(c))) continue; // 分隔行
    const row = {};
    headers.forEach((h, i) => (row[h] = cells(line)[i] ?? ""));
    rows.push(row);
  }
  return rows;
}

async function sql(client, stmt, signal, timeoutMs) {
  const text = await client.callTool(
    "siyuan-mcp-sql",
    { action: "query", stmt },
    { signal, timeoutMs },
  );
  return parseSqlTable(text);
}

// 按 hpath 找 agent-memory 里的 doc id（hpath 形如 /<project>/<记忆名>）。
async function docIdByHpath(client, nb, hpath, signal) {
  const rows = await sql(
    client,
    `SELECT id FROM blocks WHERE box='${nb}' AND hpath='${hpath}' AND type='d'`,
    signal,
  );
  return rows[0]?.id;
}

// 从 ial 字符串里抽 key="value" 属性。
function parseIal(ial) {
  const out = {};
  for (const m of ial?.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function splitFileName(fileName) {
  if (typeof fileName !== "string" || !fileName.trim()) throw new Error("file_name 不能为空");
  const segments = fileName.split("/").map((s) => s.trim());
  for (const s of segments) {
    if (!s) throw new Error(`file_name 含空段：${fileName}`);
    if (s === "." || s === "..") throw new Error(`file_name 不允许 . / ..：${fileName}`);
  }
  if (segments.length < 2) throw new Error(`file_name 需为 <project>/<记忆名> 形式：${fileName}`);
  return { project: segments[0], title: segments.slice(1).join("/") };
}

// ---------- 系统提示注入用：标题级记忆索引 ----------

// 生成 agent-memory 全量记忆的标题级索引（渐进披露：只给标题/类型/描述，
// 全文靠 mem_read）。空库返回 ""（不注入无意义内容）。
//
// projectCandidates：当前项目的 slug 候选（如 ["daily"] 或 ["GithubRes-ninfer"]）。
// 命中时走混合格式：当前项目带描述 + 其它项目只留标题（省 token）；
// 全部未命中时退回全量带描述索引（兜底，不比不传候选差）。
export async function buildMemoryIndex(client, { signal, timeoutMs, projectCandidates } = {}) {
  const n = await notebookId(client, signal);
  const rows = await sql(
    client,
    `SELECT id, hpath, ial FROM blocks WHERE box='${n}' AND type='d' AND ial LIKE '%memtype=%'`,
    signal,
    timeoutMs,
  );
  if (rows.length === 0) return "";

  const MAX_LINES = 150;
  const withDesc = (r) => {
    const attrs = parseIal(r.ial);
    const desc = attrs.description ? `：${attrs.description}` : "";
    return `- [${r.hpath}] (${attrs.memtype ?? "?"})${desc}`;
  };
  const titleOnly = (r) => {
    const attrs = parseIal(r.ial);
    return `- ${r.hpath} (${attrs.memtype ?? "?"})`;
  };

  // 混合模式：当前项目（带描述）+ 其它项目（仅标题）
  if (projectCandidates?.length) {
    const isCurrent = (r) => projectCandidates.includes(parseIal(r.ial).project);
    const current = rows.filter(isCurrent);
    if (current.length > 0) {
      const others = rows.filter((r) => !isCurrent(r));
      const othersLines = others.map(titleOnly);
      const othersBody =
        othersLines.length > MAX_LINES
          ? othersLines.slice(0, MAX_LINES).join("\n") + `\n… 另有 ${othersLines.length - MAX_LINES} 条，用 mem_search 查`
          : othersLines.join("\n");
      return (
        `跨项目记忆索引（思源 agent-memory，共 ${rows.length} 条，当前项目 ${current.length} 条）：\n` +
        `## 当前项目\n${current.map(withDesc).join("\n")}\n` +
        `## 其它项目（仅标题）\n${othersBody}\n` +
        "需要全文用 mem_read（file_name = <project>/<记忆名>）；按关键词用 mem_search。"
      );
    }
    // 当前项目无记忆 → 落到下方全量索引
  }

  const lines = rows.map(withDesc);
  const body =
    lines.length > MAX_LINES
      ? lines.slice(0, MAX_LINES).join("\n") + `\n… 另有 ${lines.length - MAX_LINES} 条，用 mem_search 查`
      : lines.join("\n");
  return (
    `跨项目记忆索引（思源 agent-memory，共 ${rows.length} 条）：\n${body}\n` +
    "需要全文用 mem_read（file_name = <project>/<记忆名>）；按关键词用 mem_search。"
  );
}

export function buildMemTools(client) {
  let cachedNb = null;
  const nb = async (signal) => (cachedNb ??= await notebookId(client, signal));

  return {
    mem_save: {
      name: "mem_save",
      description:
        "把一条跨项目记忆存入思源 agent-memory notebook（mem_* 系列的写入口）。" +
        "file_name 形如 <project>/<记忆名>——末段即思源 doc 标题（= hpath 末段），" +
        "mem_read / mem_delete 都按这个 file_name 定位。" +
        "同名记忆已存在时覆盖（旧 doc 删除后重建）。" +
        "仅在用户明确要求记住某事时调用；先用 mem_list / mem_search 查重。",
      input: {
        type: "object",
        properties: {
          file_name: {
            type: "string",
            description: "<project-slug>/<记忆名>，如 daily/build-process、llamaOn/docker-gotcha；末段即 doc 标题",
          },
          name: { type: "string", description: "可选：显示名（存为属性）；doc 标题以 file_name 末段为准" },
          description: { type: "string", description: "一句话描述，供日后判断相关性" },
          type: {
            type: "string",
            enum: MEM_TYPES,
            description: "记忆类型：user / feedback / project / reference",
          },
          content: { type: "string", description: "记忆正文（markdown）" },
        },
        required: ["file_name", "type", "content"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const { project, title } = splitFileName(input.file_name);
          const signal = context?.signal;
          const n = await nb(signal);

          // 1. 项目目录 doc 必须先存在（思源不自动建父目录）
          if (!(await docIdByHpath(client, n, `/${project}`, signal))) {
            await client.callTool(
              "siyuan-mcp-document",
              { action: "create", notebook: n, path: "/", title: project },
              { signal },
            );
          }
          // 2. 同名旧 doc → 删除（覆盖语义）
          const oldId = await docIdByHpath(client, n, `/${project}/${title}`, signal);
          if (oldId) {
            await client.callTool("siyuan-mcp-document", { action: "delete", id: oldId }, { signal });
          }
          // 3. 建新 doc（path 传完整路径：父目录段 + 叶子；hpath 叶子 = title）
          const created = await client.callTool(
            "siyuan-mcp-document",
            { action: "create", notebook: n, path: `/${project}/${title}`, title, markdown: input.content },
            { signal },
          );
          const newId = created.match(/document created: ([0-9a-z-]+)/)?.[1];
          if (!newId) throw new Error(`document.create 返回无法解析：${created}`);
          // 4. 打属性（memtype 不是保留键；type 是 SiYuan 保留键，不可用）
          const attrs = { memtype: input.type, project };
          if (input.name) attrs.name = input.name;
          if (input.description) attrs.description = input.description;
          await client.callTool("siyuan-mcp-attr", { action: "set", id: newId, attrs }, { signal });
          return {
            content: `记忆已存入 /${project}/${title}（id ${newId}，memtype ${input.type}）。` +
              "注意：思源写库有延迟，立即 mem_search 可能搜不到，隔几秒再查。",
          };
        } catch (err) {
          return { content: `mem_save 失败：${err.message}` };
        }
      },
    },

    mem_search: {
      name: "mem_search",
      description:
        "跨项目全文搜索思源 agent-memory 里的记忆（只返回 agent-memory notebook 的命中，不含用户其它笔记）。" +
        "回答涉及本机环境事实 / 操作规范 / 历史决策前，先搜再答。",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词（全文匹配）" },
          project: { type: "string", description: "可选：只看某项目的记忆（hpath 前缀过滤）" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const signal = context?.signal;
          const n = await nb(signal);
          const text = await client.callTool("siyuan-mcp-search", { action: "fulltext", query: input.query }, { signal });
          if (!text || text.startsWith("No results")) return { content: `没有匹配「${input.query}」的记忆。` };

          // 解析命中条目：`- [hpath] Type` + 片段 + `id: xxx`
          const entries = [];
          const chunks = text.split(/\n(?=- \[)/);
          for (const chunk of chunks) {
            const head = chunk.match(/^- \[(.*?)\] ([\w]+)/m);
            const idm = chunk.match(/^  id: ([0-9a-z-]+)/m);
            if (head && idm) {
              const snippet = chunk
                .split("\n")
                .slice(1)
                .filter((l) => !l.startsWith("  id:"))
                .join(" ")
                .replace(/<mark>/g, "")
                .replace(/<\/mark>/g, "")
                .trim();
              entries.push({ hpath: head[1], id: idm[1], snippet });
            }
          }
          if (entries.length === 0) return { content: `没有匹配「${input.query}」的记忆。` };

          // 只保留 agent-memory notebook 的命中（box 过滤）
          const ids = entries.map((e) => e.id);
          const rows = await sql(
            client,
            `SELECT id, box, hpath FROM blocks WHERE id IN (${ids.map((i) => `'${i}'`).join(",")})`,
            signal,
          );
          const kept = new Set(rows.filter((r) => r.box === n).map((r) => r.id));
          const hits = entries.filter((e) => kept.has(e.id));
          const filtered = input.project
            ? hits.filter((e) => e.hpath === input.project || e.hpath.startsWith(`/${input.project}/`))
            : hits;
          if (filtered.length === 0) return { content: `「${input.query}」在 agent-memory 里没有命中。` };
          const lines = filtered.map(
            (e) => `- [${e.hpath}] (id ${e.id})\n  ${e.snippet.slice(0, 160)}${e.snippet.length > 160 ? "..." : ""}`,
          );
          return {
            content:
              `${filtered.length} 条记忆命中「${input.query}」：\n${lines.join("\n")}\n` +
              "读全文用 mem_read（file_name = <project>/<记忆名>）。",
          };
        } catch (err) {
          return { content: `mem_search 失败：${err.message}` };
        }
      },
    },

    mem_read: {
      name: "mem_read",
      description: "读一条跨项目记忆的全文（思源 agent-memory）。file_name 形如 <project>/<记忆名>。",
      input: {
        type: "object",
        properties: {
          file_name: { type: "string", description: "<project-slug>/<记忆名>" },
        },
        required: ["file_name"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const { project, title } = splitFileName(input.file_name);
          const signal = context?.signal;
          const n = await nb(signal);
          const id = await docIdByHpath(client, n, `/${project}/${title}`, signal);
          if (!id) return { content: `找不到记忆 ${input.file_name}（agent-memory 里没有这个 doc）。` };
          const md = await client.callTool("siyuan-mcp-export", { action: "md", id }, { signal });
          return { content: md };
        } catch (err) {
          return { content: `mem_read 失败：${err.message}` };
        }
      },
    },

    mem_list: {
      name: "mem_list",
      description: "列出思源 agent-memory 里已存的跨项目记忆（标题 / 类型 / 描述）。存新记忆前先用它查重。",
      input: {
        type: "object",
        properties: {
          project: { type: "string", description: "可选：只列某项目的记忆" },
        },
        additionalProperties: false,
      },
      async execute(_input, context) {
        try {
          const signal = context?.signal;
          const n = await nb(signal);
          const project = _input?.project;
          const stmt =
            `SELECT id, hpath, ial FROM blocks WHERE box='${n}' AND type='d'` +
            (project ? ` AND ial LIKE '%project="${project}"%'` : "");
          const rows = await sql(client, stmt, signal);
          if (rows.length === 0) return { content: project ? `项目 ${project} 下还没有记忆。` : "agent-memory 里还没有记忆。" };
          const lines = rows.map((r) => {
            const attrs = parseIal(r.ial);
            const nm = attrs.name ? ` ${attrs.name}` : "";
            const desc = attrs.description ? `：${attrs.description}` : "";
            return `- [${r.hpath}]${nm} (memtype: ${attrs.memtype ?? "?"}, id ${r.id})${desc}`;
          });
          return { content: `${rows.length} 条记忆：\n${lines.join("\n")}` };
        } catch (err) {
          return { content: `mem_list 失败：${err.message}` };
        }
      },
    },

    mem_delete: {
      name: "mem_delete",
      description: "删除一条过时的跨项目记忆（思源 agent-memory）。file_name 形如 <project>/<记忆名>。",
      input: {
        type: "object",
        properties: {
          file_name: { type: "string", description: "<project-slug>/<记忆名>" },
        },
        required: ["file_name"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const { project, title } = splitFileName(input.file_name);
          const signal = context?.signal;
          const n = await nb(signal);
          const id = await docIdByHpath(client, n, `/${project}/${title}`, signal);
          if (!id) return { content: `找不到记忆 ${input.file_name}，无需删除。` };
          await client.callTool("siyuan-mcp-document", { action: "delete", id }, { signal });
          return { content: `记忆 ${input.file_name} 已删除（id ${id}）。` };
        } catch (err) {
          return { content: `mem_delete 失败：${err.message}` };
        }
      },
    },
  };
}
