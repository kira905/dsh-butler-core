// ops-core / src/alert.mjs —— 告警通道（独立于骨架自身组件）
//
// 设计纪律：告警必须比被观察的系统更"耐活"。所以这里只用 node: 内建 + 追加写，
// 不 import 调度器 / job / 面板。附加通道由调用方注册，任何通道抛错都不得影响主流程。
import fs from 'node:fs';
import { ensureDir, opsPaths } from './paths.mjs';

const channels = [];

/** 注册附加通道：fn(entry) 可抛错，会被吞掉。返回注销函数。 */
export function addChannel(fn) {
  if (typeof fn !== 'function') return () => {};
  channels.push(fn);
  return () => {
    const i = channels.indexOf(fn);
    if (i >= 0) channels.splice(i, 1);
  };
}

/**
 * 发一条告警。
 * @param {{level?:'info'|'warn'|'error', source:string, message:string, detail?:object}} entry
 * @param {{home?:string, silent?:boolean}} [opts]
 * @returns {{ok:boolean, file:string, error?:string}}
 */
export function alert(entry, opts = {}) {
  const rec = {
    at: new Date().toISOString(),
    level: entry.level ?? 'warn',
    source: entry.source ?? 'ops-core',
    message: entry.message ?? '',
    detail: entry.detail ?? null,
  };
  const p = opsPaths(opts.home);
  let ok = true;
  let error;
  try {
    ensureDir(p.home);
    fs.appendFileSync(p.alertLog, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) {
    ok = false;
    error = e?.message ?? String(e);
  }
  if (!opts.silent) {
    try { process.stderr.write(`[ops-core][${rec.level}] ${rec.source}: ${rec.message}\n`); } catch { /* ignore */ }
  }
  for (const ch of channels) {
    try { ch(rec); } catch { /* 通道自身故障不影响主流程 */ }
  }
  return { ok, file: p.alertLog, error };
}

/** 读告警尾部。 */
export function tailAlerts(limit = 20, opts = {}) {
  const p = opsPaths(opts.home);
  try {
    return fs.readFileSync(p.alertLog, 'utf8').split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch {
    return [];
  }
}
