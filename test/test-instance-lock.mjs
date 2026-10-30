// 夹具：调度器单实例守卫（活锁被判死 / pid 撞号 / 孤儿双跑 / fail-open / ⑤失败环）
//
// 三条纪律（写在这里免得后来的人改坏）：
//   ① **绝不起真进程**：所有"实例"都是同一进程里的逻辑实例，用**假 instance 日志**数实例
//      （`instances.jsonl` 里一行 = 一个真起来的实例）。这样夹具 0.3 s 跑完，也不会留下僵尸。
//   ② **DSH_HOME / OPS_CORE_HOME 全程指夹具临时目录**：本文件不读不写任何真实 home，
//      也不碰生产 tickd（不停、不重启、不删锁）。
//   ③ 每一条断言都对应"把判据改反就会红"的那一格 —— 与 test-mutation-lock.mjs 成对。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeChecker, makeTempDir, rmTree, writeJson, readJsonSafe } from './lib/harness.mjs';
import {
  acquireInstanceLock, computeLiveness, isPidAlive, judgeLock, readLockView, recordHeartbeat,
} from '../src/lock.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { acquireLock as acquireJobLock } from '../src/store.mjs';

export const name = '实例单例守卫（活锁/撞号/孤儿/失败环）';

const THIS_FILE = fileURLToPath(import.meta.url);
const LOCK_NAME = 'ops-tickd-instance';
const out = (s) => process.stdout.write(`  ${s}\n`);

// ─────────────────────────────── 夹具小工具 ───────────────────────────────

function makeHome() {
  return makeTempDir('butler-core-lock');
}

function lockFileOf(home) {
  return path.join(home, 'ops-locks', `${LOCK_NAME}.lock`);
}

function writeLockFile(home, payload) {
  const file = lockFileOf(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
  return file;
}

function shaOf(file) {
  try {
    return fs.readFileSync(file).toString('base64').slice(0, 24) + `#${fs.statSync(file).size}`;
  } catch {
    return '(gone)';
  }
}

/** 找一个"确定不存在"的 pid（只用 kill(pid,0) 只读探测，不起进程）。 */
function findDeadPid() {
  for (let pid = 4_194_300; pid > 4_194_200; pid--) {
    if (isPidAlive(pid).alive === false) return pid;
  }
  return null;
}

function auditRecords(home) {
  const dir = path.join(home, 'ops-audit');
  const rows = [];
  try {
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* 半行跳过 */ }
      }
    }
  } catch { /* 没有审计目录 = 没有记录 */ }
  return rows;
}

function alertRecords(home) {
  const rows = [];
  try {
    for (const line of fs.readFileSync(path.join(home, 'ops-alert.log'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* 半行跳过 */ }
    }
  } catch { /* 没有告警 = 没有记录 */ }
  return rows;
}

/** 假 instance 日志：一行 = 一个真起来的实例（夹具用它数实例，而不是去数进程）。 */
function makeInstanceLog(home) {
  const file = path.join(home, 'instances.jsonl');
  return {
    file,
    started(label) {
      fs.appendFileSync(file, JSON.stringify({ kind: 'started', label, at: new Date().toISOString(), pid: process.pid }) + '\n', 'utf8');
    },
    rejected(label) {
      fs.appendFileSync(file, JSON.stringify({ kind: 'rejected', label, at: new Date().toISOString(), pid: process.pid }) + '\n', 'utf8');
    },
    count(kind = 'started') {
      try {
        return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return {}; } })
          .filter((r) => r.kind === kind).length;
      } catch { return 0; }
    },
  };
}

/** 起一个"逻辑实例"：ensure 成功才算真起来（写进假日志）。 */
function bootInstance(home, log, label, opts = {}) {
  const scheduler = createScheduler({ home, logger: () => {}, ...opts });
  const r = scheduler.ensure();
  if (r.ok) log.started(label);
  else log.rejected(label);
  return { scheduler, r };
}

// ─────────────────────────────── ① 活锁被判死 ───────────────────────────────

