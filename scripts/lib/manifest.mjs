/**
 * 清单（suite-manifest.json）= 单一真相。
 *
 * 安装器与自检脚本读的是同一份文件、同一批字段：安装器用它决定"装什么、怎么算装好"，
 * 自检脚本用它决定"查什么、怎么算绿"。任何一方想加判据，只能改这份清单，不许在代码里
 * 另写一份包名表 —— 两处真相必然漂移。
 *
 * 同源说明（重要）：本文件与 `dsh-butler-install` 仓的 `lib/manifest.mjs` **同源**。
 * 差异只有一处（见下面 `EXTENDED_PROBE_FIELDS` 的注释）：本仓额外认 `probe.api`（插件
 * 的只读 HTTP 探针），它是**可选扩展字段**；那边不认它、也不拒绝未知字段，所以同一份
 * 清单两边都能读，加这个字段**不需要改安装器**。
 *
 * 校验的纪律：**每条错误都带文件名 + 行号**。清单是给人手改的，只说"少了 type"
 * 等于让人在大文件里瞎找。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseRange, describeRange } from './semver.mjs';

export const SCHEMA_VERSION = 1;
export const PROBE_KINDS = ['existence', 'help', 'cmd'];
export const ITEM_TYPES = ['plugin', 'cli'];
export const MOUNT_MODES = ['auto', 'manual', 'none'];

/**
 * 本仓额外认的可选探针字段（安装器不认，但它不拒绝未知字段 ⇒ 同一份清单两边通吃）。
 *   api —— 插件类专用的**只读** HTTP 路径（如 /api/task-board/tasks），自检第 13 项会 GET 它。
 */
export const EXTENDED_PROBE_FIELDS = ['api'];

export class ManifestError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'ManifestError';
    this.issues = issues || [];
  }
}

function lineAt(raw, index) {
  if (index < 0) return 1;
  return raw.slice(0, index).split(/\r?\n/).length;
}

/** JSON.parse 的报错里有位置信息，翻成行号；翻不出来就报第 1 行 */
function parseErrorLocation(raw, err) {
  const msg = String(err && err.message ? err.message : err);
  const lineCol = /line (\d+) column (\d+)/.exec(msg);
  if (lineCol) return Number(lineCol[1]);
  const posMatch = /position (\d+)/.exec(msg);
  if (posMatch) return lineAt(raw, Number(posMatch[1]));
  return 1;
}

/**
 * 给某个条目定位行号：优先按 name，其次 versionRange / group，
 * 全都没有时退化成"第 index+1 个对象字面量的起始行"。
 */
