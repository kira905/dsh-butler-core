// ops-core / src/lock.mjs —— 实例级单例锁（锁定的是"一个调度器进程"，不是单个 job）
//
// 为什么单独抽出这个文件：`store.mjs` 的 `acquireLock` 只回答"锁过期了没"，
// 而"锁主**还活着**却被判过期 ⇒ 删锁 ⇒ 起第二个实例"这件事，光看 TTL 永远判不出来
// （心跳停了、时钟跳了、宿主休眠了，都可能让 TTL 判过期，而进程活得好好的）。
// 所以这里把判定拆成两条互不冒充的问题：
//   ① 锁主**还在不在**（pid 存活）—— 进程级事实，跟时间无关；
//   ② 这个 pid **还是不是当初那个进程**（pid 复用 / 撞号）—— 看方向，不看绝对差。
//
// 🔴 时钟口径（写死三条，改之前先读 WHY）：
//   1. **撞号判据看方向不看绝对差**：只有「进程启动时间 > 锁 startedAt + 容差」才**可能**是
//      pid 撞号；「启动时间 < startedAt」⇒ 同一个进程 ⇒ 判 alive。
//      为什么：两个时间戳都来自墙钟。宿主休眠 / NTP 校时 / 跨时区迁移之后，差值会变负或变成巨值。
//      按绝对差判 ⇒ 负值判"不是撞号"（于是删锁起第二实例 = 本文件要治的病），
//      巨值判"是撞号"（于是判活/判死反向）。方向判据在两种异常下都落在安全侧。
//   2. **出现负差 / 读不到时钟 ⇒ fail-open 判 alive，并写一行审计**（明写，不许隐式）。
//      fail-open 的代价是：锁主真死了却判 alive ⇒ 第二个实例永不启动 ⇒ 调度静默停摆。
//      所以配了出口：`computeLiveness()` —— 连续 N 个周期没有写出新状态 ⇒ 告警（见下）。
//   3. **容差可配，默认 120 s**，依据是：容差只需覆盖「同一进程的启动时刻」与「它写锁的时刻」
//      之间的自然差（进程起来 → 加载 → 写锁，量级 < 3 s），不是覆盖"两次 tick 的间隔"。
//      生产侧 ttlMs 分 120/180/300/600/900/1200 s 六档 ⇒ 默认取**最小档 120 s**
//      并允许派生 `min(ttlMs, 120_000)`（ttl 更小的档位下，容差不该比 ttl 还长）。
//
// 心跳（`*.lock.beat`）**只作证据，不作判据**：它回答"上次见到这个实例动是什么时候"，
// 用来给人看、给审计留痕；任何一处判定都不拿它当输入（否则又变回"用一个会停的时钟判生死"）。
import fs from 'node:fs';
import path from 'node:path';
import { appendAudit } from './audit.mjs';
import { ensureDir, iso, opsPaths } from './paths.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';

export const LOCK_SCHEMA = 1;
/** 锁 TTL 默认值 = 生产侧 ttlMs 最小档（120 s）。 */
export const DEFAULT_TTL_MS = 120_000;
/** pid 撞号判定的容差（见文件头 🔴 第 3 条：可配 + 依据）。 */
export const DEFAULT_START_TIME_TOLERANCE_MS = 120_000;
/** 回收一把陈旧锁最多试几次（每次都会重新读锁、重新判活）。 */
export const DEFAULT_MAX_RECLAIM_ATTEMPTS = 3;
/** 失败环：连续多少个周期没写出新状态就该喊人（可配；3 是"连丢三轮"的保守值）。 */
export const DEFAULT_LIVENESS_CYCLES = 3;

const CLOCK_TICKS_PER_SEC = 100; // Linux USER_HZ 常量；/proc/<pid>/stat 的 starttime 以它为时间基

// ─────────────────────────────── 进程存活 / 启动时间 ───────────────────────────────

/**
 * pid 是否存活。返回 { alive: true|false|null, reason }，null = 判不了（不是"活着"也不该死）。
 * process.kill(pid, 0) 的三种结果：成功=活；EPERM=存在但无权限（仍是活）；ESRCH=不存在。
 */
