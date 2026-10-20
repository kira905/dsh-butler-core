// ops-core / src/store.mjs —— 状态文件读写唯一入口
//
// 三条硬契约（从生产大管家 years of 事故里提炼，骨架也必须守住）：
//   1. 原子写：写同目录临时文件 → fsync → rename 覆盖。禁止 writeFileSync(目标)。
//      rename 失败重试 3 次（50/150/400ms），仍失败保留 .tmp 并抛错 —— 绝不退化为直接写目标。
//   2. 单例 tick 互斥：锁用 wx 原子创建（禁止 existsSync + 写 的 TOCTOU）。
//      抢不到且未过期 ⇒ { ok:false }，调用方按"本轮跳过"处理（不是错误）。
//      锁过期 ⇒ 可抢占，并返回 stale:true 让调用方记一行审计。
//   3. 读-改-写唯一入口：readJson / updateJson。任何脚本不得自己
//      JSON.parse(readFileSync(...)) 后再写回 —— 那会丢并发更新。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.mjs';

export class AtomicWriteError extends Error {
  constructor(file, tmp, attempts, cause) {
    super(`原子写失败（重试 ${attempts} 次）：${file}（${cause}）；临时文件已保留：${tmp}`);
    this.name = 'AtomicWriteError';
    this.code = 'ATOMIC_WRITE_FAILED';
    this.file = file;
    this.tmp = tmp;
  }
}

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
/** 同步 sleep（短命 tick 里比异步更可靠：没有 event loop 竞争）。 */
export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_BUF, 0, 0, ms);
}

function tmpPathFor(file) {
  const rnd = crypto.randomBytes(4).toString('hex');
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${rnd}.tmp`);
}

function fsyncDir(dir) {
  // Windows 上对目录 fsync 会 EPERM/EISDIR，忽略即可；POSIX 上这一步保证 rename 落盘。
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* 平台差异，不影响语义 */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/** 原子写文本。返回写入的字节数。 */
export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = tmpPathFor(file);
  const attempts = [0, 50, 150, 400];
  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i]) sleepSync(attempts[i]);
    try {
      const fd = fs.openSync(tmp, 'w');
      try {
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
      fsyncDir(path.dirname(file));
      return Buffer.byteLength(text, 'utf8');
    } catch (e) {
      lastErr = e;
      // 临时文件可能已经存在（上次失败残留）；下一次用新随机名重试，旧文件留给排障。
      try { if (fs.existsSync(tmp) && !fs.existsSync(file)) fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    }
  }
  throw new AtomicWriteError(file, tmp, attempts.length, lastErr?.message ?? String(lastErr));
}

/** 原子写 JSON（2 空格缩进 + 末尾换行，便于人工 diff）。 */
export function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * 读 JSON。
 * @param {string} file
 * @param {{defaultValue?: any, onCorrupt?: (info:{file,backup,error})=>void}} [opts]
 *   defaultValue 显式传入时：文件不存在 / 解析失败都返回它（并把坏文件备份为 *.corrupt-<ts>）
 *   未传 defaultValue 时：文件不存在返回 null；解析失败抛错（调用方明确报错，不静默降级）
 */
export function readJson(file, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return opts.defaultValue !== undefined ? structuredClone(opts.defaultValue) : null;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    if (opts.defaultValue === undefined) throw new Error(`状态文件解析失败：${file}（${e.message}）`);
    let backup = null;
    try {
      backup = `${file}.corrupt-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
      fs.renameSync(file, backup);
    } catch { backup = null; }
    try { opts.onCorrupt?.({ file, backup, error: e.message }); } catch { /* 回调失败不影响主流程 */ }
    return structuredClone(opts.defaultValue);
  }
}

/** 读-改-写（同步）。updater 返回新值；返回写入后的值。 */
export function updateJson(file, updater, opts = {}) {
  const current = readJson(file, opts);
  const next = updater(current);
  if (next !== undefined) writeJsonAtomic(file, next);
  return next;
}

/** 单例锁。锁文件内容 = {name, pid, at, ttlMs, runId}。 */
export function acquireLock(name, { home, ttlMs = 5 * 60_000, runId = null } = {}) {
  const dir = path.join(home, 'ops-locks');
  ensureDir(dir);
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '_');
  const file = path.join(dir, `${safe}.lock`);
  const payload = JSON.stringify({ name, pid: process.pid, at: new Date().toISOString(), ttlMs, runId });
  const claim = () => fs.writeFileSync(file, payload, { encoding: 'utf8', flag: 'wx' });
  try {
    claim();
    return { ok: true, file, release: () => releaseLock(file, payload), stale: false };
  } catch (e) {
    if (e?.code !== 'EEXIST') throw e;
  }
  // 锁已存在：判断是否过期（坏锁/空锁/时钟异常一律当过期，避免永久卡死）
  let holder = null;
  try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { holder = null; }
  const at = Date.parse(holder?.at ?? '');
  const ttl = Number.isFinite(Number(holder?.ttlMs)) ? Number(holder.ttlMs) : ttlMs;
  const expired = !holder || !Number.isFinite(at) || Date.now() - at > ttl;
  if (!expired) return { ok: false, file, reason: `locked by pid ${holder?.pid ?? '?'} since ${holder?.at ?? '?'}`, release: () => {} };
  // 抢占：先写新内容再 rename（同目录原子）；抢占失败说明别人刚抢到，按"跳过"处理
  try {
    const tmp = tmpPathFor(file);
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file, release: () => releaseLock(file, payload), stale: true };
  } catch {
    return { ok: false, file, reason: 'stale lock race', release: () => {} };
  }
}

/** 释放锁。只删"仍属于自己"的锁（防抢占后旧持有者删掉新锁）；删失败交给 TTL 兜底。 */
export function releaseLock(file, expect = null) {
  try {
    if (expect) {
      const cur = fs.readFileSync(file, 'utf8');
      if (cur !== expect) return false;
    }
    fs.rmSync(file, { force: true });
    return true;
  } catch { return false; }
}

/** 列锁文件（自愈 job 用）。 */
export function listLocks(home) {
  const dir = path.join(home, 'ops-locks');
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.lock')).map((n) => {
      const file = path.join(dir, n);
      let info = null;
      try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { info = null; }
      const st = fs.statSync(file);
      const at = Date.parse(info?.at ?? '');
      const ttl = Number(info?.ttlMs) || 0;
      return { file, name: n.replace(/\.lock$/, ''), info, size: st.size, mtimeMs: Math.round(st.mtimeMs), expired: !info || !Number.isFinite(at) || Date.now() - at > ttl };
    });
  } catch {
    return [];
  }
}

/** 文件指纹（自检 / 幂等判据用）。 */
export function fingerprint(file) {
  try {
    const st = fs.statSync(file);
    const buf = fs.readFileSync(file);
    return { exists: true, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0, sha256: null };
  }
}
