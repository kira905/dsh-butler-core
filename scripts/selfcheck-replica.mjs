#!/usr/bin/env node
// scripts/selfcheck-replica.mjs —— 「装完之后」自检（复刻③）
//
// 与 scripts/verify-source.mjs 的分工（两条完全不同的判据，别混）：
//   verify-source     = 发布前自检：这份源码本身能不能发（语法 / 绝对路径 / 私有依赖 / 清单）
//   selfcheck-replica = 装完之后自检：这套环境装成了没有（Node / home / 主包 / 端口 / 插件 /
//                       记忆 / 会话工具 / 状态文件 / tickd / 隔离）
//
// 三条纪律：
//   1. 默认只读。唯一的写 = home 内一个临时探测文件（写完立刻删）；`--fix` 才初始化状态文件，
//      且**只在 home 内**。生产 home 默认连临时文件都不写（改用 W_OK 只读探测）。
//   2. 找不到某件 = SKIP + 原因，绝不崩；但**显式指定**（`--dsh-root` / `--plugin-dir` /
//      `--memory-cmd` / `--session-tool`）却不可用 = FAIL —— 显式即断言，静默降级会骗人。
//   3. 退出码：0 = 无 FAIL（SKIP 不阻断）· 3 = 有 FAIL · 2 = 用法错 / 安全拒跑。
//
// 隔离自守（**发布件不能 import 任何私有件**）：
//   在夹具里运行时，执行器会注入 `REPLICA_GUARD=1` + `REPLICA_FIXTURE_ROOT=<夹具树>`；
//   本脚本据此断言 home 落在夹具树内，否则 rc=2 拒跑（零写入）。
//   直接裸跑（普通安装场景）时这两个变量不存在，按普通安装处理。
//
// 用法：
//   node scripts/selfcheck-replica.mjs [--home <dir>] [--json] [--fix] [--allow-production]
//   node scripts/selfcheck-replica.mjs --manifest <file> --profile web
//   node scripts/selfcheck-replica.mjs --help
//
// 13 项 = 旧 10 项 + 第 11/12/13 项（包在不在 / 挂载生效没 / 关键能力能不能跑）。
// 后三项是**清单驱动**的：清单来自 --manifest，或自动发现安装器随包发布的 suite-manifest.json，
// 都没有就用内置 3 项兜底（见 scripts/lib/default-manifest.mjs）。旧 10 项不读清单。
//
// 第 12 项的两条诚实边界（必须和结论一起读）：
//   ① 它判的是**组合**，不是运行时 —— dump 只证明"组合树里有这一行"，不证明"运行时没崩"；
//      真要验后者，得人工起一次 `dsh web --no-open` 看日志。
//   ② dump 抓不到"撞 id"以外的运行时冲突 —— 两个不同 id 抢同一位置时 dump 两行、宿主不报错，
//      本项只覆盖"同 id / 同 name"这一种，别当万能判据。
//
// 选项：
//   --home <dir>            状态根（默认 OPS_CORE_HOME > DSH_HOME > <用户主目录>/.dsh）
//   --json                  stdout 只输出 JSON（人读表走 stderr 不输出；诊断走 stderr）
//   --fix                   初始化缺失的状态文件（只在 home 内；生产 home 需 --allow-production）
//   --allow-production      允许对真实 home（<用户主目录>/.dsh）做写入型动作
//   --dsh-root <dir>        显式指定 DSH 主包安装根（不指定则自动探测）
//   --api-base <url>        显式指定 DSH 服务地址（默认 http://127.0.0.1:3080）
//   --plugin-dir <dir>      显式指定看板插件目录（默认在 home 下按已知形态探测）
//   --memory-cmd <file>     显式指定记忆召回探针（契约：`--probe` 退出码 0 即通过）
//   --session-tool <file>   显式指定 session-mark 脚本（默认探测 PATH）
//   --tickd <file>          显式指定 ops-tickd（默认本仓 bin/ops-tickd.mjs）
//   --expect-jobs a,b,c     期望 tickd 跑出的 job（默认 queue-notify,self-heal,daily-report）
//   --manifest <file>       装机清单（默认自动发现安装器那份，再退内置 3 项兜底）
//   --profile <name>        判挂载用哪个 profile（默认自动：profiles 下唯一一个，多个优先 web）
//   --dump-config-file <f>  用离线 dump 文本代替跑 `dsh --dump-config`（零执行，夹具/离线核对用）
//   --no-dump               不跑 --dump-config（第 12 项的组合树维度降级 SKIP）
//   --probe-batch <ms>      第 13 项整批墙钟上限（默认 30000）
//   --min-node <n>          覆盖 Node 最低版本（默认读 package.json engines；自测用）
//   --timeout <ms>          外部命令/网络超时（默认 8000）
//   --no-net                不探测网络（跳过端口/插件 API 两段）
//   --no-npm                不调 npm（主包探测只试 `dsh --version`）
//   --verbose               打印探测细节
//   --help                  本帮助
//
// 注意：本脚本从不调用 process.exit()（house rule），只设 process.exitCode。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadManifest, loadManifestObject, formatManifestError, ManifestError } from './lib/manifest.mjs';
import { parseRange, describeRange, satisfies } from './lib/semver.mjs';
import { findGlobalPackage, findPackageInRoot, resolveCommand, spawnPlan, pathDirs } from './lib/global-paths.mjs';
import { summarizeDump, parseSkipLines, findCollisions, judgeMount, SKIP_ATTRIBUTION } from './lib/dump-parse.mjs';
import { planProbe, shouldDegradeBatch } from './lib/probe-plan.mjs';
import { DEFAULT_MANIFEST, DEFAULT_MANIFEST_SOURCE_NOTE } from './lib/default-manifest.mjs';

const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
const ROOT = path.resolve(path.dirname(SELF), '..');   // 仓根（含 bin/ src/ docs/）
const SELF_REL = 'scripts/selfcheck-replica.mjs';

// ---------------------------------------------------------------- 参数
const KNOWN_VALUES = new Set([
  'home', 'dsh-root', 'api-base', 'plugin-dir', 'memory-cmd', 'session-tool', 'tickd',
  'expect-jobs', 'min-node', 'timeout', 'manifest', 'profile', 'dump-config-file', 'probe-batch',
]);
const KNOWN_FLAGS = new Set([
  'json', 'fix', 'allow-production', 'no-net', 'no-npm', 'verbose', 'help', 'no-dump',
]);

function parseArgv(argv) {
  const values = {};
  const flags = {};
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { unknown.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) {
      const k = a.slice(2, eq);
      if (!KNOWN_VALUES.has(k)) unknown.push('--' + k);
      else values[k] = a.slice(eq + 1);
      continue;
    }
    const k = a.slice(2);
    if (KNOWN_FLAGS.has(k)) { flags[k] = true; continue; }
    if (KNOWN_VALUES.has(k)) {
      const nx = argv[i + 1];
      if (nx === undefined || nx.startsWith('--')) { unknown.push('--' + k + '（缺值）'); continue; }
      values[k] = nx;
      i += 1;
      continue;
    }
    unknown.push('--' + k);
  }
  return { values, flags, unknown };
}

function usage() {
  const text = `用法：
  node scripts/selfcheck-replica.mjs [选项]

选项：
  --home <dir>            状态根（默认 OPS_CORE_HOME > DSH_HOME > <用户主目录>/.dsh）
  --json                  stdout 只输出 JSON
  --fix                   初始化缺失的状态文件（只在 home 内；生产 home 需 --allow-production）
  --allow-production      允许对真实 home 做写入型动作
  --dsh-root <dir>        显式指定 DSH 主包安装根
  --api-base <url>        显式指定 DSH 服务地址（默认 http://127.0.0.1:3080）
  --plugin-dir <dir>      显式指定看板插件目录
  --memory-cmd <file>     显式指定记忆召回探针（--probe 退出码 0 即通过）
  --session-tool <file>   显式指定 session-mark 脚本
  --tickd <file>          显式指定 ops-tickd（默认本仓 bin/ops-tickd.mjs）
  --expect-jobs a,b,c     期望的 job 名单（默认 queue-notify,self-heal,daily-report）
  --manifest <file>       装机清单（默认自动发现安装器那份，再退内置 3 项兜底）
  --profile <name>        判挂载用哪个 profile（默认自动：唯一一个，多个优先 web）
  --dump-config-file <f>  用离线 dump 文本代替跑 --dump-config（零执行）
  --no-dump               不跑 --dump-config（第 12 项组合树维度降级 SKIP）
  --probe-batch <ms>      第 13 项整批墙钟上限（默认 30000；超了剩余探针整体降级 SKIP）
  --min-node <n>          覆盖 Node 最低版本（自测用）
  --timeout <ms>          外部命令/网络超时（默认 8000）
  --no-net                不探测网络
  --no-npm                不调 npm
  --verbose               打印探测细节
  --help                  本帮助

第 11/12/13 项（包在不在 / 挂载生效没 / 关键能力能不能跑）由清单驱动：
每项写 包名 / 类型 / 期望版本区间 / 探针。清单优先取 --manifest 指的那份，
其次自动发现全局装着的 @kira905/dsh-butler-install/suite-manifest.json，
都没有才用内置 3 项兜底（输出里会写明用的是哪一份）。
旧 10 项不读清单，行为与改造前一致（第 3 项是 W1 修好的自动探测）。

两条诚实边界（第 12 项）：
  · 它判的是**组合**，不是运行时 —— dump 只证明"组合树里有这一行"，
    "运行时没崩"只能人工起一次服务看日志。
  · dump 抓不到"撞 id"以外的运行时冲突（不同 id 抢同一位置 ⇒ dump 两行、宿主不报错），
    本项只覆盖"同 id / 同 name"这一种。

退出码：0 = 无 FAIL（SKIP 不阻断）· 3 = 有 FAIL · 2 = 用法错 / 安全拒跑`;
  return text;
}

