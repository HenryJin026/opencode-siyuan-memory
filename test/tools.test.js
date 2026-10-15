// test/tools.test.js — saveMemory 父目录去重 / 并发串行化回归单测。
// 直接 node 跑：node test/tools.test.js（node v24 自动按 ESM 加载 tools.js）。
// 全过退出码 0，任一失败退出码 1。
//
// 背景：2026-10-08 事故——并发 mem_save 对同一新项目双双创建父目录 doc，
// 产生两个同 hpath 的 /GithubRes-ninfer-custom（同时间戳 20261008193814）。
// 本测试用 mock client 模拟思源状态，验证：
//   1. 并发保存同一新项目 → 恰好一个父目录 doc（串行化生效）
//   2. 历史重复父目录 → 去重保留有子文档的真容器、删空壳
import { buildMemTools, slugAliases, normalizeSlug } from "../tools.js";

// ---------- mock SiYuan 状态机 ----------
// docs: Map<hpath, Array<{id}>>（允许同 hpath 多个，模拟重复创建）
// children: Map<parentId, Set<childId>>
// memtype: Set<id>（有 memtype 属性 = 记忆 doc，非父目录空壳）
// project: Map<id, slug>（attr set 时记录的 project 属性）
class MockSiyuan {
  constructor() {
    this.nb = "nb-test";
    this.docs = new Map();
    this.children = new Map();
    this.memtype = new Set();
    this.project = new Map();
    this.idSeq = 0;
  }
  nextId() {
    this.idSeq++;
    return `20261008000000-${String(this.idSeq).padStart(7, "0")}`;
  }
  addDoc(hpath, parentId) {
    const id = this.nextId();
    if (!this.docs.has(hpath)) this.docs.set(hpath, []);
    this.docs.get(hpath).push({ id });
    if (parentId) {
      if (!this.children.has(parentId)) this.children.set(parentId, new Set());
      this.children.get(parentId).add(id);
    }
    return id;
  }
  removeDoc(id) {
    for (const [hpath, arr] of this.docs) {
      const i = arr.findIndex((d) => d.id === id);
      if (i >= 0) arr.splice(i, 1);
      if (arr.length === 0) this.docs.delete(hpath);
    }
    for (const set of this.children.values()) set.delete(id);
    this.memtype.delete(id);
    this.project.delete(id);
  }
  docCreate(args) {
    // args: { notebook, path, title }。path 语义（对齐 saveMemory 用法）：
    //   建父目录时 path="/"（根），新 doc hpath = /<title>；
    //   建叶子时 path=完整 hpath（/<proj>/<title>），新 doc 就建在该 hpath。
    const { path, title } = args;
    let hpath, parentHpath;
    if (path === "/") {
      hpath = `/${title}`;
      parentHpath = "";
    } else if (path.endsWith(`/${title}`)) {
      hpath = path;
      parentHpath = path.slice(0, path.lastIndexOf("/"));
    } else {
      hpath = `${path}/${title}`;
      parentHpath = path;
    }
    let parentId = null;
    if (parentHpath) {
      const p = this.docs.get(parentHpath);
      if (p && p.length > 0) parentId = p[0].id;
    }
    return this.addDoc(hpath, parentId);
  }
  // 所有记忆 doc（有 memtype 的）：[{ id, hpath }]
  memoryDocs() {
    const out = [];
    for (const [hpath, arr] of this.docs) {
      for (const d of arr) if (this.memtype.has(d.id)) out.push({ id: d.id, hpath });
    }
    return out;
  }
  sqlQuery(stmt) {
    // 1. projectSlugs：SELECT hpath FROM blocks WHERE ... ial LIKE '%memtype=%'（无 hpath LIKE）
    if (/^SELECT hpath FROM blocks/.test(stmt) && /memtype/.test(stmt) && !/hpath LIKE/.test(stmt)) {
      const rows = this.memoryDocs();
      if (rows.length === 0) return "no results";
      return `| hpath |\n|---|\n${rows.map((r) => `| ${r.hpath} |`).join("\n")}`;
    }
    // 2. 模糊兜底 byTitle：SELECT hpath FROM blocks ... hpath LIKE '%/<title>'
    let m = stmt.match(/hpath LIKE '%\/([^']+)'/);
    if (m && /SELECT hpath FROM blocks/.test(stmt)) {
      const rows = this.memoryDocs().filter((r) => r.hpath.endsWith(`/${m[1]}`));
      if (rows.length === 0) return "no results";
      return `| hpath |\n|---|\n${rows.map((r) => `| ${r.hpath} |`).join("\n")}`;
    }
    // 3. 模糊兜底 byProject：SELECT hpath FROM blocks ... hpath LIKE '/<project>/%'
    m = stmt.match(/hpath LIKE '\/([^']+)\/%'/);
    if (m && /SELECT hpath FROM blocks/.test(stmt)) {
      const rows = this.memoryDocs().filter((r) => r.hpath.startsWith(`/${m[1]}/`));
      if (rows.length === 0) return "no results";
      return `| hpath |\n|---|\n${rows.map((r) => `| ${r.hpath} |`).join("\n")}`;
    }
    // 4. mem_list：SELECT id, hpath, ial FROM blocks WHERE ... memtype [AND (project 过滤)]
    if (/^SELECT id, hpath, ial FROM blocks/.test(stmt) && /memtype/.test(stmt)) {
      let rows = this.memoryDocs();
      const projMatches = [...stmt.matchAll(/project="([^"]+)"/g)].map((mm) => mm[1]);
      if (projMatches.length > 0) {
        rows = rows.filter((r) => projMatches.includes(this.project.get(r.id)));
      }
      if (rows.length === 0) return "no results";
      return (
        `| id | hpath | ial |\n|---|---|---|\n` +
        rows
          .map((r) => `| ${r.id} | ${r.hpath} | memtype=x project="${this.project.get(r.id) ?? ""}" |`)
          .join("\n")
      );
    }
    // 5. docIdByHpath / gcEmptyParent：SELECT id FROM blocks WHERE ... hpath='HP'
    m = stmt.match(/hpath='([^']+)'/);
    if (m && /SELECT id FROM blocks/.test(stmt)) {
      const docs = this.docs.get(m[1]) ?? [];
      if (docs.length === 0) return "no results";
      return `| id |\n|---|\n${docs.map((d) => `| ${d.id} |`).join("\n")}`;
    }
    // 6. childCount：SELECT COUNT(*) AS n FROM blocks WHERE ... path LIKE '/ID/%'
    m = stmt.match(/path LIKE '\/([^']+)\/%'/);
    if (m && /COUNT\(\*\)/.test(stmt)) {
      const count = (this.children.get(m[1]) ?? new Set()).size;
      return `| n |\n|---|\n| ${count} |`;
    }
    throw new Error(`mock sql 未处理：${stmt}`);
  }
  async callTool(name, args) {
    if (name === "siyuan-mcp-notebook" && args.action === "list") {
      return `Notebooks (1):\n\n- agent-memory (id: ${this.nb}, icon: 1f4dd, closed: false)`;
    }
    if (name === "siyuan-mcp-sql" && args.action === "query") {
      return this.sqlQuery(args.stmt);
    }
    if (name === "siyuan-mcp-document") {
      if (args.action === "create") return `document created: ${this.docCreate(args)}`;
      if (args.action === "delete") {
        this.removeDoc(args.id);
        return `document deleted: ${args.id}`;
      }
    }
    if (name === "siyuan-mcp-attr" && args.action === "set") {
      if (args.attrs?.memtype) this.memtype.add(args.id);
      if (args.attrs?.project) this.project.set(args.id, args.attrs.project);
      return "attrs set";
    }
    if (name === "siyuan-mcp-search" && args.action === "fulltext") {
      // 简化：全量命中所有记忆 doc，project 过滤由 mem_search 代码做。
      const rows = this.memoryDocs();
      if (rows.length === 0) return "No results";
      return rows
        .map((r) => `- [${r.hpath}] project\n  snippet for ${r.hpath}\n  id: ${r.id}`)
        .join("\n");
    }
    throw new Error(`mock 未处理：${name} ${args?.action}`);
  }
}

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL [${name}]: ${detail}`);
  }
}

async function run() {
  // ---- 测试 1：并发保存同一新项目 → 恰好一个父目录 doc ----
  {
    const client = new MockSiyuan();
    const tools = buildMemTools(client);
    await Promise.all([
      tools.mem_save.execute({ file_name: "newproj/mem-a", type: "project", content: "a" }, {}),
      tools.mem_save.execute({ file_name: "newproj/mem-b", type: "project", content: "b" }, {}),
    ]);
    const parents = client.docs.get("/newproj") ?? [];
    check(
      "并发保存只建一个父目录",
      parents.length === 1,
      `期望 1 个父目录 doc，实际 ${parents.length}（ids: ${parents.map((p) => p.id).join(", ")}）`,
    );
    // 两个叶子都应挂在唯一父目录下
    const parent = parents[0]?.id;
    const kids = parent ? [...(client.children.get(parent) ?? [])] : [];
    check(
      "两个叶子都挂在唯一父目录下",
      kids.length === 2,
      `期望 2 个子文档，实际 ${kids.length}`,
    );
  }

  // ---- 测试 2：历史重复父目录 → 去重保留有子文档的真容器 ----
  {
    const client = new MockSiyuan();
    const tools = buildMemTools(client);
    // 模拟历史残留：真容器 A 有 1 个子文档，空壳 B 无子文档
    const idA = client.addDoc("/dupproj");
    client.addDoc("/dupproj/mem-x", idA);
    const idB = client.addDoc("/dupproj");
    await tools.mem_save.execute({ file_name: "dupproj/mem-y", type: "project", content: "y" }, {});
    const parents = client.docs.get("/dupproj") ?? [];
    check(
      "去重后只剩一个父目录",
      parents.length === 1,
      `期望 1 个父目录 doc，实际 ${parents.length}（ids: ${parents.map((p) => p.id).join(", ")}）`,
    );
    check(
      "保留的是有子文档的真容器 A",
      parents[0]?.id === idA,
      `期望保留 ${idA}，实际 ${parents[0]?.id ?? "(无)"}`,
    );
    // 新叶子 mem-y 应挂在保留的真容器 A 下
    const kidsA = [...(client.children.get(idA) ?? [])];
    check(
      "新叶子挂到真容器 A 下",
      kidsA.length === 2,
      `真容器 A 下期望 2 个子文档（mem-x + mem-y），实际 ${kidsA.length}`,
    );
  }

  // ---- 测试 3：无重复时正常保存不受影响 ----
  {
    const client = new MockSiyuan();
    const tools = buildMemTools(client);
    const r = await tools.mem_save.execute({ file_name: "solo/mem-z", type: "project", content: "z" }, {});
    const parents = client.docs.get("/solo") ?? [];
    check("无重复时正常建一个父目录", parents.length === 1, `实际 ${parents.length}`);
    check(
      "返回新 doc id",
      typeof r?.content === "string" && r.content.includes("记忆已存入 /solo/mem-z"),
      `返回：${r?.content}`,
    );
  }

  // ---- 测试 4：写侧归一——末段变体落到已存在的父段-末段目录，不新建 /<末段> ----
  {
    const client = new MockSiyuan();
    const tools = buildMemTools(client);
    // 先建 canonical 项目（父段-末段形式）
    await tools.mem_save.execute({ file_name: "GithubRes-Infernix/mem-a", type: "project", content: "a" }, {});
    // 用末段变体存 → 应归一到 GithubRes-Infernix，不建 /Infernix 目录
    const r = await tools.mem_save.execute({ file_name: "Infernix/mem-b", type: "project", content: "b" }, {});
    check(
      "末段变体不新建 /Infernix 父目录",
      (client.docs.get("/Infernix") ?? []).length === 0,
      `实际 ${client.docs.get("/Infernix")?.length ?? 0}`,
    );
    check(
      "mem-b 落在 /GithubRes-Infernix 下",
      (client.docs.get("/GithubRes-Infernix/mem-b") ?? []).length === 1,
      `实际 ${client.docs.get("/GithubRes-Infernix/mem-b")?.length ?? 0}`,
    );
    check(
      "响应标注已归一",
      typeof r?.content === "string" && r.content.includes("Infernix → GithubRes-Infernix"),
      `返回：${r?.content}`,
    );
  }

  // ---- 测试 5：读侧候选过滤——mem_search project 命中末段变体记忆 ----
  {
    const client = new MockSiyuan();
    const tools = buildMemTools(client);
    // canonical 项目一条记忆（走 mem_save）
    await tools.mem_save.execute({ file_name: "GithubRes-Infernix/mem-a", type: "project", content: "a" }, {});
    // 手动建 /Infernix/mem-c（模拟历史分裂，绕过归一）
    client.docCreate({ notebook: client.nb, path: "/", title: "Infernix" });
    const leafC = client.docCreate({ notebook: client.nb, path: "/Infernix/mem-c", title: "mem-c" });
    client.memtype.add(leafC);
    client.project.set(leafC, "Infernix");
    // 搜 project=GithubRes-Infernix，候选过滤应命中 /Infernix/mem-c
    const r = await tools.mem_search.execute({ query: "x", project: "GithubRes-Infernix" }, {});
    check(
      "候选过滤命中末段变体记忆 /Infernix/mem-c",
      typeof r?.content === "string" && r.content.includes("/Infernix/mem-c"),
      `返回：${r?.content}`,
    );
    // 反向：搜一个无关项目应无命中
    const r2 = await tools.mem_search.execute({ query: "x", project: "unrelated" }, {});
    check(
      "无关项目无命中",
      typeof r2?.content === "string" && r2.content.includes("没有命中"),
      `返回：${r2?.content}`,
    );
  }

  // ---- 测试 6：删侧 GC——删唯一子文档后父目录空壳被一并删掉 ----
  {
    const client = new MockSiyuan();
    const tools = buildMemTools(client);
    await tools.mem_save.execute({ file_name: "gcproj/mem-only", type: "project", content: "x" }, {});
    check("删前父目录存在", (client.docs.get("/gcproj") ?? []).length === 1, `实际 ${client.docs.get("/gcproj")?.length ?? 0}`);
    await tools.mem_delete.execute({ file_name: "gcproj/mem-only" }, {});
    check(
      "GC：删唯一子文档后父目录空壳被删",
      (client.docs.get("/gcproj") ?? []).length === 0,
      `实际 ${client.docs.get("/gcproj")?.length ?? 0}`,
    );
  }

  // ---- 测试 7：helper 单测——slugAliases / normalizeSlug ----
  {
    const existing = new Set(["GithubRes-Infernix", "daily"]);
    check(
      "slugAliases：末段变体展开",
      [...slugAliases("Infernix", existing)].sort().join(",") === "GithubRes-Infernix,Infernix",
      `[${[...slugAliases("Infernix", existing)].join(", ")}]`,
    );
    check(
      "normalizeSlug：末段归一到父段-末段",
      normalizeSlug("Infernix", existing) === "GithubRes-Infernix",
      normalizeSlug("Infernix", existing),
    );
    check(
      "normalizeSlug：已存在 slug 原样保留",
      normalizeSlug("daily", existing) === "daily",
      normalizeSlug("daily", existing),
    );
    check(
      "normalizeSlug：全新 slug 不归一",
      normalizeSlug("brandnew", existing) === "brandnew",
      normalizeSlug("brandnew", existing),
    );
    check(
      "normalizeSlug：两变体并存取最短（末段，仓库文件夹名）",
      normalizeSlug("Infernix", new Set(["Infernix", "GithubRes-Infernix"])) === "Infernix",
      normalizeSlug("Infernix", new Set(["Infernix", "GithubRes-Infernix"])),
    );
    check(
      "normalizeSlug：父段-末段输入归一到末段",
      normalizeSlug("GithubRes-Infernix", new Set(["Infernix", "GithubRes-Infernix"])) === "Infernix",
      normalizeSlug("GithubRes-Infernix", new Set(["Infernix", "GithubRes-Infernix"])),
    );
  }

  // ---- 测试 8：写入校验——全新 slug 带「新 slug」警告，已有项目不带 ----
  {
    const client = new MockSiyuan();
    const tools = buildMemTools(client);
    const r = await tools.mem_save.execute({ file_name: "brandnewproj/mem-x", type: "project", content: "x" }, {});
    check(
      "全新 slug 带「新 slug」警告",
      typeof r?.content === "string" && r.content.includes("新 slug"),
      `返回：${r?.content}`,
    );
    const r2 = await tools.mem_save.execute({ file_name: "brandnewproj/mem-y", type: "project", content: "y" }, {});
    check(
      "已有项目不带「新 slug」警告",
      typeof r2?.content === "string" && !r2.content.includes("新 slug"),
      `返回：${r2?.content}`,
    );
  }

  // ---- 测试 9：读取模糊兜底——读不到时返回相近匹配 ----
  {
    const client = new MockSiyuan();
    const tools = buildMemTools(client);
    await tools.mem_save.execute({ file_name: "projA/real-mem", type: "project", content: "x" }, {});
    const r = await tools.mem_read.execute({ file_name: "projA/wrong-title" }, {});
    check(
      "读不到时返回相近匹配（含同项目其它记忆）",
      typeof r?.content === "string" && r.content.includes("相近的有") && r.content.includes("/projA/real-mem"),
      `返回：${r?.content}`,
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("测试运行异常：", err);
  process.exit(1);
});
