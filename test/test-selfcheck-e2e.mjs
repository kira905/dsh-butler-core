// 端到端：真的跑一遍 scripts/selfcheck-replica.mjs，只看第 11/12/13 三项
//
// 每个场景都用**夹具自己的临时 home + 假包 + 假 dump**，不读也不写任何真实安装。
// 这里判的是"这三项会不会说出正确的话"，不是"整套环境装没装好"。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixtureHome, makeManifest, dumpText, addSlowCommand, addNoHelpCommand, SELFCHECK } from './lib/fixture-env.mjs';

export const name = '第 11/12/13 项端到端（假 profile / 假包 / 假 dump）';

function runSelfcheck(args, env = {}) {
  const cleanEnv = { ...process.env };
  // 夹具环境里不能带上"夹具守卫"（那是生产隔离用的），也清掉可能串进来的 DSH home
  delete cleanEnv.REPLICA_GUARD;
  delete cleanEnv.REPLICA_FIXTURE_ROOT;
  delete cleanEnv.DSH_HOME;
  delete cleanEnv.OPS_CORE_HOME;
  const r = spawnSync(process.execPath, [SELFCHECK, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...cleanEnv, ...env },
  });
  let parsed = null;
  try {
    parsed = JSON.parse(String(r.stdout ?? '').replace(/^\uFEFF/, ''));
  } catch {
    parsed = null;
  }
  return { rc: r.status, raw: `${r.stdout ?? ''}${r.stderr ?? ''}`, json: parsed };
}

function checkOf(json, id) {
  return (json?.checks ?? []).find((x) => x.id === id) ?? null;
}

const PLUGIN = (name, versionRange = '^1.0.0', extra = {}) => ({
  name,
  versionRange,
  type: 'plugin',
  group: '夹具',
  mount: 'auto',
  probe: { kind: 'existence' },
  ...extra,
});