// ---------------------------------------------------------------- 小工具
function width(s) {
  let n = 0;
  for (const ch of String(s ?? '')) n += ch.codePointAt(0) > 0x2e80 ? 2 : 1;
  return n;
}
function pad(s, w) {
  const t = String(s ?? '');
  return t + ' '.repeat(Math.max(0, w - width(t)));
}
function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const line = (cells) => cells.map((c, i) => pad(c, widths[i])).join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map((r) => line(r))].join('\n');
}
function realOrResolve(p) {
  try { return fs.realpathSync.native(p); } catch { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
}
function norm(p) {
  return realOrResolve(p).toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
}
function isInside(child, parent) {
  const a = norm(child);
  const b = norm(parent);
  return !!a && !!b && (a === b || a.startsWith(b + '\\'));
}
function isDriveRoot(p) {
  const n = norm(p);
  return /^[a-z]:$/.test(n) || n === '';
}
function tail(s, n = 200) {
  const t = String(s ?? '').trim().replace(/\s+/g, ' ');
  return t.length > n ? '…' + t.slice(-n) : t;
}

const ARGV = parseArgv(process.argv.slice(2));
const V = ARGV.values;
const F = ARGV.flags;
const VERBOSE = F.verbose === true;
const TIMEOUT = Number.isFinite(Number(V.timeout)) && Number(V.timeout) > 0 ? Number(V.timeout) : 8000;
const PROD_HOME = path.join(os.homedir(), '.dsh');
const HOME = path.resolve(String(V.home ?? process.env.OPS_CORE_HOME ?? process.env.DSH_HOME ?? PROD_HOME));
const FIXTURE_ROOT = String(process.env.REPLICA_FIXTURE_ROOT ?? '').trim();
const GUARD_ON = process.env.REPLICA_GUARD === '1';

const WRITES = [];
const CHECKS = [];

function say(line) { process.stdout.write(line + '\n'); }
function diag(line) { process.stderr.write(line + '\n'); }

/** 目标类型：production / fixture / user-home / other。 */
function classify(home) {
  if (isInside(home, PROD_HOME)) return 'production';
  if (FIXTURE_ROOT && isInside(home, FIXTURE_ROOT)) return 'fixture';
  if (isInside(home, os.homedir())) return 'user-home';
  return 'other';
}

/**
 * 写闸：只有下列之一才允许在 home 内写。
 *   · 夹具内（REPLICA_GUARD=1 且 home 在 REPLICA_FIXTURE_ROOT 内）
 *   · --allow-production（显式承认在动真实 home）
 *   · 既不是生产 home、也不是用户主目录、也不是盘符根（例如系统临时目录下的沙箱位置）
 */
function verdict(home, allowProduction) {
  const kind = classify(home);
  const codes = [];
  if (!String(home ?? '').trim()) codes.push('HOME_EMPTY');
  if (isDriveRoot(home)) codes.push('HOME_IS_DRIVE_ROOT');
  if (kind === 'production' && !allowProduction) codes.push('HOME_IS_PRODUCTION_WITHOUT_ALLOW');
  if (kind === 'user-home' && !allowProduction) codes.push('HOME_IS_USER_HOME');
  const writable = codes.length === 0;
  return { kind, writable, codes };
}

/** 夹具自守：REPLICA_GUARD=1 时 home 必须在夹具树内（零写入出口）。 */
function selfGuard() {
  if (!GUARD_ON) return null;
  if (!FIXTURE_ROOT) return { ok: false, msg: 'REPLICA_GUARD=1 但缺少 REPLICA_FIXTURE_ROOT —— 拒绝在无法判定的环境里写入' };
  if (!fs.existsSync(FIXTURE_ROOT) || !fs.statSync(FIXTURE_ROOT).isDirectory()) {
    return { ok: false, msg: `REPLICA_FIXTURE_ROOT 不是目录：${FIXTURE_ROOT}` };
  }
  if (!isInside(HOME, FIXTURE_ROOT)) {
    return { ok: false, msg: `home 不在夹具树内：${HOME}（夹具树 = ${FIXTURE_ROOT}）` };
  }
  return null;
}

// ---------------------------------------------------------------- 外部命令
function runNodeScript(file, args, { timeout = TIMEOUT, label = '' } = {}) {
  const r = spawnSync(process.execPath, [file, ...args], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false,
    env: { ...process.env },
  });
  if (VERBOSE) diag(`[probe] ${label || file} → rc=${r.status}${r.error ? ' err=' + (r.error.code ?? r.error.message) : ''}`);
  return { rc: typeof r.status === 'number' ? r.status : null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}

function runCmd(cmd, args, { timeout = TIMEOUT, label = '' } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, shell: false, env: { ...process.env } });
  if (VERBOSE) diag(`[probe] ${label || cmd} → rc=${r.status}${r.error ? ' err=' + (r.error.code ?? r.error.message) : ''}`);
  return { rc: typeof r.status === 'number' ? r.status : null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}

/**
 * 跑一份"执行计划"（由 global-paths 的 spawnPlan 产出）。
 * 与 runCmd 的区别：它已经知道这条命令该用 node 直跑还是该经壳，所以能跨平台跑通
 * `.cmd` / `.ps1` 这类 Windows 壳命令 —— 直接 spawn 它们会 EINVAL。
 */
function runPlan(plan, { timeout = TIMEOUT, label = '', extraEnv = null } = {}) {
  if (!plan) return { rc: null, stdout: '', stderr: '', error: { code: 'NO_PLAN' } };
  const r = spawnSync(plan.cmd, plan.args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false,
    env: extraEnv ? { ...process.env, ...extraEnv } : { ...process.env },
  });
  if (VERBOSE) diag(`[probe] ${label || plan.cmd} → rc=${r.status}${r.error ? ' err=' + (r.error.code ?? r.error.message) : ''}`);
  return { rc: typeof r.status === 'number' ? r.status : null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
}

