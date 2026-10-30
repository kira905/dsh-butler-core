// ops-core / src/scheduler.mjs —— 轻量调度器（无常驻进程）
//
// 设计原则（与生产大管家的 tickd 同口径，但砍到最小）：
//   - 每个 job 独立注册：一个失败不拖垮其他（单 tick 抛错被隔离）
//   - 统一契约：run(ctx) 可返回 { ok, detail } / undefined / 抛错；调度器永不 reject
//   - 每个 job 执行前抢自己的锁：抢不到 = 静默跳过（不是失败）
//   - 记录每次 tick 的耗时 / 状态，落 ops-tickd.json（原子写，保留最近 50 次）
//   - 本模块不自己起定时器；常驻循环在 CLI 层（bin/ops-tickd.mjs --interval）
//
// 实例级单例（`ensure()`，与 job 锁**不是一回事**）：
//   job 锁管的是"两个 tick 别同时跑同一个 job"；实例锁管的是"别出现第二个调度器进程"。
//   后者的病不在锁本身，而在"锁主还活着却被判死 ⇒ 删锁 ⇒ 起第二个 ⇒ 两个一起跑"——
//   所以 ensure() 的语义是：**已存在活实例 ⇒ 拒删、返回 already-running**，绝不抢。
//   拿到锁立刻写一次状态（③），消掉"拿到锁 → 第一次 tick 落盘"之间那段谁都看不见的空窗。
//   fail-open（判不清就判活）的代价由 `checkLiveness()` 兜：连续 N 个周期没写出新状态 ⇒ 告警。
import fs from 'node:fs';
import { appendAudit } from './audit.mjs';
import { alert } from './alert.mjs';
import {
  DEFAULT_LIVENESS_CYCLES,
  DEFAULT_START_TIME_TOLERANCE_MS,
  DEFAULT_TTL_MS,
  computeLiveness,
  lastStateWriteAtOf,
  readInstanceState,
  recordHeartbeat,
  acquireInstanceLock,
} from './lock.mjs';
import { iso, newRunId, opsPaths } from './paths.mjs';
import { acquireLock, readJson, updateJson } from './store.mjs';

export const TICKD_SCHEMA = 1;
const MAX_RUNS = 50;