function caseAliveLockKilled(c) {
  const now = Date.now();
  // 真实形态：同一个进程**已经跑了很久**（1 小时），它 5 秒前写的锁，TTL 只给了 1 秒 ⇒ 按 TTL 早过期了。
  // 真实的 uptime 造不出"跑了 1 小时"，所以注入启动时间 —— 判定逻辑本身不受影响（见 lock.mjs 文件头口径 1）。
  const holderStartedLongAgo = () => now - 3_600_000;
  const lockOfAliveHolder = (at) => ({ name: LOCK_NAME, pid: process.pid, at: new Date(at).toISOString(), ttlMs: 1_000 });

  // (a) 旧口径对照（store.acquireLock 只看 TTL）：同一形态的锁会被判过期并抢占 —— 这就是本卡要治的病
  const homeOld = makeHome();
  writeLockFile(homeOld, lockOfAliveHolder(now - 5_000));
  const old = acquireJobLock(LOCK_NAME, { home: homeOld, ttlMs: 1_000 });
  c.ok(old.ok === true && old.stale === true, '对照：旧口径（只看 TTL）把"活锁"判过期并抢占了（病根复现）');
  out(`[①a] 旧口径 store.acquireLock：ok=${old.ok} stale=${old.stale} ⇒ 抢到（等于允许起第二个实例）`);
  rmTree(homeOld);

  // (b) 新口径：pid 活着 ⇒ 拒删、already-running、锁文件一个字节都不动
  const home = makeHome();
  const log = makeInstanceLog(home);
  const file = writeLockFile(home, lockOfAliveHolder(now - 5_000));
  const before = shaOf(file);

  const { scheduler, r } = bootInstance(home, log, 'second', { startTimeOf: holderStartedLongAgo });
  c.eq(r.ok, false, '锁主还活着 ⇒ ensure 必须返回 ok:false');
  c.eq(r.reason, 'already-running', 'reason = already-running');
  c.ok(String(r.judge.reason).startsWith('holder-alive-same-process'),
    `判据 = holder-alive-same-process（不是"过期"；负差时带 -negative-delta 后缀）：实际 ${r.judge.reason}`);
  c.eq(shaOf(file), before, '锁文件字节未变（没删、没重写）');
  c.eq(log.count('started'), 0, '假 instance 日志：0 个实例起来');
  out(`[①b] 新口径 ensure：ok=${r.ok} reason=${r.reason} 锁=${shaOf(file)}（TTL 已过期但 pid 活着 ⇒ 不删）`);
  c.ok(instanceSectionWritten(home) === false, '拒绝时也不写状态（否则会被当成"我正在跑"）');
  // "有人想当第二个实例"要留痕：否则事后只看到"没起来"，看不到"为什么没起来"
  const busy = auditRecords(home).find((x) => x.kind === 'instance.lock-busy');
  c.ok(Boolean(busy), '拒绝成为第二个实例时写了 instance.lock-busy 审计（可排障）');
  c.eq(busy?.detail?.holderPid, process.pid, '审计里记下了原持有者 pid');
  c.ok(String(busy?.message ?? '').includes('拒绝成为第二个实例'), '审计文案说清是"拒绝成为第二个"');
  scheduler.release();
  rmTree(home);
}

/** 有没有写出 instance 段（= 有没有把自己登记成"正在跑"）。 */
function instanceSectionWritten(home) {
  const st = readJsonSafe(path.join(home, 'ops-tickd.json'), null);
  return Boolean(st && st.instance);
}

// ─────────────────────────────── ② pid 撞号（含反向） ───────────────────────────────