/** 从任意文本里抠第一个 semver（`0.2.0-rc.2` 这种带预发布后缀的也算） */
function firstVersion(text) {
  const m = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

async function httpProbe(url, timeoutMs = TIMEOUT) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        // 宿主 API 有同源栅栏：裸 GET 会 403，带上这个头才 200
        'sec-fetch-site': 'same-origin',
        'accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
      },
      signal: ac.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, headers: res.headers };
  } catch (e) {
    const code = e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.code
      || (e?.cause?.message ? String(e.cause.message) : '')
      || String(e?.message ?? e);
    return { ok: false, status: 0, text: '', error: tail(code, 60) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 检查项登记
function add(id, name, status, detail, hint = '') {
  CHECKS.push({ id, name, status, detail, hint });
}

// 1 ---------------------------------------------------------------- Node 版本
function checkNode() {
  const pkgFile = path.join(ROOT, 'package.json');
  let want = 20;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    const m = /(\d+)/.exec(String(pkg?.engines?.node ?? ''));
    if (m) want = Number(m[1]);
  } catch { /* 没有 package.json 就用 20 */ }
  if (V['min-node'] !== undefined) {
    const n = Number(V['min-node']);
    if (Number.isFinite(n) && n > 0) want = n;
  }
  const cur = process.versions.node;
  const major = Number(String(cur).split('.')[0]);
  if (major >= want) add(1, 'Node 版本', 'PASS', `${cur}（要求 ≥ ${want}）`);
  else add(1, 'Node 版本', 'FAIL', `${cur}（要求 ≥ ${want}）`, `升级 Node 到 ${want} 或更高：https://nodejs.org/`);
}

// 2 ---------------------------------------------------------------- home 可写
function checkHome() {
  if (!fs.existsSync(HOME)) {
    add(2, '状态根可写（home）', 'FAIL', `home 不存在：${HOME}`, '先建目录，或跑 `--fix` 让它初始化（只在 home 内写）');
    return;
  }
  let st;
  try { st = fs.statSync(HOME); } catch (e) {
    add(2, '状态根可写（home）', 'FAIL', `stat 失败：${e?.code ?? e?.message}`, '检查路径权限');
    return;
  }
  if (!st.isDirectory()) {
    add(2, '状态根可写（home）', 'FAIL', `home 不是目录：${HOME}`, '把 --home 指向目录（或删掉这个同名文件）');
    return;
  }
  if (classify(HOME) === 'production' && !F['allow-production']) {
    try {
      fs.accessSync(HOME, fs.constants.W_OK);
      add(2, '状态根可写（home）', 'PASS', '只读探测通过（生产 home 未写入）');
    } catch (e) {
      add(2, '状态根可写（home）', 'FAIL', `生产 home 不可写：${e?.code ?? e?.message}`, '修权限，或把 --home 指到别处');
    }
    return;
  }
  const tmp = path.join(HOME, `.selfcheck-replica-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, 'selfcheck\n', 'utf8');
    WRITES.push({ what: '临时探测文件', file: tmp });
    fs.rmSync(tmp, { force: true });
    add(2, '状态根可写（home）', 'PASS', `已建并删除临时文件（${path.basename(tmp)}）`);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    add(2, '状态根可写（home）', 'FAIL', `建临时文件失败：${e?.code ?? e?.message}`, '换目录，或修该目录权限');
  }
}

// 3 ---------------------------------------------------------------- DSH 主包
function checkDshPackage() {
  const explicit = V['dsh-root'];
  const probeDshRoot = (dir) => {
    const cands = [
      path.join(dir, 'package.json'),
      path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ];
    for (const f of cands) {
      try {
        const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (pkg?.name === '@deepseek-ai/dsh') return { ok: true, file: f, version: String(pkg.version ?? '?') };
      } catch { /* 下一个 */ }
    }
    return { ok: false };
  };

  if (explicit) {
    const dir = path.resolve(explicit);
    if (!fs.existsSync(dir)) {
      add(3, 'DSH 主包在', 'FAIL', `--dsh-root 指向的目录不存在：${dir}`, '指到装了 @deepseek-ai/dsh 的目录，或去掉 --dsh-root 让脚本自动探测');
      return;
    }
    const r = probeDshRoot(dir);
    if (r.ok) add(3, 'DSH 主包在', 'PASS', `找到 @deepseek-ai/dsh@${r.version}（${path.relative(dir, r.file) || 'package.json'}）`);
    else add(3, 'DSH 主包在', 'FAIL', `--dsh-root 下没有 @deepseek-ai/dsh：${dir}`, '显式指定即断言；指到正确目录，或去掉 --dsh-root');
    return;
  }

  // ★ W1 修点：自动探测**先读盘**，不再靠 spawn —— Windows 上 `dsh` / `npm` 是
  //   `.cmd` / `.ps1` 壳，`shell: false` 时 spawn 必 ENOENT（点 `.cmd` 还会 EINVAL），
  //   于是旧版这条分支在 Windows 上永远 SKIP，而主包其实装着。
  const disk = findGlobalPackage('@deepseek-ai/dsh');
  if (disk) {
    add(
      3,
      'DSH 主包在',
      'PASS',
      `找到 @deepseek-ai/dsh@${String(disk.pkg.version ?? '?')}（读全局 node_modules：${disk.root}；读盘探测，未起外部进程）`,
    );
    return;
  }

  // ② 兜底：把 `dsh` 命令解析成执行计划（还是只读盘）。解析到包内 JS 入口才真跑一次，
  //    这样跨平台一致，也不用碰 Windows 的壳。
  const resolved = resolveCommand('dsh');
  if (resolved && resolved.kind === 'node') {
    const r = runPlan(spawnPlan(resolved, ['--version']), { timeout: Math.min(TIMEOUT, 5000), label: 'dsh --version' });
    const ver = firstVersion(r.stdout) || firstVersion(r.stderr) || resolved.version;
    if (r.rc === 0 && ver) {
      add(3, 'DSH 主包在', 'PASS', `dsh --version → ${ver}（${resolved.packageName}；入口 ${path.relative(resolved.packageDir, resolved.file) || resolved.file}）`);
      return;
    }
    if (ver) {
      add(3, 'DSH 主包在', 'PASS', `找到 ${resolved.packageName}@${ver}（--version 退出码 ${r.rc ?? 'null'}，但包在）`);
      return;
    }
  }

  // ③ 老路径兜底：npm ls -g（Linux/macOS 上 npm 是 shim，这条仍然有效）
  if (!F['no-npm']) {
    const npm = runCmd('npm', ['ls', '-g', '@deepseek-ai/dsh', '--depth=0'], { timeout: Math.min(TIMEOUT, 8000), label: 'npm ls -g' });
    if (npm.rc === 0 && /@deepseek-ai\/dsh@/.test(npm.stdout)) {
      add(3, 'DSH 主包在', 'PASS', `npm ls -g → ${tail(npm.stdout.split('\n').filter((l) => l.includes('dsh@')).join(' '), 90)}`);
      return;
    }
  }
  add(
    3,
    'DSH 主包在',
    'SKIP',
    '未发现 DSH 主包（全局 node_modules 里没有 @deepseek-ai/dsh，PATH 里也没有能跑的 dsh）—— 只装骨架时可以忽略',
    '装主包：npm i -g @deepseek-ai/dsh；装了但不在 PATH / 不在全局目录时用 --dsh-root 指过去',
  );
}

// 4 ---------------------------------------------------------------- DSH 端口
async function checkPort() {
  if (F['no-net']) { add(4, 'DSH 端口活着', 'SKIP', '--no-net：跳过网络探测'); return; }
  const base = String(V['api-base'] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const explicit = V['api-base'] !== undefined;
  let r = await httpProbe(base + '/');
  if (!(r.status > 0)) {
    const r2 = await httpProbe(base + '/api/task-board/tasks');
    if (r2.status > 0) r = r2;
  }
  if (r.status > 0) {
    const note = (r.status === 401 || r.status === 403) ? '（服务在，但需要登录凭据）' : '';
    add(4, 'DSH 端口活着', 'PASS', `GET ${base}/ → HTTP ${r.status}${note}`);
    return;
  }
  const why = r.error ? `连接失败（${r.error}）` : `HTTP ${r.status}`;
  if (explicit) add(4, 'DSH 端口活着', 'FAIL', `${base}：${why}`, '起服务：dsh web（或在设置里确认端口），或改用正确的 --api-base');
  else add(4, 'DSH 端口活着', 'SKIP', `${base}：${why} —— 未发现运行中的 DSH`, '装完还没起服务时属正常；起服务后重跑本项即 PASS');
}

// 5 ---------------------------------------------------------------- 看板插件
function pluginEntry(dir) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* 无 package.json */ }
  const candidates = [];
  const pushTarget = (t) => {
    if (typeof t === 'string') candidates.push(t);
    else if (t && typeof t === 'object') for (const v of Object.values(t)) pushTarget(v);
  };
  if (pkg) {
    if (pkg.main) pushTarget(pkg.main);
    if (pkg.exports) pushTarget(pkg.exports);
  }
  candidates.push('lib/index.js', 'lib/index.mjs', 'dist/index.js', 'index.js', 'lib/client.js');
  for (const rel of candidates) {
    if (typeof rel !== 'string' || rel.includes('*')) continue;
    const f = path.resolve(dir, rel);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return { ok: true, file: f, name: pkg?.name ?? path.basename(dir), version: pkg?.version ?? '?' };
  }
  return { ok: false, name: pkg?.name ?? path.basename(dir) };
}

async function checkPlugin() {
  const explicit = V['plugin-dir'];
  const candidates = [];
  if (explicit) candidates.push(path.resolve(explicit));
  else {
    // 形态①：<home>/profiles/<profile>/node_modules/<插件>（当前宿主的实际布局）
    try {
      const profilesDir = path.join(HOME, 'profiles');
      for (const name of fs.readdirSync(profilesDir)) {
        const dir = path.join(profilesDir, name, 'node_modules', 'dsh-task-board-local');
        if (fs.existsSync(dir)) candidates.push(dir);
      }
    } catch { /* 没有 profiles 目录 */ }
    candidates.push(
      path.join(HOME, 'profiles', 'node_modules', 'dsh-task-board-local'),
      path.join(HOME, 'node_modules', 'dsh-task-board-local'),
      path.join(HOME, 'plugins', 'dsh-task-board-local'),
    );
  }
  const found = [];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    const e = pluginEntry(dir);
    if (e.ok) found.push({ dir, ...e });
  }
  if (!found.length) {
    if (explicit) add(5, '看板插件加载', 'FAIL', `--plugin-dir 下没有可加载的 entry：${candidates[0]}`, '确认插件目录里有 package.json（main/exports）或 lib/index.js；或去掉 --plugin-dir 让脚本自动探测');
    else add(5, '看板插件加载', 'SKIP', '未发现 dsh-task-board-local（只装骨架时可以忽略）', '装插件：见宿主侧插件安装说明；装了但不在已知位置时用 --plugin-dir 指过去');
    return;
  }
  const e = found[0];
  if (F['no-net']) {
    add(5, '看板插件加载', 'PASS', `${e.name}@${e.version} entry = ${path.relative(e.dir, e.file)}（--no-net：未验 API）`);
    return;
  }
  const base = String(V['api-base'] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const r = await httpProbe(base + '/api/task-board/tasks');
  let tasks = null;
  if (r.ok) {
    try {
      const j = JSON.parse(r.text);
      tasks = Array.isArray(j) ? j : (Array.isArray(j?.tasks) ? j.tasks : null);
    } catch { /* 非 JSON */ }
  }
  if (tasks) add(5, '看板插件加载', 'PASS', `${e.name}@${e.version} entry 在 · API 返回 ${tasks.length} 张卡`);
  else if (r.status === 401 || r.status === 403) add(5, '看板插件加载', 'PASS', `${e.name}@${e.version} entry 在；API HTTP ${r.status}（需要登录凭据，命令行不验 tasks）`);
  else add(5, '看板插件加载', 'FAIL', `${e.name}@${e.version} entry 在，但 API 没给出 tasks 数组（${r.error ? '连接失败 ' + r.error : 'HTTP ' + r.status}）`, '查插件是否真被宿主加载（契约 / cordis.patch.yml），以及 DSH 是否在跑');
}

// 6 ---------------------------------------------------------------- 记忆引擎
function checkMemory() {
  const cmd = V['memory-cmd'];
  if (cmd) {
    const file = path.resolve(cmd);
    if (!fs.existsSync(file)) {
      add(6, '记忆引擎可用', 'FAIL', `--memory-cmd 指向的文件不存在：${file}`, '指到你的召回探针脚本，或去掉 --memory-cmd');
      return;
    }
    const isJs = /\.(mjs|cjs|js)$/i.test(file);
    const r = isJs ? runNodeScript(file, ['--probe'], { label: 'memory probe' }) : runCmd(file, ['--probe'], { label: 'memory probe' });
    if (r.rc === 0) add(6, '记忆引擎可用', 'PASS', `召回探针 rc=0（${path.basename(file)}）`);
    else add(6, '记忆引擎可用', 'FAIL', `召回探针 rc=${r.rc ?? 'null'}：${tail(r.stderr || r.stdout || (r.error?.code ?? ''), 160)}`, '确认探针能跑（契约：`--probe` 退出码 0），以及底层库/模型可用');
    return;
  }
  const memDir = path.join(HOME, 'memory');
  if (fs.existsSync(memDir)) {
    add(6, '记忆引擎可用', 'SKIP', '检测到 memory/，但未提供召回命令（--memory-cmd）—— 本件零私有依赖，不猜你的后端', '用 --memory-cmd 指一个探针（契约：`--probe` 退出码 0）即可纳入自检');
  } else {
    add(6, '记忆引擎可用', 'SKIP', '该 home 下没有 memory/（未安装记忆引擎）', '装了记忆引擎后用 --memory-cmd 指一个召回探针');
  }
}

// 7 ---------------------------------------------------------------- 会话工具
function checkSessionTool() {
  const explicit = V['session-tool'];
  if (explicit) {
    const file = path.resolve(explicit);
    if (!fs.existsSync(file)) {
      add(7, '会话工具在', 'FAIL', `--session-tool 指向的文件不存在：${file}`, '指到 session-mark.mjs，或去掉 --session-tool');
      return;
    }
    const isJs = /\.(mjs|cjs|js)$/i.test(file);
    const r = isJs ? runNodeScript(file, ['--help'], { label: 'session-mark --help' }) : runCmd(file, ['--help'], { label: 'session-mark --help' });
    if (r.rc === 0) add(7, '会话工具在', 'PASS', `${path.basename(file)} --help rc=0`);
    else add(7, '会话工具在', 'FAIL', `${path.basename(file)} --help rc=${r.rc ?? 'null'}：${tail(r.stderr || r.stdout || (r.error?.code ?? ''), 160)}`, '确认 toolkit 已装且脚本可执行');
    return;
  }
  const r = runCmd('session-mark', ['--help'], { timeout: Math.min(TIMEOUT, 5000), label: 'session-mark --help' });
  if (r.rc === 0) add(7, '会话工具在', 'PASS', 'session-mark --help rc=0（PATH 里找到）');
  else if (r.error && r.error.code === 'ENOENT') add(7, '会话工具在', 'SKIP', 'PATH 里没有 session-mark（没装 toolkit 时可以忽略）', '装 toolkit，或用 --session-tool 指到脚本');
  else add(7, '会话工具在', 'FAIL', `session-mark --help rc=${r.rc ?? 'null'}：${tail(r.stderr || r.stdout, 160)}`, '确认 toolkit 安装完整');
}

// 8 ---------------------------------------------------------------- 状态文件
async function checkStateFiles() {
  let mod;
  try {
    mod = await import('../src/state-files.mjs');
  } catch (e) {
    add(8, '状态文件就位', 'SKIP', `本脚本不在骨架仓内（找不到 src/state-files.mjs）：${e?.code ?? e?.message}`, '从仓库里跑本脚本，或先 npm i @kira905/dsh-butler-core');
    return;
  }
  const rows = mod.inspectStateFiles(HOME);
  const missingRequired = rows.filter((r) => r.required && !r.exists).map((r) => r.name);
  const corrupt = rows.filter((r) => r.parse === false).map((r) => r.name);
  const optionalMissing = rows.filter((r) => !r.required && !r.exists).map((r) => r.name);
  if (missingRequired.length || corrupt.length) {
    const parts = [];
    if (missingRequired.length) parts.push(`必需件缺失 ${missingRequired.length} 个（${missingRequired.join('、')}）`);
    if (corrupt.length) parts.push(`坏 JSON ${corrupt.length} 个（${corrupt.join('、')}）`);
    add(8, '状态文件就位', 'FAIL', parts.join('；'), `初始化：node bin/ops-tickd.mjs --once --only self-heal --home <home>（或本脚本 --fix）`);
    return;
  }
  const note = optionalMissing.length ? `；可选件缺 ${optionalMissing.length} 个（会自动建）` : '';
  add(8, '状态文件就位', 'PASS', `必需件齐（${rows.filter((r) => r.required).length} 个），坏 JSON 0 个${note}`);
}

// 9 ---------------------------------------------------------------- tickd 跑一轮
function checkTickd() {
  const tickd = path.resolve(String(V.tickd ?? path.join(ROOT, 'bin', 'ops-tickd.mjs')));
  if (!fs.existsSync(HOME)) {
    add(9, 'tickd 能跑一轮', 'SKIP', `home 不存在：${HOME}（先 \`--fix\` 初始化）`, `node bin/ops-tickd.mjs --once --only self-heal --home <home>`);
    return;
  }
  if (!fs.existsSync(tickd)) {
    add(9, 'tickd 能跑一轮', 'FAIL', `找不到 ops-tickd：${tickd}`, '用 --tickd 指到 bin/ops-tickd.mjs，或先装包');
    return;
  }
  const v = verdict(HOME, F['allow-production'] === true);
  if (!v.writable) {
    add(9, 'tickd 能跑一轮', 'SKIP', 'home 是真实 home：写一轮需要 --allow-production（本项跳过，避免动生产）', '确认要在真实 home 上跑后加 --allow-production；或在夹具 home 上验证');
    return;
  }
  const r = runNodeScript(tickd, ['--once', '--json', '--home', HOME], { timeout: Math.max(TIMEOUT, 60000), label: 'ops-tickd --once' });
  if (r.rc !== 0) {
    add(9, 'tickd 能跑一轮', 'FAIL', `--once rc=${r.rc ?? 'null'}：${tail(r.stderr || r.stdout || (r.error?.code ?? ''), 200)}`, '看上面的 stderr；常见原因：job 抛错、home 不可写、Node 版本太低');
    return;
  }
  let run = null;
  try { run = JSON.parse(r.stdout.trim()); } catch { /* 非 JSON */ }
  if (!run || !Array.isArray(run.results)) {
    add(9, 'tickd 能跑一轮', 'FAIL', `--once 输出不是预期 JSON：${tail(r.stdout, 160)}`, '确认 --tickd 指的真是不带私有改动的 ops-tickd');
    return;
  }
  const expect = String(V['expect-jobs'] ?? 'queue-notify,self-heal,daily-report').split(',').map((s) => s.trim()).filter(Boolean);
  const got = run.results.map((x) => x.id);
  const missing = expect.filter((id) => !got.includes(id));
  if (missing.length) {
    add(9, 'tickd 能跑一轮', 'FAIL', `跑通了，但缺 job：${missing.join('、')}（实际 ${got.join('、') || '空'}）`, '查 src/registry.mjs 的 JOB_ORDER 与 JOB_DEFS：注册表里少了 job 就不会跑');
    return;
  }
  if (Number(run.failed) > 0) {
    const bad = run.results.filter((x) => x.status !== 'ok').map((x) => `${x.id}:${x.status}${x.error ? '(' + tail(x.error, 60) + ')' : ''}`);
    add(9, 'tickd 能跑一轮', 'FAIL', `有 job 失败：${bad.join('、')}`, '按失败的 job 名去查（日报/队列/自愈各自的日志在 home 内）');
    return;
  }
  const day = new Date();
  const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const report = path.join(HOME, 'ops-reports', `${dayKey}.md`);
  if (!fs.existsSync(report)) {
    add(9, 'tickd 能跑一轮', 'FAIL', `跑通了但没有日报产物：${path.join('ops-reports', `${dayKey}.md`)}`, '查 daily-report job 是否被模块开关关掉（ops-autonomy module off daily-report）');
    return;
  }
  add(9, 'tickd 能跑一轮', 'PASS', `${run.results.length} 个 job 跑完 · 日报 ${path.basename(report)} 已产出（failed=0；本轮写入全在 home 内，属骨架正常行为）`);
}

