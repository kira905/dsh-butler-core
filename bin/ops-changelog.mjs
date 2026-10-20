#!/usr/bin/env node
// ops-changelog —— 记账最小件（等价于生产大管家的 changelog-add）
//
//   node bin/ops-changelog.mjs add --text "修了什么" [--key 自定义幂等键] [--file <目标.md>]
//   node bin/ops-changelog.mjs tail [--limit 20] [--file <目标.md>]
//
// 默认写到 <DSH_HOME>/ops-changelog/YYYY-MM.md（最新在上）。
// 幂等：同一个 key（默认 = text 的 sha256 前 8 位）只写一次；重复执行打印 skipped。
// --file 指到你自己仓库里的 CHANGELOG.md 时，插入规则 = 第一个 `#` 标题之后的第一行。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, numArg } from '../src/cli.mjs';
import { dayKey, ensureDir, monthKey, opsPaths, resolveHome } from '../src/paths.mjs';
import { writeTextAtomic } from '../src/store.mjs';

const args = parseArgs(process.argv.slice(2));
const [cmd = 'add'] = args._;

function targetFile(home) {
  if (args.values.file) return path.resolve(String(args.values.file));
  return path.join(opsPaths(home).changelogDir, `${monthKey()}.md`);
}

function stamp(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function insertLine(text, line) {
  const lines = text.split('\n');
  const h1 = lines.findIndex((l) => /^#\s/.test(l));
  if (h1 < 0) return line + '\n\n' + text;
  // 标题后先保留一个空行，再把新条目插在空行之后（最新在上）
  let at = h1 + 1;
  while (at < lines.length && lines[at].trim() === '') at += 1;
  lines.splice(at, 0, line);
  // 保证标题与条目之间有一个空行
  if (lines[h1 + 1] !== '') lines.splice(h1 + 1, 0, '');
  return lines.join('\n');
}

let rc = 0;
try {
  const home = resolveHome(args.values.home);
  const file = targetFile(home);
  if (cmd === 'add') {
    const text = String(args.values.text ?? args._[1] ?? '').trim();
    if (!text) throw new Error('用法：add --text "一句话说明" [--key k] [--file <目标>]');
    const key = String(args.values.key ?? crypto.createHash('sha256').update(text).digest('hex').slice(0, 8));
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (existing.includes(`[${key}]`)) {
      console.log(`skipped（key ${key} 已存在）：${file}`);
    } else {
      ensureDir(path.dirname(file));
      const header = existing ? '' : `# 变更流水 · ${monthKey()}\n\n`;
      const line = `- ${stamp()} [${key}] ${text}`;
      const next = existing ? insertLine(existing, line) : `${header}${line}\n`;
      writeTextAtomic(file, next.endsWith('\n') ? next : next + '\n');
      console.log(`ok（key ${key}）：${file}`);
    }
  } else if (cmd === 'tail') {
    const limit = numArg(args, 'limit', { min: 1, max: 1000, fallback: 20 });
    if (!fs.existsSync(file)) { console.log('（还没有变更流水）'); }
    else {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.startsWith('- '));
      console.log(lines.slice(-limit).join('\n') || '（空）');
    }
  } else {
    throw new Error(`未知子命令：${cmd}（可用：add / tail）`);
  }
} catch (e) {
  console.error(`[ops-changelog] ${e.message}`);
  rc = 2;
}
process.exitCode = rc;
