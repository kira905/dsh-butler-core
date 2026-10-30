// 变异测试：**把四格里的判定改反 ⇒ 上面的夹具必须红**
//
// 做法不是"再写一遍断言"，而是把 scripts/lib/dump-parse.mjs 的源码做定点变异（文本替换），
// 写到临时文件里 import 进来，跑**同一批**断言：
//   · 原版：断言全过
//   · 变异版：断言必须至少红一条
// 只要有一条变异"抓不到"，说明那一格其实没被夹具真正锁住 —— 这一份夹具本身就不合格。
// dump-parse.mjs 没有相对依赖，可以安全地整份复制到临时目录再 import。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeChecker, makeTempDir, rmTree } from './lib/harness.mjs';

export const name = '变异测试（四格判定改反必须被抓到）';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO_ROOT, 'scripts', 'lib', 'dump-parse.mjs');

/** 跑"四格那一批"断言，返回 checker（看 state.fail 就知道有没有红） */
function judgeBatch(mod) {
  const ck = makeChecker();
  const base = { name: 'pkg', treeKnown: true, inTree: false, skipped: null };

  // 格①
  ck.eq(mod.judgeMount({ ...base, hasBundle: true, registered: true, inTree: true }).verdict, 'PASS', '格① PASS');
  // 格②
  const g2 = mod.judgeMount({ ...base, hasBundle: true, registered: false });
  ck.eq(g2.verdict, 'FAIL', '格② FAIL');
  ck.contains(g2.message, 'dsh plugin add pkg', '格② 给补 add');
  // 格③
  const g3 = mod.judgeMount({ ...base, hasBundle: true, registered: true, skipped: { kind: 'no-bundle', reason: 'x' } });
  ck.eq(g3.verdict, 'FAIL', '格③ FAIL');
  ck.contains(g3.attribution ?? '', '① 声明缺失', '格③ 归因先排声明缺失');
  // 格③ 换一种归因
  const g3b = mod.judgeMount({ ...base, hasBundle: true, registered: true, skipped: { kind: 'missing-entity', reason: 'x' } });
  ck.contains(g3b.attribution ?? '', '② 实体不在', '格③ 归因能落到实体不在');
  // 格④
  const g4 = mod.judgeMount({ ...base, hasBundle: false, registered: false });
  ck.eq(g4.verdict, 'PASS-NOTE', '格④ PASS 但带说明');
  // 四格之外
  const extra = mod.judgeMount({ ...base, hasBundle: false, registered: true });
  ck.eq(extra.verdict, 'FAIL', '登记了但包没声明 ⇒ FAIL');
  ck.contains(extra.message, '摘掉这条登记', '这一格的处置不是补 add');
  // 组合树判不了时（没 dump）只能 SKIP —— 这条是"假绿"最常走的那条路
  const unknownTree = mod.judgeMount({ ...base, hasBundle: true, registered: true, treeKnown: false });
  ck.eq(unknownTree.verdict, 'SKIP', '组合树未知 ⇒ SKIP（不许判成 PASS）');
  // 撞车口径（summarizeDump 吃的是**文本**，不是 parseDump 的返回值 —— 别搞混）
  const repeated = mod.summarizeDump(
    ['# == b1', '- id: a', "  name: 'n'", '# == b1, patched by X', '- id: b', "  name: 'n'", '# == b2', '- id: c', "  name: 'other'"].join('\n'),
  );
  ck.eq(mod.findCollisions(repeated).length, 0, '同一个 bundle 里重复打印同名条目不算撞车');
  const collided = mod.summarizeDump(['# == mem-a', '- id: memory', '# == mem-b', '- id: memory'].join('\n'));
  ck.eq(mod.findCollisions(collided).length, 1, '跨 bundle 的同 id 才算撞车');
  // 跳过归因
  ck.eq(mod.classifySkipReason('x declares no dsh.bundle in its package.json'), 'no-bundle', '归因：声明缺失');
  ck.eq(mod.classifySkipReason('cannot resolve profile bundle "x"'), 'missing-entity', '归因：实体不在');
  ck.eq(mod.classifySkipReason('Plugin x is incompatible with dsh y'), 'compat', '归因：兼容闸');

  return ck;
}

/** 变异表：每条都是"把某一条判据改反/放松"，并说明夹具靠哪条断言抓它 */
const MUTANTS = [
  {
    label: '格② 有声明没登记 判成 PASS',
    edits: [["      verdict: 'FAIL',\n      cell: 'declared-not-registered',", "      verdict: 'PASS',\n      cell: 'declared-not-registered',"]],
  },
  {
    label: '四格之外那一格（登记了但没声明）整段失效',
    edits: [['  if (registered && !hasBundle) {', '  if (registered && !hasBundle && false) {']],
  },
  {
    label: '格③ 声明了但树里没有 判成 PASS',
    edits: [["    verdict: 'FAIL',\n    cell: 'registered-not-in-tree',", "    verdict: 'PASS',\n    cell: 'registered-not-in-tree',"]],
  },
  {
    label: '撞车口径放松（跨段头 > 99 才算）',
    edits: [['if (heads.size > 1) out.push({ kind: \'id\', key, heads: [...heads] });', 'if (heads.size > 99) out.push({ kind: \'id\', key, heads: [...heads] });']],
  },
  {
    label: '格④ CLI 类 判成 FAIL（假红方向）',
    edits: [["    return {\n      verdict: 'PASS-NOTE',\n      cell: 'cli-class',", "    return {\n      verdict: 'FAIL',\n      cell: 'cli-class',"]],
  },
  {
    label: '跳过归因里删掉"声明缺失"这一支（错归到 other）',
    edits: [["  if (/declares no dsh\\.bundle/i.test(s)) return 'no-bundle';", '']],
  },
  {
    label: '组合树未知时直接判 PASS（最典型的假绿）',
    edits: [["      verdict: 'SKIP',\n      cell: 'tree-unknown',", "      verdict: 'PASS',\n      cell: 'tree-unknown',"]],
  },
];

export async function run(c) {
  const srcText = fs.readFileSync(SRC, 'utf8');
  const dir = makeTempDir('butler-core-mutant');
  try {
    // 先证明原版能过这一批断言（否则后面"变异被抓到"可能是别的错造成的假象）
    const original = await import(`${pathToFileURL(SRC).href}?v=original`);
    const origChecks = judgeBatch(original);
    c.eq(
      origChecks.state.fail,
      0,
      `原版 dump-parse 能过四格那批断言（${origChecks.state.pass} 条通过）${origChecks.state.failures.length ? '；红的是：' + origChecks.state.failures.join(' | ') : ''}`,
    );

    let index = 0;
    for (const mutant of MUTANTS) {
      index += 1;
      let text = srcText;
      for (const [from, to] of mutant.edits) {
        if (!text.includes(from)) {
          c.ok(false, `变异"${mutant.label}"的锚点在源码里找不到 —— 源码改了但变异表没跟上（夹具自身失修）`);
          text = null;
          break;
        }
        text = text.split(from).join(to);
      }
      if (text === null) continue;
      if (text === srcText) {
        c.ok(false, `变异"${mutant.label}"没改到任何字符（等于没变异）`);
        continue;
      }
      const file = path.join(dir, `mutant-${index}.mjs`);
      fs.writeFileSync(file, text, 'utf8');
      const mod = await import(`${pathToFileURL(file).href}?v=${index}`);
      const ck = judgeBatch(mod);
      c.ok(ck.state.fail > 0, `变异"${mutant.label}"被抓到了（红了 ${ck.state.fail} 条）`);
    }
  } finally {
    rmTree(dir);
  }
}