function casePidReuse(c) {
  const now = Date.now();
  const deadPid = findDeadPid();
  c.ok(deadPid !== null, '夹具能找到一个确定不存在的 pid（用于模拟"这个 pid 后来被别的进程占了"）');
  if (deadPid === null) return;

  // 撞号的前提：pid 现在**活着**（被别的进程复用），但它的启动时间比锁晚。
  const lateStart = () => now - 1_000;             // 1 秒前才启动 ⇒ 锁（5 分钟前）不可能是它写的
  const earlyStart = () => now - 3_600_000;        // 1 小时前就启动 ⇒ 比锁早 ⇒ 就是同一个进程

  const home = makeHome();
  writeLockFile(home, { name: LOCK_NAME, pid: deadPid, at: new Date(now - 300_000).toISOString(), ttlMs: 120_000 });
  const view = readLockView(lockFileOf(home));

  const reused = judgeLock({
    view, lockFile: lockFileOf(home), now, ttlMs: 120_000, startTimeToleranceMs: 120_000,
    isAliveOf: () => true, startTimeOf: lateStart,
  });
  c.eq(reused.state, 'reclaimable', '撞号 ⇒ 判可回收（锁是孤儿）');
  c.eq(reused.reason, 'pid-reused', 'reason = pid-reused');
  c.ok(reused.evidence.deltaMs > 0, '证据里 deltaMs 为正（启动时间晚于锁）');

  const sameProcess = judgeLock({
    view, lockFile: lockFileOf(home), now, ttlMs: 120_000, startTimeToleranceMs: 120_000,
    isAliveOf: () => true, startTimeOf: earlyStart,
  });
  c.eq(sameProcess.state, 'alive', '反向：启动时间早于锁 ⇒ 同一个进程 ⇒ 判 alive');
  c.ok(String(sameProcess.reason).includes('negative-delta'), 'reason 明写负差');
  c.ok(sameProcess.evidence.deltaMs < 0, '证据里 deltaMs 为负');

  // 这一条是"方向 vs 绝对差"的分水岭：两组时间戳的**绝对差一样大**（都是 300 s），结论必须相反
  c.ok(
    Math.abs(reused.evidence.deltaMs) > 120_000 && Math.abs(sameProcess.evidence.deltaMs) > 120_000,
    '两组差值的绝对值都远超容差 ⇒ 只有方向判据能给出正确答案（绝对差判据会把两者判成同一结论）',
  );
  out(`[②] 撞号：delta=+${Math.round(reused.evidence.deltaMs / 1000)}s ⇒ ${reused.state}/${reused.reason}`
    + ` · 反向：delta=${Math.round(sameProcess.evidence.deltaMs / 1000)}s ⇒ ${sameProcess.state}/${sameProcess.reason}`);

  // 撞号之后真回收：acquire 应该成功（锁是孤儿）
  const reclaimed = acquireInstanceLock({
    home, now, ttlMs: 120_000, startTimeToleranceMs: 120_000, isAliveOf: () => true, startTimeOf: lateStart,
  });
  c.eq(reclaimed.ok, true, '撞号锁能被回收（真的拿到锁）');
  c.eq(reclaimed.reclaimed, true, '返回 reclaimed=true（不是第一次就拿到）');
  rmTree(home);
}

// ─────────────────────────────── ③ 孤儿双跑 ───────────────────────────────

function caseOrphanDoubleRun(c) {
  const now = Date.now();
  const deadPid = findDeadPid();
  if (deadPid === null) { c.ok(false, '找不到死 pid，孤儿夹具无法构造'); return; }

  const home = makeHome();
  const log = makeInstanceLog(home);
  // 上一个实例崩了：锁还在，pid 已经不在了
  writeLockFile(home, { name: LOCK_NAME, pid: deadPid, at: new Date(now - 300_000).toISOString(), ttlMs: 120_000 });

  const first = bootInstance(home, log, 'A');
  c.eq(first.r.ok, true, '孤儿锁（pid 已死）⇒ 第一个实例能回收并起来');
  c.eq(log.count('started'), 1, '假 instance 日志：1 个实例');

  const second = bootInstance(home, log, 'B');
  c.eq(second.r.ok, false, '第二个实例起来时必须被拒');
  c.eq(second.r.reason, 'already-running', 'reason = already-running');
  c.eq(log.count('started'), 1, '假 instance 日志仍然只有 1 个（没有双跑）');
  c.eq(log.count('rejected'), 1, '被拒的那一次也留痕（可排障）');
  out(`[③] 孤儿锁被回收后：started=${log.count('started')} rejected=${log.count('rejected')}（双跑被拦住）`);

  // 第一个正常退出 ⇒ 第三个能起来（不能因为"防止双跑"变成"永久锁死"）
  c.eq(first.scheduler.release(), true, '第一个实例正常释放自己的锁');
  const third = bootInstance(home, log, 'C');
  c.eq(third.r.ok, true, '前一个释放后，下一个实例能起来');
  c.eq(log.count('started'), 2, '假 instance 日志：2 个实例（先后两个，不是同时两个）');
  third.scheduler.release();
  rmTree(home);
}

// ─────────────────────────────── ④ 负差 / 读不到时钟 ⇒ fail-open + 审计 ───────────────────────────────