export function isPidAlive(pid, opts = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: null, reason: 'invalid-pid' };
  if (pid === process.pid) return { alive: true, reason: 'self' };
  if (typeof opts.isAliveOf === 'function') {
    try {
      const v = opts.isAliveOf(pid);
      return { alive: v === null ? null : Boolean(v), reason: 'injected' };
    } catch {
      return { alive: null, reason: 'injected-threw' };
    }
  }
  try {
    process.kill(pid, 0);
    return { alive: true, reason: 'signal-0-ok' };
  } catch (e) {
    if (e?.code === 'EPERM') return { alive: true, reason: 'EPERM（存在但无权限）' };
    if (e?.code === 'ESRCH') return { alive: false, reason: 'ESRCH（不存在）' };
    return { alive: null, reason: `无法判定：${e?.code ?? e?.message ?? e}` };
  }
}

/** 本进程启动时刻（跨平台可靠：只用 Date.now 与 process.uptime）。 */
function selfStartMs(now = Date.now()) {
  const up = Number(process.uptime?.());
  if (!Number.isFinite(up) || up < 0) return null;
  return now - Math.round(up * 1000);
}

/** Linux：/proc/<pid>/stat 的 starttime（开机后的 jiffies）+ /proc/stat 的 btime。 */
function procStartMs(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 字段可能含空格与括号 ⇒ 从最后一个 ')' 之后切；切完第 1 个 token 是字段 3（state）
    const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = Number(rest[19]); // 字段 22（starttime）
    const btimeSec = Number(/^btime\s+(\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))?.[1]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(btimeSec)) return null;
    return btimeSec * 1000 + (startTicks / CLOCK_TICKS_PER_SEC) * 1000;
  } catch {
    return null;
  }
}

/**
 * 取某 pid 的启动时间，归一化为 { ms: number|null, source: string }。
 *
 * Windows 上**没有**零依赖、零子进程的取法 ⇒ 默认如实返回 ms:null（于是判定走 fail-open）。
 * 想在 Windows 上也判撞号，把 `opts.startTimeOf` 注入进来即可（例如由调用方用
 * PowerShell 的 Get-Process CreationDate 取、或自己起进程时把启动时刻写在自己的状态里）。
 * 反过来：**本进程自己**（最常见的"同一个进程反复 ensure"场景）在任何平台都取得准。
 */
export function readStartTime(pid, opts = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ms: null, source: 'invalid-pid' };
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  // 注入优先（含本进程）：夹具要模拟"本进程已经跑了很久"，真实的 uptime 造不出来；
  // 而"注入的人说了算"也比"偷偷按自己算"更容易排障。
  if (opts.startTimeOf !== undefined && opts.startTimeOf !== null) {
    if (typeof opts.startTimeOf !== 'function') return { ms: null, source: 'injected-not-a-function' };
    try {
      const raw = opts.startTimeOf(pid);
      if (raw && typeof raw === 'object') {
        const ms = Number.isFinite(raw.ms) ? raw.ms : null;
        return { ms, source: String(raw.source ?? 'injected') };
      }
      return { ms: Number.isFinite(raw) ? raw : null, source: 'injected' };
    } catch (e) {
      return { ms: null, source: `injected-threw:${e?.message ?? e}` };
    }
  }
  if (pid === process.pid) {
    const ms = selfStartMs(now);
    return { ms, source: ms === null ? 'self-uptime-unavailable' : 'self-uptime' };
  }
  if (process.platform === 'linux') {
    const ms = procStartMs(pid);
    return { ms, source: ms === null ? 'proc-unavailable' : 'proc-stat' };
  }
  return { ms: null, source: `unsupported:${process.platform}` };
}

// ─────────────────────────────── 锁文件读写 ───────────────────────────────

export function lockFileFor(dir, name) {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
  return path.join(dir, `${safe}.lock`);
}

/** 心跳文件（证据文件）与锁文件同目录、同名 + `.beat` 后缀 —— 写它不会改动锁文件字节。 */
export function beatFileFor(lockFile) {
  return `${lockFile}.beat`;
}

