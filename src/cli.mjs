// ops-core / src/cli.mjs —— 极简参数解析（零依赖）
//
// 只支持骨架自己需要的形状：
//   --flag / --key value / --key=value / 位置参数
//   --only a,b  这类逗号列表由调用方自己 split
// 不认识的参数**报错退出**（rc=2）—— 宁可拒绝，不猜。
export function parseArgs(argv) {
  const out = { _: [], flags: {}, values: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) {
      const k = a.slice(2, eq);
      out.values[k] = a.slice(eq + 1);
      continue;
    }
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.values[k] = next;
      i += 1;
    } else {
      out.flags[k] = true;
    }
  }
  return out;
}

/** 取数字参数：非法值直接抛错（不静默回落默认值）。 */
export function numArg(args, key, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) {
  const raw = args.values[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${key} 必须是 ${min}~${max} 之间的数字（收到 ${raw}）`);
  return n;
}

/** 简单表格（列宽按字符数，中文按 2 个宽度近似）。 */
export function table(rows, headers) {
  const width = (s) => [...String(s ?? '')].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const pad = (s, w) => String(s ?? '') + ' '.repeat(Math.max(0, w - width(s)));
  const cols = headers.length;
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map((r) => line(r.slice(0, cols)))].join('\n');
}
