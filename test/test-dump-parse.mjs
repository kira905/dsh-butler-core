// 第 12 项的纯函数判据：段解析 / 撞 id 的口径 / 跳过归因 / 四格判定
//
// 这一份是整个扩项里最容易出「假绿」和「假红」的地方，所以断言写得比别处细：
//   · 假绿 = 只看"出现过"就当挂上了（其实组合树里有两行）
//   · 假红 = 按字面数同名条目（同一个 bundle 被 patch 重打会重复打印，实测生产 profile 有 8 次）
import path from 'node:path';
import { parseDump, summarizeDump, findCollisions, parseSkipLines, classifySkipReason, judgeMount, isPathLikeHead } from '../scripts/lib/dump-parse.mjs';
import { dumpText } from './lib/fixture-env.mjs';

export const name = '第 12 项判据（段解析 / 撞车口径 / 跳过归因 / 四格）';

// 绝对路径按片段拼，别把盘符字面量写进源码（本仓有"无绝对路径"的发布扫描）
const FAKE_ABS = `C:${path.sep}Users${path.sep}fixture${path.sep}cordis.patch.yml`;

export async function run(c) {
  // ---------------------------------------------------------------- 段解析
  {
    const text = dumpText([
      { head: '@deepseek-ai/dsh-base', ids: ['timer', 'hmr'], names: ['@deepseek-ai/cordis-plugin-timer'] },
      { head: 'dsh-memory', patchedBy: FAKE_ABS, ids: ['memory'], names: ['dsh-memory'] },
      { head: FAKE_ABS, ids: ['memory-user-patch'], names: ['@fake/injected'] },
    ]);
    const segs = parseDump(text);
    c.eq(segs.length, 3, '三个 `# ==` 头切成三段');
    c.eq(segs[1].head, 'dsh-memory', '`patched by` 后面的来源不并进段头');
    c.eq(segs[1].patchedBy, FAKE_ABS, '`patched by` 的来源单独记');
    c.eq(segs[2].isPathLayer, true, '绝对路径段头 = profile 用户 patch 层');
    c.eq(segs[1].isPathLayer, false, '包名段头（含 scope）不是路径层');
    c.eq(isPathLikeHead('@liustack/modlens'), false, '带 scope 的包名里那个斜杠不算路径');
  }

  // ---------------------------------------------------------------- 撞车口径（本项最关键的一条）
  {
    // 复刻生产现场：同一个 bundle 被 patch 重打多次 ⇒ 同一批条目重复打印，**不是**撞车
    const repeated = dumpText([
      { head: '@deepseek-ai/dsh-web-app', ids: ['preset'], names: ['@deepseek-ai/dsh-agent-preset'] },
      { head: '@deepseek-ai/dsh-web-app', patchedBy: FAKE_ABS, ids: ['preset-2'], names: ['@deepseek-ai/dsh-agent-preset'] },
      { head: '@deepseek-ai/dsh-web-app', patchedBy: FAKE_ABS, ids: ['preset-3'], names: ['@deepseek-ai/dsh-agent-preset'] },
    ]);
    const sum = summarizeDump(repeated);
    c.eq(sum.bundleHeads.length, 1, '三段其实是同一个 bundle（只有 1 个 bundle 段头）');
    c.eq(findCollisions(sum).length, 0, '同一个 bundle 里重复打印同名条目 ⇒ 不算撞车（否则生产 profile 直接假红）');
  }
  {
    // 方案 §2.4-③ 的场景：两个 bundle 各 insert 一个同名/同 id 的条目
    const collision = dumpText([
      { head: 'mem-a', ids: ['memory'], names: ['@x/mem'] },
      { head: 'mem-b', ids: ['memory'], names: ['@x/mem'] },
    ]);
    const sum = summarizeDump(collision);
    const hits = findCollisions(sum);
    c.eq(hits.length, 2, '同 id + 同 name 各算一处撞车');
    c.eq(hits.filter((h) => h.kind === 'id')[0].key, 'memory', '撞的是 id: memory');
    c.eq(hits.filter((h) => h.kind === 'id')[0].heads.length, 2, '撞车要能说出落在哪两个 bundle 段');
  }
  {
    // 用户 patch 层里出现跟 bundle 同名的条目：不算撞（那一行是在改它，不是又挂一份）
    const withUserLayer = dumpText([
      { head: 'dsh-task-board-local', ids: ['board'], names: ['dsh-task-board-local'] },
      { head: FAKE_ABS, ids: ['board'], names: ['dsh-task-board-local'] },
    ]);
    c.eq(findCollisions(summarizeDump(withUserLayer)).length, 0, 'profile 用户 patch 层里的同名条目不算双挂');
  }

  // ---------------------------------------------------------------- 跳过归因（三选一，不许只写兼容闸）
  {
    const stderr = [
      'dsh: skipping profile bundle "mem-toolkit": Error: dsh: profile bundle "mem-toolkit" declares no dsh.bundle in its package.json',
      'dsh: skipping profile bundle "gone-pkg": Error: dsh: cannot resolve profile bundle "gone-pkg" from the dsh installation',
      'dsh: skipping profile bundle "old-plugin": Error: Plugin old-plugin@1.0.0 is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh":"^0.1.0"}.',
    ].join('\n');
    const skips = parseSkipLines(stderr);
    c.eq(skips.length, 3, '三行跳过记录都抠出来');
    c.eq(skips.map((s) => s.kind), ['no-bundle', 'missing-entity', 'compat'], '三种原因分别归到 声明缺失 / 实体不在 / 兼容闸');
    c.eq(skips[2].packageName, 'old-plugin', '包名去引号');
  }
  {
    c.eq(classifySkipReason('something totally unexpected'), 'other', '归不进去的一律 other（不许硬塞兼容闸）');
    c.eq(classifySkipReason('Plugin x is incompatible with dsh y'), 'compat', '兼容闸文案认得出来');
  }

  // ---------------------------------------------------------------- 四格 + 四格之外那一格
  const base = { name: 'pkg', treeKnown: true, inTree: false, skipped: null };

  {
    const r = judgeMount({ ...base, hasBundle: true, registered: true, inTree: true });
    c.eq(r.verdict, 'PASS', '格① 有声明 + 已登记 + 树里有 ⇒ PASS');
  }
  {
    const r = judgeMount({ ...base, hasBundle: true, registered: false });
    c.eq(r.verdict, 'FAIL', '格② 有声明但没登记 ⇒ FAIL');
    c.contains(r.message, 'dsh plugin add pkg', '格② 的修复动作要写成可复制的命令');
  }
  {
    const r = judgeMount({ ...base, hasBundle: true, registered: true, inTree: false, skipped: { kind: 'no-bundle', reason: 'declares no dsh.bundle' } });
    c.eq(r.verdict, 'FAIL', '格③ 声明了、登记了、树里没有 ⇒ FAIL');
    c.contains(r.attribution, '① 声明缺失', '格③ 归因优先按"声明缺失"');
    c.notContains(r.attribution, '兼容闸', '格③ 不许默认写兼容闸');
  }
  {
    const r = judgeMount({ ...base, hasBundle: true, registered: true, inTree: false, skipped: { kind: 'missing-entity', reason: 'cannot resolve' } });
    c.contains(r.attribution, '② 实体不在', '格③ 归因能落到"实体不在"');
  }
  {
    const r = judgeMount({ ...base, hasBundle: true, registered: true, inTree: false, skipped: { kind: 'compat', reason: 'incompatible' } });
    c.contains(r.attribution, '③ 主包版本兼容闸', '三种都排除后才落到兼容闸');
  }
  {
    const r = judgeMount({ ...base, hasBundle: true, registered: true, inTree: false, skipped: null });
    c.contains(r.attribution, '原因未查证', '没在跳过清单里 ⇒ 如实写"未查证"，别猜');
  }
  {
    const r = judgeMount({ ...base, hasBundle: false, registered: false });
    c.eq(r.verdict, 'PASS-NOTE', '格④ 没声明也没登记 ⇒ PASS 但带说明（CLI 类的正确状态）');
    c.contains(r.message, 'CLI 类', '格④ 的说明保留原话"这是 CLI 类"');
  }
  {
    const r = judgeMount({ ...base, hasBundle: false, registered: true });
    c.eq(r.verdict, 'FAIL', '四格之外：登记了但包没声明 ⇒ FAIL');
    c.contains(r.message, '摘掉这条登记', '这一格处置是"装回去或摘登记"，不是"补 add"');
    c.notContains(r.message, 'dsh plugin add', '这一格不许跟格② 的处置混');
  }
  {
    const r = judgeMount({ ...base, hasBundle: true, registered: true, treeKnown: false });
    c.eq(r.verdict, 'SKIP', '组合树判不了时，格③ 只能 SKIP（不许当通过）');
    c.contains(r.message, '没跑到', 'SKIP 要说清为什么没判');
  }
}
