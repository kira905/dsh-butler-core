// ops-core / src/scheduler.mjs —— 轻量调度器（无常驻进程）
//
// 设计原则（与生产大管家的 tickd 同口径，但砍到最小）：
//   - 每个 job 独立注册：一个失败不拖垮其他（单 tick 抛错被隔离）
//   - 统一契约：run(ctx) 可返回 { ok, detail } / undefined / 抛错；调度器永不 reject
//   - 每个 job 执行前抢自己的锁：抢不到 = 静默跳过（不是失败）
//   - 记录每次 tick 的耗时 / 状态，落 ops-tickd.json（原子写，保留最近 50 次）
//   - 本模块不自己起定时器；常驻循环在 CLI 层（bin/ops-tickd.mjs --interval）
import { appendAudit } from './audit.mjs';
import { alert } from './alert.mjs';
import { iso, newRunId, opsPaths } from './paths.mjs';
import { acquireLock, readJson, updateJson } from './store.mjs';

export const TICKD_SCHEMA = 1;
const MAX_RUNS = 50;

/**
 * @param {{home:string, name?:string, logger?:(line:string)=>void, clock?:()=>number, audit?:boolean}} opts
 */
export function createScheduler(opts) {
  if (!opts?.home) throw new Error('createScheduler: 需要 home');
  const home = opts.home;
  const name = opts.name ?? 'ops-core';
  const clock = opts.clock ?? Date.now;
  const log = (msg) => {
    try {
      if (typeof opts.logger === 'function') opts.logger(msg);
      else process.stdout.write(`[ops-tickd] ${msg}\n`);
    } catch { /* 日志失败不影响调度 */ }
  };
  const doAudit = opts.audit !== false;
  const tasks = new Map();

  function register(spec) {
    if (!spec || typeof spec.id !== 'string' || !spec.id) throw new Error('scheduler.register: 需要字符串 id');
    if (tasks.has(spec.id)) throw new Error(`scheduler.register: id 重复 ${spec.id}`);
    if (typeof spec.run !== 'function') throw new Error(`scheduler.register: ${spec.id} 缺少 run(ctx)`);
    const intervalMs = Number(spec.intervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error(`scheduler.register: ${spec.id} intervalMs 必须为正数`);
    const task = {
      id: spec.id,
      label: spec.label ?? spec.id,
      intervalMs,
      ttlMs: Number.isFinite(spec.ttlMs) ? spec.ttlMs : Math.max(intervalMs * 2, 60_000),
      timeoutMs: Number.isFinite(spec.timeoutMs) ? spec.timeoutMs : 60_000,
      initialDelayMs: Number.isFinite(spec.initialDelayMs) ? spec.initialDelayMs : 0,
      run: spec.run,
      registeredAt: clock(),
      runs: 0,
      failures: 0,
      lastRunAt: 0,
      lastStatus: 'pending',
      lastDurationMs: null,
      lastError: null,
    };
    tasks.set(task.id, task);
    return () => tasks.delete(task.id);
  }

  function list() {
    return [...tasks.values()].map((t) => ({
      id: t.id, label: t.label, intervalMs: t.intervalMs,
      runs: t.runs, failures: t.failures, lastRunAt: t.lastRunAt ? iso(t.lastRunAt) : null,
      lastStatus: t.lastStatus, lastDurationMs: t.lastDurationMs, lastError: t.lastError,
    }));
  }

  function readState() {
    return readJson(opsPaths(home).tickd, { defaultValue: { schemaVersion: TICKD_SCHEMA, runs: [], jobs: {} } });
  }

  function persistTick(run, records) {
    const p = opsPaths(home);
    try {
      updateJson(p.tickd, (cur) => {
        const runs = Array.isArray(cur?.runs) ? cur.runs : [];
        runs.push(run);
        const jobs = { ...(cur?.jobs ?? {}) };
        for (const rec of records) {
          jobs[rec.id] = {
            lastRunAt: rec.at, lastStatus: rec.status, lastDurationMs: rec.durationMs,
            lastError: rec.error ?? null, runs: (jobs[rec.id]?.runs ?? 0) + 1,
            failures: (jobs[rec.id]?.failures ?? 0) + (rec.status === 'ok' ? 0 : 1),
          };
        }
        return {
          schemaVersion: TICKD_SCHEMA,
          lastTickAt: run.at,
          lastRunId: run.runId,
          runs: runs.slice(-MAX_RUNS),
          jobs,
        };
      }, { defaultValue: { schemaVersion: TICKD_SCHEMA, runs: [], jobs: {} } });
    } catch (e) {
      alert({ level: 'warn', source: 'ops-scheduler', message: `tick 状态落盘失败：${e?.message ?? e}` }, { home });
    }
  }

  function withTimeout(promise, timeoutMs, id) {
    if (!timeoutMs) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`job ${id} 超时（${timeoutMs}ms）`)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async function runOne(task, runId, at) {
    const lock = acquireLock(`tickd-${task.id}`, { home, ttlMs: task.ttlMs, runId });
    if (!lock.ok) {
      log(`${task.id}: 跳过（${lock.reason}）`);
      return { id: task.id, at: iso(at), runId, status: 'locked', durationMs: 0, error: null, detail: { reason: lock.reason } };
    }
    const t0 = clock();
    const ctx = {
      id: task.id,
      runId,
      now: t0,
      home,
      log: (m) => log(`${task.id}: ${m}`),
      audit: (entry) => appendAudit({ runId, tick: task.id, ...entry }, { home, silent: true }),
      alert: (entry) => alert({ source: `ops-tick:${task.id}`, ...entry }, { home, silent: true }),
    };
    let status = 'ok';
    let error = null;
    let detail = null;
    try {
      const r = await withTimeout(Promise.resolve().then(() => task.run(ctx)), task.timeoutMs, task.id);
      if (r === false) { status = 'error'; error = 'run returned false'; }
      else if (r && typeof r === 'object' && r.ok === false) { status = 'error'; error = r.error ?? r.reason ?? 'run returned ok:false'; }
      else if (r && typeof r === 'object') detail = r.detail ?? null;
    } catch (e) {
      status = /超时/.test(e?.message ?? '') ? 'timeout' : 'error';
      error = (e?.message ?? String(e)).split('\n')[0].slice(0, 400);
    } finally {
      lock.release();
    }
    const durationMs = clock() - t0;
    task.runs += 1;
    if (status !== 'ok') task.failures += 1;
    task.lastRunAt = at;
    task.lastStatus = status;
    task.lastDurationMs = durationMs;
    task.lastError = error;
    const rec = { id: task.id, label: task.label, at: iso(at), runId, status, durationMs, error, detail, staleLock: lock.stale === true };
    if (doAudit) appendAudit({ kind: 'tick.job', job: task.id, status, durationMs, error, detail }, { home, silent: true });
    return rec;
  }

  /**
   * 跑一轮：默认只跑到期任务；force=true 跑全部。
   * 永不 reject —— 单个 job 抛错被隔离，其余照跑。
   */
  async function tickOnce({ force = false, only = null, now = null } = {}) {
    const at = now ?? clock();
    const runId = newRunId(`tick-${name}`);
    const results = [];
    if (doAudit) appendAudit({ kind: 'tick.start', runId, at: iso(at), force, only }, { home, silent: true });
    for (const task of tasks.values()) {
      if (only && !only.includes(task.id)) continue;
      const due = task.lastRunAt === 0
        ? at - task.registeredAt >= task.initialDelayMs
        : at - task.lastRunAt >= task.intervalMs;
      if (!force && !due) { results.push({ id: task.id, status: 'not-due' }); continue; }
      results.push(await runOne(task, runId, at));
    }
    const executed = results.filter((r) => !['not-due'].includes(r.status)).length;
    const failed = results.filter((r) => r.status === 'error' || r.status === 'timeout').length;
    const run = { runId, at: iso(at), executed, failed, results };
    persistTick(run, results.filter((r) => r.status !== 'not-due'));
    if (doAudit) appendAudit({ kind: 'tick.end', runId, executed, failed }, { home, silent: true });
    log(`tick ${runId}: executed=${executed} failed=${failed}`);
    return run;
  }

  return { name, home, register, list, tickOnce, readState, tasks };
}
