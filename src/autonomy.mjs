// ops-core / src/autonomy.mjs —— 自主矩阵（"谁可以自己动手"的唯一数据源）
//
// 为什么默认全关：一个能自己写状态、自己清锁、自己发通知的循环，第一次跑错就会
// 污染整个 home。所以骨架的默认值必须"只观察、只记录"：
//   mode = observe  → 只读 + 写自己的产物（日报 / 审计 / 本地 outbox）
//   mode = act      → 才允许 self-heal 真正清理陈旧锁
//   auto.selfHeal   → 即使 mode=act，也要这一项显式为 true（双闸）
//
// fail-safe 铁律：文件缺失 / 解析失败 / 字段不是 true ⇒ 一律按"关"处理。
// 宁可少做一次自动动作，不可在未放行时自动执行。
//
// 开关写盘必须带 by / why，并落一行审计（谁在什么时候为什么放宽了闸门）。
import fs from 'node:fs';
import path from 'node:path';
import { appendAudit } from './audit.mjs';
import { alert } from './alert.mjs';
import { iso, opsPaths } from './paths.mjs';
import { readJson, writeJsonAtomic } from './store.mjs';

export const AUTONOMY_SCHEMA = 1;
export const MODES = ['observe', 'report', 'act'];

/** 登记在案的模块（job id 与模块 id 同名，避免两套命名漂移）。 */
export const MODULES = {
  tickd: { label: '常驻 tick 调度（全部 job 的总闸）', defaultEnabled: true, writes: false },
  'daily-report': { label: '日报 job（写 ops-reports/<日期>.md）', defaultEnabled: true, writes: true },
  'queue-notify': { label: '队列通知 job（读队列 → 写本地 outbox）', defaultEnabled: true, writes: true },
  'self-heal': { label: '自愈 job（初始化状态 / 清理过期锁）', defaultEnabled: true, writes: true },
};

/** 自动动作（不是 job；它们是 job 内部的"是否真动手"闸门）。 */
export const AUTO_ACTIONS = {
  selfHeal: { label: '自愈的实际修复动作（清过期锁 / 重建损坏状态）', defaultEnabled: false },
};

export function defaultAutonomy(now = Date.now()) {
  const modules = {};
  for (const [id, meta] of Object.entries(MODULES)) modules[id] = meta.defaultEnabled !== false;
  const auto = {};
  for (const [id, meta] of Object.entries(AUTO_ACTIONS)) auto[id] = meta.defaultEnabled === true;
  return {
    schemaVersion: AUTONOMY_SCHEMA,
    product: 'ops-core',
    mode: 'observe',
    modules,
    auto,
    jobs: {},
    updatedAt: iso(now),
    updatedBy: null,
  };
}

/** 读自主矩阵。文件缺失时按 opts.ensure 决定"写默认"还是"只返回默认"。 */
export function readAutonomy({ home, ensure = false, silent = false } = {}) {
  const file = opsPaths(home).autonomy;
  const dflt = defaultAutonomy();
  let created = false;
  let repaired = false;
  let state = readJson(file, {
    defaultValue: dflt,
    onCorrupt: ({ backup, error }) => {
      repaired = true;
      alert({ level: 'warn', source: 'ops-autonomy', message: `自主矩阵损坏，已按默认值重建（备份：${backup ?? '失败'}）`, detail: { file, error } }, { home, silent });
    },
  });
  if (!fs.existsSync(file)) {
    created = true;
    if (ensure) {
      writeJsonAtomic(file, dflt);
      appendAudit({ kind: 'autonomy.init', mode: dflt.mode, file }, { home, silent });
    }
  }
  // 结构兜底：老文件缺段时补默认，不覆盖用户已写的值
  state = normalize(state ?? dflt);
  return { state, file, created, repaired, exists: fs.existsSync(file) };
}

/** 补全缺失段（不写盘；是否落盘由调用方决定）。 */
export function normalize(raw) {
  const d = defaultAutonomy();
  const out = { ...d, ...(raw && typeof raw === 'object' ? raw : {}) };
  out.modules = { ...d.modules, ...(raw?.modules && typeof raw.modules === 'object' ? raw.modules : {}) };
  out.auto = { ...d.auto, ...(raw?.auto && typeof raw.auto === 'object' ? raw.auto : {}) };
  out.jobs = raw?.jobs && typeof raw.jobs === 'object' && !Array.isArray(raw.jobs) ? raw.jobs : {};
  if (!MODES.includes(out.mode)) out.mode = 'observe';
  out.schemaVersion = AUTONOMY_SCHEMA;
  return out;
}

/** 模块是否启用（fail-safe：未知模块 / 缺字段 ⇒ 关）。 */
export function isModuleEnabled(state, id) {
  if (!MODULES[id]) return false;
  return state?.modules?.[id] === true;
}

