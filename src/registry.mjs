// ops-core / src/registry.mjs —— job 注册表（骨架的"调度骨架"核心）
//
// 三个 job 的顺序是有意的：queue-notify → self-heal → daily-report。
// 日报必须最后跑，才能读到"本轮已经落好的"队列与自愈结果；
// 否则同一天第二次跑时，日报会看到中间态而重写一次（破坏幂等）。
import { isModuleEnabled, readAutonomy } from './autonomy.mjs';
import { createScheduler } from './scheduler.mjs';
import { makeDailyReportJob } from './jobs/daily-report.mjs';
import { makeQueueNotifyJob } from './jobs/queue-notify.mjs';
import { makeSelfHealJob } from './jobs/self-heal.mjs';

export const JOB_ORDER = ['queue-notify', 'self-heal', 'daily-report'];

export const JOB_DEFS = {
  'queue-notify': { label: '队列通知（读队列 → 写本地 outbox）', intervalMs: 60_000, run: makeQueueNotifyJob },
  'self-heal': { label: '自愈（初始化状态 / 清过期锁）', intervalMs: 5 * 60_000, run: makeSelfHealJob },
  'daily-report': { label: '日报（写 ops-reports/<日期>.md）', intervalMs: 10 * 60_000, run: makeDailyReportJob },
};

/**
 * 建一个装好三个 job 的调度器。
 * @param {{home:string, logger?:(line:string)=>void, only?:string[]}} opts
 */
export function createOpsScheduler(opts) {
  const scheduler = createScheduler({ home: opts.home, logger: opts.logger });
  const { state } = readAutonomy({ home: opts.home, ensure: true });
  for (const id of JOB_ORDER) {
    const def = JOB_DEFS[id];
    scheduler.register({
      id,
      label: def.label,
      intervalMs: def.intervalMs,
      run: async (ctx) => {
        // 模块级总闸：关掉的 job 仍出现在结果里（status=ok, detail.disabled），
        // 但**不执行**任何逻辑 —— 这样 `module off` 是"改开关不是改代码"。
        // 每轮重读（而不是闭包快照）：常驻 tickd 也能感知运行期的开关变更。
        const { state: latest } = readAutonomy({ home: opts.home });
        if (!isModuleEnabled(latest, id)) return { ok: true, detail: { disabled: true } };
        return def.run({ home: opts.home })(ctx);
      },
    });
  }
  return { scheduler, autonomy: state };
}
