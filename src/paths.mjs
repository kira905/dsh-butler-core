// ops-core / src/paths.mjs —— 路径解析单点定义
//
// 三条约定（所有组件共用，禁止各脚本自己拼字符串）：
//   1. 状态根目录 = OPS_CORE_HOME > DSH_HOME > <用户主目录>/.dsh
//      （OPS_CORE_HOME 优先，是为了让一次快速试跑能完整隔离，连 DSH_HOME 都不必覆盖）
//   2. 组件根目录 = 本文件所在目录的上一级（realpath 兜住 junction / 软链接场景）
//   3. 所有路径都是绝对路径；相对路径入参按 resolve 处理，不依赖 cwd
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 组件根目录（<root>/src/paths.mjs）。realpath 兜住 junction：import.meta.url 会解析为物理路径。 */
export const COMPONENT_ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    return fs.realpathSync(path.join(here, '..'));
  } catch {
    return path.resolve(path.join(here, '..'));
  }
})();

/**
 * 状态根目录。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [explicit] 显式传入优先（CLI --home）
 */
export function resolveHome(explicit, env = process.env) {
  if (explicit && String(explicit).trim()) return path.resolve(String(explicit).trim());
  const fromEnv = String(env.OPS_CORE_HOME ?? env.DSH_HOME ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.dsh');
}

/** 状态文件 / 目录的集中定义。改文件名只改这里。 */
export function opsPaths(home = resolveHome()) {
  return {
    home,
    autonomy: path.join(home, 'ops-autonomy.json'),
    tickd: path.join(home, 'ops-tickd.json'),
    queue: path.join(home, 'ops-queue.json'),
    notifyState: path.join(home, 'ops-notify-state.json'),
    notifyOutbox: path.join(home, 'ops-notify-outbox.jsonl'),
    auditDir: path.join(home, 'ops-audit'),
    alertLog: path.join(home, 'ops-alert.log'),
    reportsDir: path.join(home, 'ops-reports'),
    locksDir: path.join(home, 'ops-locks'),
    // 实例级单例锁（锁的是"一个调度器进程"，与 job 锁不同；心跳只作证据）
    instanceLock: path.join(home, 'ops-locks', 'ops-tickd-instance.lock'),
    instanceBeat: path.join(home, 'ops-locks', 'ops-tickd-instance.lock.beat'),
    healLog: path.join(home, 'ops-heal-log.jsonl'),
    changelogDir: path.join(home, 'ops-changelog'),
  };
}

/** 幂等建目录。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 真实路径（不存在时返回 resolve 后的绝对路径）。凡"路径相等"判断一律走这里。 */
export function realOrResolve(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** 当前月份键（审计流水按月分文件 YYYY-MM.jsonl）。 */
export function monthKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 当天日期键（日报按天单文件 YYYY-MM-DD.md）。 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** runId：可读的时间戳 + pid + 随机后缀（排障时能在日志里定位到具体一次 tick）。 */
export function newRunId(prefix = 'run') {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${t}-${process.pid}-${r}`;
}

/** ISO 时间（统一出口，便于测试注入 clock）。 */
export function iso(ts = Date.now()) {
  return new Date(ts).toISOString();
}
