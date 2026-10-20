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
//   node scripts/selfcheck-replica.mjs --help
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

const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
const ROOT = path.resolve(path.dirname(SELF), '..');   // 仓根（含 bin/ src/ docs/）
const SELF_REL = 'scripts/selfcheck-replica.mjs';

// ---------------------------------------------------------------- 参数
const KNOWN_VALUES = new Set([
  'home', 'dsh-root', 'api-base', 'plugin-dir', 'memory-cmd', 'session-tool', 'tickd',
  'expect-jobs', 'min-node', 'timeout',
]);
const KNOWN_FLAGS = new Set([
  'json', 'fix', 'allow-production', 'no-net', 'no-npm', 'verbose', 'help',
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
  --min-node <n>          覆盖 Node 最低版本（自测用）
  --timeout <ms>          外部命令/网络超时（默认 8000）
  --no-net                不探测网络
  --no-npm                不调 npm
  --verbose               打印探测细节
  --help                  本帮助

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

  const cli = runCmd('dsh', ['--version'], { timeout: Math.min(TIMEOUT, 5000), label: 'dsh --version' });
  if (cli.rc === 0) {
    add(3, 'DSH 主包在', 'PASS', `dsh --version → ${tail(cli.stdout || cli.stderr, 80)}`);
    return;
  }
  if (!F['no-npm']) {
    const npm = runCmd('npm', ['ls', '-g', '@deepseek-ai/dsh', '--depth=0'], { timeout: Math.min(TIMEOUT, 8000), label: 'npm ls -g' });
    if (npm.rc === 0 && /@deepseek-ai\/dsh@/.test(npm.stdout)) {
      add(3, 'DSH 主包在', 'PASS', `npm ls -g → ${tail(npm.stdout.split('\n').filter((l) => l.includes('dsh@')).join(' '), 90)}`);
      return;
    }
  }
  add(3, 'DSH 主包在', 'SKIP', '未发现 DSH 主包（`dsh` 不在 PATH，npm 全局也没有）—— 只装骨架时可以忽略', '装主包：npm i -g @deepseek-ai/dsh；装了但不在 PATH 时用 --dsh-root 指过去');
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
    }, null, 2));
    return rc;
  }

  say(`[自检] home        = ${HOME}`);
  say(`[自检] 判定        = ${kind}${v.writable ? '（可写）' : '（只读）'}${GUARD_ON ? ' · 夹具守卫开' : ''}`);
  say(`[自检] 骨架仓      = ${ROOT}`);
  say(`[自检] Node        = ${process.versions.node}`);
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