/**
 * 单个 job 是否允许跑。
 * 优先级：jobs[id].enabled（显式覆盖）> modules[id] > 模块默认值。
 * job 级覆盖项缺失时按 modules 判定 —— 这样 `job off` 与 `module off` 语义一致。
 */
export function isJobEnabled(state, id) {
  const override = state?.jobs?.[id];
  if (override && typeof override === 'object' && override.enabled === false) return { enabled: false, source: 'job', why: override.why ?? null };
  if (override && typeof override === 'object' && override.enabled === true) return { enabled: true, source: 'job', why: override.why ?? null };
  if (!MODULES[id]) return { enabled: false, source: 'registry', why: '未登记的模块' };
  const enabled = state?.modules?.[id] === true;
  return { enabled, source: 'module', why: null };
}

/** 自动动作是否放行（双闸：mode=act 且 auto[action]===true）。 */
export function isAutoAllowed(state, action) {
  if (!AUTO_ACTIONS[action]) return { allowed: false, reason: '未登记的自动动作' };
  if (state?.mode !== 'act') return { allowed: false, reason: `当前档位 ${state?.mode ?? 'observe'}（需 act）` };
  if (state?.auto?.[action] !== true) return { allowed: false, reason: `auto.${action} 未开启` };
  return { allowed: true, reason: null };
}

function persist(home, state, { by, why, kind, detail }, silent = false) {
  const file = opsPaths(home).autonomy;
  state.updatedAt = iso();
  state.updatedBy = by ?? null;
  writeJsonAtomic(file, state);
  const audit = appendAudit({ kind, by: by ?? null, why: why ?? null, detail: detail ?? null }, { home, silent });
  return { ok: true, file, auditOk: audit.ok, state };
}

/** 切换模块开关。 */
export function setModule(id, enabled, { home, by = 'cli', why = null, silent = false } = {}) {
  if (!MODULES[id]) return { ok: false, error: `模块 ${id} 未登记（拒绝写入）` };
  const { state } = readAutonomy({ home, ensure: true, silent });
  state.modules[id] = enabled === true;
  return persist(home, state, { by, why, kind: 'autonomy.module', detail: { module: id, enabled: enabled === true } }, silent);
}

/** 切换单个 job 的覆盖开关。 */
export function setJob(id, enabled, { home, by = 'cli', why = null, silent = false } = {}) {
  if (!MODULES[id]) return { ok: false, error: `job ${id} 未登记（拒绝写入）` };
  const { state } = readAutonomy({ home, ensure: true, silent });
  state.jobs[id] = { enabled: enabled === true, since: iso(), by, why: why ?? null };
  return persist(home, state, { by, why, kind: 'autonomy.job', detail: { job: id, enabled: enabled === true } }, silent);
}

/** 切换自动动作。 */
export function setAuto(id, enabled, { home, by = 'cli', why = null, silent = false } = {}) {
  if (!AUTO_ACTIONS[id]) return { ok: false, error: `自动动作 ${id} 未登记（拒绝写入）` };
  const { state } = readAutonomy({ home, ensure: true, silent });
  state.auto[id] = enabled === true;
  return persist(home, state, { by, why, kind: 'autonomy.auto', detail: { auto: id, enabled: enabled === true } }, silent);
}

/** 切换档位。 */
export function setMode(mode, { home, by = 'cli', why = null, silent = false } = {}) {
  if (!MODES.includes(mode)) return { ok: false, error: `档位必须是 ${MODES.join(' / ')}` };
  const { state } = readAutonomy({ home, ensure: true, silent });
  state.mode = mode;
  return persist(home, state, { by, why, kind: 'autonomy.mode', detail: { mode } }, silent);
}

/** 给 CLI / 日报用的可读摘要。 */
export function describe(state) {
  const modeNote = {
    observe: '只观察：写日报/审计/本地 outbox，不做修复',
    report: '只观察（同 observe，保留给"只发报告"的部署）',
    act: '可动手：仍需 auto.* 逐项放行',
  }[state.mode] ?? '未知档位';
  return {
    mode: state.mode,
    modeNote,
    modules: Object.entries(MODULES).map(([id, meta]) => ({
      id, label: meta.label, enabled: state.modules?.[id] === true,
    })),
    auto: Object.entries(AUTO_ACTIONS).map(([id, meta]) => ({
      id, label: meta.label, enabled: isAutoAllowed(state, id).allowed,
      raw: state.auto?.[id] === true,
    })),
    jobs: Object.keys(state.jobs ?? {}),
    updatedAt: state.updatedAt ?? null,
    updatedBy: state.updatedBy ?? null,
  };
}

/** 状态文件路径（给测试注入 home 用）。 */
export function autonomyPath(home) {
  return path.join(opsPaths(home).home, 'ops-autonomy.json');
}
