/**
 * 全局安装位置解析 —— **零 spawn、纯读盘**。
 *
 * 为什么要有这个文件（W1 的根因）：
 *   旧版自检用 `spawnSync('dsh')` / `spawnSync('npm')` 自动探测主包。这两个在 Windows 上
 *   是 `.cmd` / `.ps1` 壳（不是 exe），`shell: false` 时 spawn 一定失败（`ENOENT`；直接点
 *   `.cmd` 会 `EINVAL`）⇒ 「自动探测分支」在 Windows 上**永远 SKIP**，而主包其实装着。
 *   所以这里改成只读盘：按已知布局算出「全局 node_modules 根」和「全局 bin 目录」，
 *   直接读 `<根>/<包名>/package.json`。**一个外部进程都不起**。
 *
 * 另一件同等重要的事：真要执行一条全局命令时，**优先找到它 package.json 里的 bin 映射、
 * 用 node 直跑那个 JS 入口**，而不是去点 `.cmd` 壳 —— 这样跨平台一致、也不受 shell 引号
 * 地狱影响。只有实在找不到 JS 入口时才退回"按平台选壳"。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
const EXEC_DIR = path.dirname(process.execPath);

function uniq(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item) continue;
    const key = IS_WIN ? path.resolve(item).toLowerCase() : path.resolve(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path.resolve(item));
  }
  return out;
}

/** 读 `<dir>/.npmrc` 里的 `prefix=`（不读用户级之外的任何配置，也不改它） */
function npmrcPrefixes(dir) {
  const found = [];
  try {
    const raw = fs.readFileSync(path.join(dir, '.npmrc'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*prefix\s*=\s*(.+?)\s*$/.exec(line);
      if (m) found.push(m[1].replace(/^["']|["']$/g, ''));
    }
  } catch {
    /* 没有 .npmrc */
  }
  return found;
}

/** PATH 里的目录（Windows 上大小写不敏感，但这里只用来找文件，不比较） */
export function pathDirs() {
  const raw = String(process.env.PATH ?? process.env.Path ?? '');
  return uniq(raw.split(IS_WIN ? ';' : ':').filter(Boolean));
}

/**
 * 全局 node_modules 根候选（按可信度排序）。
 * 覆盖：官方安装器 / nvm-windows 符号链接 / npm 的 Windows 默认前缀 / 自定义 prefix / pnpm 全局。
 */
export function globalPackageRoots() {
  const cands = [];
  const prefixes = [
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
    ...npmrcPrefixes(os.homedir()),
  ].filter(Boolean);

  if (IS_WIN) {
    // ① 与 node.exe 同级（官方安装器把全局包放这儿）
    cands.push(path.join(EXEC_DIR, 'node_modules'));
    // ② npm 的 Windows 默认前缀：<appdata>/npm/node_modules
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'npm', 'node_modules'));
    // ③ 自定义 prefix
    for (const p of prefixes) cands.push(path.join(p, 'node_modules'));
    // ④ 从 PATH 反推：如果 PATH 里有 `...\npm`，那 `...\npm\node_modules` 也是一处全局根
    for (const d of pathDirs()) {
      if (/[\\/]npm$/i.test(d)) cands.push(path.join(d, 'node_modules'));
    }
  } else {
    cands.push(path.join(EXEC_DIR, '..', 'lib', 'node_modules'));
    for (const p of prefixes) cands.push(path.join(p, 'lib', 'node_modules'), path.join(p, 'node_modules'));
    cands.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'));
    cands.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  }
  return uniq(cands);
}

/** 全局 bin 目录候选（放可执行 shim 的地方） */
export function globalBinDirs() {
  const cands = [EXEC_DIR];
  const prefixes = [
    process.env.npm_config_prefix,
    process.env.NPM_CONFIG_PREFIX,
    ...npmrcPrefixes(os.homedir()),
  ].filter(Boolean);
  if (IS_WIN) {
    if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'npm'));
    for (const p of prefixes) cands.push(p);
  } else {
    for (const p of prefixes) cands.push(path.join(p, 'bin'), p);
    cands.push(path.join(os.homedir(), '.npm-global', 'bin'), '/usr/local/bin', '/usr/bin');
  }
  return uniq(cands);
}

/** 读一个 package.json，失败返回 null（永不抛） */
export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 在一个 node_modules 根里找包。
 * @returns {{root:string, dir:string, file:string, pkg:object}|null}
 */
export function findPackageInRoot(root, name) {
  const dir = path.join(root, ...String(name).split('/'));
  const file = path.join(dir, 'package.json');
  const pkg = readJsonFile(file);
  if (!pkg) return null;
  return { root, dir, file, pkg };
}

/** 在多个根里找包，返回第一个命中的 */
export function findPackageInRoots(name, roots) {
  for (const root of roots) {
    const hit = findPackageInRoot(root, name);
    if (hit) return hit;
  }
  return null;
}

/** 在所有已知全局根里找一个全局包 */
export function findGlobalPackage(name) {
  return findPackageInRoots(name, globalPackageRoots());
}