function locateItemLine(raw, item, index) {
  const probes = [];
  if (item && typeof item.name === 'string') probes.push(`"name": ${JSON.stringify(item.name)}`);
  if (item && typeof item.versionRange === 'string') probes.push(`"versionRange": ${JSON.stringify(item.versionRange)}`);
  if (item && typeof item.group === 'string') probes.push(`"group": ${JSON.stringify(item.group)}`);
  for (const needle of probes) {
    const at = raw.indexOf(needle);
    if (at >= 0) return lineAt(raw, at);
  }
  // 退化路径：数第 index+1 个 `\n    {`
  const re = /\n[ \t]*\{/g;
  let hit = null;
  let count = 0;
  let m;
  while ((m = re.exec(raw))) {
    // 跳过最外层对象：顶层 `{` 在第 1 行附近
    count += 1;
    if (count === index + 2) {
      hit = m.index + 1;
      break;
    }
  }
  return lineAt(raw, hit === null ? 0 : hit);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 校验一份已解析的清单对象（纯函数，不读盘，便于夹具直接喂数据）。
 * @returns {{items: Array, excluded: Array, groups: string[]}}
 */
export function validateManifest(data, raw) {
  const issues = [];
  const report = (line, message) => issues.push({ line, message });
  const text = typeof raw === 'string' ? raw : JSON.stringify(data, null, 2);

  if (!isPlainObject(data)) {
    report(1, '清单根节点必须是对象');
    throw new ManifestError('清单校验失败', issues);
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    report(1, `schemaVersion 必须是 ${SCHEMA_VERSION}（现在读到 ${JSON.stringify(data.schemaVersion)}）`);
  }
  if (!Array.isArray(data.items) || data.items.length === 0) {
    report(1, 'items 必须是非空数组');
    throw new ManifestError('清单校验失败', issues);
  }

  const seenNames = new Map(); // name -> line
  const seenAliases = new Map(); // alias -> line
  const items = [];

  data.items.forEach((item, index) => {
    const line = locateItemLine(text, item, index);
    const where = `第 ${index + 1} 个条目`;
    if (!isPlainObject(item)) {
      report(line, `${where}必须是对象`);
      return;
    }

    // name
    if (typeof item.name !== 'string' || !item.name.trim()) {
      report(line, `${where}缺 name（非空字符串，包名形态如 @scope/name 或 name）`);
    } else if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(item.name.trim())) {
      report(line, `${where}的 name 不像包名：${JSON.stringify(item.name)}`);
    } else if (seenNames.has(item.name)) {
      report(line, `${where}的 name 与第 ${seenNames.get(item.name)} 行重复：${item.name}`);
    } else {
      seenNames.set(item.name, line);
    }

    // versionRange
    if (typeof item.versionRange !== 'string') {
      report(line, `${where}缺 versionRange（非空字符串，写法 ^x.y.z / ~x.y.z / x.y.z）`);
    } else if (!parseRange(item.versionRange)) {
      report(
        line,
        `${where}的 versionRange 非法：${JSON.stringify(item.versionRange)}（只接受 ^x.y.z / ~x.y.z / x.y.z，不接受 >=、1.x、|| 组合）`,
      );
    }

    // type
    if (!ITEM_TYPES.includes(item.type)) {
      report(line, `${where}的 type 必须是 ${ITEM_TYPES.join(' 或 ')}（现在读到 ${JSON.stringify(item.type)}）`);
    }

    // group
    if (typeof item.group !== 'string' || !item.group.trim()) {
      report(line, `${where}缺 group（非空字符串，用于 --only 按组选）`);
    }

    // mount
    if (item.mount !== undefined) {
      if (!MOUNT_MODES.includes(item.mount)) {
        report(line, `${where}的 mount 必须是 ${MOUNT_MODES.join(' / ')}（现在读到 ${JSON.stringify(item.mount)}）`);
      } else if (item.type === 'cli' && item.mount !== 'none') {
        report(line, `${where}是 cli 类型，不该带 mount=${item.mount}（命令行工具不进组合列表）`);
      }
    }

    // probe
    const probe = item.probe;
    if (!isPlainObject(probe)) {
      report(line, `${where}缺 probe 对象（至少要有 kind）`);
    } else {
      const kind = probe.kind === undefined ? 'existence' : probe.kind;
      if (!PROBE_KINDS.includes(kind)) {
        report(line, `${where}的 probe.kind 必须是 ${PROBE_KINDS.join(' / ')}（现在读到 ${JSON.stringify(probe.kind)}）`);
      }
      if (item.type === 'cli' && (typeof probe.cmd !== 'string' || !probe.cmd.trim())) {
        report(line, `${where}是 cli 类型，probe.cmd 必填（要查的那个命令名）`);
      }
      if (kind === 'help') {
        if (typeof probe.cmd !== 'string' || !probe.cmd.trim()) {
          report(line, `${where}标了 probe.kind=help，必须写 probe.cmd（--help 是按命令核的，不是按仓一刀切）`);
        }
        if (!isPlainObject(probe.helpVerified) || typeof probe.helpVerified.file !== 'string' || !probe.helpVerified.file.trim()) {
          report(
            line,
            `${where}标了 probe.kind=help，必须给 probe.helpVerified（{file, line?, note?}）说明"这条命令确实实现了 --help"是核在哪份源码上得出的`,
          );
        }
      }
      if (kind === 'cmd') {
        if (typeof probe.cmd !== 'string' || !probe.cmd.trim()) {
          report(line, `${where}标了 probe.kind=cmd，必须写 probe.cmd`);
        }
        if (typeof probe.readonlyBecause !== 'string' || !probe.readonlyBecause.trim()) {
          report(line, `${where}标了 probe.kind=cmd，必须写 probe.readonlyBecause（凭什么认定这条命令只读）`);
        }
      }
      // 本仓扩展字段：probe.api（插件类只读 HTTP 探针）
      if (probe.api !== undefined) {
        if (typeof probe.api !== 'string' || !/^\/[^\s]*$/.test(probe.api.trim())) {
          report(line, `${where}的 probe.api 必须是以 / 开头的路径（例如 /api/task-board/tasks）`);
        } else if (item.type !== 'plugin') {
          report(line, `${where}的 probe.api 只对 plugin 类有意义（cli 类要查命令用 probe.cmd）`);
        }
      }
    }

    // aliases
    if (item.aliases !== undefined) {
      if (!Array.isArray(item.aliases) || item.aliases.some((a) => typeof a !== 'string' || !a.trim())) {
        report(line, `${where}的 aliases 必须是字符串数组`);
      } else {
        for (const alias of item.aliases) {
          if (seenAliases.has(alias)) {
            report(line, `${where}的别名 ${alias} 与第 ${seenAliases.get(alias)} 行重复`);
          } else {
            seenAliases.set(alias, line);
          }
        }
      }
    }

    items.push(item);
  });

  // 别名不许撞包名
  for (const [alias, line] of seenAliases) {
    if (seenNames.has(alias)) {
      report(line, `别名 ${alias} 与某个条目的 name 相同，会造成 --only 歧义`);
    }
  }

  const excluded = [];
  if (data.excluded !== undefined) {
    if (!Array.isArray(data.excluded)) {
      report(1, 'excluded 必须是数组（可以省略）');
    } else {
      data.excluded.forEach((entry, i) => {
        if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.reason !== 'string' || !entry.reason.trim()) {
          report(1, `excluded 第 ${i + 1} 项必须是 {id, reason}，且都是非空字符串`);
        } else {
          excluded.push(entry);
        }
      });
    }
  }

  if (issues.length) throw new ManifestError('清单校验失败', issues);

  const groups = [...new Set(items.map((i) => i.group))];
  return { items, excluded, groups };
}

