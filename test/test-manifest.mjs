// 清单校验（同源件的纪律）+ 版本区间三态 + 内置兜底清单能过自己的校验
import { loadManifest, loadManifestObject, validateManifest, ManifestError } from '../scripts/lib/manifest.mjs';
import { satisfies, parseRange, describeRange } from '../scripts/lib/semver.mjs';
import { DEFAULT_MANIFEST } from '../scripts/lib/default-manifest.mjs';
import { makeManifest } from './lib/fixture-env.mjs';

export const name = '清单校验 + 版本三态 + 内置兜底清单';

function expectManifestError(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ManifestError ? e : null;
  }
}

function item(over = {}) {
  return { name: '@fake/one', versionRange: '^0.1.0', type: 'plugin', group: '固定件', probe: { kind: 'existence' }, ...over };
}

export async function run(c) {
  // ---------------------------------------------------------------- 版本三态
  {
    c.eq(satisfies('^0.4.5', '0.4.5'), 'yes', '下界命中 = yes');
    c.eq(satisfies('^0.4.5', '0.4.9'), 'yes', '^0.4.x 区间内（只改 patch）');
    c.eq(satisfies('^0.4.5', '0.5.0'), 'no', '^0.4 的上界是 0.5.0（不含）');
    c.eq(satisfies('^1.0.0', '2.0.0'), 'no', '^1 的上界是 2.0.0');
    c.eq(satisfies('^0.1.2', '0.1.1'), 'no', '比下界低 = no');
    c.eq(satisfies('~1.2.3', '1.2.9'), 'yes', '~ 只锁 patch 之前的位：1.2.x 都算');
    c.eq(satisfies('~1.2.3', '1.3.0'), 'no', '~ 的上界是 1.3.0');
    c.eq(satisfies('^0.1.0', '0.1.0-local'), 'unknown', '带预发布/本地后缀 ⇒ unknown，不许当通过');
    c.eq(satisfies('^0.1.0', 'not-a-version'), 'unknown', '解析不了 ⇒ unknown');
    c.eq(describeRange(parseRange('^0.4.5')), '>= 0.4.5 且 < 0.5.0', '人读的区间文案（FAIL 里直接用它）');
  }

  // ---------------------------------------------------------------- 清单：合法件
  {
    const r = loadManifestObject(makeManifest([item()]), '<夹具>');
    c.eq(r.items.length, 1, '合法清单读得出来');
    c.eq(r.groups, ['固定件'], 'groups 去重后给出');
  }

  // ---------------------------------------------------------------- 清单：三道强纪律
  {
    const bad = makeManifest([item({ type: 'cli', probe: { kind: 'help', cmd: 'board-snapshot-export' } })]);
    const e = expectManifestError(() => loadManifestObject(bad, '<夹具>'));
    c.ok(e !== null, 'kind=help 但没给 helpVerified ⇒ 校验必须失败');
    c.contains(e?.issues.map((i) => i.message).join(' '), 'helpVerified', '报错要指名 helpVerified（按命令核，不是按仓一刀切）');
  }
  {
    const bad = makeManifest([item({ type: 'cli', probe: { kind: 'cmd', cmd: 'rulecheck' } })]);
    const e = expectManifestError(() => loadManifestObject(bad, '<夹具>'));
    c.ok(e !== null, 'kind=cmd 但没写 readonlyBecause ⇒ 校验必须失败');
    c.contains(e?.issues.map((i) => i.message).join(' '), 'readonlyBecause', '报错要指名 readonlyBecause');
  }
  {
    const bad = makeManifest([item({ probe: { kind: 'existence', api: 'api/no-slash' } })]);
    const e = expectManifestError(() => loadManifestObject(bad, '<夹具>'));
    c.ok(e !== null, 'probe.api 不以 / 开头 ⇒ 失败');
  }
  {
    const bad = makeManifest([item({ type: 'cli', probe: { kind: 'existence', cmd: 'x', api: '/api/x' } })]);
    const e = expectManifestError(() => loadManifestObject(bad, '<夹具>'));
    c.ok(e !== null, 'probe.api 只对 plugin 类有意义 ⇒ cli 带着它要报错');
  }
  {
    const bad = makeManifest([item({ versionRange: '>=1.2.3' })]);
    const e = expectManifestError(() => loadManifestObject(bad, '<夹具>'));
    c.ok(e !== null, '>= 这类写法不接受（收敛到 ^ / ~ / 精确）');
    c.ok((e?.issues?.[0]?.line ?? 0) > 0, '清单错误要带行号');
  }
  {
    const bad = makeManifest([item({ type: 'cli', mount: 'auto', probe: { kind: 'existence', cmd: 'x' } })]);
    c.ok(expectManifestError(() => loadManifestObject(bad, '<夹具>')) !== null, 'cli 类不该带 mount=auto');
  }

  // ---------------------------------------------------------------- 磁盘上读（错误带文件名）
  {
    const e = expectManifestError(() => loadManifest('this-file-does-not-exist.json'));
    c.ok(e !== null, '读不到清单 ⇒ ManifestError');
    c.contains(e?.message ?? '', '读不到清单', '文案要人读');
  }

  // ---------------------------------------------------------------- 内置兜底清单必须过自己的校验
  {
    const r = loadManifestObject(DEFAULT_MANIFEST, '<内置兜底清单>');
    c.eq(r.items.length, DEFAULT_MANIFEST.items.length, '内置兜底清单能过校验');
    c.ok(r.items.every((i) => (i.probe?.kind ?? 'existence') === 'existence'), '内置清单的探针一律 existence（零执行）');
    const cli = r.items.filter((i) => i.type === 'cli');
    c.ok(cli.every((i) => typeof i.probe?.cmd === 'string' && i.probe.cmd), '内置清单里 cli 类都写了 probe.cmd');
  }

  // ---------------------------------------------------------------- validateManifest 是纯函数（不读盘）
  {
    const data = makeManifest([item()]);
    const r = validateManifest(data, JSON.stringify(data, null, 2));
    c.eq(r.items.length, 1, 'validateManifest 可以直接喂对象（夹具用）');
  }
}