/**
 * 把一个包 package.json 的 `bin` 规范化成 `{ 命令名: 相对路径 }`。
 * 字符串形态时，命令名取包名最后一段（作用域包去掉 `@scope/`）。
 */
export function normalizeBin(pkg, packageName) {
  const bin = pkg?.bin;
  if (typeof bin === 'string' && bin.trim()) {
    const last = String(packageName ?? '').split('/').pop() || 'bin';
    return { [last]: bin };
  }
  if (bin && typeof bin === 'object' && !Array.isArray(bin)) {
    const out = {};
    for (const [k, v] of Object.entries(bin)) {
      if (typeof v === 'string' && v.trim()) out[k] = v;
    }
    return out;
  }
  return {};
}

/** Windows 上点一个可执行文件要试的扩展名（`.ps1` 单列，它必须经 shell） */
const WIN_EXTS = ['.CMD', '.cmd', '.exe', '.bat', '.BAT', '.ps1'];

/** 在一个 bin 目录里找一个命令文件；找到返回绝对路径 */
export function findBinInDir(dir, cmd) {
  const direct = path.join(dir, cmd);
  const cands = IS_WIN ? [direct + '.exe', direct + '.CMD', direct + '.cmd', direct, direct + '.bat', direct + '.ps1'] : [direct];
  for (const f of cands) {
    try {
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** 按 PATH 顺序找命令文件（只查存在，不执行） */
export function whichOnPath(cmd) {
  for (const dir of pathDirs()) {
    const hit = findBinInDir(dir, cmd);
    if (hit) return hit;
  }
  return null;
}

/**
 * 解析一条命令该怎么跑 —— **首选"用 node 直跑 JS 入口"，避免碰 .cmd/.ps1 壳**。
 *
 * @param {string} cmd 命令名（如 dsh / npm / session-mark）
 * @param {{extraRoots?: string[], extraBinDirs?: string[]}} [opts]
 * @returns {null | {kind:'node', file:string, packageName:string, packageDir:string, version:string|null}
 *               | {kind:'shell', file:string, shell:'cmd'|'powershell'|'direct'}}
 */
export function resolveCommand(cmd, opts = {}) {
  const extraRoots = Array.isArray(opts.extraRoots) ? opts.extraRoots : [];
  const extraBinDirs = Array.isArray(opts.extraBinDirs) ? opts.extraBinDirs : [];
  const roots = uniq([...extraRoots, ...globalPackageRoots()]);
  const binDirs = uniq([...extraBinDirs, ...globalBinDirs(), ...pathDirs()]);

  // ① 在 node_modules 根里按"包的 bin 映射"反查：最可靠，且拿到的是 JS 文件
  for (const root of roots) {
    for (const found of scanRootForBin(root, cmd)) return found;
  }

  // ② 退回 bin 目录里的壳文件；按扩展名决定用什么执行
  for (const dir of binDirs) {
    const file = findBinInDir(dir, cmd);
    if (!file) continue;
    if (/\.ps1$/i.test(file)) return { kind: 'shell', file, shell: 'powershell' };
    if (/\.(cmd|bat)$/i.test(file)) return { kind: 'shell', file, shell: 'cmd' };
    return { kind: 'shell', file, shell: 'direct' };
  }
  return null;
}

/**
 * 扫一个 node_modules 根，找哪个包的 bin 里登记了 `cmd`。
 * 只扫两层（`<root>/<name>` 与 `<root>/@scope/<name>`），不做深递归 —— 全局根下的
 * 传递依赖有几百个，深扫会把 0.1 秒的事拖成几秒。
 */
function scanRootForBin(root, cmd) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    if (!e.name.startsWith('@')) {
      dirs.push(path.join(root, e.name));
      continue;
    }
    try {
      for (const sub of fs.readdirSync(path.join(root, e.name), { withFileTypes: true })) {
        if (sub.isDirectory() || sub.isSymbolicLink()) dirs.push(path.join(root, e.name, sub.name));
      }
    } catch {
      /* 读不了这个 scope 目录 */
    }
  }
  for (const dir of dirs) {
    const pkg = readJsonFile(path.join(dir, 'package.json'));
    if (!pkg) continue;
    const bin = normalizeBin(pkg, pkg.name);
    const rel = bin[cmd];
    if (!rel) continue;
    const file = path.resolve(dir, rel);
    try {
      if (!fs.statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    out.push({
      kind: 'node',
      file,
      packageName: String(pkg.name ?? ''),
      packageDir: dir,
      version: pkg.version ? String(pkg.version) : null,
    });
    break;
  }
  return out;
}

/** 用一条已解析的命令起子进程时要传的 `{ cmd, args }`（不在此处执行，调用方决定） */
export function spawnPlan(resolved, args = []) {
  if (!resolved) return null;
  if (resolved.kind === 'node') return { cmd: process.execPath, args: [resolved.file, ...args] };
  if (resolved.shell === 'cmd') return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${resolved.file}"`, ...args] };
  if (resolved.shell === 'powershell') {
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved.file, ...args] };
  }
  return { cmd: resolved.file, args };
}

/** Windows 上这些扩展名列表导出给夹具用 */
export const WINDOWS_BIN_EXTS = WIN_EXTS;