function caseFailOpen(c) {
  const now = Date.now();
  const deadPid = findDeadPid();
  if (deadPid === null) { c.ok(false, '找不到死 pid，fail-open 夹具无法构造'); return; }

  // (a) 读不到时钟：pid 活着（注入），但拿不到它的启动时间 ⇒ fail-open 判 alive
  const home = makeHome();
  writeLockFile(home, { name: LOCK_NAME, pid: deadPid, at: new Date(now - 300_000).toISOString(), ttlMs: 120_000 });
  const r = acquireInstanceLock({
    home, now, ttlMs: 120_000, isAliveOf: () => true, startTimeOf: () => null,
  });
  c.eq(r.ok, false, '取不到启动时间 ⇒ 不删锁（判 alive）');
  c.eq(r.reason, 'already-running', 'reason = already-running（安全侧）');
  c.eq(r.judge.reason, 'no-start-time', 'judge.reason = no-start-time');
  c.eq(r.judge.failOpen, true, 'judge.failOpen = true（明写，不是隐式行为）');

  const fo = auditRecords(home).find((x) => x.kind === 'instance.lock-fail-open');
  c.ok(Boolean(fo), 'fail-open 必须写一行审计（不许隐式）');
  c.ok(String(fo?.message ?? '').includes('取不到'), '审计行写清了原因');
  out(`[④a] fail-open 审计原文：${JSON.stringify(fo && { kind: fo.kind, message: fo.message, pid: fo.detail?.pid })}`);

  // (b) 负差：启动时间早于锁（时钟跳变/休眠唤醒的典型形态）⇒ 判 alive + 审计 instance.lock-clock-skew
  const home2 = makeHome();
  writeLockFile(home2, { name: LOCK_NAME, pid: deadPid, at: new Date(now - 300_000).toISOString(), ttlMs: 120_000 });
  const r2 = acquireInstanceLock({
    home: home2, now, ttlMs: 120_000, isAliveOf: () => true, startTimeOf: () => now - 3_600_000,
  });
  c.eq(r2.ok, false, '负差 ⇒ 同进程 ⇒ 不删锁');
  const skew = auditRecords(home2).find((x) => x.kind === 'instance.lock-clock-skew');
  c.ok(Boolean(skew), '负差也写一行审计（instance.lock-clock-skew）');
  out(`[④b] 负差审计原文：${JSON.stringify(skew && { kind: skew.kind, message: skew.message, deltaMs: skew.detail?.deltaMs })}`);

  // (c) 坏锁 + 读不到文件时间 ⇒ fail-open（这条最容易被人用"当过期"糊过去）
  const view = { exists: true, raw: null, lock: null, lockMtimeMs: null, readError: 'EACCES' };
  const j = judgeLock({ view, now, ttlMs: 1_000 });
  c.eq(j.state, 'alive', '锁内容坏了且读不到文件时间 ⇒ 判 alive');
  c.eq(j.reason, 'unreadable-no-clock', 'reason = unreadable-no-clock');
  c.eq(j.failOpen, true, '同样标 failOpen');

  // (d) 坏锁 + 已过 TTL ⇒ 才允许按陈旧回收（否则坏锁会永久堵死）
  const view2 = { exists: true, raw: '{{{', lock: null, lockMtimeMs: now - 600_000 };
  const j2 = judgeLock({ view: view2, now, ttlMs: 120_000 });
  c.eq(j2.state, 'reclaimable', '坏锁 + 已超过 TTL ⇒ 可回收（有出口，不会永久卡死）');

  rmTree(home);
  rmTree(home2);
}

// ─────────────────────────────── ⑤ 失败环（fail-open 的出口） ───────────────────────────────

