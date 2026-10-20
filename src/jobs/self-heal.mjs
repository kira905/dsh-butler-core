// ops-core / src/jobs/self-heal.mjs —— 自愈 job（最小闭环的"能修一点东西"一段）
//
// 两段式（刻意分开，因为它们的安全等级不同）：
//   ① ensure —— 永远执行：建目录、初始化缺失的状态文件。这是"让系统能跑"，不是"自动修复"。
//   ② repair —— 只在 mode=act 且 auto.selfHeal=true 时执行：清过期锁、清陈旧 .tmp 残留。
//
// 幂等判据：第二次跑 ensure 列表为空、repair 动作 0 个（状态文件已存在 / 没有过期锁）。
import fs from 'node:fs';
import path from 'node:path';
import { appendAudit } from '../audit.mjs';
import { alert } from '../alert.mjs';
import { defaultAutonomy, isAutoAllowed, readAutonomy } from '../autonomy.mjs';
import { ensureDir, opsPaths } from '../paths.mjs';
import { listLocks, readJson, writeJsonAtomic } from '../store.mjs';

const STALE_TMP_MS = 24 * 60 * 60 * 1000;

/** 确保一个 JSON 状态文件存在（缺失则写默认；损坏走 readJson 的备份逻辑）。 */
function ensureJson(file, defaultValue, initialized) {
  if (!fs.existsSync(file)) {
    writeJsonAtomic(file, defaultValue);
    initialized.push(path.basename(file));
    return true;
  }
  // 存在但坏：readJson 会备份并返回默认值（不在这里静默覆盖，避免吞掉用户的半截写入）
  try { readJson(file); } catch { /* 留给下次显式报错 */ }
  return false;
}

export function makeSelfHealJob({ home } = {}) {
  return async function selfHeal(ctx) {
    const p = opsPaths(ctx.home);
    const initialized = [];
    // ── ① ensure：永远执行 ────────────────────────────────────────────────
    for (const dir of [p.home, p.auditDir, p.reportsDir, p.locksDir, p.changelogDir]) ensureDir(dir);
    // autonomy：缺失时建默认（并记 autonomy.init 审计）
    if (!fs.existsSync(p.autonomy)) {
      const { created } = readAutonomy({ home: ctx.home, ensure: true });
      if (created) initialized.push('ops-autonomy.json');
    }
    ensureJson(p.tickd, { schemaVersion: 1, runs: [], jobs: {} }, initialized);
    ensureJson(p.queue, { schemaVersion: 1, items: [] }, initialized);
    ensureJson(p.notifyState, { schemaVersion: 1, processed: [], lastRunAt: null }, initialized);

    // ── ② repair：双闸放行才执行 ──────────────────────────────────────────
    const { state } = readAutonomy({ home: ctx.home, ensure: true });
    const gate = isAutoAllowed(state, 'selfHeal');
    let repaired = 0;
    const actions = [];
    if (gate.allowed) {
      // 过期锁：删除；未过期的不碰
      for (const lock of listLocks(ctx.home)) {
        if (!lock.expired) continue;
        try {
          fs.rmSync(lock.file, { force: true });
          repaired += 1;
          actions.push({ action: 'clear-stale-lock', file: lock.name });
        } catch (e) {
          alert({ level: 'warn', source: 'ops-self-heal', message: `清理过期锁失败：${lock.name}（${e?.message ?? e}）` }, { home: ctx.home, silent: true });
        }
      }
      // 陈旧 .tmp（>24h）：删除；当天的保留（可能正在写）
      try {
        for (const name of fs.readdirSync(ctx.home)) {
          if (!name.endsWith('.tmp')) continue;
          const full = path.join(ctx.home, name);
          const st = fs.statSync(full);
          if (Date.now() - st.mtimeMs <= STALE_TMP_MS) continue;
          fs.rmSync(full, { force: true });
          repaired += 1;
          actions.push({ action: 'clear-stale-tmp', file: name });
        }
      } catch { /* home 不可读：忽略，别让自愈自己炸 */ }
    }

    if (initialized.length || repaired) {
      try {
        const line = JSON.stringify({ at: new Date(ctx.now).toISOString(), initialized, repaired, actions }) + '\n';
        fs.appendFileSync(p.healLog, line, 'utf8');
      } catch { /* 产物写失败不影响主流程 */ }
      appendAudit({ kind: 'self-heal', initialized: initialized.length, repaired, actions }, { home: ctx.home, silent: true });
    }
    ctx.log(`初始化 ${initialized.length} 个状态文件 / 修复动作 ${repaired} 个${gate.allowed ? '' : `（修复未放行：${gate.reason}）`}`);
    return { ok: true, detail: { initialized, repaired, autoAllowed: gate.allowed, reason: gate.reason, actions } };
  };
}

/** 给 CLI / 测试用：默认值（避免 import 两处常量漂移）。 */
export const SELF_HEAL_DEFAULTS = {
  autonomy: defaultAutonomy,
};
