// 向后兼容：**不给清单时旧 10 项的输出必须不变**
//
// 两条可机械检查的判据：
//   ① 旧 10 项的 id / 名称表不许变（有人改了旧项就是破坏契约）
//   ② 旧 10 项的结果与说明**不受 --manifest 影响**（清单只驱动第 11/12/13 项）
//
// 第 3 项（DSH 主包在）是 W1 有意修好的：它在新旧版本之间**会**变（SKIP → PASS），
// 所以这里比的是"同一版脚本在不同清单参数下是否一致"，不是"与历史版本逐字一致"。
// 与历史版本的一致性另有一次性证据（交付报告里给命令原文）。
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeFixtureHome, makeManifest, makeTempDir, rmTree, SELFCHECK } from './lib/fixture-env.mjs';

export const name = '向后兼容（旧 10 项不受清单影响）';

/** 旧 10 项的名称表 —— 契约 */
const LEGACY = [
  [1, 'Node 版本'],
  [2, '状态根可写（home）'],
  [3, 'DSH 主包在'],
  [4, 'DSH 端口活着'],
  [5, '看板插件加载'],
  [6, '记忆引擎可用'],
  [7, '会话工具在'],
  [8, '状态文件就位'],
  [9, 'tickd 能跑一轮'],
  [10, '生产/夹具隔离'],
];

function runSelfcheck(args) {
  const env = { ...process.env };
  delete env.REPLICA_GUARD;
  delete env.REPLICA_FIXTURE_ROOT;
  delete env.DSH_HOME;
  delete env.OPS_CORE_HOME;
  const r = spawnSync(process.execPath, [SELFCHECK, ...args, '--json', '--no-net', '--no-npm'], { encoding: 'utf8', timeout: 120000, windowsHide: true, env });
  try {
    return JSON.parse(String(r.stdout ?? '').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 去掉每个 home 各不相同的动态痕迹（pid / 时间戳），否则两次跑必然"不一样" */
function norm(detail) {
  return String(detail ?? '').replace(/\.selfcheck-replica-\d+-\d+\.tmp/g, '.{TMP}');
}

function legacySnapshot(json, home) {
  const rows = {};
  for (const c of json?.checks ?? []) {
    if (c.id > 10) continue;
    rows[c.id] = { status: c.status, detail: norm(String(c.detail ?? '').split(home).join('<HOME>')) };
  }
  return rows;
}

export async function run(c) {
  const fx = makeFixtureHome();
  try {
    // 夹具里造一份完全无关的清单：如果旧 10 项被它影响了，就说明"清单驱动"漏进了旧项
    fx.addPackage({ name: '@fake/unrelated', version: '1.0.0', dshBundle: true, registered: true });
    const mf = fx.writeManifest(makeManifest([{ name: '@fake/unrelated', versionRange: '^1.0.0', type: 'plugin', group: '夹具', probe: { kind: 'existence' } }]));

    const without = runSelfcheck(['--home', fx.home, '--no-dump']);
    const withManifest = runSelfcheck(['--home', fx.home, '--no-dump', '--manifest', mf]);

    c.ok(without !== null && withManifest !== null, '两次都拿到完整 JSON');

    // ① 名称表是契约
    const names = (without?.checks ?? []).slice(0, 10).map((x) => [x.id, x.name]);
    c.eq(names, LEGACY, '旧 10 项的 id 与名称一字未改（顺序也没变）');

    // ② 结果与说明不受清单影响
    const a = legacySnapshot(without, fx.home);
    const b = legacySnapshot(withManifest, fx.home);
    for (const [id] of LEGACY) {
      c.eq(b[id], a[id], `第 ${id} 项：给不给 --manifest，结果与说明都一样`);
    }

    // ③ 新三项：两种"判不了"都要如实说，不许当通过
    c.eq(without?.checks?.length, 13, '总项数 = 13');
    //   (a) 不给清单 ⇒ 内置兜底 3 项；夹具 home 里那几个包一个都没装 ⇒ 明写"一个都没装"
    const m12 = (without?.checks ?? []).find((x) => x.id === 12);
    c.eq(m12?.status, 'SKIP', '内置清单里的包一个都没装 ⇒ 第 12 项 SKIP（不许当通过）');
    c.contains(m12?.detail ?? '', '一个都没装', 'SKIP 理由写清"清单里的 plugin 一个都没装"');
    c.contains(m12?.detail ?? '', '本项判的是组合，不是运行时', 'SKIP 也要带这条诚实边界');
    //   (b) 给了清单 + --no-dump ⇒ 文件层面正常，但组合树维度明写"没判"
    const m12b = (withManifest?.checks ?? []).find((x) => x.id === 12);
    c.eq(m12b?.status, 'SKIP', '--no-dump ⇒ 第 12 项 SKIP');
    c.contains(m12b?.detail ?? '', '组合树维度没判', 'SKIP 理由写清"组合树维度没判"');

    // ④ 不给 --manifest 时走的是内置兜底清单，且要在 JSON 里自证来源
    c.eq(without?.manifest?.source, 'builtin', '不给清单 ⇒ 内置兜底（JSON 里自证）');
    c.eq(withManifest?.manifest?.source, 'explicit', '给了清单 ⇒ explicit');
    c.ok((without?.manifest?.items ?? 0) > 0, '内置兜底清单不是空的');

    // ⑤ 完全没有 profile 的 home：第 12 项必须说清"没有 profile"，而不是编一个结论
    const bare = makeTempDir('butler-core-noprofile');
    try {
      const r = runSelfcheck(['--home', bare, '--no-dump']);
      const m = (r?.checks ?? []).find((x) => x.id === 12);
      c.eq(m?.status, 'SKIP', '没有 profile ⇒ 第 12 项 SKIP');
      c.contains(m?.detail ?? '', '没有 profile', 'SKIP 理由写清"没有 profile 目录"');
    } finally {
      rmTree(bare);
    }
  } finally {
    fx.cleanup();
  }
}