/** 读锁文件：返回 { exists, raw, lock, lockMtimeMs }。raw 用于"只删自己读到的那一版"。 */
export function readLockView(lockFile) {
  let raw = null;
  let mtimeMs = null;
  try {
    const st = fs.statSync(lockFile);
    mtimeMs = Math.round(st.mtimeMs);
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { exists: false, raw: null, lock: null, lockMtimeMs: null };
    return { exists: true, raw: null, lock: null, lockMtimeMs: null, readError: e?.message ?? String(e) };
  }
  let lock = null;
  try { lock = JSON.parse(raw); } catch { lock = null; }
  return { exists: true, raw, lock: lock && typeof lock === 'object' ? lock : null, lockMtimeMs: mtimeMs };
}

/** 心跳：只记录"上次见到这个实例动"，不参与任何判定。返回 { ok, file, beat }。 */
export function recordHeartbeat(lockFile, { now = Date.now(), pid = process.pid } = {}) {
  const file = beatFileFor(lockFile);
  try {
    const prev = readJson(file, { defaultValue: null });
    const beat = {
      schemaVersion: LOCK_SCHEMA,
      lock: path.basename(lockFile),
      pid,
      at: iso(now),
      count: (Number.isFinite(prev?.count) ? prev.count : 0) + 1,
    };
    writeJsonAtomic(file, beat);
    return { ok: true, file, beat };
  } catch {
    return { ok: false, file, beat: null };
  }
}

/** 读心跳（给审计 / 人看）。读不到返回 null —— 心跳缺失**永远不**等于"实例死了"。 */
export function readHeartbeat(lockFile) {
  const beat = readJson(beatFileFor(lockFile), { defaultValue: null });
  if (!beat) return null;
  const at = Date.parse(beat.at ?? '');
  return { ...beat, atMs: Number.isFinite(at) ? at : null };
}

/** 只在内容没变时删（防"我判完死、别人重写了锁、我把它删了"）。 */
function removeIfUnchanged(lockFile, expectedRaw) {
  try {
    const cur = fs.readFileSync(lockFile, 'utf8');
    if (cur !== expectedRaw) return { removed: false, reason: 'content-changed' };
  } catch (e) {
    if (e?.code === 'ENOENT') return { removed: false, reason: 'already-gone' };
    return { removed: false, reason: `read-failed:${e?.code ?? e}` };
  }
  try {
    fs.rmSync(lockFile, { force: true });
    return { removed: true, reason: 'removed' };
  } catch (e) {
    return { removed: false, reason: `rm-failed:${e?.code ?? e}` };
  }
}

// ─────────────────────────────── 判定（纯函数，可单测） ───────────────────────────────

/**
 * 判一把锁的状态。**纯函数**：不写文件、不发告警，只把"该写哪行审计"放在结果的 `audit` 里，
 * 由调用方（acquireInstanceLock / scheduler.ensure）负责真写 —— 这样判据可被夹具单独锁死。
 *
 * @param {{
 *   view?: {exists:boolean, raw:string|null, lock:object|null, lockMtimeMs:number|null},
 *   now?: number, ttlMs?: number, startTimeToleranceMs?: number,
 *   startTimeOf?: Function, isAliveOf?: Function,
 * }} input
 * @returns {{
 *   state: 'missing'|'alive'|'reclaimable',
 *   reason: string,          // 机器码，夹具按它断言
 *   message: string,         // 一句人话
 *   reclaimable: boolean,
 *   failOpen: boolean,       // true = 这是"判不清所以判活"的那条分支
 *   audit: null|{kind:string, message:string, detail:object},
 *   evidence: object,
 * }}
 */
