// ops-core / src/jobs/daily-report.mjs —— 日报 job（骨架的"可见产物"）
//
// 为什么日报要幂等：如果每天重跑一次就多一份"今天干了 X"的记录，日报会变成
// 自己给自己灌水的日志。这里刻意只写**当天稳定的快照**（档位 / 状态文件存在性 /
// 队列统计 / 上次 job 状态），不写瞬时计数、不写生成时刻 ——
// 于是同一天重复跑，内容逐字节相同，job 直接跳过。
//
// 判据：文件已存在且内容 hash 相同 ⇒ { ok:true, detail:{ skipped:true } }，不写盘。
import fs from 'node:fs';
import path from 'node:path';
import { appendAudit } from '../audit.mjs';
import { readAutonomy } from '../autonomy.mjs';
import { dayKey, opsPaths } from '../paths.mjs';
import { healthSummary } from '../state-files.mjs';
import { readJson, writeTextAtomic } from '../store.mjs';
import { tailAlerts } from '../alert.mjs';
import { stableQueueId } from './queue-notify.mjs';

function render({ day, mode, modeNote, health, tickd, queueStats, notes }) {
  const lines = [];
  lines.push(`# 运维日报 · ${day}`);
  lines.push('');
  lines.push('> 由 `ops-tickd` 的 `daily-report` job 生成。同一份内容重复生成时不会重写（幂等）；跨天会生成新文件。');
  lines.push('');
  lines.push('## 1. 档位');
  lines.push('');
  lines.push(`- 当前档位：**${mode}** —— ${modeNote}`);
  lines.push('- 自主动作默认关闭；要开见文末「下一步」。');
  lines.push('');
  lines.push('## 2. 调度（上一次跑完的状态）');
  lines.push('');
  lines.push('| job | 上次状态 |');
  lines.push('|---|---|');
  for (const row of tickd) lines.push(`| ${row.id} | ${row.status} |`);
  lines.push('');
  lines.push('> 只列"上一次状态"，不写瞬时计数 —— 这是同一天重复跑结果逐字节一致的前提。');
  lines.push('');
  lines.push('## 3. 状态文件');
  lines.push('');
  lines.push('| 文件 | 存在 | 可解析 |');
  lines.push('|---|---|---|');
  for (const row of health.rows) {
    lines.push(`| \`${row.name}\` | ${row.exists ? '是' : '否'} | ${row.parse === null ? '—' : row.parse ? '是' : '**否**'} |`);
  }
  lines.push('');
  lines.push(`- 必需件缺失：${health.missingRequired.length ? health.missingRequired.join('、') : '0 个'}`);
  lines.push(`- 坏 JSON：${health.corrupt.length ? health.corrupt.join('、') : '0 个'}`);
  lines.push('');
  lines.push('## 4. 队列与通知');
  lines.push('');
  lines.push(`- 队列条目：${queueStats.queued}`);
  lines.push(`- 已通知：${queueStats.processed}`);
  lines.push(`- 待通知：${queueStats.pending}`);
  if (notes.length) {
    lines.push('- 最近条目：');
    for (const n of notes) lines.push(`  - \`[${n.level}]\` ${n.message}`);
  }
  lines.push('');
  lines.push('## 5. 告警');
  lines.push('');
  lines.push(`- 告警日志条数：${queueStats.alerts}`);
  lines.push('');
  lines.push('## 6. 下一步');
  lines.push('');
  lines.push('- 要清过期锁 / 真正修复：`ops-autonomy mode act` 然后 `ops-autonomy auto on selfHeal`');
  lines.push('- 要接自己的通知通道：见 README「接自己的通道」（仓库内不预置任何外发地址）');
  return lines.join('\n') + '\n';
}

export function makeDailyReportJob({ home } = {}) {
  return async function dailyReport(ctx) {
    const p = opsPaths(ctx.home);
    const day = dayKey(ctx.now);
    const file = path.join(p.reportsDir, `${day}.md`);
    const { state } = readAutonomy({ home: ctx.home, ensure: true });
    const modeNote = {
      observe: '只观察：写日报 / 审计 / 本地 outbox，不做修复',
      report: '只观察（同 observe，保留给"只发报告"的部署）',
      act: '可动手：仍需 auto.* 逐项放行',
    }[state.mode] ?? '未知档位';
    const health = healthSummary(ctx.home);
    const tickdState = readJson(p.tickd, { defaultValue: { runs: [], jobs: {} } });
    const tickd = ['queue-notify', 'self-heal'].map((id) => ({
      id,
      status: tickdState?.jobs?.[id]?.lastStatus ?? 'pending',
    }));
    const queue = readJson(p.queue, { defaultValue: { items: [] } });
    const notify = readJson(p.notifyState, { defaultValue: { processed: [] } });
    const items = Array.isArray(queue?.items) ? queue.items : [];
    const processed = new Set(Array.isArray(notify?.processed) ? notify.processed : []);
    const pending = items.filter((it, i) => !processed.has(String(it?.id ?? stableQueueId(it, i)))).length;
    const notes = items.slice(-3).map((it) => ({ level: it?.level ?? 'info', message: String(it?.message ?? '').slice(0, 120) }));
    const alerts = tailAlerts(1000, { home: ctx.home }).length;
    const body = render({
      day,
      mode: state.mode,
      modeNote,
      health,
      tickd,
      queueStats: { queued: items.length, processed: processed.size, pending, alerts },
      notes,
    });

    let skipped = false;
    if (fs.existsSync(file)) {
      try {
        if (fs.readFileSync(file, 'utf8') === body) skipped = true;
      } catch { /* 读失败就重写 */ }
    }
    if (!skipped) writeTextAtomic(file, body);
    appendAudit({ kind: 'daily-report', file, skipped, bytes: Buffer.byteLength(body, 'utf8') }, { home: ctx.home, silent: true });
    ctx.log(`日报 ${day}：${skipped ? '内容未变，跳过写盘' : '已写入'}（${path.basename(file)}）`);
    return { ok: true, detail: { file, day, skipped, bytes: Buffer.byteLength(body, 'utf8') } };
  };
}
