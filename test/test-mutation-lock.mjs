// 变异测试：**把单实例守卫的判定改反 ⇒ 上面的夹具必须红**
//
// 做法与 test-mutation.mjs 同源（定点文本变异 → 同批断言必须抓得到），差别只在落点：
//   · test-mutation.mjs 变异的是 scripts/lib/dump-parse.mjs（零相对依赖，可整份复制到临时目录）
//   · 这里变异的是 src/lock.mjs —— 它有相对依赖（./audit.mjs / ./paths.mjs / ./store.mjs），
//     所以变异体必须**写回 src/ 目录**（临时文件名 `.mutant-lock-<n>.mjs`），跑完删干净。
//
// 判据：每条变异至少要有一条断言红；一条都没红 ⇒ 说明那一格其实没被夹具锁住，这份夹具不合格。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeChecker } from './lib/harness.mjs';

export const name = '变异测试（单实例判据改反必须被抓到）';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SRC = path.join(SRC_DIR, 'lock.mjs');

const NOW = 1_700_000_000_000;
const TTL = 120_000;
const TOL = 120_000;
const lockOf = (pid) => ({ exists: true, raw: '', lock: { pid, at: new Date(NOW - 300_000).toISOString(), ttlMs: TTL }, lockMtimeMs: NOW - 300_000 });

/** 跑"单实例判定"这一批断言（每一格都对应一条真事故形态）。 */
function judgeBatch(mod) {
  const ck = makeChecker();
  const base = { now: NOW, ttlMs: TTL, startTimeToleranceMs: TOL };

  // ① 活锁：pid 活着、启动时间比锁早（跑了 1 小时）、TTL 早过期 ⇒ 必须是 alive
  const alive = mod.judgeLock({
    view: lockOf(4242), ...base, isAliveOf: () => true, startTimeOf: () => NOW - 3_600_000,
  });
  ck.eq(alive.state, 'alive', '活锁（pid 活着 + TTL 过期）⇒ alive（不是可回收）');

  // ② 撞号：pid 活着但启动时间比锁晚 5 分钟 ⇒ 可能是复用 ⇒ 可回收
  const reused = mod.judgeLock({
    view: lockOf(4242), ...base, isAliveOf: () => true, startTimeOf: () => NOW - 1_000,
  });
  ck.eq(reused.state, 'reclaimable', 'pid 撞号（启动晚于锁）⇒ 可回收');
  ck.eq(reused.reason, 'pid-reused', 'reason = pid-reused');

  // ③ 反向：**绝对差一样大**，只是方向相反 ⇒ 结论必须相反（方向判据 vs 绝对差判据的分水岭）
  const reverse = mod.judgeLock({
    view: lockOf(4242), ...base, isAliveOf: () => true, startTimeOf: () => NOW - 599_000,
  });
  ck.eq(reverse.state, 'alive', '方向相反（启动早于锁）⇒ alive（同进程）');
  ck.eq(
    Math.abs(reused.evidence.deltaMs), Math.abs(reverse.evidence.deltaMs),
    '两侧差值的绝对值一样大（只有方向不同）—— 所以只有方向判据能分开它们',
  );

  // ④ fail-open：取不到启动时间 ⇒ alive + failOpen
  const noClock = mod.judgeLock({
    view: lockOf(4242), ...base, isAliveOf: () => true, startTimeOf: () => null,
  });
  ck.eq(noClock.state, 'alive', '取不到启动时间 ⇒ fail-open 判 alive');
  ck.eq(noClock.failOpen, true, '并且明写 failOpen=true');

  // ⑤ pid 已死 ⇒ 孤儿可回收（这条不许被 fail-open 吞掉）
  const dead = mod.judgeLock({ view: lockOf(4242), ...base, isAliveOf: () => false });
  ck.eq(dead.state, 'reclaimable', 'pid 已死 ⇒ 可回收');
  ck.eq(dead.reason, 'pid-dead', 'reason = pid-dead');

  // ⑥ 失败环：错过 2 个周期 / 阈值 3 ⇒ 不告警；阈值 2 ⇒ 告警
  const lv2 = mod.computeLiveness({ lastStateWriteAt: NOW - 120_000, now: NOW, intervalMs: 60_000, cycles: 3 });
  ck.eq(lv2.stalled, false, '错过 2 个周期 / 阈值 3 ⇒ 不告警');
  const lv3 = mod.computeLiveness({ lastStateWriteAt: NOW - 120_000, now: NOW, intervalMs: 60_000, cycles: 2 });
  ck.eq(lv3.stalled, true, '错过 2 个周期 / 阈值 2 ⇒ 告警');

  return ck;
}

