// ops-core / src/audit.mjs —— 审计流水唯一写入口（append-only + 哈希链）
//
// 为什么要有哈希链：审计文件是"事后证明系统做过什么"的唯一凭据。如果它能被静默改写，
// 整条自主链的追责就失效了。每条记录带 prev（上一条 hash）+ hash（本条内容 hash），
// 任何一处删除/改写都会在 verify 时暴露。
//
// 契约：
//   - 单行 JSON，appendFileSync 追加（O_APPEND 单行写入在 POSIX 上原子；Windows 上单进程 tick 足够）
//   - 写失败绝不抛：审计不能反过来拖垮主流程，失败走 alert 并返回 { ok:false }
//   - 本文件只依赖 node: 内建，不 import 调度器 / 业务 job（避免循环依赖）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, monthKey, opsPaths } from './paths.mjs';

/** 一条记录的内容 hash（排除 hash 字段本身）。 */
export function recordHash(rec) {
  const { hash, ...rest } = rec ?? {};
  return crypto.createHash('sha256').update(JSON.stringify(rest), 'utf8').digest('hex');
}

/** 读文件末尾最后一条记录的 hash（哈希链锚点；读失败返回 null）。 */
function lastHash(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const st = fs.fstatSync(fd);
      if (!st.size) return null;
      const size = Math.min(st.size, 64 * 1024);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, st.size - size);
      const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
      const last = lines[lines.length - 1];
      if (!last) return null;
      const rec = JSON.parse(last);
      return typeof rec?.hash === 'string' ? rec.hash : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * 追加一行审计。
 * @param {object} entry 审计内容（自动补 at / pid / prev / hash）
 * @param {{home?:string, silent?:boolean}} [opts]
 * @returns {{ok:boolean, file:string, hash?:string, error?:string}}
 */
export function appendAudit(entry, opts = {}) {
  const p = opsPaths(opts.home);
  const file = path.join(p.auditDir, `${monthKey()}.jsonl`);
  const rec = { at: new Date().toISOString(), pid: process.pid, ...entry };
  try {
    ensureDir(p.auditDir);
    rec.prev = lastHash(file);
    rec.hash = recordHash(rec);
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    return { ok: true, file, hash: rec.hash };
  } catch (e) {
    const error = e?.message ?? String(e);
    if (!opts.silent) {
      try { process.stderr.write(`[ops-core][warn] 审计写入失败：${error}（${file}）\n`); } catch { /* ignore */ }
    }
    return { ok: false, file, error };
  }
}

/** 读审计尾部（排障 / 日报用）。 */
export function tailAudit(limit = 20, opts = {}) {
  const p = opsPaths(opts.home);
  const file = path.join(p.auditDir, `${monthKey()}.jsonl`);
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}

/**
 * 审计链自检：返回 { ok, breaks:[...], count }。
 * 判据 = 每条记录的 prev 必须等于上一条的 hash；链首 prev 必须为 null。
 */
export function verifyAuditChain(opts = {}) {
  const p = opsPaths(opts.home);
  const file = path.join(p.auditDir, `${monthKey()}.jsonl`);
  const breaks = [];
  let count = 0;
  let prev = null;
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      count += 1;
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { breaks.push({ line: i + 1, reason: 'json' }); continue; }
      if (rec.prev !== prev) breaks.push({ line: i + 1, reason: 'prev-mismatch', expected: prev, actual: rec.prev ?? null });
      const want = recordHash(rec);
      if (rec.hash !== want) breaks.push({ line: i + 1, reason: 'hash-mismatch', expected: want, actual: rec.hash ?? null });
      prev = rec.hash ?? null;
    }
  } catch { /* 文件不存在 = 空链 */ }
  return { ok: breaks.length === 0, breaks, count, file };
}