export function judgeLock(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const view = input.view ?? { exists: false, raw: null, lock: null, lockMtimeMs: null };
  const ttlMs = Number.isFinite(input.ttlMs) ? input.ttlMs : DEFAULT_TTL_MS;
  const tolerance = Number.isFinite(input.startTimeToleranceMs)
    ? input.startTimeToleranceMs
    : Math.min(DEFAULT_START_TIME_TOLERANCE_MS, ttlMs);
  const evidenceBase = { ttlMs, toleranceMs: tolerance, now: iso(now) };

  if (!view.exists) {
    return {
      state: 'missing', reason: 'no-lock', message: '没有锁（可以创）', reclaimable: true,
      failOpen: false, audit: null, evidence: evidenceBase,
    };
  }

  // ── ① 内容坏到定位不了持有者：用文件 mtime 当 startedAt 的兜底证据 ──────────────
  const holder = view.lock;
  const pid = Number(holder?.pid);
  const startedAt = Date.parse(holder?.at ?? '');
  const hasPid = Number.isInteger(pid) && pid > 0;
  const hasStart = Number.isFinite(startedAt);

  if (!holder || !hasPid || !hasStart) {
    const mtimeMs = Number.isFinite(view.lockMtimeMs) ? view.lockMtimeMs : null;
    if (mtimeMs === null) {
      // 连文件时间都读不到 ⇒ 判不了 ⇒ fail-open 判活（明写一行审计）
      return {
        state: 'alive', reason: 'unreadable-no-clock', message: '锁内容坏了且读不到文件时间 ⇒ fail-open 判活',
        reclaimable: false, failOpen: true,
        audit: {
          kind: 'instance.lock-fail-open',
          message: '锁无法解析且拿不到文件时间 ⇒ 判 alive（不删锁）',
          detail: { ...evidenceBase, readError: view.readError ?? null },
        },
        evidence: { ...evidenceBase, lockUnreadable: true, lockMtimeMs: null },
      };
    }
    const ageMs = now - mtimeMs;
    const expired = ageMs > ttlMs;
    return {
      state: expired ? 'reclaimable' : 'alive',
      reason: expired ? 'unreadable-expired' : 'unreadable-fresh',
      message: expired
        ? `锁内容不可解析且已超过 TTL（${Math.round(ageMs / 1000)}s > ${Math.round(ttlMs / 1000)}s）⇒ 可回收`
        : `锁内容不可解析但仍在 TTL 内 ⇒ 判活（不删锁）`,
      reclaimable: expired,
      failOpen: !expired,
      audit: {
        kind: 'instance.lock-unreadable',
        message: expired ? '锁不可解析且已超过 TTL ⇒ 按陈旧回收（有审计留痕）' : '锁不可解析但未超过 TTL ⇒ 判活',
        detail: { ...evidenceBase, lockMtimeMs: mtimeMs, ageMs, expired },
      },
      evidence: { ...evidenceBase, lockUnreadable: true, lockMtimeMs: mtimeMs, ageMs, expired },
    };
  }

  // ── ② pid 存活：进程级事实，与时间无关 ──────────────────────────────────────
  const alive = isPidAlive(pid, input);
  const startInfo = readStartTime(pid, { now, startTimeOf: input.startTimeOf });
  const beat = input.lockFile ? readHeartbeat(input.lockFile) : null;
  const beatAgeMs = beat && Number.isFinite(beat.atMs) ? now - beat.atMs : null;
  const ageMs = now - startedAt;
  const evidence = {
    ...evidenceBase, pid, startedAt: iso(startedAt), startedAtMs: startedAt, ageMs,
    pidAlive: alive.alive, pidAliveReason: alive.reason,
    holderStartMs: startInfo.ms, holderStartSource: startInfo.source,
    heartbeatAgeMs: beatAgeMs,          // 只作证据 —— 下面没有任何一处拿它当判据
    runId: holder.runId ?? null,
  };

  if (alive.alive === false) {
    return {
      state: 'reclaimable', reason: 'pid-dead',
      message: `锁主 pid ${pid} 已不存在 ⇒ 孤儿锁，可回收`,
      reclaimable: true, failOpen: false,
      audit: {
        kind: 'instance.lock-orphan',
        message: `锁主 pid ${pid} 已不存在 ⇒ 回收孤儿锁`,
        detail: { ...evidence },
      },
      evidence,
    };
  }

  // ── ③ pid 活着（或判不了）：TTL 一律不参与，只看"这个 pid 还是不是当初那个进程" ──
  //    活锁被判死 = 本卡要治的病 ⇒ 走到这里就不许用 TTL 删锁。
  if (alive.alive === null) {
    return {
      state: 'alive', reason: 'liveness-unknown', message: `pid ${pid} 存活判不了（${alive.reason}）⇒ fail-open 判活`,
      reclaimable: false, failOpen: true,
      audit: {
        kind: 'instance.lock-fail-open',
        message: `pid ${pid} 存活判不了 ⇒ 判 alive（不删锁）：${alive.reason}`,
        detail: { ...evidence },
      },
      evidence,
    };
  }

  if (startInfo.ms === null) {
    return {
      state: 'alive', reason: 'no-start-time',
      message: `pid ${pid} 活着但取不到它的启动时间（${startInfo.source}）⇒ fail-open 判活`,
      reclaimable: false, failOpen: true,
      audit: {
        kind: 'instance.lock-fail-open',
        message: `取不到 pid ${pid} 的启动时间 ⇒ 判 alive（不删锁；由失败环告警兜）`,
        detail: { ...evidence },
      },
      evidence,
    };
  }

  // 方向判据：只有「启动时间 > 锁 startedAt + 容差」才可能是撞号
  const deltaMs = startInfo.ms - startedAt;
  evidence.deltaMs = deltaMs;
  evidence.direction = deltaMs > 0 ? 'later' : deltaMs < 0 ? 'earlier' : 'same';

  if (deltaMs > tolerance) {
    return {
      state: 'reclaimable', reason: 'pid-reused',
      message: `pid ${pid} 活着但启动时间比锁晚 ${Math.round(deltaMs / 1000)}s（> 容差 ${Math.round(tolerance / 1000)}s）⇒ pid 撞号，锁是孤儿`,
      reclaimable: true, failOpen: false,
      audit: {
        kind: 'instance.lock-pid-reused',
        message: `pid ${pid} 被复用（启动时间晚 ${Math.round(deltaMs / 1000)}s，超过容差 ${Math.round(tolerance / 1000)}s）⇒ 回收孤儿锁`,
        detail: { ...evidence },
      },
      evidence,
    };
  }

  const negative = deltaMs < 0;
  return {
    state: 'alive',
    reason: negative ? 'holder-alive-same-process-negative-delta' : 'holder-alive-same-process',
    message: negative
      ? `pid ${pid} 活着且启动时间早于锁 ${Math.round(-deltaMs / 1000)}s ⇒ 同一个进程（负差，按 alive）`
      : `pid ${pid} 活着且就是写锁的那个进程 ⇒ 活锁`,
    reclaimable: false, failOpen: false,
    // 负差要明写一行审计（方案要求"出现负差 ⇒ fail-open 判 alive 并写一行审计"，不许隐式）
    audit: negative
      ? {
        kind: 'instance.lock-clock-skew',
        message: `时钟负差 ${Math.round(-deltaMs / 1000)}s（进程启动时间早于锁 startedAt）⇒ 判 alive，不删锁`,
        detail: { ...evidence },
      }
      : null,
    evidence,
  };
}

