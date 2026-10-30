// 夹具总入口：逐个跑、汇总 PASS/FAIL 数，有一处红就 rc 1。
// 所有环境都由夹具自己造（临时目录里的假 home / 假 profile / 假包），
// 不读、不写任何真实安装，也不碰 DSH 的生产 home。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { makeChecker } from './lib/harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const modules = [
  'test-manifest.mjs', // 清单校验 + 版本区间三态 + 内置兜底清单
  'test-probe-plan.mjs', // 第 13 项"该不该跑"（禁跑未核 --help）+ 整批墙钟
  'test-dump-parse.mjs', // 第 12 项段解析 / 撞车口径 / 跳过归因 / 四格
  'test-global-paths.mjs', // W1 零 spawn 读盘探测
  'test-backcompat.mjs', // 旧 10 项不受清单影响
  'test-selfcheck-e2e.mjs', // 第 11/12/13 项端到端（假 home / 假包 / 假 dump）
  'test-instance-lock.mjs', // K2：调度器单实例守卫（活锁 / pid 撞号 / 孤儿双跑 / fail-open / 失败环）
  'test-mutation.mjs', // 把判定改反 ⇒ 夹具必须红
  'test-mutation-lock.mjs', // 同上，落点 = 单实例守卫（lock.mjs）
];

let pass = 0;
let fail = 0;
const failures = [];
const lines = [];

for (const file of modules) {
  const checker = makeChecker();
  let label = file;
  try {
    const mod = await import(`file://${path.join(here, file).replace(/\\/g, '/')}`);
    label = mod.name || file;
    await mod.run(checker);
  } catch (err) {
    checker.state.fail += 1;
    checker.state.failures.push(`（这个夹具自己抛错了）${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : err}`);
  }
  pass += checker.state.pass;
  fail += checker.state.fail;
  for (const f of checker.state.failures) failures.push(`${label} → ${f}`);
  lines.push(`${checker.state.fail === 0 ? 'PASS' : 'FAIL'}  ${label}  ${checker.state.pass}/${checker.state.pass + checker.state.fail}`);
}

process.stdout.write(`${lines.join('\n')}\n\n`);
if (fail) {
  process.stdout.write(`共 ${pass + fail} 条断言：${pass} 通过 / ${fail} 失败\n`);
  for (const f of failures) process.stdout.write(`  ✖ ${f}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`共 ${pass} 条断言：全部通过\n`);
  process.exitCode = 0;
}
