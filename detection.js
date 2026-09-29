// detection.js — git commit 命令检测（commit 提醒 nudge 用）。
//
// 判断一条 shell 命令是否执行了 git commit。按 shell 操作符（| / || / && / ;）
// 和换行分段逐段判断，避免 `git log | grep commit` 这类管道误判；段内要求
// 首 token 是 git 且 commit 为独立 token（`git log --grep=commit` 不误判）。
// 覆盖 `git -C <path> commit` / `git -c x=y commit` / `git --no-verify commit`
// 等前置 flag 写法。
//
// 换行也作分段符：shell 工具常以多行脚本形式跑命令，`git commit` 往往独占一行，
// 若不分换行，它会和前面的行粘在同一段、段首 token 不是 git 而漏检（2026-09-29 实测）。
//
// 分段是「引号感知」的（2026-09-29 修复）：单/双引号内的操作符与换行是字面量，
// 不作分段符。否则 `node -e "...git commit..."`、测试用例字符串、heredoc 里的
// `git commit` 会被切碎成「段首是 git commit」而误判——误判比漏检更糟（精度优先）。
//
// 已知缺口（软提醒下可接受的漏检，刻意不修）：
//   - `sudo git commit`（段首是 sudo）
//   - `sh -c "git commit"` / `bash -c '...'`（段首是 sh / bash）
//   - 子 shell `(git commit ...)`、命令替换 `$(git commit ...)`
//   - heredoc 正文里独占一行的 `git commit`（`cat <<EOF\ngit commit\nEOF`）
// nudge 是软提醒，漏检时模型仍可按 AGENTS.md 检查点规则自发 mem_progress 兜底，
// 故接受这些漏检；重点是别误判（精度优先）。

// 引号感知地按 shell 操作符（| / || / && / ; / & / 换行）切分命令。
// 单/双引号内的操作符与换行是字面量，不作分段符；反斜杠转义按 shell 规则处理
// （双引号内 \" 与 \\ 为转义，单引号内一切字面量）。
function splitSegments(cmd) {
  const segs = [];
  let cur = "";
  let quote = null; // null | "'" | '"'
  let i = 0;
  const push = () => {
    segs.push(cur);
    cur = "";
  };
  while (i < cmd.length) {
    const ch = cmd[i];
    if (quote === "'") {
      // 单引号内一切字面量，直到闭合 '
      cur += ch;
      if (ch === "'") quote = null;
      i++;
      continue;
    }
    if (quote === '"') {
      // 双引号内 \" 与 \\ 为转义，其余字面量，直到闭合 "
      if (
        ch === "\\" &&
        i + 1 < cmd.length &&
        (cmd[i + 1] === '"' || cmd[i + 1] === "\\")
      ) {
        cur += ch + cmd[i + 1];
        i += 2;
        continue;
      }
      cur += ch;
      if (ch === '"') quote = null;
      i++;
      continue;
    }
    // 引号外
    if (ch === "\\") {
      cur += ch + (cmd[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      quote = '"';
      cur += ch;
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "\r") {
      push();
      i++;
      continue;
    }
    if (ch === "&") {
      push();
      i += cmd[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "|") {
      push();
      i += cmd[i + 1] === "|" ? 2 : 1;
      continue;
    }
    cur += ch;
    i++;
  }
  push();
  return segs;
}

export function isGitCommitCommand(cmd) {
  if (typeof cmd !== "string") return false;
  // 带参全局 flag（其后紧跟一个参数 token）；= 形式（--git-dir=x）参数在 token 内
  const GLOBAL_FLAGS_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree"]);
  return splitSegments(cmd).some((seg) => {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    if (toks[0] !== "git") return false;
    // 跳过 git 全局 flag（及其参数），定位子命令；要求子命令恰为 commit，
    // 避免 `git log commit`（commit 作 pathspec）这类误判
    let i = 1;
    while (i < toks.length && toks[i].startsWith("-")) {
      i += 1;
      if (GLOBAL_FLAGS_WITH_ARG.has(toks[i - 1]) && !toks[i - 1].includes("=")) i += 1;
    }
    return toks[i] === "commit";
  });
}
