// ops-core / src/state-files.mjs —— 状态文件清单的单一数据源
//
// 这张表同时服务三处：日报的健康检查、CLI 的 `state` 子命令、README / 复刻手册。
// 每项都要回答：谁写的、缺了会怎样、能不能重建、能不能出机器。
import fs from 'node:fs';
import { readInstanceState } from './lock.mjs';
import { opsPaths } from './paths.mjs';
import { readJson } from './store.mjs';

export const STATE_FILES = [
  {
    id: 'autonomy',
    path: (p) => p.autonomy,
    name: 'ops-autonomy.json',
    schema: 1,
    writer: 'ops-autonomy / ops-tickd',
    purpose: '自主矩阵：档位（observe/report/act）+ 模块开关 + auto 动作开关 + job 覆盖项',
    required: true,
    onMissing: '自动建默认（全关 / observe），并记一行 autonomy.init 审计',
    rebuildable: true,
    sensitive: false,
    manual: '**别删**：删了等于把所有闸门恢复默认（安全，但丢你的放行记录）。可以 `ops-autonomy status` 随时看。',
  },
  {
    id: 'tickd',
    path: (p) => p.tickd,
    name: 'ops-tickd.json',
    schema: 1,
    writer: 'ops-tickd',
    purpose: '调度状态：最近 50 次 tick 的读数 + 每个 job 的上次状态/计数',
    required: false,
    onMissing: '自动建默认（空 runs / 空 jobs）',
    rebuildable: true,
    sensitive: false,
    manual: '可删（只影响"上次跑到哪"的参考值，不影响 job 本身）。',
  },
  {
    id: 'queue',
    path: (p) => p.queue,
    name: 'ops-queue.json',
    schema: 1,
    writer: '你的业务 / 手工',
    purpose: '待通知队列：{ items: [{ id, level, message, createdAt }] }',
    required: false,
    onMissing: '自动建空队列（items: []），并在 job 详情里记 queue.created=true',
    rebuildable: true,
    sensitive: false,
    manual: '可删（会丢未处理的通知条目）。这是**唯一由使用者喂数据**的文件。',
  },
  {
    id: 'notify-state',
    path: (p) => p.notifyState,
    name: 'ops-notify-state.json',
    schema: 1,
    writer: 'queue-notify job',
    purpose: '通知去重：processed[]（已发过的 queue item id）+ lastRunAt',
    required: false,
    onMissing: '自动建默认（processed: []）——注意：这会让你重发历史通知',
    rebuildable: true,
    sensitive: false,
    manual: '**别手删**（除非你确实想重发）。要单独重发某条，把它从 processed[] 移出即可。',
  },
  {
    id: 'notify-outbox',
    path: (p) => p.notifyOutbox,
    name: 'ops-notify-outbox.jsonl',
    schema: null,
    writer: 'queue-notify job（file 适配器）',
    purpose: '本地通知产物：一行一条 JSON。默认不接任何外发通道',
    required: false,
    onMissing: '首次通知时自动创建',
    rebuildable: false,
    sensitive: false,
    manual: '可删（是产物，不是状态；但删了就丢了"发过什么"的记录）。',
  },
  {
    id: 'audit',
    path: (p) => p.auditDir,
    name: 'ops-audit/YYYY-MM.jsonl',
    schema: null,
    writer: 'appendAudit（所有写动作）',
    purpose: 'append-only 审计流水，带 prev/hash 哈希链；证明系统做过什么',
    required: false,
    onMissing: '首次写审计时自动创建目录',
    rebuildable: false,
    sensitive: false,
    manual: '**别删**：它是追责与排障的唯一凭据。损坏时 `ops-tickd --state` 会报链断点。',
  },
  {
    id: 'alert-log',
    path: (p) => p.alertLog,
    name: 'ops-alert.log',
    schema: null,
    writer: 'alert（组件自身故障）',
    purpose: '告警日志：一行一条 JSON（warn / error）',
    required: false,
    onMissing: '首次告警时自动创建',
    rebuildable: false,
    sensitive: false,
    manual: '可删（是产物）。但出现连续告警时先看它。',
  },
  {
    id: 'reports',
    path: (p) => p.reportsDir,
    name: 'ops-reports/YYYY-MM-DD.md',
    schema: null,
    writer: 'daily-report job',
    purpose: '日报产物（本骨架的"可见产物"）',
    required: false,
    onMissing: '第一次 daily-report 时自动建目录与文件',
    rebuildable: true,
    sensitive: false,
    manual: '可删（下次 tick 会重建当天的）。',
  },
  {
    id: 'instance',
    path: (p) => p.instanceLock,
    name: 'ops-locks/ops-tickd-instance.lock',
    schema: 1,
    writer: 'scheduler.ensure()（实例级单例锁）',
    purpose: '调度器单实例：谁的 pid 拿着锁；同名 `.beat` 心跳只作证据（不作判据）',
    required: false,
    onMissing: '首次 ensure() 时创建；崩溃留下的孤儿锁由下一次 ensure 按「pid 已不存在 / pid 被复用」回收',
    rebuildable: true,
    sensitive: false,
    manual: '**别手删**：删了等于允许起第二个调度器进程（两个一起跑会重复发通知）。要确认谁在跑：`ops-tickd --state`。',
  },
  {
    id: 'locks',
    path: (p) => p.locksDir,
    name: 'ops-locks/*.lock',
    schema: null,
    writer: 'scheduler / store',
    purpose: '单例互斥锁（内容含 pid / at / ttlMs）；进程崩溃会留下过期锁',
    required: false,
    onMissing: '首次加锁时自动建目录',
    rebuildable: true,
    sensitive: false,
    manual: '可删（但别在 tick 正在跑时删）。过期锁由 self-heal（需 act + auto.selfHeal）清理。',
  },
  {
    id: 'heal-log',
    path: (p) => p.healLog,
    name: 'ops-heal-log.jsonl',
    schema: null,
    writer: 'self-heal job',
    purpose: '自愈动作流水（初始化了哪些文件 / 清了哪些锁）',
    required: false,
    onMissing: '首次修复动作时自动创建',
    rebuildable: true,
    sensitive: false,
    manual: '可删（是产物）。排查"谁在什么时候清过锁"时看它。',
  },
  {
    id: 'changelog',
    path: (p) => p.changelogDir,
    name: 'ops-changelog/YYYY-MM.md',
    schema: null,
    writer: 'ops-changelog add',
    purpose: '变更流水（记账最小件；也可用 --file 指到你自己的 changelog）',
    required: false,
    onMissing: '第一次 add 时自动创建',
    rebuildable: false,
    sensitive: false,
    manual: '可删（是产物）。团队协作时建议用 --file 指到仓库里的 CHANGELOG。',
  },
];