/** 从磁盘读 + 校验；错误统一转成带 `文件:行` 的 ManifestError */
export function loadManifest(manifestPath) {
  const resolved = path.resolve(manifestPath);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new ManifestError(`读不到清单：${resolved}（${err.code || err.message}）`, []);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const line = parseErrorLocation(raw, err);
    throw new ManifestError('清单不是合法 JSON', [
      { line, message: `JSON 解析失败：${String(err.message).replace(/^.*?JSON\.parse: /, '')}` },
    ]);
  }
  const result = validateManifest(data, raw);
  return { ...result, path: resolved, raw, meta: { suite: data.suite, description: data.description } };
}

/** 校验一个已解析的清单对象（内置兜底清单走这条），错误同样带行号 */
export function loadManifestObject(data, label = '<内置清单>') {
  const raw = JSON.stringify(data, null, 2);
  const result = validateManifest(data, raw);
  return { ...result, path: label, raw, meta: { suite: data.suite, description: data.description } };
}

/** 把 ManifestError 印成人读的 `文件:行: 说明` 列表 */
export function formatManifestError(err, fileName) {
  const head = fileName ? `${fileName}` : 'suite-manifest.json';
  const lines = [err.message || String(err)];
  for (const issue of err.issues || []) {
    lines.push(`  ${head}:${issue.line}: ${issue.message}`);
  }
  return lines.join('\n');
}

/** 给人读的一项摘要（dry-run / 报告共用） */
export function describeItem(item) {
  const range = parseRange(item.versionRange);
  const probe = item.probe || {};
  const mount = item.mount || (item.type === 'plugin' ? 'auto' : 'none');
  return {
    name: item.name,
    type: item.type,
    group: item.group,
    rangeText: describeRange(range),
    mount,
    probeKind: probe.kind || 'existence',
    probeCmd: probe.cmd || '',
  };
}
