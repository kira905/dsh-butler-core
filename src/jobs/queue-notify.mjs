// ops-core / src/jobs/queue-notify.mjs —— 队列通知 job（最小闭环的"派通知"一段）
//
// 链路：读队列 → 逐条判定（是否已处理）→ 发一条通知 → 记 processed（去重）
// 默认通道 = 本地 outbox 文件；不带任何私聊/群机器人适配器（见 notify.mjs 的说明）。
//
// 幂等判据：同一条 queue item 的 id 只会发一次（processed[] 去重）。
// 失败语义：发送失败**不**标记 processed —— 下一轮重试；连续失败会出现在 job 状态与告警里。
import { appendAudit } from '../audit.mjs';
import { alert } from '../alert.mjs';
import { fileNotifier } from '../notify.mjs';
import { iso, opsPaths } from '../paths.mjs';
import { readJson, writeJsonAtomic } from '../store.mjs';

const MAX_PROCESSED = 500;

/** 稳定 id：item 没写 id 时按内容生成（避免每次跑都算成"新条目"）。 */
export function stableQueueId(item, index) {
  const base = `${item?.createdAt ?? ''}|${item?.level ?? ''}|${item?.message ?? ''}|${index}`;
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) | 0;
  return `q-${Math.abs(h).toString(36)}`;
}

/**
 * 造一个 queue-notify job。
 * @param {{home:string, notifier?:{name:string, send:(e:object)=>Promise<{ok:boolean}>}}} opts
 */
export function makeQueueNotifyJob({ home, notifier = null } = {}) {
  const send = notifier ?? fileNotifier({ home });
  return async function queueNotify(ctx) {
    const p = opsPaths(ctx.home);
    let created = false;
    const queue = readJson(p.queue, {
      defaultValue: { schemaVersion: 1, items: [] },
      onCorrupt: ({ backup, error }) => alert({ level: 'warn', source: 'ops-queue-notify', message: `队列文件损坏，已重建空队列（备份：${backup ?? '失败'}）`, detail: { error } }, { home: ctx.home }),
    });
    if (!queue || !Array.isArray(queue.items)) {
      // 结构不对：按空队列处理，但明确告警（不静默吞掉数据）
      alert({ level: 'warn', source: 'ops-queue-notify', message: '队列文件结构不合法（缺 items 数组），按空队列处理' }, { home: ctx.home });
    }
    const items = Array.isArray(queue?.items) ? queue.items : [];
    const state = readJson(p.notifyState, { defaultValue: { schemaVersion: 1, processed: [], lastRunAt: null } });
    const processed = new Set(Array.isArray(state?.processed) ? state.processed : []);

    let sent = 0;
    let failed = 0;
    let duplicate = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? {};
      const id = String(item.id ?? stableQueueId(item, i));
      if (!id) continue;
      if (processed.has(id)) { duplicate += 1; continue; }
      const r = await send.send({ id, level: item.level ?? 'info', message: item.message ?? '', source: item.source ?? 'ops-queue', createdAt: item.createdAt ?? null });
      if (r?.ok) {
        processed.add(id);
        sent += 1;
      } else {
        failed += 1;
        alert({ level: 'warn', source: 'ops-queue-notify', message: `通知发送失败：${id}（${r?.error ?? r?.status ?? 'unknown'}）` }, { home: ctx.home, silent: true });
      }
    }
    const processedList = [...processed].slice(-MAX_PROCESSED);
    const pending = items.filter((item, i) => !processed.has(String(item?.id ?? stableQueueId(item, i)))).length;
    writeJsonAtomic(p.notifyState, {
      schemaVersion: 1,
      processed: processedList,
      lastRunAt: iso(ctx.now),
      lastResult: { queued: items.length, sent, failed, pending },
    });
    appendAudit({ kind: 'queue.notify', queued: items.length, sent, failed, duplicate, pending, channel: send.name ?? 'file' }, { home: ctx.home, silent: true });
    ctx.log(`队列 ${items.length} 条 / 新发 ${sent} / 重复跳过 ${duplicate} / 待发 ${pending}`);
    return { ok: failed === 0, error: failed ? `${failed} 条通知发送失败` : undefined, detail: { queued: items.length, sent, failed, duplicate, pending, created } };
  };
}
