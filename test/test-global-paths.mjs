// W1 的路径解析：**零 spawn 的读盘探测**
//
// 判据不是"代码看起来没起进程"，而是两条可机械检查的：
//   ① 这个文件里根本不出现 child_process（不可能起外部进程）
//   ② 在没有 PATH 的环境里也能从 node_modules 布局读出包与命令
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageInRoot, findPackageInRoots, findGlobalPackage, normalizeBin, findBinInDir, resolveCommand, spawnPlan } from '../scripts/lib/global-paths.mjs';
import { makeTempDir, rmTree, writeJson, writeText } from './lib/harness.mjs';

export const name = 'W1 全局路径解析（零 spawn）';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'global-paths.mjs');

function makeRoot() {
  const root = makeTempDir('butler-core-paths');
  const mods = path.join(root, 'node_modules');
  fs.mkdirSync(mods, { recursive: true });
  return { root, mods };
}

export async function run(c) {
  // ---------------------------------------------------------------- ① 源码里没有 child_process
  {
    const text = fs.readFileSync(SRC, 'utf8');
    c.notContains(text, 'child_process', '本模块完全不碰 child_process（W1 的根因就是靠 spawn 探测）');
  }

  // ---------------------------------------------------------------- ② 读盘找包
  const { root, mods } = makeRoot();
  try {
    writeJson(path.join(mods, '@deepseek-ai', 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', bin: { dsh: 'lib/bin.js' } });
    writeText(path.join(mods, '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// entry\n');
    writeJson(path.join(mods, 'single-bin', 'package.json'), { name: 'single-bin', version: '1.2.3', bin: 'cli.js' });
    writeText(path.join(mods, 'single-bin', 'cli.js'), '// entry\n');
    writeJson(path.join(mods, 'no-bin', 'package.json'), { name: 'no-bin', version: '0.0.1' });

    {
      const hit = findPackageInRoot(mods, '@deepseek-ai/dsh');
      c.eq(hit?.pkg?.version, '0.2.0-rc.2', '从 node_modules 布局直接读出主包版本（不需要跑 dsh --version）');
      c.eq(findPackageInRoot(mods, 'not-there'), null, '找不到就是 null，不抛');
      c.eq(findPackageInRoots('single-bin', [path.join(root, 'nope'), mods])?.pkg?.version, '1.2.3', '多根候选按顺序找');
    }

    {
      c.eq(normalizeBin({ bin: 'x.js' }, '@scope/thing'), { thing: 'x.js' }, 'bin 是字符串时，命令名取包名末段（去 scope）');
      c.eq(normalizeBin({ bin: { a: 'a.js', b: 'b.js' } }), { a: 'a.js', b: 'b.js' }, 'bin 是对象时原样用');
      c.eq(normalizeBin({}), {}, '没有 bin 就是空表');
    }

    {
      const binDir = path.join(root, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      writeText(path.join(binDir, 'demo.CMD'), '@echo off\n');
      c.ok(findBinInDir(binDir, 'demo') !== null, 'Windows 上能找到 .CMD 壳（按扩展名试）');
      c.eq(findBinInDir(binDir, 'nothing'), null, '找不到返回 null');
    }

    {
      const r = resolveCommand('dsh', { extraRoots: [mods] });
      c.eq(r?.kind, 'node', '按包的 bin 映射反查到 JS 入口 ⇒ 直跑 node，不碰 .cmd 壳');
      c.eq(r?.packageName, '@deepseek-ai/dsh', '解析结果带上包名（detail 里要用）');
      c.eq(r?.version, '0.2.0-rc.2', '解析结果带上版本（W1 的 detail 要带版本号）');
      const plan = spawnPlan(r, ['--version']);
      c.eq(plan.cmd, process.execPath, '执行计划用当前 node 直跑');
      c.eq(plan.args, [r.file, '--version'], '执行计划把入口文件放第一个参数');
    }

    {
      const r = resolveCommand('single-bin', { extraRoots: [mods] });
      c.eq(r?.packageName, 'single-bin', 'bin 是字符串形态的包也能反查到');
    }

    {
      c.eq(resolveCommand('definitely-not-a-command-xyz', { extraRoots: [mods], extraBinDirs: [] }), null, '完全没有这条命令 ⇒ null（调用方据此 SKIP/FAIL）');
    }

    {
      // 全局根目录里没有主包时也必须返回 null 而不是崩（W1 的"没装"分支）
      const r = findGlobalPackage('@that-does-not-exist-anywhere/fake');
      c.eq(r, null, '全局找不到 ⇒ null，不抛');
    }
  } finally {
    rmTree(root);
  }
}