/** 变异表：每条 = "把某条判据改反/放松"，以及它对应哪条断言。 */
const MUTANTS = [
  {
    label: 'fail-open 改 fail-closed（取不到时钟就判可回收）',
    edits: [["      state: 'alive', reason: 'no-start-time',", "      state: 'reclaimable', reason: 'no-start-time',"]],
    caughtBy: '④ fail-open 那条',
  },
  {
    label: '方向判据改绝对差（|delta| > 容差 ⇒ 撞号）',
    edits: [['  if (deltaMs > tolerance) {', '  if (Math.abs(deltaMs) > tolerance) {']],
    caughtBy: '③ 反向那条',
  },
  {
    label: '活锁被判死（pid 活着但 TTL 过期就算死）',
    edits: [['  if (alive.alive === false) {', '  if (alive.alive === false || now - startedAt > ttlMs) {']],
    caughtBy: '① 活锁那条',
  },
  {
    label: '孤儿检测失效（pid 死了也判活）',
    edits: [["      state: 'reclaimable', reason: 'pid-dead',", "      state: 'alive', reason: 'pid-dead',"]],
    caughtBy: '⑤ pid 已死那条',
  },
];

export async function run(c) {
  const srcText = fs.readFileSync(SRC, 'utf8');

  // 先证明原版能过这一批断言（否则后面"变异被抓到"可能是别的错造成的假象）
  const original = await import(`${pathToFileURL(SRC).href}?v=lock-original`);
  const orig = judgeBatch(original);
  c.eq(
    orig.state.fail, 0,
    `原版 lock.mjs 能过单实例那批断言（${orig.state.pass} 条通过）${orig.state.failures.length ? '；红的是：' + orig.state.failures.join(' | ') : ''}`,
  );

  const written = [];
  try {
    let index = 0;
    for (const mutant of MUTANTS) {
      index += 1;
      let text = srcText;
      let broken = false;
      for (const [from, to] of mutant.edits) {
        if (!text.includes(from)) {
          c.ok(false, `变异"${mutant.label}"的锚点在源码里找不到 —— 源码改了但变异表没跟上（夹具自身失修）`);
          broken = true;
          break;
        }
        text = text.split(from).join(to);
      }
      if (broken) continue;
      if (text === srcText) {
        c.ok(false, `变异"${mutant.label}"没改到任何字符（等于没变异）`);
        continue;
      }
      const file = path.join(SRC_DIR, `.mutant-lock-${index}.mjs`);
      fs.writeFileSync(file, text, 'utf8');
      written.push(file);
      const mod = await import(`${pathToFileURL(file).href}?v=mutant-${index}`);
      const ck = judgeBatch(mod);
      c.ok(ck.state.fail > 0, `变异"${mutant.label}"被抓到了（红了 ${ck.state.fail} 条，落在${mutant.caughtBy}）`);
      process.stdout.write(`  [变异 ${index}] ${mutant.label} → 红 ${ck.state.fail} 条 / 共 ${ck.state.pass + ck.state.fail} 条（${mutant.caughtBy}）\n`);
      if (ck.state.failures.length) {
        for (const f of ck.state.failures.slice(0, 2)) process.stdout.write(`      ✖ ${f}\n`);
      }
    }
  } finally {
    for (const file of written) {
      try { fs.rmSync(file, { force: true }); } catch { /* 收尾失败不算断言失败 */ }
    }
  }
}

// 直接跑本文件时自检并打印（验收贴输出用）
const isMain = (() => {
  const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!argv1) return false;
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  return real(argv1) === real(fileURLToPath(import.meta.url));
})();

if (isMain) {
  const c = makeChecker();
  await run(c);
  process.stdout.write(`\n${c.state.fail === 0 ? 'PASS' : 'FAIL'}  ${name}  ${c.state.pass}/${c.state.pass + c.state.fail}\n`);
  for (const f of c.state.failures) process.stdout.write(`  ✖ ${f}\n`);
  process.exitCode = c.state.fail ? 1 : 0;
}
