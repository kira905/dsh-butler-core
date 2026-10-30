// 第 13 项的"该不该跑"判据：**禁止对没实现 --help 的命令跑 --help** + 整批墙钟边界
//
// 这条红线是方案 §3.2-C 的结论：对没实现 --help 的命令，`--help` 会被当普通参数忽略、
// 脚本照常导出/归档/改状态 ⇒ 它不是"看一眼"，是**真动作**。所以要有两道闸：
//   ① 清单校验强制 helpVerified / readonlyBecause
//   ② 执行前 planProbe 再核一遍（本文件测的就是这一道）
import { planProbe, shouldDegradeBatch, PROBE_SKIP_REASON } from '../scripts/lib/probe-plan.mjs';

export const name = '第 13 项探针计划（禁跑未核 --help）';

export async function run(c) {
  // ---------------------------------------------------------------- existence：零执行
  {
    c.eq(planProbe({ type: 'plugin', probe: { kind: 'existence' } }).mode, 'existence', 'existence 只查存在，不产生执行计划');
    c.eq(planProbe({ type: 'plugin', probe: {} }).mode, 'existence', 'probe 不给 kind 时默认 existence（绝不默认去执行）');
  }

  // ---------------------------------------------------------------- help：没核过就不跑
  {
    const p = planProbe({ type: 'cli', probe: { kind: 'help', cmd: 'board-snapshot-export' } });
    c.eq(p.mode, 'skip', '没给 helpVerified 的 help 探针 ⇒ 拒绝执行');
    c.eq(p.code, 'help-not-verified', '拒绝理由要可判（help-not-verified）');
    c.contains(p.why, '真动作', '文案要说明为什么不能跑');
  }
  {
    const p = planProbe({ type: 'cli', probe: { kind: 'help', cmd: 'board-archive-bulk', helpVerified: { file: 'board-archive-bulk.mjs', line: 84 } } });
    c.eq(p.mode, 'exec', '核过 --help 的命令才允许执行');
    c.eq(p.args, ['--help'], '执行参数就是 --help');
    c.eq(p.label, 'board-archive-bulk --help', 'label 用于 detail');
  }
  {
    const p = planProbe({ type: 'cli', probe: { kind: 'help', helpVerified: { file: 'x.mjs' } } });
    c.eq(p.mode, 'skip', '缺 cmd 的 help 探针同样拒跑');
    c.eq(p.code, 'no-cmd', '缺 cmd 的理由是 no-cmd');
  }

  // ---------------------------------------------------------------- cmd：说不出凭什么只读就不跑
  {
    const p = planProbe({ type: 'cli', probe: { kind: 'cmd', cmd: 'rulecheck' } });
    c.eq(p.mode, 'skip', '没写 readonlyBecause 的 cmd 探针 ⇒ 拒绝执行');
    c.eq(p.code, 'cmd-not-readonly-proven', '理由可判');
  }
  {
    const p = planProbe({ type: 'cli', probe: { kind: 'cmd', cmd: 'rulecheck', readonlyBecause: '只扫文件不出报告', args: ['dod', '--file', 'x.md'] } });
    c.eq(p.mode, 'exec', '写了 readonlyBecause 才允许执行');
    c.eq(p.args, ['dod', '--file', 'x.md'], '参数照清单给的传');
  }

  // ---------------------------------------------------------------- 未知类型：不猜、不跑
  {
    const p = planProbe({ type: 'cli', probe: { kind: 'run-whatever' } });
    c.eq(p.mode, 'skip', '不认识的 probe.kind 一律不跑');
    c.eq(p.code, 'unknown-kind', '理由可判');
    c.contains(PROBE_SKIP_REASON['unknown-kind'], '只认 existence / help / cmd', '文案说清只认这三种');
  }

  // ---------------------------------------------------------------- 整批墙钟
  {
    c.eq(shouldDegradeBatch(0, 1000, 30000), false, '用了 1 秒 < 30 秒上限 ⇒ 继续跑');
    c.eq(shouldDegradeBatch(0, 30000, 30000), false, '正好到上限 ⇒ 还没超，继续');
    c.eq(shouldDegradeBatch(0, 30001, 30000), true, '超一点就算超（剩余整体降级）');
    c.eq(shouldDegradeBatch(0, 900, 1000), false, '夹具可把上限压小来测（--probe-batch）');
    c.eq(shouldDegradeBatch('x', 1, 2), false, '参数不合法时不降级（不制造假 SKIP）');
  }
}
