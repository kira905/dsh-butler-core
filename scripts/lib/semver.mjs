/**
 * 版本区间比对（零依赖小实现）。
 *
 * 同源说明（重要）：本文件与 `dsh-butler-install` 仓的 `lib/semver.mjs` **同源**，
 * 那边是安装器用的版本判据，这边是装后自检用的。判据必须字字相同 —— 否则会出现
 * "安装器说装好了、自检说版本不对"的双真相。改动要**两处同批**。
 *
 * 为什么只用区间、不钉精确版本：宿主把组件装进 profile 时，落进
 * `dependencies` 的是 `^x.y.z` 这样的**区间**，不是精确版本。清单写精确版本
 * 只会造成"清单与实体永远不一致"的假红，所以清单的期望值一律用区间表达。
 *
 * 支持三种写法：`^x.y.z`（插入号）、`~x.y.z`（波浪号）、`x.y.z`（精确）。
 * 其它写法（`>=1.2`、`1.x`、`||` 组合）**不支持**，清单校验阶段会报错 ——
 * 与其在两处语义上各猜一半，不如让写法收敛。
 *
 * 三态返回（这是调用方唯一该依赖的接口）：
 *   'yes'     —— 版本落在区间内
 *   'no'      —— 版本明确落在区间外
 *   'unknown' —— 无法判定（版本串解析不了、或带预发布后缀），**不许当通过用**
 */

const NUM = '(0|[1-9]\\d*)';
const VERSION_RE = new RegExp(`^v?${NUM}\\.${NUM}\\.${NUM}(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.-]+)?$`);
const RANGE_RE = new RegExp(`^([\\^~=])?${NUM}\\.${NUM}\\.${NUM}$`);

/** 解析 `1.2.3` / `v1.2.3` / `1.2.3-rc.1`，失败返回 null */
export function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || '',
    raw: input.trim(),
  };
}

/** 解析 `^1.2.3` / `~1.2.3` / `1.2.3`，失败返回 null（不抛） */
export function parseRange(input) {
  if (typeof input !== 'string') return null;
  const m = RANGE_RE.exec(input.trim());
  if (!m) return null;
  return {
    op: m[1] || '=',
    major: Number(m[2]),
    minor: Number(m[3]),
    patch: Number(m[4]),
    raw: input.trim(),
  };
}

export function compareVersions(a, b) {
  const keys = ['major', 'minor', 'patch'];
  for (const k of keys) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

/** 区间的上界（不含）。`^` 允许改最后一档以内的位；`~` 只允许改补丁号 */
export function rangeUpperBound(range) {
  if (range.op === '^') {
    if (range.major > 0) return { major: range.major + 1, minor: 0, patch: 0 };
    if (range.minor > 0) return { major: 0, minor: range.minor + 1, patch: 0 };
    return { major: 0, minor: 0, patch: range.patch + 1 };
  }
  if (range.op === '~') return { major: range.major, minor: range.minor + 1, patch: 0 };
  return null;
}

/** 人读的"期望区间"文案，用于报告与 dry-run 输出 */
export function describeRange(range) {
  if (!range) return '<非法区间>';
  if (range.op === '=') return `= ${range.major}.${range.minor}.${range.patch}`;
  const lower = `${range.major}.${range.minor}.${range.patch}`;
  if (range.op === '~') return `>= ${lower} 且 < ${range.major}.${range.minor + 1}.0`;
  if (range.major > 0) return `>= ${lower} 且 < ${range.major + 1}.0.0`;
  if (range.minor > 0) return `>= ${lower} 且 < 0.${range.minor + 1}.0`;
  return `>= ${lower} 且 < 0.0.${range.patch + 1}`;
}

/**
 * 三态判定。
 * @returns {'yes'|'no'|'unknown'}
 */
export function satisfies(rangeInput, versionInput) {
  const range = typeof rangeInput === 'string' ? parseRange(rangeInput) : rangeInput;
  const version = typeof versionInput === 'string' ? parseVersion(versionInput) : versionInput;
  if (!range || !version) return 'unknown';
  // 带预发布后缀的实体版本：不同的解析器给出的边界各不相同，本工具一律不猜。
  if (version.prerelease) return 'unknown';
  const lower = { major: range.major, minor: range.minor, patch: range.patch };
  if (compareVersions(version, lower) < 0) return 'no';
  const upper = rangeUpperBound(range);
  if (!upper) return compareVersions(version, lower) === 0 ? 'yes' : 'no';
  return compareVersions(version, upper) < 0 ? 'yes' : 'no';
}