// 10 --------------------------------------------------------------- 生产/夹具隔离
function checkIsolation() {
  const root = path.parse(HOME).root; // 盘符根（或 /）
  const a = verdict(PROD_HOME, false);
  const b = verdict(PROD_HOME, true);
  const c = verdict(root, false);
  const cases = [
    { id: 'A', ok: a.writable === false, what: '真实 home + 未显式许可 ⇒ 必须拒写' },
    { id: 'B', ok: b.writable === true, what: '真实 home + --allow-production ⇒ 允许（开关真的有效，不是永远拒）' },
    { id: 'C', ok: c.writable === false, what: '盘符根 ⇒ 必须拒写' },
  ];
  const bad = cases.filter((x) => !x.ok);
  const kind = classify(HOME);
  const v = verdict(HOME, F['allow-production'] === true);
  const wrote = WRITES.length;
  const outside = WRITES.filter((w) => !isInside(w.file, HOME));
  if (bad.length) {
    add(10, '生产/夹具隔离', 'FAIL', `写闸自测不过：${bad.map((x) => x.id + ' ' + x.what).join('；')}`, '写闸逻辑坏了 —— 先修 verdict()，别在任何 home 上跑 --fix');
    return;
  }
  if (WRITES.length && outside.length) {
    add(10, '生产/夹具隔离', 'FAIL', `有 ${outside.length} 次写入落在 home 之外（${outside.map((w) => w.file).join('、')}）`, '只允许在 home 内写');
    return;
  }
  if (FIXTURE_ROOT && GUARD_ON && !isInside(HOME, FIXTURE_ROOT)) {
    add(10, '生产/夹具隔离', 'FAIL', `夹具守卫放过了树外的 home：${HOME}`, '修 selfGuard()');
    return;
  }
  add(10, '生产/夹具隔离', 'PASS',
    `写闸 3/3 通过 · 本次目标 = ${kind}${v.writable ? '（可写）' : '（只读）'} · 写入 ${wrote} 次全在 home 内`);
}