export async function run(c) {
  // ================================================================ 场景 A：四格 + 四格之外那一格
  {
    const fx = makeFixtureHome();
    try {
      fx.addPackage({ name: '@fake/all-three', version: '1.2.3', dshBundle: true, registered: true });
      fx.addPackage({ name: '@fake/not-registered', version: '0.9.0', dshBundle: true, registered: false });
      fx.addPackage({ name: '@fake/not-in-tree', version: '2.0.0', dshBundle: true, registered: true });
      fx.addPackage({ name: '@fake/cli-class', version: '1.1.0', dshBundle: false, registered: false });
      fx.addPackage({ name: '@fake/registered-no-bundle', version: '1.0.0', dshBundle: false, registered: true });

      const dumpFile = fx.writeDump(
        dumpText([{ head: '@fake/all-three', ids: ['all-three'], names: ['@fake/all-three'] }], {
          skipLines: [
            'dsh: skipping profile bundle "@fake/not-in-tree": Error: dsh: cannot resolve profile bundle "@fake/not-in-tree" from the dsh installation',
          ],
        }),
      );
      const mf = fx.writeManifest(
        makeManifest([
          PLUGIN('@fake/all-three', '^1.0.0'),
          PLUGIN('@fake/not-registered', '^1.0.0'),
          PLUGIN('@fake/not-in-tree', '^2.0.0'),
          PLUGIN('@fake/cli-class', '^1.0.0'),
          PLUGIN('@fake/registered-no-bundle', '^1.0.0'),
        ]),
      );

      const r = runSelfcheck(['--home', fx.home, '--no-net', '--no-npm', '--manifest', mf, '--dump-config-file', dumpFile, '--profile', fx.profileName]);
      const m11 = checkOf(r.json, 11);
      const m12 = checkOf(r.json, 12);
      const m13 = checkOf(r.json, 13);
      c.ok(m11 && m12 && m13, '三项都在（第 11/12/13 项）');
      if (!m11 || !m12 || !m13) return;

      // 第 11 项：只有版本越界那一项不过（not-registered 装的是 0.9.0，清单要 ^1.0.0）
      c.eq(m11.status, 'FAIL', '第 11 项：版本越界 ⇒ FAIL');
      c.contains(m11.detail, '@fake/not-registered', '第 11 项点名哪个包不对');
      c.contains(m11.detail, '期望', '第 11 项写出期望区间');
      c.contains(m11.detail, '0.9.0', '第 11 项写出实体版本');
      c.contains(m11.detail, 'profile', '第 11 项写清"装在哪"');

      // 第 12 项：三个格子各说各话
      c.eq(m12.status, 'FAIL', '第 12 项：格② 格③ 与"登记了但没声明"都在 ⇒ FAIL');
      c.contains(m12.detail, 'dsh plugin add @fake/not-registered', '格②（有声明没登记）的修复动作是补 add');
      c.contains(m12.detail, '@fake/not-in-tree', '格③（声明了但树里没有）要被点名');
      c.contains(m12.detail, '② 实体不在', '格③ 归因落在"实体不在"（stderr 那行说的就是它）');
      c.contains(m12.detail, '@fake/registered-no-bundle', '四格之外那一格（登记了但包没声明）要被点名');
      c.contains(m12.detail, '摘掉这条登记', '这一格的处置是"装回去或摘登记"，不是补 add');
      c.notContains(m12.detail, '@fake/cli-class', '格④（CLI 类）是正确状态，不许被算成问题');
      c.contains(m12.detail, '本项判的是组合，不是运行时', '第 12 项必须带着这条诚实边界');

      // 第 13 项：走 existence，零执行 ⇒ 全过
      c.eq(m13.status, 'PASS', '第 13 项：existence 探针全过（只看文件在不在）');
      c.contains(m13.detail, '只读', '第 13 项 detail 要写明"只读"');
      c.contains(m13.detail, '上限', '第 13 项 detail 要写出整批墙钟上限');

      // JSON 里要能拿到清单来源与 dump 概况（给复核者留证据）
      c.eq(r.json?.manifest?.source, 'explicit', 'JSON 标出清单来源 = --manifest');
      c.eq(r.json?.manifest?.items, 5, 'JSON 标出清单项数');
      c.ok(Array.isArray(r.json?.dump?.bundleSegments) && r.json.dump.bundleSegments.length === 1, 'JSON 标出 dump 里几个 bundle 段');
      c.eq(r.json?.dump?.skippedBundles?.[0]?.kind, 'missing-entity', 'JSON 里能查到跳过归因');
    } finally {
      fx.cleanup();
    }
  }

  // ================================================================ 场景 B：撞 id（两个 bundle 各插一个 memory）
  {
    const fx = makeFixtureHome();
    try {
      fx.addPackage({ name: '@fake/mem-a', version: '1.0.0', dshBundle: true, registered: true });
      fx.addPackage({ name: '@fake/mem-b', version: '1.0.0', dshBundle: true, registered: true });
      const dumpFile = fx.writeDump(
        dumpText([
          { head: '@fake/mem-a', ids: ['memory'], names: ['@fake/mem-impl'] },
          { head: '@fake/mem-b', ids: ['memory'], names: ['@fake/mem-impl'] },
        ]),
      );
      const mf = fx.writeManifest(makeManifest([PLUGIN('@fake/mem-a'), PLUGIN('@fake/mem-b')]));
      const r = runSelfcheck(['--home', fx.home, '--no-net', '--no-npm', '--manifest', mf, '--dump-config-file', dumpFile, '--profile', fx.profileName]);
      const m12 = checkOf(r.json, 12);
      c.eq(m12?.status, 'FAIL', '撞 id ⇒ 第 12 项 FAIL（只"出现过"判不出来）');
      c.contains(m12?.detail ?? '', '撞 id', 'detail 要点明是撞 id');
      c.contains(m12?.detail ?? '', 'memory', 'detail 要给出撞的那个 id');
      c.contains(m12?.detail ?? '', 'mem-a', 'detail 要附上两处段头（好定位）');
    } finally {
      fx.cleanup();
    }
  }

  // ================================================================ 场景 C：位置互斥（抢同一个记忆位置）
  {
    const fx = makeFixtureHome();
    try {
      fx.addPackage({ name: 'dsh-memory', version: '0.1.0', dshBundle: true, registered: true });
      fx.addPackage({ name: '@kira905/dsh-memory-toolkit', version: '0.1.2', dshBundle: true, registered: true });
      const dumpFile = fx.writeDump(
        dumpText([
          { head: 'dsh-memory', ids: ['memory'], names: ['dsh-memory'] },
          { head: '@kira905/dsh-memory-toolkit', ids: ['memory-local'], names: ['@kira905/dsh-memory-local'] },
        ]),
      );
      const mf = fx.writeManifest(makeManifest([PLUGIN('dsh-memory', '^0.1.0'), PLUGIN('@kira905/dsh-memory-toolkit', '^0.1.2')]));
      const r = runSelfcheck(['--home', fx.home, '--no-net', '--no-npm', '--manifest', mf, '--dump-config-file', dumpFile, '--profile', fx.profileName]);
      const m12 = checkOf(r.json, 12);
      c.eq(m12?.status, 'FAIL', '两套记忆实现同时登记 ⇒ 第 12 项 FAIL');
      c.contains(m12?.detail ?? '', '抢同一个记忆位置', 'detail 说清是抢位置，不是撞 id');
    } finally {
      fx.cleanup();
    }
  }

  // ================================================================ 场景 D：探针红线 + 超时 + 整批墙钟
  {
    const fx = makeFixtureHome();
    try {
      const marker = path.join(fx.root, 'nohelp-ran.marker');
      addNoHelpCommand(fx, { name: '@fake/nohelp-cli', cmd: 'fake-nohelp', marker });
      addSlowCommand(fx, { name: '@fake/slow-cli', cmd: 'fake-slow', sleepMs: 6000 });
      // 这两个包要"装上了"才算，但它们是 cli 类（没有 dsh.bundle）
      fx.addPackage({ name: '@fake/nohelp-cli', version: '1.0.0', dshBundle: false, registered: false, bin: { 'fake-nohelp': 'real-action.mjs' } });
      fx.addPackage({ name: '@fake/slow-cli', version: '1.0.0', dshBundle: false, registered: false, bin: { 'fake-slow': 'slow.mjs' } });

      // D-1：清单标了 help 但没给 helpVerified ⇒ 清单校验就该挡住，命令**一行都不能跑**
      const badManifest = fx.writeManifest(
        makeManifest([
          { name: '@fake/nohelp-cli', versionRange: '^1.0.0', type: 'cli', group: '夹具', probe: { kind: 'help', cmd: 'fake-nohelp' } },
        ]),
      );
      const rBad = runSelfcheck(['--home', fx.home, '--no-net', '--no-npm', '--manifest', badManifest, '--no-dump', '--profile', fx.profileName]);
      const m13bad = checkOf(rBad.json, 13);
      c.eq(m13bad?.status, 'SKIP', '清单不合格 ⇒ 第 13 项 SKIP（不许当成通过）');
      c.contains(m13bad?.detail ?? '', 'helpVerified', 'SKIP 理由要指名 helpVerified');
      c.eq(fs.existsSync(marker), false, '🔴 没核过 --help 的命令**一次都没被执行**（标记文件不存在）');

      // D-2：慢探针 + 单项超时 ⇒ SKIP 且明写"超时不算通过"
      const okManifest = fx.writeManifest(
        makeManifest([
          { name: '@fake/slow-cli', versionRange: '^1.0.0', type: 'cli', group: '夹具', probe: { kind: 'cmd', cmd: 'fake-slow', readonlyBecause: '夹具：只是睡一会儿', args: ['--probe-only'] } },
        ]),
      );
      const rSlow = runSelfcheck(['--home', fx.home, '--no-net', '--no-npm', '--manifest', okManifest, '--no-dump', '--profile', fx.profileName, '--timeout', '500']);
      const m13slow = checkOf(rSlow.json, 13);
      c.eq(m13slow?.status, 'SKIP', '探针超时 ⇒ SKIP（不是 FAIL，也绝不是 PASS）');
      c.contains(m13slow?.detail ?? '', '超时不算通过', 'detail 要明写"超时不算通过"');

      // D-3：整批墙钟上限 —— 把上限压到 300ms，第 2 项起整体降级
      const threeManifest = fx.writeManifest(
        makeManifest([
          { name: '@fake/slow-cli', versionRange: '^1.0.0', type: 'cli', group: '夹具', probe: { kind: 'cmd', cmd: 'fake-slow', readonlyBecause: '夹具', args: ['--a'] } },
          { name: '@fake/slow2-cli', versionRange: '^1.0.0', type: 'cli', group: '夹具', probe: { kind: 'cmd', cmd: 'fake-slow', readonlyBecause: '夹具', args: ['--b'] } },
          { name: '@fake/slow3-cli', versionRange: '^1.0.0', type: 'cli', group: '夹具', probe: { kind: 'cmd', cmd: 'fake-slow', readonlyBecause: '夹具', args: ['--c'] } },
        ]),
      );
      // 需要三个包都在，否则会被"包没装 ⇒ SKIP"提前吃掉
      fx.addPackage({ name: '@fake/slow2-cli', version: '1.0.0', dshBundle: false, registered: false, bin: { 'fake-slow': 'slow.mjs' } });
      fx.addPackage({ name: '@fake/slow3-cli', version: '1.0.0', dshBundle: false, registered: false, bin: { 'fake-slow': 'slow.mjs' } });
      const rBatch = runSelfcheck(['--home', fx.home, '--no-net', '--no-npm', '--manifest', threeManifest, '--no-dump', '--profile', fx.profileName, '--timeout', '250', '--probe-batch', '200']);
      const m13batch = checkOf(rBatch.json, 13);
      c.eq(m13batch?.status, 'SKIP', '整批墙钟超了 ⇒ 剩余探针降级 SKIP 汇总一行');
      c.contains(m13batch?.detail ?? '', '整批墙钟', 'detail 要说清是整批墙钟超了');
      c.contains(m13batch?.detail ?? '', '不是通过', '降级要明写"不是通过"');
    } finally {
      fx.cleanup();
    }
  }

  // ================================================================ 场景 E：清单不存在 / 不合法的用法错
  {
    const fx = makeFixtureHome();
    try {
      const r = runSelfcheck(['--home', fx.home, '--no-net', '--no-npm', '--manifest', path.join(fx.root, 'nope.json'), '--no-dump']);
      c.ok(r.json !== null, '清单读不到也要给出完整 JSON（不许崩）');
      c.eq(checkOf(r.json, 11)?.status, 'SKIP', '清单不可用 ⇒ 第 11 项 SKIP');
      c.contains(checkOf(r.json, 11)?.detail ?? '', '读不到清单', 'detail 说清读不到哪份清单');
    } finally {
      fx.cleanup();
    }
  }
}