// ─────────────────────────────── 拿锁 / 释放 ───────────────────────────────

/**
 * 拿实例锁。语义 = 「我要成为唯一活着的实例」。活锁 ⇒ **拒删** 并返回 already-running。
 *
 * @param {{
 *   home: string, dir?: string, name?: string,
 *   ttlMs?: number, startTimeToleranceMs?: number, maxReclaimAttempts?: number,
 *   now?: number, runId?: string, startTimeOf?: Function, isAliveOf?: Function,
 *   audit?: boolean, extra?: object,
 * }} opts
 */
export function acquireInstanceLock(opts = {}) {
  const home = opts.home;
  if (!home) throw new Error('acquireInstanceLock: 需要 home');
  const dir = opts.dir ?? path.join(home, 'ops-locks');
  ensureDir(dir);
  const name = opts.name ?? 'ops-tickd-instance';
  const file = lockFileFor(dir, name);
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const tolerance = Number.isFinite(opts.startTimeToleranceMs)
    ? opts.startTimeToleranceMs
    : Math.min(DEFAULT_START_TIME_TOLERANCE_MS, ttlMs);
  const attempts = Number.isInteger(opts.maxReclaimAttempts) ? opts.maxReclaimAttempts : DEFAULT_MAX_RECLAIM_ATTEMPTS;
  const doAudit = opts.audit !== false;
  const now = () => (Number.isFinite(opts.now) ? opts.now : Date.now());

  const payloadFor = (at) => ({
    schemaVersion: LOCK_SCHEMA,
    name,
    pid: process.pid,
    at: iso(at),
    ttlMs,
    toleranceMs: tolerance,
    runId: opts.runId ?? null,
    host: requireHost(),
    ...(opts.extra ?? {}),
  });
  const auditOf = (judged) => {
    if (!doAudit || !judged?.audit) return;
    try { appendAudit({ instance: name, ...judged.audit }, { home, silent: true }); } catch { /* 审计失败不影响加锁 */ }
  };

  let lastJudge = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const at = now();
    const payload = payloadFor(at);
    const text = JSON.stringify(payload);
    // 抢锁：wx 原子创建（不用 existsSync + 写 —— 那是 TOCTOU）
    try {
      fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' });
      return {
        ok: true, file, name, payload, attempt, reclaimed: attempt > 1,
        release: () => releaseLockText(file, text),
      };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }

    // ── 已存在：先判"锁主是不是活实例"，活 ⇒ 拒删（本卡核心） ──────────────
    const view = readLockView(file);
    const judged = judgeLock({
      view, lockFile: file, now: at, ttlMs: Number(view.lock?.ttlMs) || ttlMs, startTimeToleranceMs: tolerance,
      startTimeOf: opts.startTimeOf, isAliveOf: opts.isAliveOf,
    });
    lastJudge = judged;
    if (!judged.reclaimable) {
      auditOf(judged);
      // "有人想当第二个实例"本身要留痕（否则事后只能看到"没起来"，看不到"为什么没起来"）
      if (doAudit) {
        try {
          appendAudit({
            kind: 'instance.lock-busy', instance: name,
            message: `拒绝成为第二个实例：${judged.reason}`,
            detail: { pid: process.pid, holderPid: view.lock?.pid ?? null, pidAlive: judged.evidence?.pidAlive, failOpen: judged.failOpen },
          }, { home, silent: true });
        } catch { /* 审计失败不影响拒绝 */ }
      }
      return {
        ok: false, reason: 'already-running', file, name, judge: judged,
        holder: view.lock, message: `已有活实例（pid ${view.lock?.pid ?? '?'}）：${judged.message}`,
        release: () => {},
      };
    }

    // ── 要删：删之前**再核一遍**（缩小 TOCTOU 窗口：别人可能刚刚重写了这把锁） ──
    const view2 = readLockView(file);
    if (view2.raw !== view.raw) continue; // 内容变过 ⇒ 重新从抢锁开始
    const judged2 = judgeLock({
      view: view2, lockFile: file, now: now(), ttlMs: Number(view2.lock?.ttlMs) || ttlMs,
      startTimeToleranceMs: tolerance, startTimeOf: opts.startTimeOf, isAliveOf: opts.isAliveOf,
    });
    if (!judged2.reclaimable) {
      auditOf(judged2);
      if (doAudit) {
        try {
          appendAudit({
            kind: 'instance.lock-busy', instance: name,
            message: `二次复核时发现是活实例，拒绝成为第二个：${judged2.reason}`,
            detail: { pid: process.pid, holderPid: view2.lock?.pid ?? null, pidAlive: judged2.evidence?.pidAlive, failOpen: judged2.failOpen },
          }, { home, silent: true });
        } catch { /* 审计失败不影响拒绝 */ }
      }
      return {
        ok: false, reason: 'already-running', file, name, judge: judged2,
        holder: view2.lock, message: `二次复核时发现是活实例：${judged2.message}`,
        release: () => {},
      };
    }
    auditOf(judged2);
    const rm = removeIfUnchanged(file, view2.raw);
    if (!rm.removed) {
      // 已经没了 / 被改过 / 删不动 ⇒ 下一轮重来（别原地把别人活锁当死的）
      continue;
    }
  }

  return {
    ok: false, reason: 'reclaim-race', file, name, judge: lastJudge, holder: null,
    message: `连续 ${attempts} 次回收/抢占都没成功（锁一直被改写）—— 按"有别人在"处理，不强行删`,
    release: () => {},
  };
}

