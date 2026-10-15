// tools.js — siyuan-memory 的 6 个 mem_* 工具定义（OpenCode V2 形状：
// { name, description, input: JSONSchema, execute(input, context) }）。
//
// 存储：思源 agent-memory notebook，经 alltool 代理的 siyuan-mcp-* 工具。
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

// ---------- slug 变体归一（防 /<末段> 与 /<父段-末段> 分裂成两个项目目录）----------
//
// 一个项目的 slug 有两个候选形式：末段（Infernix）与 父段-末段（GithubRes-Infernix），
// 见 index.js slugCandidates。两者指同一项目。已有 slug 集合里若存在某候选，
// 就应归一到它，避免各建各的目录（2026-10-12 /Infernix 与 /GithubRes-Infernix 并存事故根因）。

// 同一项目的 slug 集合：input + 与已有 slug 中互为「末段 / 父段-末段」变体的。
// C 与 input 同项目 ⟺ C === input，或 C 以 "-"+input 结尾（C=父段-末段、input=末段），
// 或 input 以 "-"+C 结尾（input=父段-末段、C=末段）。
export function slugAliases(input, existingSlugs) {
  const set = new Set([input]);
  for (const c of existingSlugs) {
    if (c === input) continue;
    if (c.endsWith("-" + input) || input.endsWith("-" + c)) set.add(c);
  }
  return set;
}

// 写入归一：优先落到已存在的 slug（多候选取最短 = 末段形式，即仓库文件夹名，
// 不带 父段- 前缀）；无已存在候选则原样返回（新建项目，不归一）。
export function normalizeSlug(input, existingSlugs) {
  const aliases = slugAliases(input, existingSlugs);
  const existing = [...aliases].filter((s) => existingSlugs.has(s));
  if (existing.length === 0) return input;
  return existing.sort((a, b) => a.length - b.length)[0];
}

// ---------- 系统提示注入用：标题级记忆索引 ----------

// 拉全量记忆行（网络 I/O）。返回 [{ id, hpath, ial }, ...]。
export async function fetchMemoryRows(client, { signal, timeoutMs } = {}) {
  const n = await notebookId(client, signal);
  return sql(
    client,
    `SELECT id, hpath, ial FROM blocks WHERE box='${n}' AND type='d' AND ial LIKE '%memtype=%'`,
    signal,
    timeoutMs,
  );
}

