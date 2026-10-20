#!/usr/bin/env node
// scripts/verify-source.mjs —— 发布前自检（只读，不改任何文件）
//
// 四类判据（任一不满足即 rc=1）：
//   ① 语法：所有 *.mjs 过 `node --check`
//   ② 无绝对路径：盘符路径 / 用户主目录 / 临时目录 / 环境变量取值
//   ③ 无私有依赖：dependencies 为空；所有 import 只指向 node: 内置或本仓相对路径
//   ④ 清单一致：package.json 的 files / bin / main / exports 指到的都存在，且该发的东西都在 files 里
//
// 用法：node scripts/verify-source.mjs [--verbose]
// 退出码：0 = 全过；1 = 有失败项；2 = 用法/环境错
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fs.realpathSync(fileURLToPath(import.meta.url));
const ROOT = path.resolve(path.dirname(SELF), '..');
const SELF_REL = 'scripts/verify-source.mjs';
const VERBOSE = process.argv.includes('--verbose');

const fails = [];
const passes = [];
const fail = (check, detail) => { fails.push({ check, detail }); };
const pass = (check, detail) => { passes.push({ check, detail }); };
const say = (line) => process.stdout.write(line + '\n');

const SKIP_DIRS = new Set(['node_modules', '.git', '.ops-demo-home']);
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.md', '.ps1', '.sh', '.yml', '.yaml', '.txt']);

/** 递归列文件（相对路径，统一 / 分隔）。 */
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.ops-demo-home')) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------- ① 语法
function checkSyntax(files) {
  const mjs = files.filter((f) => f.endsWith('.mjs'));
  const bad = [];
  for (const rel of mjs) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, rel)], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${rel}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`);
  }
  if (bad.length) fail('① 语法', bad.join(' | '));
  else pass('① 语法', `${mjs.length} 个 .mjs 全部通过 node --check`);
  return bad.length;
}

// ---------------------------------------------------------------- ② 绝对路径
// 说明：本文件自己的规则文本里必然出现这些模式字面量，因此扫描时跳过它自己；
// 环境变量名按片段拼接，避免规则文本本身在发布扫描里留下"命中"。
const ENV_MARKERS = ['USER' + 'PROFILE', 'TEM' + 'P', 'APP' + 'DATA'].map((n) => '%' + n + '%');
const ABS_RULES = [
  { id: 'drive', re: /(?:^|[^A-Za-z0-9:.\/])[A-Za-z]:[\\/]/ },
  { id: 'user-dir', re: /\bUsers[\\/][A-Za-z0-9._-]+/ },
  { id: 'env-var', re: new RegExp(ENV_MARKERS.join('|')) },
  { id: 'ps-env', re: new RegExp('\\$env:[A-Za-z_]') },
  { id: 'home-name', re: /\/(?:home|Users)\/[A-Za-z0-9._-]+/ },
];

function stripUrls(text) {
  return text.replace(/https?:\/\/[^\s<>"'`)\]}]+/g, '<url>').replace(/git@[^\s<>"'`)\]}]+/g, '<remote>');
}

function checkAbsolutePaths(files) {
  const hits = [];
  let scanned = 0;
  for (const rel of files) {
    if (rel === SELF_REL) continue;
    if (!TEXT_EXT.has(path.extname(rel))) continue;
    const text = stripUrls(readText(rel));
    scanned += 1;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const rule of ABS_RULES) {
        if (rule.re.test(lines[i])) {
          hits.push(`${rel}:${i + 1} [${rule.id}] ${lines[i].trim().slice(0, 80)}`);
        }
      }
    }
  }
  if (hits.length) fail('② 无绝对路径', hits.slice(0, 20).join(' | ') + (hits.length > 20 ? ` … 共 ${hits.length} 处` : ''));
  else pass('② 无绝对路径', `${scanned} 个文本文件未发现盘符/用户目录/临时目录/环境变量取值`);
  return hits.length;
}