// ---------------------------------------------------------------- 清单 / profile / dump（第 11–13 项共用）
/**
 * 一次运行里这些只该算一次，所以放上下文里：
 *   manifest —— 清单（显式 / 自动发现 / 内置兜底，三选一）
 *   profile  —— 判挂载用哪个 profile 目录
 *   dump     —— `--dump-config` 的文本（真跑、读离线文件、或明确跳过）
 */
const CTX = {
  manifest: null,
  manifestLabel: '',
  manifestSource: '',
  profile: null,
  profilePkg: null,
  profilePkgPath: null,
  dump: null,
  dumpSummary: null,
  skips: [],
};

/**
 * 清单三路加载：显式 `--manifest` > 自动发现安装器那份 > 内置兜底。
 * 自动发现**不是猜**：它读的是全局装着的 `@kira905/dsh-butler-install/suite-manifest.json`
 * （这个包随 npm tarball 发布时就带着清单）。
 */
function loadManifestForRun() {
  if (V.manifest !== undefined) {
    try {
      const m = loadManifest(V.manifest);
      return { ok: true, manifest: m, label: `--manifest ${m.path}`, source: 'explicit' };
    } catch (e) {
      if (e instanceof ManifestError) return { ok: false, message: formatManifestError(e, String(V.manifest)) };
      return { ok: false, message: `读清单失败：${e?.message ?? e}` };
    }
  }
  const installer = findGlobalPackage('@kira905/dsh-butler-install');
  if (installer) {
    const file = path.join(installer.dir, 'suite-manifest.json');
    if (fs.existsSync(file)) {
      try {
        const m = loadManifest(file);
        return { ok: true, manifest: m, label: `自动发现 ${path.basename(file)}`, source: 'auto', path: file };
      } catch (e) {
        // 自动发现的那份坏了：不当成致命错误，退回内置兜底，但把原因记下来
        const inner = loadManifestObject(DEFAULT_MANIFEST, '<内置兜底清单>');
        return {
          ok: true,
          manifest: inner,
          source: 'builtin',
          label: `内置兜底（自动发现的那份读不了：${e instanceof ManifestError ? formatManifestError(e, file) : e?.message ?? e}）`,
        };
      }
    }
  }
  const m = loadManifestObject(DEFAULT_MANIFEST, '<内置兜底清单>');
  return { ok: true, manifest: m, label: `内置兜底 ${m.items.length} 项`, source: 'builtin' };
}

/** 定 profile：显式 --profile > profiles 下唯一一个 > 优先 web > 第一个 */
function resolveProfile() {
  const profilesDir = path.join(HOME, 'profiles');
  if (V.profile !== undefined) {
    const name = String(V.profile);
    return { name, dir: path.join(profilesDir, name), explicit: true, available: readProfileNames(profilesDir) };
  }
  const names = readProfileNames(profilesDir);
  if (!names.length) return null;
  if (names.length === 1) return { name: names[0], dir: path.join(profilesDir, names[0]), explicit: false, available: names };
  if (names.includes('web')) return { name: 'web', dir: path.join(profilesDir, 'web'), explicit: false, available: names };
  return { name: names[0], dir: path.join(profilesDir, names[0]), explicit: false, available: names };
}

