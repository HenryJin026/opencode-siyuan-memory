// test/tools.test.js — saveMemory 父目录去重 / 并发串行化回归单测。
// 直接 node 跑：node test/tools.test.js（node v24 自动按 ESM 加载 tools.js）。
// 全过退出码 0，任一失败退出码 1。
//
// 背景：2026-10-08 事故——并发 mem_save 对同一新项目双双创建父目录 doc，
// 产生两个同 hpath 的 /GithubRes-ninfer-custom（同时间戳 20261008193814）。
// 本测试用 mock client 模拟思源状态，验证：
//   1. 并发保存同一新项目 → 恰好一个父目录 doc（串行化生效）
//   2. 历史重复父目录 → 去重保留有子文档的真容器、删空壳
import { buildMemTools } from "../tools.js";

// ---------- mock SiYuan 状态机 ----------
// docs: Map<hpath, Array<{id}>>（允许同 hpath 多个，模拟重复创建）
// children: Map<parentId, Set<childId>>
class MockSiyuan {
  constructor() {
    this.nb = "nb-test";
    this.docs = new Map();
    this.children = new Map();
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
  sqlQuery(stmt) {
    // 1. SELECT id FROM blocks WHERE box='NB' AND hpath='HP' AND type='d'
    let m = stmt.match(/hpath='([^']+)'/);
    if (m && /SELECT id FROM blocks/.test(stmt)) {
      const docs = this.docs.get(m[1]) ?? [];
      if (docs.length === 0) return "no results";
      return `| id |\n|---|\n${docs.map((d) => `| ${d.id} |`).join("\n")}`;
    }
    // 2. SELECT COUNT(*) AS n FROM blocks WHERE box='NB' AND path LIKE '/ID/%' AND type='d'
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
    if (name === "siyuan-mcp-attr" && args.action === "set") return "attrs set";
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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("测试运行异常：", err);
  process.exit(1);
});