async function caseLiveness(c) {
  const now = Date.now();
  const home = makeHome();
  // 造"连续 10 个周期没有写出新状态"
  writeJson(path.join(home, 'ops-tickd.json'), {
    schemaVersion: 1, runs: [], jobs: {}, lastStateWriteAt: new Date(now - 600_000).toISOString(),
  });
  const scheduler = createScheduler({ home, logger: () => {}, livenessIntervalMs: 60_000, livenessCycles: 3 });

  const lv = scheduler.checkLiveness({ now });
  c.eq(lv.stalled, true, '10 个周期没写状态 ⇒ stalled');
  c.eq(lv.missedCycles, 10, 'missedCycles = 10');
  c.eq(lv.alerted, true, '首次进入停摆 ⇒ alerted = true');
  const alarms = alertRecords(home).filter((a) => a.source === 'ops-instance-liveness');
  c.eq(alarms.length, 1, '告警落 ops-alert.log 一行');
  c.ok(String(alarms[0]?.message ?? '').includes('没有写出新状态'), '告警文案说清"没有写出新状态"');
  out(`[⑤] 失败环告警：${JSON.stringify({ level: alarms[0]?.level, source: alarms[0]?.source, message: alarms[0]?.message })}`);

  // 同一段停摆不刷屏（否则每轮告警一次，人会把通道关掉）
  const lv2 = scheduler.checkLiveness({ now: now + 1_000 });
  c.eq(lv2.alerted, false, '同一段停摆只喊一次');
  c.eq(alertRecords(home).filter((a) => a.source === 'ops-instance-liveness').length, 1, '告警条数仍是 1');

  // 一轮 tick 写出新状态 ⇒ 停摆解除
  await scheduler.tickOnce({ force: false, now: now + 2_000 });
  const lv3 = scheduler.checkLiveness({ now: now + 3_000 });
  c.eq(lv3.stalled, false, '写出新状态后立即解除（不是"喊完就忘"）');
  c.eq(lv3.missedCycles, 0, 'missedCycles 归零');

  // 边界：N 可配（N=3 时"错过 2 个"不算；N=2 时算）
  const edge = (cycles) => computeLiveness({ lastStateWriteAt: now - 120_000, now, intervalMs: 60_000, cycles });
  c.eq(edge(3).stalled, false, '错过 2 个周期 / 阈值 3 ⇒ 不告警');
  c.eq(edge(2).stalled, true, '错过 2 个周期 / 阈值 2 ⇒ 告警（N 改小，边界随之移动）');
  c.eq(edge(3).missedCycles, 2, '边界值本身也是 2（不是四舍五入出来的）');
  out(`[⑤边界] missed=2：阈值3 ⇒ stalled=${edge(3).stalled} · 阈值2 ⇒ stalled=${edge(2).stalled}`);

  // 从没写出过状态 ⇒ 判不了（不冒充"停摆"，也不冒充"正常"）
  const never = computeLiveness({ lastStateWriteAt: null, now, intervalMs: 60_000, cycles: 3 });
  c.eq(never.verdict, 'never-started', '没有任何状态记录 ⇒ verdict = never-started');
  c.eq(never.stalled, false, '从未启动过不喊"停摆"（否则新装第一天就误报）');

  const snap = scheduler.instanceState({ now });
  c.eq(snap.liveness.stalled, false, 'instanceState() 的 liveness 与 checkLiveness 同口径');
  rmTree(home);
}

// ─────────────────────────────── ⑥ 拿到锁立刻写状态（消空窗） ───────────────────────────────

function caseNoStateGap(c) {
  const home = makeHome();
  const log = makeInstanceLog(home);
  const t0 = Date.now();
  const { scheduler, r } = bootInstance(home, log, 'A');
  c.eq(r.ok, true, '空 home ⇒ ensure 成功');

  // 关键：**不跑任何 tick**，直接读状态 —— 空窗被消掉了才算过
  const st = readJsonSafe(path.join(home, 'ops-tickd.json'), null);
  c.ok(Boolean(st), 'ensure 之后状态文件就已经存在（不用等第一轮 tick）');
  c.eq(st?.instance?.pid, process.pid, '状态里记下了持有实例锁的 pid');
  const wrote = Date.parse(String(st?.lastStateWriteAt ?? ''));
  c.ok(Number.isFinite(wrote) && wrote >= t0 - 2_000, 'lastStateWriteAt 在 ensure 时刻就已经写出来了');
  c.eq(log.count('started'), 1, '假 instance 日志：1 个实例');

  const snap = scheduler.instanceState();
  c.eq(snap.lock?.pid, process.pid, 'instanceState() 能读到锁主');
  scheduler.heartbeat();
  const beat = readJsonSafe(path.join(home, 'ops-locks', `${LOCK_NAME}.lock.beat`), null);
  c.eq(beat?.pid, process.pid, '心跳（证据文件）写出来了');
  out(`[⑥] 空窗：ensure 后无 tick 即读出 instance.pid=${st?.instance?.pid} lastStateWriteAt=${st?.lastStateWriteAt}`);
  scheduler.release();
  rmTree(home);
}