/** 清单 + 当前状态（给 CLI / 日报用）。 */
export function inspectStateFiles(home) {
  const p = opsPaths(home);
  return STATE_FILES.map((f) => {
    const file = f.path(p);
    let exists = false;
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = fs.statSync(file);
      exists = true;
      size = st.size;
      mtimeMs = Math.round(st.mtimeMs);
    } catch { /* missing */ }
    let parse = null;
    if (exists && f.name.endsWith('.json')) {
      try { readJson(file); parse = true; } catch { parse = false; }
    }
    return { ...f, file, exists, size, mtimeMs, parse };
  });
}

/** 只读的"一句话健康"：缺几个必需件 / 有没有坏 JSON / 调度器有没有停摆。 */
export function healthSummary(home, opts = {}) {
  const rows = inspectStateFiles(home);
  const missingRequired = rows.filter((r) => r.required && !r.exists).map((r) => r.name);
  const corrupt = rows.filter((r) => r.parse === false).map((r) => r.name);
  // 失败环：只读地算"连续几个周期没写出新状态"（不告警、不写盘 —— 告警由 scheduler.checkLiveness 发）
  const liveness = instanceLiveness(home, opts);
  return {
    rows, missingRequired, corrupt, liveness,
    ok: missingRequired.length === 0 && corrupt.length === 0,
  };
}

/**
 * 实例状态 + 失败环读数（只读）。
 * 为什么单独导出而不塞进 healthSummary：调用方常常只想知道"调度器还在动吗"，不想顺手算全表。
 * @param {string} home
 * @param {{intervalMs?:number, cycles?:number, now?:number, lockName?:string}} [opts]
 */
export function instanceLiveness(home, opts = {}) {
  const snap = readInstanceState(home, opts);
  return {
    ...snap.liveness,
    instance: snap.instance,
    lock: snap.lock,
    lockFile: snap.lockFile,
    heartbeat: snap.heartbeat,
    lastStateWriteAt: snap.lastStateWriteAt,
  };
}
