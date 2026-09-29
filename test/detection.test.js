// test/detection.test.js — isGitCommitCommand 回归单测。
// 直接 node 跑：node test/detection.test.js（node v24 自动按 ESM 加载 detection.js）。
// 全过退出码 0，任一失败退出码 1。
import { isGitCommitCommand } from "../detection.js";

const cases = [
  // [命令, 期望, 说明]
  ["git commit -m x", true, "基本写法"],
  ["git commit", true, "无参 commit"],
  ["git -C /path commit -m x", true, "前置 -C flag"],
  ["git -c user.name=x commit", true, "前置 -c flag"],
  ["git --no-verify commit", true, "前置 --no-verify"],
  ["git add .\ngit commit -m x", true, "多行：commit 独占一行"],
  ["cd repo\ngit commit -m x\ngit log --oneline -1", true, "多行脚本里夹 commit"],
  ["git commit -m x && git push", true, "&& 后接 push 仍含 commit"],
  ["git log | grep commit", false, "管道：commit 是 grep 参数，不误判"],
  ["git log --grep=commit", false, "commit 在 flag 值里，不误判"],
  ['echo "git commit"', false, "commit 在 echo 字符串里，段首是 echo"],
  ["git log commit", false, "commit 作 pathspec（段首 git 但非 commit 子命令）"],
  ["sudo git commit -m x", false, "已知缺口：段首 sudo（软提醒可接受漏检）"],
  ['sh -c "git commit -m x"', false, "已知缺口：段首 sh"],
  ["npm test", false, "非 git 命令"],
  ["", false, "空命令"],
  [null, false, "非字符串入参"],
];

let pass = 0;
let fail = 0;
for (const [cmd, expected, note] of cases) {
  const got = isGitCommitCommand(cmd);
  if (got === expected) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL [${note}]: isGitCommitCommand(${JSON.stringify(cmd)}) = ${got}, 期望 ${expected}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed (共 ${cases.length} 例)`);
process.exit(fail === 0 ? 0 : 1);