// 纯本地格式化：按 projectCandidates 切分 + 拼装索引文本（无网络 I/O）。
// 空行返回 ""（不注入无意义内容）。
export function formatMemoryIndex(rows, projectCandidates) {
  if (!rows || rows.length === 0) return "";

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

// 兼容入口：fetch + format。
export async function buildMemoryIndex(client, { signal, timeoutMs, projectCandidates } = {}) {
  const rows = await fetchMemoryRows(client, { signal, timeoutMs });
  return formatMemoryIndex(rows, projectCandidates);
}

export function buildMemTools(client) {
  let cachedNb = null;
  const nb = async (signal) => (cachedNb ??= await notebookId(client, signal));

  // 项目 slug 缓存（mem_search 漏出哨兵用）：agent-memory 里所有记忆 doc 的
  // hpath 首段集合。5 分钟 TTL，mem_save 后失效。
  let slugCache = null; // { slugs: Set<string>, at: number }
  const SLUG_TTL_MS = 5 * 60 * 1000;
  async function projectSlugs(signal) {
    if (slugCache && Date.now() - slugCache.at < SLUG_TTL_MS) return slugCache.slugs;
    const n = await nb(signal);
    const rows = await sql(
      client,
      `SELECT hpath FROM blocks WHERE box='${n}' AND type='d' AND ial LIKE '%memtype=%'`,
      signal,
    );
    const slugs = new Set();
    for (const r of rows) {
      const seg = r.hpath?.split("/")[1];
      if (seg) slugs.add(seg);
    }
    slugCache = { slugs, at: Date.now() };
    return slugs;
  }

  // 统一的「存一条记忆」底层逻辑（mem_save / mem_progress 共用）：
  // 建父目录 doc（若缺）→ 去重父目录 → 删同名旧 doc（覆盖）→ 建新 doc → 打属性。
  // 返回新 doc id。
  //
  // 串行化：saveMemory 全程持锁。并发 mem_save / mem_progress 对同一新项目的
  // 「父目录不存在」检查会同时通过、双双创建 → 重复父目录 doc（2026-10-08
  // GithubRes-ninfer-custom 双目录事故根因：两个 doc 同时间戳 20261008193814）。
  // 串行后检查-创建不再交错。
  let saveChain = Promise.resolve();
  function withSaveLock(fn) {
    const run = saveChain.then(() => fn());
    saveChain = run.then(
      () => {},
      () => {},
    ); // 前一个失败不污染后续
    return run;
  }

  // 某 doc 的直接子文档数（按 blocks.path 前缀 /<docId>/ 计）。
  async function childCount(n, docId, signal) {
    const rows = await sql(
      client,
      `SELECT COUNT(*) AS n FROM blocks WHERE box='${n}' AND path LIKE '/${docId}/%' AND type='d'`,
      signal,
    );
    return Number(rows[0]?.n ?? 0);
  }

  // 同一 hpath 下若有多个 doc（并发创建 / 历史残留），保留子文档最多的那个
  // （真容器），删掉其余（空壳）。必须在建叶子 doc 之前调用，否则新叶子可能
  // 挂到将被删的空壳下。无重复时仅一次 SQL 查询即返回（开销可忽略）。
  async function dedupHpath(n, hpath, signal) {
    const rows = await sql(
      client,
      `SELECT id FROM blocks WHERE box='${n}' AND hpath='${hpath}' AND type='d'`,
      signal,
    );
    if (rows.length < 2) return;
    let keep = rows[0].id;
    let keepCount = -1;
    for (const r of rows) {
      const c = await childCount(n, r.id, signal);
      if (c > keepCount) {
        keepCount = c;
        keep = r.id;
      }
    }
    for (const r of rows) {
      if (r.id !== keep) {
        await client.callTool("siyuan-mcp-document", { action: "delete", id: r.id }, { signal });
      }
    }
  }

  // 删叶子后 GC：父目录 doc 若已零子文档（空壳），一并删掉，不留 /<project> 空壳。
  // 只删「确实空」的父目录，有子文档的不动。
  async function gcEmptyParent(n, project, signal) {
    const parents = await sql(
      client,
      `SELECT id FROM blocks WHERE box='${n}' AND hpath='/${project}' AND type='d'`,
      signal,
    );
    for (const r of parents) {
      if ((await childCount(n, r.id, signal)) === 0) {
        await client.callTool("siyuan-mcp-document", { action: "delete", id: r.id }, { signal });
      }
    }
  }

  // 保存后预置新 slug 进 slugCache：复用现有缓存（或缓存失效时新鲜查询拿已有 slug 全集）+ 新 slug。
  // 避免下次 projectSlugs() 依赖 SQL 索引——刚建 doc 的 IAL 滞后 ~10s 才进索引，
  // 期间 projectSlugs() 查不到新 slug → 误判新 slug → 硬拦截误挡（2026-10-15 实测 edge case）。
  async function seedSlugCache(project, signal) {
    let base;
    if (slugCache && Date.now() - slugCache.at < SLUG_TTL_MS) {
      base = slugCache.slugs;
    } else {
      const n = await nb(signal);
      const rows = await sql(
        client,
        `SELECT hpath FROM blocks WHERE box='${n}' AND type='d' AND ial LIKE '%memtype=%'`,
        signal,
      );
      base = new Set();
      for (const r of rows) {
        const seg = r.hpath?.split("/")[1];
        if (seg) base.add(seg);
      }
    }
    slugCache = { slugs: new Set([...base, project]), at: Date.now() };
  }

  async function saveMemory(args) {
    return withSaveLock(() => doSaveMemory(args));
  }

  async function doSaveMemory({ project, title, content, memtype, name, description, signal }) {
    const n = await nb(signal);
    // 1. 项目目录 doc 必须先存在（思源不自动建父目录）
    if (!(await docIdByHpath(client, n, `/${project}`, signal))) {
      await client.callTool(
        "siyuan-mcp-document",
        { action: "create", notebook: n, path: "/", title: project },
        { signal },
      );
    }
    // 1b. 去重父目录：若存在重复 doc（并发创建 / 历史残留），保留有子文档的，删空壳
    await dedupHpath(n, `/${project}`, signal);
    // 2. 同名旧 doc → 删除（覆盖语义）
    const oldId = await docIdByHpath(client, n, `/${project}/${title}`, signal);
    if (oldId) {
      await client.callTool("siyuan-mcp-document", { action: "delete", id: oldId }, { signal });
    }
    // 3. 建新 doc（path 传完整路径：父目录段 + 叶子；hpath 叶子 = title）
    const created = await client.callTool(
      "siyuan-mcp-document",
      { action: "create", notebook: n, path: `/${project}/${title}`, title, markdown: content },
      { signal },
    );
    const newId = created.match(/document created: ([0-9a-z-]+)/)?.[1];
    if (!newId) throw new Error(`document.create 返回无法解析：${created}`);
    // 4. 打属性（memtype 不是保留键；type 是 SiYuan 保留键，不可用）
    const attrs = { memtype, project };
    if (name) attrs.name = name;
    if (description) attrs.description = description;
    await client.callTool("siyuan-mcp-attr", { action: "set", id: newId, attrs }, { signal });
    // 预置新 slug 进缓存（复用现有缓存或新鲜查询 + 新 slug），避免下次 projectSlugs() 依赖滞后的 SQL 索引
    await seedSlugCache(project, signal);
    return newId;
  }

  return {
    mem_save: {
      name: "mem_save",
      description:
        "把一条跨项目记忆存入思源 agent-memory notebook（mem_* 系列的写入口）。" +
        "file_name 形如 <project>/<记忆名>——末段即思源 doc 标题（= hpath 末段），" +
        "mem_read / mem_delete 都按这个 file_name 定位。" +
        "创建新项目 slug 时，从当前工作目录末段推导（= 仓库文件夹名，不带 父段- 前缀；当前目录见 env 块 / Get-Location）；例：工作目录 D:/.../GithubRes/ninfer → slug ninfer。" +
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
          newProject: { type: "boolean" },
        },
        required: ["file_name", "type", "content"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          const { project: rawProject, title } = splitFileName(input.file_name);
          const signal = context?.signal;
          const slugs = await projectSlugs(signal);
          const project = normalizeSlug(rawProject, slugs);
          const normalized = project !== rawProject;
          // 硬拦截：新 slug（不匹配已有项目）默认不建，需传 newProject=true 确认，防 typo 静默分裂。
          // newProject 不写进描述（避免模型习惯性传 true 滥用），只在被挡时经返回文本告知。
          const isNew = !slugs.has(project);
          if (isNew && !input.newProject) {
            return {
              content: `新 slug「${project}」未匹配到已有项目，未创建。确认是新建项目请传 newProject=true 重调。`,
            };
          }
          const newId = await saveMemory({
            project,
            title,
            content: input.content,
            memtype: input.type,
            name: input.name,
            description: input.description,
            signal,
          });
          let note = "";
          if (normalized) note += `（slug 已归一：${rawProject} → ${project}）`;
          if (isNew) note += "（已确认新建项目）";
          return {
            content: `记忆已存入 /${project}/${title}（id ${newId}，memtype ${input.type}）${note}。` +
              "注意：思源写库有延迟，立即 mem_search 可能搜不到，隔几秒再查。",
          };
        } catch (err) {
          return { content: `mem_save 失败：${err.message}` };
        }
      },
    },

    mem_progress: {
      name: "mem_progress",
      description:
        "记录 / 更新一个项目的「工作状态」快照（<project>/progress，覆盖写，永远只有一份）。" +
        "跨会话延续用：阶段性工作做到检查点时调用，新会话 mem_read 它就能接上当前状态。" +
        "project slug 从当前工作目录末段推导（= 仓库文件夹名，不带 父段- 前缀；当前目录见 env 块 / Get-Location）。" +
        "content 用 markdown，按 5 节模板写（空节省略）：## 当前状态 / ## 已完成 / ## 下一步 / ## 关键决策 / ## 关键上下文。" +
        "边界——当前状态=现在时事实；已完成=过去时工作项（一条一个，不放状态/流程说明）；下一步=将来时动作；关键决策=取舍记录（选了什么+为什么）；关键上下文=背景参考。",
      input: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description: "项目 slug（如 ninfer、GithubRes-ninfer、daily），单个、不含 /",
          },
          content: {
            type: "string",
            description:
              "当前状态 markdown，按 5 节模板写（空节省略）：\n" +
              "## 当前状态\n<现在时事实：git/同步/部署状态、在跑什么、健康度>\n" +
              "## 已完成\n- <工作项（功能/修复/决策），可带 commit ref，一条一个>\n" +
              "## 下一步\n- <待办/下一步动作/可选增强/未决问题>\n" +
              "## 关键决策\n- <选了什么 + 为什么>\n" +
              "## 关键上下文\n<参考源、坑、依赖、回归基线>",
          },
          description: {
            type: "string",
            description: "可选：一句话当前状态摘要（供索引显示，新会话靠它判断要不要 mem_read 全文）",
          },
          newProject: { type: "boolean" },
        },
        required: ["project", "content"],
        additionalProperties: false,
      },
      async execute(input, context) {
        try {
          if (
            typeof input.project !== "string" ||
            !input.project.trim() ||
            input.project.includes("/")
          ) {
            throw new Error(`project 需为单个 slug（不含 /）：${input.project}`);
          }
          const rawProject = input.project.trim();
          const signal = context?.signal;
          const slugs = await projectSlugs(signal);
          const project = normalizeSlug(rawProject, slugs);
          const normalized = project !== rawProject;
          // 硬拦截：新 slug 默认不建，需传 newProject=true 确认（同 mem_save，不写进描述防滥用）。
          const isNew = !slugs.has(project);
          if (isNew && !input.newProject) {
            return {
              content: `新 slug「${project}」未匹配到已有项目，未创建。确认是新建项目请传 newProject=true 重调。`,
            };
          }
          const newId = await saveMemory({
            project,
            title: "progress",
            content: input.content,
            memtype: "project",
            description: input.description,
            signal,
          });
          let note = "";
          if (normalized) note += `（slug 已归一：${rawProject} → ${project}）`;
          if (isNew) note += "（已确认新建项目）";
          return {
            content: `进度已更新 /${project}/progress（id ${newId}）${note}。` +
              "注意：思源写库有延迟，立即 mem_search 可能搜不到，隔几秒再查。",
          };
        } catch (err) {
          return { content: `mem_progress 失败：${err.message}` };
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
          // notebook 参数限定结果集（内核源码：硬 box=? 过滤，修召回）；
          // pageSize 防默认页大小截断。
          const text = await client.callTool(
            "siyuan-mcp-search",
            { action: "fulltext", query: input.query, notebook: n, pageSize: 100 },
            { signal },
          );
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

          // 漏出哨兵：只保留 hpath 首段属于已知项目 slug 的命中（= agent-memory 的）。
          // notebook 参数已是硬 box=? 过滤，正常不会有条目被滤掉；若滤掉，
          // 说明内核 FTS 过滤回归，记录探针。
          const slugs = await projectSlugs(signal);
          const hits = entries.filter((e) => slugs.has(e.hpath.split("/")[1]));
          const leaked = entries.length - hits.length;
          if (leaked > 0) {
            console.log(`[siyuan-memory] mem_search「${input.query}」检测到 ${leaked} 条非 agent-memory 命中（notebook 过滤疑似失效）`);
          }
          // project 过滤用候选式：slug 变体（末段 / 父段-末段）都命中，与注入逻辑对齐。
          let filtered = hits;
          if (input.project) {
            const slugs = await projectSlugs(signal);
            const aliases = slugAliases(input.project, slugs);
            filtered = hits.filter((e) => aliases.has(e.hpath.split("/")[1]));
          }
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
          const { project: rawProject, title } = splitFileName(input.file_name);
          const signal = context?.signal;
          const n = await nb(signal);
          // 叶子可能落在任一 slug 变体下，逐个别名 hpath 找，命中即停。
          const slugs = await projectSlugs(signal);
          const aliases = [...slugAliases(rawProject, slugs)];
          let id = null;
          for (const a of aliases) {
            id = await docIdByHpath(client, n, `/${a}/${title}`, signal);
            if (id) break;
          }
          if (!id) {
            // 读取模糊兜底：同标题（任意项目）+ 该项目下其它记忆，供模型选对，而非静默 not found
            const byTitle = await sql(
              client,
              `SELECT hpath FROM blocks WHERE box='${n}' AND type='d' AND ial LIKE '%memtype=%' AND hpath LIKE '%/${title}'`,
              signal,
            );
            const byProject = await sql(
              client,
              `SELECT hpath FROM blocks WHERE box='${n}' AND type='d' AND ial LIKE '%memtype=%' AND hpath LIKE '/${rawProject}/%'`,
              signal,
            );
            const suggestions = [...new Set([...byTitle, ...byProject].map((r) => r.hpath))].slice(0, 10);
            if (suggestions.length > 0) {
              return {
                content:
                  `找不到记忆 ${input.file_name}。相近的有：\n${suggestions.map((s) => `- ${s}`).join("\n")}\n` +
                  "用 mem_read 传正确的 file_name 重读。",
              };
            }
            return { content: `找不到记忆 ${input.file_name}（agent-memory 里没有这个 doc，也没有相近的）。` };
          }
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
          let stmt = `SELECT id, hpath, ial FROM blocks WHERE box='${n}' AND type='d' AND ial LIKE '%memtype=%'`;
          if (project) {
            // 候选式：slug 变体（末段 / 父段-末段）都命中，与注入逻辑对齐。
            const slugs = await projectSlugs(signal);
            const aliases = [...slugAliases(project, slugs)];
            const conds = aliases.map((a) => `ial LIKE '%project="${a}"%'`).join(" OR ");
            stmt += ` AND (${conds})`;
          }
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
          const { project: rawProject, title } = splitFileName(input.file_name);
          const signal = context?.signal;
          const n = await nb(signal);
          // 叶子可能落在任一 slug 变体下，逐个别名 hpath 找，命中即停。
          const slugs = await projectSlugs(signal);
          const aliases = [...slugAliases(rawProject, slugs)];
          let id = null;
          let usedProject = rawProject;
          for (const a of aliases) {
            id = await docIdByHpath(client, n, `/${a}/${title}`, signal);
            if (id) {
              usedProject = a;
              break;
            }
          }
          if (!id) return { content: `找不到记忆 ${input.file_name}，无需删除。` };
          await client.callTool("siyuan-mcp-document", { action: "delete", id }, { signal });
          // GC：删叶子后父目录若零子文档（空壳），一并删掉，不留 /<project> 空壳。
          await gcEmptyParent(n, usedProject, signal);
          return { content: `记忆 ${input.file_name} 已删除（id ${id}）。` };
        } catch (err) {
          return { content: `mem_delete 失败：${err.message}` };
        }
      },
    },
  };
}