// ---------------------------------------------------------------- ③ 私有依赖
function checkImports(files) {
  const specRe = /(?:^|[^\w$])(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const bad = [];
  let count = 0;
  for (const rel of files) {
    if (!rel.endsWith('.mjs') || rel === SELF_REL) continue;
    // 注释里的示例 import 不是依赖：跳过以 // * /* 开头的行
    const text = readText(rel).split('\n')
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
      .join('\n');
    for (const re of [specRe, dynRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const spec = m[1];
        count += 1;
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        bad.push(`${rel} → ${spec}`);
      }
    }
  }
  if (bad.length) fail('③ 无私有依赖', bad.join(' | '));
  else pass('③ 无私有依赖', `${count} 条 import 全部指向 node: 内置或本仓相对路径`);
  return bad.length;
}

// ---------------------------------------------------------------- ④ package.json 与清单一致
function checkManifest(files) {
  const problems = [];
  let pkg;
  try {
    pkg = JSON.parse(readText('package.json'));
  } catch (e) {
    fail('④ 清单一致', `package.json 无法解析：${e.message}`);
    return 1;
  }

  const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
  const fileSet = new Set(files);

  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const v = pkg[key];
    if (v && typeof v === 'object' && Object.keys(v).length) problems.push(`${key} 非空：${Object.keys(v).join(',')}`);
  }

  if (pkg.main && !exists(pkg.main)) problems.push(`main 不存在：${pkg.main}`);
  if (pkg.exports) {
    for (const [key, target] of Object.entries(pkg.exports)) {
      const rel = typeof target === 'string' ? target : target?.import ?? target?.default;
      if (typeof rel === 'string' && rel.startsWith('./') && !exists(rel)) problems.push(`exports["${key}"] 不存在：${rel}`);
    }
  }
  if (pkg.bin) {
    for (const [name, rel] of Object.entries(pkg.bin)) {
      if (!exists(rel)) { problems.push(`bin.${name} 不存在：${rel}`); continue; }
      const head = readText(rel.replace(/^\.\//, '')).split('\n')[0];
      if (!head.startsWith('#!')) problems.push(`bin.${name} 缺少 shebang：${rel}`);
    }
  }

  const filesPatterns = Array.isArray(pkg.files) ? pkg.files : [];
  if (!filesPatterns.length) problems.push('files 为空（会把整个目录打进包里）');
  for (const p of filesPatterns) {
    const clean = String(p).replace(/\/+$/, '');
    if (clean.includes('*')) { problems.push(`files 里不支持通配：${p}`); continue; }
    if (!exists(clean)) problems.push(`files 条目不存在：${p}`);
  }
  const covered = (rel) => filesPatterns.some((p) => {
    const clean = String(p).replace(/\/+$/, '');
    return rel === clean || rel.startsWith(clean + '/');
  });
  for (const rel of files) {
    if (covered(rel)) continue;
    // 允许清单之外的"仓级说明件"与开发件
    if (['package.json', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE',
      '.gitignore', '.gitattributes'].includes(rel)) continue;
    if (rel.startsWith('scripts/')) continue;
    problems.push(`未列入 files（不会发包）：${rel}`);
  }

  for (const rel of files) {
    if (/(^|\/)\.env(\.|$)/.test(rel) || /\.bak/.test(rel) || /\.tgz$/.test(rel)) {
      problems.push(`不该进仓的文件：${rel}`);
    }
  }
  if (pkg.license !== 'AGPL-3.0-only') problems.push(`license 应为 AGPL-3.0-only，实际 ${pkg.license}`);
  if (!/^\d+\.\d+\.\d+/.test(String(pkg.version ?? ''))) problems.push(`version 不是三段式：${pkg.version}`);

  if (problems.length) fail('④ 清单一致', problems.join(' | '));
  else pass('④ 清单一致', `files=${filesPatterns.length} 项 · bin=${Object.keys(pkg.bin ?? {}).length} 个 · 仓内 ${fileSet.size} 个文件均有归属`);
  return problems.length;
}

// ---------------------------------------------------------------- main
function main() {
  if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
    process.stderr.write(`[verify] 找不到 package.json（根目录解析为 ${ROOT}）\n`);
    process.exitCode = 2;
    return;
  }
  const files = walk(ROOT).sort();
  say(`[verify] root = ${ROOT}`);
  say(`[verify] files = ${files.length}`);

  const n1 = checkSyntax(files);
  const n2 = checkAbsolutePaths(files);
  const n3 = checkImports(files);
  const n4 = checkManifest(files);

  for (const p of passes) say(`  PASS  ${p.check} —— ${p.detail}`);
  for (const f of fails) say(`  FAIL  ${f.check} —— ${f.detail}`);
  if (VERBOSE) say(`[verify] 文件清单：\n  ${files.join('\n  ')}`);

  const total = n1 + n2 + n3 + n4;
  say(total === 0 ? '[verify] RESULT: PASS (4/4)' : `[verify] RESULT: FAIL (${fails.length} 项，${total} 处问题)`);
  process.exitCode = total === 0 ? 0 : 1;
}

main();
