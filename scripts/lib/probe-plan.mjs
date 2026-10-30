/**
 * 探针执行计划 —— 纯函数，**不读盘、不起进程**。
 *
 * 为什么单独抽出来：第 13 项里有一条红线是"**禁止对没实现 `--help` 的命令跑 `--help`**"
 * （方案 §3.2-C：对没实现的命令，`--help` 会被当普通参数忽略、脚本照常导出/归档/改状态）。
 * 这条判据必须能被夹具**单独证红**（把守卫改反 ⇒ 夹具必须红），而写在 CLI 主文件里的
 * 分支没法测（脚本一被 import 就会执行 main）。所以把"该不该跑"这个决定放到这里。
 *
 * 两道闸，都要过：
 *   ① 清单校验（lib/manifest.mjs）：kind=help 必须给 helpVerified、kind=cmd 必须给 readonlyBecause
 *   ② 本文件：执行前再核一遍 —— 防的是"有人把 ① 改了"或"清单对象是手工拼的"
 */

/** 各种"不跑"的理由（人读文案，直接进 detail） */
export const PROBE_SKIP_REASON = {
  'no-cmd': '清单没给 probe.cmd',
  'help-not-verified': '清单标了 help 但没给 helpVerified ⇒ 拒绝执行（对没实现 --help 的命令，--help 是导出/归档/改状态这类真动作）',
  'cmd-not-readonly-proven': '清单标了 cmd 但没写 readonlyBecause ⇒ 拒绝执行（说不出凭什么只读就不跑）',
  'unknown-kind': '未知探针类型（只认 existence / help / cmd）',
};

/**
 * @param {{type?:string, probe?:object}} item 清单条目
 * @returns {{mode:'existence'}|{mode:'exec', args:string[], label:string}|{mode:'skip', code:string, why:string}}
 */
export function planProbe(item) {
  const probe = item && typeof item.probe === 'object' && item.probe ? item.probe : {};
  const kind = probe.kind === undefined ? 'existence' : probe.kind;

  if (kind === 'existence') return { mode: 'existence' };

  const cmd = typeof probe.cmd === 'string' ? probe.cmd.trim() : '';

  if (kind === 'help') {
    if (!cmd) return { mode: 'skip', code: 'no-cmd', why: PROBE_SKIP_REASON['no-cmd'] };
    if (!probe.helpVerified || typeof probe.helpVerified.file !== 'string' || !probe.helpVerified.file.trim()) {
      return { mode: 'skip', code: 'help-not-verified', why: PROBE_SKIP_REASON['help-not-verified'] };
    }
    return { mode: 'exec', args: ['--help'], label: `${cmd} --help` };
  }

  if (kind === 'cmd') {
    if (!cmd) return { mode: 'skip', code: 'no-cmd', why: PROBE_SKIP_REASON['no-cmd'] };
    if (typeof probe.readonlyBecause !== 'string' || !probe.readonlyBecause.trim()) {
      return { mode: 'skip', code: 'cmd-not-readonly-proven', why: PROBE_SKIP_REASON['cmd-not-readonly-proven'] };
    }
    const args = Array.isArray(probe.args) ? probe.args.map(String) : [];
    return { mode: 'exec', args, label: `${cmd} ${args.join(' ')}`.trim() };
  }

  return { mode: 'skip', code: 'unknown-kind', why: `${PROBE_SKIP_REASON['unknown-kind']}：${JSON.stringify(kind)}` };
}

/** 整批墙钟判定：剩余时间不够就整体降级（纯函数，便于夹具直接测边界） */
export function shouldDegradeBatch(startedAt, now, limitMs) {
  const used = Number(now) - Number(startedAt);
  const limit = Number(limitMs);
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return false;
  return used > limit;
}
