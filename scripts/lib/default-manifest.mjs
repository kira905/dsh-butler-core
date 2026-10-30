/**
 * 内置兜底清单 —— **只在"没给 `--manifest`、本机也找不到安装器清单"时用**。
 *
 * 真相不在这里：全量清单是 `dsh-butler-install` 仓随包发布的 `suite-manifest.json`。
 * 自检的加载顺序是：
 *   ① `--manifest <文件>`（显式指定，最高优先）
 *   ② 自动发现：全局装了 `@kira905/dsh-butler-install` 就用它的 `suite-manifest.json`
 *   ③ 都没有 ⇒ 用本文件的 3 项兜底，并在输出里明写"这是兜底清单，全量请传 --manifest"
 *
 * 所以这份不是"第二份真相"，是**骨架自检的最小可跑集**：看板插件、记忆插件、会话命令行。
 * 三者的名字与区间数值抄自 `suite-manifest.json`（2026-10-30 版本），改的时候两处同批；
 * `probe.kind` 一律用 `existence`（只查存在、零执行）—— 本仓不去猜谁实现了 `--help`。
 */

export const DEFAULT_MANIFEST_SOURCE_NOTE = '内置兜底清单（3 项）。全量清单由 @kira905/dsh-butler-install 随包提供，传入方式见 --manifest';

export const DEFAULT_MANIFEST = {
  schemaVersion: 1,
  suite: 'dsh-butler-core-selfcheck-builtin',
  description: DEFAULT_MANIFEST_SOURCE_NOTE,
  items: [
    {
      name: 'dsh-task-board-local',
      versionRange: '^1.0.0',
      type: 'plugin',
      group: '内置',
      mount: 'auto',
      aliases: ['看板'],
      probe: { kind: 'existence' },
      note: '任务看板插件。带 dsh.bundle（装进 profile 即挂载）；没有 bin，所以探针只查存在性。',
    },
    {
      name: 'dsh-memory',
      versionRange: '^0.1.0',
      type: 'plugin',
      group: '内置',
      mount: 'auto',
      aliases: ['记忆'],
      probe: { kind: 'existence' },
      note: '官方记忆插件。它与 @kira905/dsh-memory-toolkit 抢同一个位置，二选一（第 12 项会单独判这一格）。',
    },
    {
      name: '@kira905/dsh-session-toolkit',
      versionRange: '^0.1.1',
      type: 'cli',
      group: '内置',
      aliases: ['会话'],
      probe: { kind: 'existence', cmd: 'session-mark' },
      note: '会话工具命令行。CLI 类，装成全局或 profile 依赖都算装上了，不进组合列表。',
    },
  ],
  excluded: [],
};