function readProfileNames(profilesDir) {
  try {
    return fs
      .readdirSync(profilesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules')
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 读 profile 的 package.json（读不到就 null，不抛） */
function readProfilePkg(dir) {
  return readJsonSafe(path.join(dir, 'package.json'));
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 取 dump 文本。三种来源，优先级：离线文件 > 真跑 > 明确跳过。
 * 真跑时**用 DSH_HOME 指向本次自检的 home**，否则会读到另一个 home 的 profile（踩过）。
 */
function loadDumpText() {
  if (F['no-dump']) return { mode: 'skipped', ok: false, reason: '--no-dump：按你的要求没跑 --dump-config' };
  if (V['dump-config-file'] !== undefined) {
    const file = path.resolve(String(V['dump-config-file']));
    try {
      return { mode: 'file', ok: true, text: fs.readFileSync(file, 'utf8'), file };
    } catch (e) {
      return { mode: 'file', ok: false, reason: `读不到离线 dump 文件：${file}（${e?.code ?? e?.message}）` };
    }
  }
  if (!CTX.profile) return { mode: 'skipped', ok: false, reason: '没找到 profile 目录，无从跑 --dump-config' };
  const resolved = resolveCommand('dsh', { extraRoots: [path.join(CTX.profile.dir, 'node_modules')] });
  if (!resolved) return { mode: 'run', ok: false, reason: 'PATH 与全局 node_modules 里都没有能跑的 dsh（装主包：npm i -g @deepseek-ai/dsh）' };
  const r = runPlan(spawnPlan(resolved, ['--profile', CTX.profile.name, '--dump-config']), {
    timeout: Math.max(TIMEOUT, 20000),
    label: 'dsh --profile X --dump-config',
    extraEnv: { DSH_HOME: HOME },
  });
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.rc !== 0) {
    return { mode: 'run', ok: false, reason: `--dump-config rc=${r.rc ?? 'null'}：${tail(r.stderr || r.stdout || (r.error?.code ?? ''), 160)}`, text };
  }
  return { mode: 'run', ok: true, text, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

function initMountContext() {
  const loaded = loadManifestForRun();
  if (!loaded.ok) {
    CTX.manifest = null;
    CTX.manifestLabel = `清单不可用：${loaded.message}`;
    CTX.manifestSource = 'error';
    return;
  }
  CTX.manifest = loaded.manifest;
  CTX.manifestLabel = loaded.label;
  CTX.manifestSource = loaded.source;

  CTX.profile = resolveProfile();
  if (CTX.profile) CTX.profilePkg = readProfilePkg(CTX.profile.dir);
  if (CTX.profile) CTX.profilePkgPath = path.join(CTX.profile.dir, 'package.json');

  CTX.dump = loadDumpText();
  if (CTX.dump.ok) {
    CTX.dumpSummary = summarizeDump(CTX.dump.text);
    // stderr 里的跳过记录优先从 stderr 抠；离线 dump 文件常常是 stdout+stderr 合在一起的，
    // 所以合文本再抠一遍（同一行的两种来源会去重）。
    const fromErr = parseSkipLines(CTX.dump.stderr ?? '');
    const fromAll = parseSkipLines(CTX.dump.text ?? '');
    const merged = [];
    const seen = new Set();
    for (const s of [...fromErr, ...fromAll]) {
      const key = `${s.packageName}\u0000${s.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(s);
    }
    CTX.skips = merged;
  }
}

/** 一个包可能装在哪：profile 实体 / profiles 共享的 node_modules / 全局 */
function collectInstalled(name) {
  const found = [];
  const tried = [];
  const roots = [];
  if (CTX.profile) roots.push({ where: 'profile', label: `${CTX.profile.name} profile`, root: path.join(CTX.profile.dir, 'node_modules') });
  roots.push({ where: 'profile-shared', label: 'profiles 共享 node_modules', root: path.join(HOME, 'profiles', 'node_modules') });
  for (const r of roots) {
    tried.push(r.label);
    const hit = findPackageInRoot(r.root, name);
    if (hit) found.push({ where: r.where, label: r.label, ...hit });
  }
  const global = findGlobalPackage(name);
  if (global) found.push({ where: 'global', label: `全局 node_modules（${global.root}）`, ...global });
  else tried.push('全局 node_modules');
  return { found, tried };
}

function installedWhereText(list) {
  if (!list.length) return '都没找到';
  return list.map((x) => x.label).join(' / ');
}

// 11 --------------------------------------------------------------- 包在不在 / 版本对不对
function checkPackages() {
  const NAME = '包在不在 / 版本对不对';
  if (!CTX.manifest) {
    add(11, NAME, 'SKIP', CTX.manifestLabel, '修好清单后重跑：--manifest <suite-manifest.json>');
    return;
  }
  const items = CTX.manifest.items;
  const rows = [];
  for (const item of items) {
    const probe = item.probe || {};
    const rangeText = describeRange(parseRange(item.versionRange));
    const { found, tried } = collectInstalled(item.name);

    if (!found.length) {
      rows.push({
        item,
        status: 'FAIL',
        short: `${item.name}：未安装（${tried.join(' / ')} 都没有）`,
      });
      continue;
    }
    // 多个位置都有时，取"第一个命中"的版本作判据；其余位置只作说明
    const primary = found[0];
    const version = String(primary.pkg?.version ?? '');
    const verdict = satisfies(item.versionRange, version);
    const whereText = installedWhereText(found);
    const extra = found.length > 1 ? `（另有 ${found.slice(1).map((x) => x.label).join(' / ')}）` : '';

    if (verdict === 'yes') {
      const cmdNote = item.type === 'cli' && probe.cmd ? ` · 命令 ${probe.cmd}` : '';
      rows.push({ item, status: 'PASS', short: `${item.name}@${version} 在 ${whereText}${cmdNote}${extra}` });
    } else if (verdict === 'no') {
      rows.push({
        item,
        status: 'FAIL',
        short: `${item.name} 版本越界：期望 ${rangeText}，实体 ${version}（在 ${whereText}）${extra}`,
      });
    } else {
      rows.push({
        item,
        status: 'SKIP',
        short: `${item.name}@${version} 版本无法判定（期望 ${rangeText}；带预发布后缀的实体版本本工具不猜，不算通过）`,
      });
    }
  }

  const fails = rows.filter((r) => r.status === 'FAIL');
  const skips = rows.filter((r) => r.status === 'SKIP');
  const pluginCount = items.filter((i) => i.type === 'plugin').length;
  const cliCount = items.filter((i) => i.type === 'cli').length;
  const srcNote = `清单来源：${CTX.manifestLabel}`;

  if (fails.length) {
    const brief = fails.slice(0, 5).map((r) => r.short).join('；') + (fails.length > 5 ? `；…等 ${fails.length} 项` : '');
    add(
      11,
      NAME,
      'FAIL',
      `${items.length} 项里 ${fails.length} 项不过：${brief}（${srcNote}）`,
      '缺就装：dsh plugin add <包>（插件）/ npm i -g <包>（命令行）。版本越界只报不修 —— 装哪个版本你自己定',
    );
    return;
  }
  if (skips.length) {
    add(11, NAME, 'SKIP', `${skips.length} 项版本无法判定（不算通过）：${skips.map((r) => r.short).join('；')}（${srcNote}）`, '看一眼实体版本是否是你想要的');
    return;
  }
  add(11, NAME, 'PASS', `清单 ${items.length} 项全部在位（plugin ${pluginCount} · cli ${cliCount}），版本都落在区间内（${srcNote}）`);
}


// 12 --------------------------------------------------------------- 挂载生效没
/**
 * 判「挂载生效没」。本项判的是**组合**，不是运行时 —— 这一点必须跟着结论一起读。
 *
 * 两个词在这里定死：
 *   声明 = 包实体 `node_modules/<包>/package.json#dsh.bundle`
 *   登记 = profile `package.json#dsh.profile.bundles`
 */
function checkMount() {
  const NAME = '挂载生效没';
  const runtimeNote = '本项判的是组合，不是运行时；要验"没崩"只能人工起一次 dsh web --no-open 看日志';

  if (!CTX.manifest) {
    add(12, NAME, 'SKIP', CTX.manifestLabel, '修好清单后重跑：--manifest <suite-manifest.json>');
    return;
  }
  if (!CTX.profile) {
    add(12, NAME, 'SKIP', `该 home 下没有 profile 目录（profiles 下没有子目录）`, '装一个 profile 后重跑；或用 --profile 指定');
    return;
  }
  if (!CTX.profilePkg) {
    add(
      12,
      NAME,
      'FAIL',
      `读不到 profile 的 package.json：${CTX.profilePkgPath}（profile 没初始化完？）`,
      `先装一次插件或用 dsh plugin --profile ${CTX.profile.name} install 初始化 profile`,
    );
    return;
  }

  const bundlesRaw = CTX.profilePkg?.dsh?.profile?.bundles;
  const bundles = Array.isArray(bundlesRaw) ? bundlesRaw.map(String) : [];
  const treeKnown = !!(CTX.dump && CTX.dump.ok);
  const summary = CTX.dumpSummary;
  const problems = [];
  const cells = { allThree: 0, declaredNotRegistered: 0, registeredNotInTree: 0, cliClass: 0, registeredWithoutBundle: 0, treeUnknown: 0 };
  let notInstalled = 0;

  const pluginItems = CTX.manifest.items.filter((i) => i.type === 'plugin');
  for (const item of pluginItems) {
    const { found } = collectInstalled(item.name);
    if (!found.length) {
      // 包都没装 —— 第 11 项会报，这里不重复判红
      notInstalled += 1;
      continue;
    }
    const primary = found[0];
    const hasBundle = !!(primary.pkg && primary.pkg.dsh && primary.pkg.dsh.bundle);
    const registered = bundles.includes(item.name);
    const inTree = treeKnown ? summary.hasBundle(item.name) : false;
    const skipped = CTX.skips.find((s) => s.packageName === item.name) ?? null;
    const verdict = judgeMount({ name: item.name, hasBundle, registered, treeKnown, inTree, skipped });

    if (verdict.cell === 'all-three') cells.allThree += 1;
    else if (verdict.cell === 'declared-not-registered') cells.declaredNotRegistered += 1;
    else if (verdict.cell === 'registered-not-in-tree') cells.registeredNotInTree += 1;
    else if (verdict.cell === 'registered-without-bundle') cells.registeredWithoutBundle += 1;
    else if (verdict.cell === 'tree-unknown') cells.treeUnknown += 1;
    else cells.cliClass += 1;

    if (verdict.verdict === 'FAIL') {
      const attr = verdict.attribution ? `（归因 ${verdict.attribution}）` : '';
      problems.push(`${item.name}：${verdict.message}${attr}`);
    }
  }

  // 宿主 stderr 里的跳过记录：一行字符串匹配就当 FAIL 依据。
  // ⚠️ 它兜不住最危险的那一格（"声明了 bundle 但没登记"时宿主一个字都不给），所以只是补充。
  for (const s of CTX.skips) {
    if (problems.some((p) => p.startsWith(`${s.packageName}：`))) continue;
    problems.push(`${s.packageName} 被宿主跳过：${SKIP_ATTRIBUTION[s.kind] ?? SKIP_ATTRIBUTION.other}（原话：${tail(s.reason, 120)}）`);
  }

  // 撞 id / 撞 name：**跨 bundle 段头**才算撞（同一个 bundle 被 patch 重打会重复打印同一批条目，那是正常现象）
  if (treeKnown) {
    for (const c of findCollisions(summary)) {
      problems.push(`${c.kind === 'id' ? '撞 id' : '撞 name'}：${c.key} 出现在 ${c.heads.length} 个 bundle 段（${c.heads.join(' | ')}）`);
    }
  }

  // 位置互斥（只覆盖"记忆位置"这一处，不是万能判据）
  const MEMORY_SLOTS = ['dsh-memory', '@kira905/dsh-memory-toolkit'];
  const memoryBoth = MEMORY_SLOTS.filter((n) => bundles.includes(n));
  if (memoryBoth.length > 1) {
    problems.push(`抢同一个记忆位置：bundles 里同时有 ${memoryBoth.join(' 与 ')}（二选一，摘掉一条）`);
  }

  const stat = `三格齐 ${cells.allThree} · CLI 类 ${cells.cliClass}${notInstalled ? ` · 未装 ${notInstalled}` : ''}`;

  if (problems.length) {
    const brief = problems.slice(0, 5).join('；') + (problems.length > 5 ? `；…等 ${problems.length} 处` : '');
    add(
      12,
      NAME,
      'FAIL',
      `${problems.length} 处不过：${brief}（${runtimeNote}）`,
      '按每条处置做：没登记的补 `dsh plugin add <包>`；树里没有的看归因；撞车的摘掉重复那条',
    );
    return;
  }
  if (pluginItems.length && notInstalled === pluginItems.length) {
    add(
      12,
      NAME,
      'SKIP',
      `清单里的 ${pluginItems.length} 项 plugin 一个都没装（第 11 项已报未安装），挂载无从判（${runtimeNote}）`,
      '先把清单里的组件装上，再回来看这一项；只想验骨架的话这项可以忽略',
    );
    return;
  }
  if (!treeKnown) {
    add(
      12,
      NAME,
      'SKIP',
      `文件层面 ${pluginItems.length - notInstalled} 项都正常（声明 + 登记都在，${stat}），但组合树维度没判：${CTX.dump?.reason ?? '没有 dump'}（${runtimeNote}）`,
      `补上组合树判据：保证能跑 dsh --profile ${CTX.profile.name} --dump-config，或用 --dump-config-file 喂一份离线 dump`,
    );
    return;
  }
  add(
    12,
    NAME,
    'PASS',
    `组合树已判（dump ${summary.lineCount} 行 · ${summary.bundleHeads.length} 个 bundle 段）：${pluginItems.length} 项 plugin 全绿（${stat}）· 撞 id/name 0 处 · 位置互斥 0 处（${runtimeNote}）`,
  );
}

// 13 --------------------------------------------------------------- 关键能力能不能跑
/** 整批墙钟上限：探针一条最坏等 8 秒，十几条就是一分多钟，所以整批封顶 30 秒，超了剩下的整体降级 SKIP */
const PROBE_BATCH_MS = (() => {
  const n = Number(V['probe-batch']);
  return Number.isFinite(n) && n > 0 ? n : 30000;
})();

/**
 * 跑一条探针。三种 kind：
 *   existence —— 只查文件在不在，**零执行**（默认）
 *   help      —— 跑 `--help`；**仅限清单给了 helpVerified 的命令**（对没实现的命令，--help 是真动作）
 *   cmd       —— 跑清单指定的只读命令（清单必须写 readonlyBecause）
 * 另外 plugin 类可带 probe.api（只读 HTTP GET）。
 */
async function probeOne(item) {
  const probe = item.probe || {};
  const kind = probe.kind || 'existence';
  const extraRoots = CTX.profile ? [path.join(CTX.profile.dir, 'node_modules')] : [];

  if (kind === 'existence') {
    const { found, tried } = collectInstalled(item.name);
    if (item.type === 'cli') {
      const cmd = String(probe.cmd ?? '');
      const resolved = resolveCommand(cmd, { extraRoots });
      if (resolved) {
        const at = resolved.kind === 'node' ? `${resolved.packageName}@${resolved.version ?? '?'}（可见 node_modules）` : `壳文件 ${resolved.file}`;
        return { item, status: 'PASS', short: `${item.name}：命令 ${cmd} 可解析 → ${at}（只查存在，未执行）` };
      }
      return { item, status: 'FAIL', short: `${item.name}：命令 ${cmd} 在 PATH 与已查 node_modules 里都没有（查过：${tried.join(' / ')}）` };
    }
    if (!found.length) return { item, status: 'FAIL', short: `${item.name}：包实体不在（${tried.join(' / ')} 都没有）` };
    const entry = pluginEntry(found[0].dir);
    if (entry.ok) return { item, status: 'PASS', short: `${item.name}：entry 在（${path.relative(found[0].dir, entry.file)}；只查存在，未执行）` };
    return { item, status: 'FAIL', short: `${item.name}：包在但没有可加载的 entry（package.json 的 main/exports 与 lib/index.js 都没命中）` };
  }

  if (kind !== 'existence') {
    const plan = planProbe(item);
    if (plan.mode === 'skip') return { item, status: 'SKIP', short: `${item.name}：${plan.why}` };
    if (plan.mode !== 'exec') return { item, status: 'SKIP', short: `${item.name}：探针计划异常（${plan.mode}）` };

    const resolved = resolveCommand(String(probe.cmd), { extraRoots });
    if (!resolved) return { item, status: 'FAIL', short: `${item.name}：探针命令 ${probe.cmd} 找不到（命令在不在由第 11 项判，这里只报探针没能跑）` };
    const r = runPlan(spawnPlan(resolved, plan.args), { timeout: TIMEOUT, label: `probe ${plan.label}` });
    const label = plan.label;
    if (r.rc === null && (r.error?.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(r.error?.message ?? '')))) {
      return { item, status: 'SKIP', short: `${item.name}：探针 ${label} 超时（>${TIMEOUT}ms）—— 超时不算通过` };
    }
    if (r.rc === 0) {
      const expect = typeof probe.expect === 'string' ? probe.expect : '';
      if (expect) {
        const hay = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
        let hit = false;
        try {
          hit = new RegExp(expect).test(hay);
        } catch {
          hit = hay.includes(expect);
        }
        if (!hit) return { item, status: 'FAIL', short: `${item.name}：${label} rc=0 但输出不含期望 ${JSON.stringify(expect)}；首行：${tail(firstLine(r.stdout || r.stderr), 120)}` };
      }
      return { item, status: 'PASS', short: `${item.name}：${label} rc=0` };
    }
    const first = firstLine(r.stderr) || firstLine(r.stdout) || String(r.error?.code ?? '');
    return { item, status: 'FAIL', short: `${item.name}：${label} rc=${r.rc ?? 'null'}；首行错误：${tail(first, 160)}` };
  }

  return { item, status: 'SKIP', short: `${item.name}：未知探针类型 ${JSON.stringify(kind)}（只认 existence / help / cmd）` };
}

function firstLine(s) {
  return String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? '';
}

/** plugin 类的只读 HTTP 探针（清单里 probe.api 给了才跑） */
async function probeApi(item) {
  const api = String(item.probe?.api ?? '');
  if (!api) return null;
  if (F['no-net']) return { item, status: 'SKIP', short: `${item.name}：--no-net，跳过只读 API ${api}` };
  const base = String(V['api-base'] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const r = await httpProbe(base + api);
  if (r.ok) return { item, status: 'PASS', short: `${item.name}：GET ${api} → HTTP ${r.status}` };
  if (r.status === 401 || r.status === 403) return { item, status: 'PASS', short: `${item.name}：GET ${api} → HTTP ${r.status}（服务在，需要登录凭据）` };
  if (r.status > 0) return { item, status: 'FAIL', short: `${item.name}：GET ${api} → HTTP ${r.status}` };
  return { item, status: 'SKIP', short: `${item.name}：GET ${api} 连不上（${r.error ?? '服务没起'}）` };
}

async function checkProbes() {
  const NAME = '关键能力能不能跑';
  if (!CTX.manifest) {
    add(13, NAME, 'SKIP', CTX.manifestLabel, '修好清单后重跑：--manifest <suite-manifest.json>');
    return;
  }
  const items = CTX.manifest.items;
  const started = Date.now();
  const rows = [];
  let degraded = 0;
  // 包都没装的，探针无从跑 —— 第 11 项已经报过"未安装"，这里只记 SKIP，不重复刷红
  const notInstalled = new Set();
  for (const item of items) {
    if (!collectInstalled(item.name).found.length) notInstalled.add(item.name);
  }

  for (const item of items) {
    if (shouldDegradeBatch(started, Date.now(), PROBE_BATCH_MS)) {
      degraded += 1;
      continue;
    }
    if (notInstalled.has(item.name)) {
      rows.push({ item, status: 'SKIP', short: `${item.name}：包没装，探针无从跑（第 11 项已报未安装）` });
      continue;
    }
    rows.push(await probeOne(item));
    const apiRow = await probeApi(item);
    if (apiRow) rows.push(apiRow);
  }

  const elapsed = Date.now() - started;
  const kinds = {};
  for (const it of items) {
    const k = it.probe?.kind || 'existence';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const kindText = Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(' · ') || '无';

  const fails = rows.filter((r) => r.status === 'FAIL');
  const skips = rows.filter((r) => r.status === 'SKIP');
  const batchNote = degraded
    ? `；整批墙钟 ${(elapsed / 1000).toFixed(1)}s 超上限 ${PROBE_BATCH_MS / 1000}s，剩余 ${degraded} 项整体降级 SKIP（不是通过）`
    : `；墙钟 ${(elapsed / 1000).toFixed(1)}s / 上限 ${PROBE_BATCH_MS / 1000}s`;

  if (fails.length) {
    add(
      13,
      NAME,
      'FAIL',
      `${fails.length} 项不过：${fails.map((r) => r.short).join('；')}（探针 ${kindText}${batchNote}）`,
      '按每条的 rc / 首行错误原文去查；探针只读，不会改你的状态',
    );
    return;
  }
  if (skips.length || degraded) {
    const sk =
      skips.slice(0, 5).map((r) => r.short).join('；') + (skips.length > 5 ? `；…等 ${skips.length} 项` : '');
    add(
      13,
      NAME,
      'SKIP',
      `${skips.length} 项探针没判过（不算通过）：${sk || '（无明细）'}${batchNote}`,
      '装齐之后再跑一次；--help 只对清单声明过 helpVerified 的命令执行',
    );
    return;
  }
  add(13, NAME, 'PASS', `清单 ${items.length} 项探针全过（${kindText}${batchNote}；全部只读，未写任何状态）`);
}

// ---------------------------------------------------------------- --fix 初始化
function applyFix() {
  const v = verdict(HOME, F['allow-production'] === true);
  if (!v.writable) {
    diag(`[REFUSE] --fix 拒写：home = ${HOME}（判定 ${v.kind}，原因 ${v.codes.join(',')}）`);
    diag('[REFUSE] 真实 home 需要显式 --allow-production；夹具 home 走 REPLICA_GUARD 执行器。零写入退出。');
    return 2;
  }
  const tickd = path.resolve(String(V.tickd ?? path.join(ROOT, 'bin', 'ops-tickd.mjs')));
  if (!fs.existsSync(tickd)) { diag(`[fix] 找不到 ops-tickd，跳过初始化：${tickd}`); return 0; }
  const before = new Set(fs.existsSync(HOME) ? fs.readdirSync(HOME) : []);
  const r = runNodeScript(tickd, ['--once', '--only', 'self-heal', '--home', HOME], { timeout: Math.max(TIMEOUT, 60000), label: 'fix: ops-tickd --only self-heal' });
  const after = fs.existsSync(HOME) ? fs.readdirSync(HOME) : [];
  const created = after.filter((n) => !before.has(n));
  if (r.rc !== 0) {
    diag(`[fix] 初始化失败 rc=${r.rc ?? 'null'}：${tail(r.stderr || r.stdout, 300)}`);
  } else {
    diag(`[fix] 初始化完成：新建 ${created.length} 项${created.length ? '（' + created.join('、') + '）' : ''}`);
    for (const n of created) WRITES.push({ what: '初始化', file: path.join(HOME, n) });
  }
  return 0;
}

// ---------------------------------------------------------------- main
async function main() {
  if (F.help) { say(usage()); return 0; }
  if (ARGV.unknown.length) {
    diag(`[用法] 未知参数：${ARGV.unknown.join(', ')}`);
    diag(usage());
    return 2;
  }

  // 夹具自守：在任何 fs 写之前
  const g = selfGuard();
  if (g) {
    diag(`[REFUSE] selfcheck-replica: ${g.msg}`);
    diag(`[REFUSE] 真实 home = ${PROD_HOME}；夹具树 = ${FIXTURE_ROOT || '（未设置）'}`);
    return 2;
  }

  const kind = classify(HOME);
  const v = verdict(HOME, F['allow-production'] === true);

  if (F.fix) {
    const rc = applyFix();
    if (rc !== 0) return rc;
  }

  checkNode();
  checkHome();
  checkDshPackage();
  await checkPort();
  await checkPlugin();
  checkMemory();
  checkSessionTool();
  await checkStateFiles();
  checkTickd();
  checkIsolation();
  // 第 11–13 项：清单驱动。放在写闸自检之后 —— 它们会跑一次 --dump-config（只读），
  // 不该混进第 10 项的写入统计里。
  initMountContext();
  checkPackages();
  checkMount();
  await checkProbes();

  const counts = { pass: 0, fail: 0, skip: 0 };
  for (const c of CHECKS) counts[c.status.toLowerCase()] += 1;
  const rc = counts.fail > 0 ? 3 : 0;

  if (F.json) {
    say(JSON.stringify({
      tool: 'selfcheck-replica',
      version: readOwnVersion(),
      ok: counts.fail === 0,
      rc,
      home: HOME,
      target: kind,
      writable: v.writable,
      guard: { on: GUARD_ON, fixtureRoot: FIXTURE_ROOT || null },
      node: process.versions.node,
      counts,
      checks: CHECKS,
      writes: WRITES,
      manifest: {
        source: CTX.manifestSource || null,
        label: CTX.manifestLabel || null,
        path: CTX.manifest?.path ?? null,
        items: CTX.manifest?.items.length ?? 0,
        excluded: CTX.manifest?.excluded.length ?? 0,
        entries: CTX.manifest
          ? CTX.manifest.items.map((i) => ({ name: i.name, type: i.type, versionRange: i.versionRange, probeKind: i.probe?.kind ?? 'existence' }))
          : [],
      },
      profile: CTX.profile ? { name: CTX.profile.name, explicit: CTX.profile.explicit === true, packageJson: CTX.profilePkgPath } : null,
      dump: CTX.dump
        ? {
            mode: CTX.dump.mode,
            ok: CTX.dump.ok === true,
            reason: CTX.dump.reason ?? null,
            lines: CTX.dumpSummary?.lineCount ?? null,
            bundleSegments: CTX.dumpSummary?.bundleHeads ?? null,
            pathLayers: CTX.dumpSummary?.pathLayers ?? null,
            skippedBundles: CTX.skips,
          }
        : null,
    }, null, 2));
    return rc;
  }

  say(`[自检] home        = ${HOME}`);
  say(`[自检] 判定        = ${kind}${v.writable ? '（可写）' : '（只读）'}${GUARD_ON ? ' · 夹具守卫开' : ''}`);
  say(`[自检] 骨架仓      = ${ROOT}`);
  say(`[自检] Node        = ${process.versions.node}`);
  say(`[自检] 清单        = ${CTX.manifestLabel || '（未加载）'}${CTX.manifest ? ` · ${CTX.manifest.items.length} 项` : ''}`);
  if (CTX.manifestSource === 'builtin') say(`                     ${DEFAULT_MANIFEST_SOURCE_NOTE}`);
  say(`[自检] profile     = ${CTX.profile ? `${CTX.profile.name}${CTX.profile.explicit ? '（--profile 指定）' : '（自动）'}` : '（该 home 下没有）'}`);
  say(
    `[自检] dump        = ${
      CTX.dump ? (CTX.dump.ok ? `已判（${CTX.dump.mode} · ${CTX.dumpSummary.lineCount} 行 · ${CTX.dumpSummary.bundleHeads.length} 个 bundle 段）` : `未判（${CTX.dump.reason}）`) : '未取'
    }`,
  );
  say('');
  const rows = CHECKS.map((c) => [String(c.id), c.name, c.status, c.detail]);
  say(table(rows, ['#', '检查项', '结果', '说明']));
  const hints = CHECKS.filter((c) => c.status === 'FAIL' && c.hint);
  if (hints.length) {
    say('');
    say('修复建议：');
    for (const c of hints) say(`  ${c.id}. ${c.hint}`);
  }
  say('');
  say(`结果：PASS ${counts.pass} · SKIP ${counts.skip} · FAIL ${counts.fail}  ⇒  ${counts.fail === 0 ? '这套环境可以使用' : '有未通过的检查项'}`);
  if (counts.fail === 0 && counts.skip > 0) say('（SKIP = 本机没装那一件，不是失败；装了之后重跑即可纳入判据）');
  return rc;
}

function readOwnVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '?'); } catch { return '?'; }
}

const rc = await main();
if (typeof rc === 'number') process.exitCode = rc;