/** 只删"仍属于自己"的锁（比字节，不靠 pid —— pid 撞号时 pid 也能一样）。 */
export function releaseLockText(file, expectedText) {
  try {
    const cur = fs.readFileSync(file, 'utf8');
    if (cur !== expectedText) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function requireHost() {
  // 只用于排障时对人说明"哪台机上的实例"，缺失不影响任何判定
  try {
    return String(process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? '').slice(0, 64) || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────── ⑤ 失败环（fail-open 的出口） ───────────────────────────────

/**
 * 失败环判据（纯函数）：连续多少个周期没有写出新状态。
 *
 * 为什么必须有这条：fail-open 判 alive 之后，锁主真死了 ⇒ 第二个实例永不启动 ⇒ 调度**静默停摆**。
 * 那比双实例更贵，因为没人会发现。所以配这条只看"状态有没有在推进"的出口 —— 它不问锁、
 * 不问 pid，只问"上一次写出新状态是什么时候"，因此在 fail-open 生效时照样能喊人。
 *
 * @param {{lastStateWriteAt:number|null, now?:number, intervalMs?:number, cycles?:number}} input
 */
export function computeLiveness(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const intervalMs = Number.isFinite(input.intervalMs) && input.intervalMs > 0 ? input.intervalMs : 60_000;
  const cycles = Number.isInteger(input.cycles) && input.cycles > 0 ? input.cycles : DEFAULT_LIVENESS_CYCLES;
  const last = Number.isFinite(input.lastStateWriteAt) ? input.lastStateWriteAt : null;
  if (last === null) {
    return {
      known: false, verdict: 'never-started', stalled: false, ageMs: null, missedCycles: null,
      threshold: cycles, intervalMs,
      message: '没有任何"写出状态"的记录 ⇒ 判不了（从未启动过，不是停摆）',
    };
  }
  const ageMs = Math.max(0, now - last);
  const missedCycles = Math.floor(ageMs / intervalMs);
  const stalled = missedCycles >= cycles;
  return {
    known: true, verdict: stalled ? 'stalled' : 'ok', stalled, ageMs, missedCycles,
    threshold: cycles, intervalMs, lastStateWriteAt: last,
    message: stalled
      ? `连续 ${missedCycles} 个周期（阈值 ${cycles}）没有写出新状态 —— 调度可能在静默停摆`
      : `状态在推进（距今 ${missedCycles} 个周期，阈值 ${cycles}）`,
  };
}

/** 从 tickd 状态对象里取"上一次写出新状态"的时刻（字段优先，文件 mtime 兜底）。 */
export function lastStateWriteAtOf(state, fileMtimeMs = null) {
  const raw = state?.lastStateWriteAt;
  const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''));
  if (Number.isFinite(parsed)) return parsed;
  return Number.isFinite(fileMtimeMs) ? fileMtimeMs : null;
}

/** 实例状态摘要（谁拿着锁 / 心跳 / 有没有停摆）。只读，给 CLI / 日报用。 */
export function readInstanceState(home, { intervalMs, cycles, now = Date.now(), lockName = 'ops-tickd-instance' } = {}) {
  const p = opsPaths(home);
  const tickdFile = p.tickd;
  let mtimeMs = null;
  try { mtimeMs = Math.round(fs.statSync(tickdFile).mtimeMs); } catch { mtimeMs = null; }
  const state = readJson(tickdFile, { defaultValue: null });
  const lastStateWriteAt = lastStateWriteAtOf(state, mtimeMs);
  const liveness = computeLiveness({ lastStateWriteAt, now, intervalMs, cycles });
  const lockFile = lockFileFor(p.locksDir, lockName);
  const view = readLockView(lockFile);
  return {
    lockFile, lock: view.lock, lockExists: view.exists,
    heartbeat: readHeartbeat(lockFile),
    instance: state?.instance ?? null,
    lastStateWriteAt, liveness,
  };
}