// ─────────────────────────────── ⑦ 心跳只作证据（不作判据） ───────────────────────────────

function caseHeartbeatIsEvidenceOnly(c) {
  const now = Date.now();
  const deadPid = findDeadPid();
  if (deadPid === null) { c.ok(false, '找不到死 pid，心跳夹具无法构造'); return; }

  // (a) 心跳很旧，但锁主活着 ⇒ 仍然判 alive（不许因为"心跳停了"就删锁）
  const home = makeHome();
  writeLockFile(home, { name: LOCK_NAME, pid: process.pid, at: new Date(now - 5_000).toISOString(), ttlMs: 120_000 });
  recordHeartbeat(lockFileOf(home), { now: now - 3_600_000 });
  const j = judgeLock({ view: readLockView(lockFileOf(home)), lockFile: lockFileOf(home), now, ttlMs: 120_000 });
  c.eq(j.state, 'alive', '心跳停了一小时，但 pid 活着 ⇒ 仍判 alive');
  c.ok(j.evidence.heartbeatAgeMs > 3_000_000, '心跳年龄只进证据（heartbeatAgeMs）');

  // (b) 心跳很新，但锁主死了 ⇒ 仍然判可回收（不许因为"心跳新"就以为它还活着）
  const home2 = makeHome();
  writeLockFile(home2, { name: LOCK_NAME, pid: deadPid, at: new Date(now - 300_000).toISOString(), ttlMs: 120_000 });
  recordHeartbeat(lockFileOf(home2), { now });
  const j2 = judgeLock({ view: readLockView(lockFileOf(home2)), lockFile: lockFileOf(home2), now, ttlMs: 120_000 });
  c.eq(j2.state, 'reclaimable', '心跳是刚写的，但 pid 已死 ⇒ 仍判可回收');
  out(`[⑦] 心跳只作证据：(a) 旧心跳+活锁主 ⇒ ${j.state} · (b) 新心跳+死锁主 ⇒ ${j2.state}`);
  rmTree(home);
  rmTree(home2);
}

// ─────────────────────────────── 总装 ───────────────────────────────

export async function run(c) {
  // DSH_HOME / OPS_CORE_HOME 全程指夹具临时目录（跑完原样恢复，不污染同进程里别的夹具）
  const saved = { OPS_CORE_HOME: process.env.OPS_CORE_HOME, DSH_HOME: process.env.DSH_HOME };
  const envRoot = makeTempDir('butler-core-lock-env');
  process.env.OPS_CORE_HOME = envRoot;
  process.env.DSH_HOME = envRoot;
  out(`[env] OPS_CORE_HOME = DSH_HOME = ${envRoot}（本夹具不写任何真实 home）`);
  try {
    out('--- ① 活锁被判死 ---');
    caseAliveLockKilled(c);
    out('--- ② pid 撞号（正/反） ---');
    casePidReuse(c);
    out('--- ③ 孤儿双跑 ---');
    caseOrphanDoubleRun(c);
    out('--- ④ 负差 / 无时钟 ⇒ fail-open + 审计 ---');
    caseFailOpen(c);
    out('--- ⑤ 失败环 ---');
    await caseLiveness(c);
    out('--- ⑥ 拿到锁立刻写状态 ---');
    caseNoStateGap(c);
    out('--- ⑦ 心跳只作证据 ---');
    caseHeartbeatIsEvidenceOnly(c);
  } finally {
    if (saved.OPS_CORE_HOME === undefined) delete process.env.OPS_CORE_HOME;
    else process.env.OPS_CORE_HOME = saved.OPS_CORE_HOME;
    if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.DSH_HOME;
    rmTree(envRoot);
  }
}

// 直接跑本文件时（`node test/test-instance-lock.mjs`）自检一遍并打印 —— 验收贴输出用。
const isMain = (() => {
  const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!argv1) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  return real(argv1) === real(THIS_FILE);
})();

if (isMain) {
  const c = makeChecker();
  await run(c);
  process.stdout.write(`\n${c.state.fail === 0 ? 'PASS' : 'FAIL'}  ${name}  ${c.state.pass}/${c.state.pass + c.state.fail}\n`);
  for (const f of c.state.failures) process.stdout.write(`  ✖ ${f}\n`);
  process.exitCode = c.state.fail ? 1 : 0;
}