/**
 * @param {{
 *   home:string, name?:string, logger?:(line:string)=>void, clock?:()=>number, audit?:boolean,
 *   instanceName?:string, instanceTtlMs?:number, startTimeToleranceMs?:number, startTimeOf?:Function,
 *   livenessCycles?:number, livenessIntervalMs?:number,
 * }} opts
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

  // ── 实例级参数（都可配；默认值见 src/lock.mjs 文件头的时钟口径） ──────────────
  // 实例锁名与 CLI 同名，不跟 name 走：它锁的是"tickd 这个进程"，不是某一个 job
  const instanceName = opts.instanceName ?? 'ops-tickd-instance';
  const instanceTtlMs = Number.isFinite(opts.instanceTtlMs) ? opts.instanceTtlMs : DEFAULT_TTL_MS;
  const toleranceMs = Number.isFinite(opts.startTimeToleranceMs)
    ? opts.startTimeToleranceMs
    : Math.min(DEFAULT_START_TIME_TOLERANCE_MS, instanceTtlMs);
  const livenessCycles = Number.isInteger(opts.livenessCycles) ? opts.livenessCycles : DEFAULT_LIVENESS_CYCLES;
  /** 失败环的采样周期：默认取已注册 job 里最短的间隔（没有 job 时 60 s）。 */
  const livenessIntervalMs = () => {
    if (Number.isFinite(opts.livenessIntervalMs) && opts.livenessIntervalMs > 0) return opts.livenessIntervalMs;
    let min = Infinity;
    for (const t of tasks.values()) min = Math.min(min, t.intervalMs);
    return Number.isFinite(min) && min > 0 ? min : 60_000;
  };

  /** 本进程持有的实例锁（null = 还没 ensure / 没抢到）。 */
  let instance = null;

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

  /**
   * 写一次"实例状态"。这是 ③ 的落地：拿到锁**立刻**写，不等第一轮 tick。
   * 失败环（checkLiveness）判的就是这个字段的推进 —— 所以它必须由"每轮 tick"也更新（见 persistTick）。
   */
  function writeInstanceState(at, extra = {}) {
    const p = opsPaths(home);
    try {
      updateJson(p.tickd, (cur) => ({
        ...(cur ?? {}),
        schemaVersion: TICKD_SCHEMA,
        runs: Array.isArray(cur?.runs) ? cur.runs : [],
        jobs: cur?.jobs ?? {},
        instance: {
          ...(cur?.instance ?? {}),
          name: instanceName,
          pid: process.pid,
          lockFile: instance?.file ?? extra.lockFile ?? null,
          runId: instance?.payload?.runId ?? extra.runId ?? null,
          since: cur?.instance?.pid === process.pid ? (cur?.instance?.since ?? iso(at)) : iso(at),
          ...extra.instancePatch,
        },
        lastStateWriteAt: iso(at),
        liveness: cur?.liveness ?? null,
      }), { defaultValue: { schemaVersion: TICKD_SCHEMA, runs: [], jobs: {} } });
      return true;
    } catch (e) {
      alert({ level: 'warn', source: 'ops-scheduler', message: `实例状态落盘失败：${e?.message ?? e}` }, { home, silent: true });
      return false;
    }
  }

  /**
   * 拿实例锁并立刻写一次状态（②③）。
   * @returns {{ok:true, file:string, release:Function, instance:object}
   *          |{ok:false, reason:'already-running'|'reclaim-race', judge:object, holder:object|null, message:string}}
   */
  function ensure(overrides = {}) {
    if (instance) return { ok: true, already: true, file: instance.file, release: () => {}, instance };
    const r = acquireInstanceLock({
      home,
      name: overrides.name ?? instanceName,
      ttlMs: Number.isFinite(overrides.ttlMs) ? overrides.ttlMs : instanceTtlMs,
      startTimeToleranceMs: Number.isFinite(overrides.startTimeToleranceMs) ? overrides.startTimeToleranceMs : toleranceMs,
      startTimeOf: overrides.startTimeOf ?? opts.startTimeOf,
      isAliveOf: overrides.isAliveOf,
      runId: overrides.runId ?? newRunId('inst'),
      audit: doAudit,
      extra: overrides.extra,
    });
    if (!r.ok) {
      // 活实例 ⇒ 只报告，绝不删锁、也绝不写状态（写状态会被当成"我正在跑"）
      log(`ensure: ${r.message}`);
      return r;
    }
    instance = r;
    writeInstanceState(clock(), { lockFile: r.file });
    return r;
  }

  /** 心跳：只作证据（写 *.lock.beat），不参与任何判定。 */
  function heartbeat(at = null) {
    if (!instance) return { ok: false, reason: 'no-instance-lock' };
    return recordHeartbeat(instance.file, { now: at ?? clock() });
  }

  /**
   * ⑤ 失败环：连续 N 个周期没有写出新状态 ⇒ 告警（可配；同一段停摆只喊一次）。
   * 它不看锁、不看 pid —— 所以在 fail-open 生效（锁主其实死了却判活）时照样能喊人。
   */
  function checkLiveness(o = {}) {
    const at = Number.isFinite(o.now) ? o.now : clock();
    const intervalMs = Number.isFinite(o.intervalMs) ? o.intervalMs : livenessIntervalMs();
    const cycles = Number.isInteger(o.cycles) ? o.cycles : livenessCycles;
    const p = opsPaths(home);
    let mtimeMs = null;
    try { mtimeMs = Math.round(fs.statSync(p.tickd).mtimeMs); } catch { mtimeMs = null; }
    const cur = readJson(p.tickd, { defaultValue: null });
    const lastStateWriteAt = lastStateWriteAtOf(cur, mtimeMs);
    const lv = computeLiveness({ lastStateWriteAt, now: at, intervalMs, cycles });

    const prev = cur?.liveness ?? null;
    const wasStalled = prev?.stalled === true;
    let alerted = false;
    if (lv.stalled && !wasStalled && o.alertOnStall !== false) {
      const message = `[${instanceName}] ${lv.message}`;
      alert({
        level: 'error',
        source: 'ops-instance-liveness',
        message,
        detail: {
          missedCycles: lv.missedCycles, threshold: lv.threshold, intervalMs: lv.intervalMs,
          lastStateWriteAt: lv.lastStateWriteAt ?? null, lockPid: instance?.payload?.pid ?? null,
        },
      }, { home });
      if (doAudit) appendAudit({ kind: 'instance.stalled', missedCycles: lv.missedCycles, threshold: lv.threshold, intervalMs: lv.intervalMs }, { home, silent: true });
      alerted = true;
      log(message);
    }
    if (lv.known) {
      try {
        updateJson(p.tickd, (c) => ({
          ...(c ?? {}),
          liveness: {
            stalled: lv.stalled,
            missedCycles: lv.missedCycles,
            threshold: lv.threshold,
            intervalMs: lv.intervalMs,
            lastAlertAt: alerted ? iso(at) : (lv.stalled ? (prev?.lastAlertAt ?? null) : null),
            checkedAt: iso(at),
          },
        }), { defaultValue: { schemaVersion: TICKD_SCHEMA, runs: [], jobs: {} } });
      } catch { /* 状态写失败不影响告警 */ }
    }
    return { ...lv, alerted, intervalMs, cycles };
  }

  /** 释放实例锁（只删属于自己的那一版字节）。 */
  function release() {
    if (!instance) return false;
    const ok = instance.release();
    instance = null;
    return ok;
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
          // 每轮 tick 落盘也算"写出了新状态"：失败环判的就是这两个字段的推进
          lastStateWriteAt: run.at,
          lastRunId: run.runId,
          // instance / liveness 必须原样保留 —— 否则每轮 tick 都会把"谁拿着锁、有没有停摆"抹掉
          instance: cur?.instance ?? null,
          liveness: cur?.liveness ?? null,
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
    // 心跳只作证据，写在最前面：这一轮会跑很久也能让"实例还在动"留痕
    if (instance) heartbeat(at);
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

  return {
    name, home, register, list, tickOnce, readState, tasks,
    // 实例级（本卡新增）：ensure / heartbeat / checkLiveness / release / instanceState
    ensure, heartbeat, checkLiveness, release,
    get instance() { return instance; },
    get instanceName() { return instanceName; },
    get livenessConfig() { return { cycles: livenessCycles, intervalMs: livenessIntervalMs() }; },
    instanceState: (o = {}) => readInstanceState(home, { intervalMs: livenessIntervalMs(), cycles: livenessCycles, ...o }),
  };
}
