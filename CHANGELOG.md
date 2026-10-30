# Changelog

本仓遵循语义化版本（`MAJOR.MINOR.PATCH`）。条目按版本倒序，最新在上。

## 0.2.0 — 未发布（本地）

**装完自检从 10 项扩到 13 项，并修掉两个盲点。**

### 修

- **W1 · Windows 上主包的自动探测永远 SKIP**：旧版用 `spawnSync('dsh')` / `spawnSync('npm')`（`shell: false`），
  Windows 上这两个是 `.cmd` / `.ps1` 壳，无 shell 必 `ENOENT`（直接点 `.cmd` 会 `EINVAL`）⇒ 第 3 项永远 SKIP，
  而主包其实装着。现改为**先读盘**：按已知布局算出全局 `node_modules` 根，直接读
  `<根>/@deepseek-ai/dsh/package.json`（**零外部进程**）。判据：不给任何参数、Windows 上跑一次必须 PASS，
  且 detail 里带出版本号。
- **W2 · 只认死一个具体插件**：清单驱动（`--manifest`），每项写 包名 / 类型 / 期望版本区间 / 探针；
  清单与安装器共用同一份真相（`dsh-butler-install` 的 `suite-manifest.json`），不给清单时走内置 3 项兜底。
  **旧 10 项不读清单，输出与以前一致。**

### 新增

- **第 11 项「包在不在 / 版本对不对」**：`plugin` 类读 profile 的 `dependencies` + 实体 `package.json` 的 `version`；
  `cli` 类查全局（也看 profile）—— 分两路判，两处都没有才 FAIL。版本越界只报不修，判定是三态
  （区间内 / 区间外 / 无法判定，带预发布后缀的一律不算通过）。
- **第 12 项「挂载生效没」**：四格（包自己的 `dsh.bundle` × profile 的 `dsh.profile.bundles` × `--dump-config` 的组合树）
  + "登记了但包没声明"独立一格 + stderr 跳过归因（声明缺失 / 实体不在 / 兼容闸，三选一，不许只写兼容闸）
  + 同 `id` / 同 `name` **跨 bundle 段**计数 == 1 + 记忆位置互斥。
- **第 13 项「关键能力能不能跑」**：`existence`（只查存在、零执行）/ `help`（**仅限核过 `--help` 的命令**）/
  `cmd`（清单指定的只读命令）三种探针；统一 8 秒超时 + **整批墙钟 30 秒**（超了剩余整体降级 SKIP）。
- 新选项：`--manifest` · `--profile` · `--dump-config-file`（零执行解析离线 dump）· `--no-dump` · `--probe-batch`。
- `scripts/lib/`：`manifest` / `semver`（**与安装器同源**）、`global-paths`（零 spawn）、`dump-parse`、
  `probe-plan`、`default-manifest`。
- `src/lock.mjs`（**调度器单实例守卫**）：实例级锁 + pid 存活 + **pid 撞号方向判据**（只看「进程启动时间
  是否晚于锁 `startedAt`」，不看绝对差）+ 心跳只作证据 + 判不清时 **fail-open 判活并写审计**。
  `scheduler.ensure()` 在删锁前先核「是否已有活实例」：活 ⇒ **拒删**并返回 `already-running`；
  拿到锁**立刻写一次状态**（消掉"拿锁 → 写状态"的空窗）。
- **⑤ 失败环**：`scheduler.checkLiveness()` —— 连续 N 个周期（`livenessCycles`，默认 3）没有写出新状态
  ⇒ 告警（`source=ops-instance-liveness`）+ 审计 `instance.stalled`，同一段只喊一次；`ops-tickd --state`
  也会显示实例与活跃度。这是 fail-open 的**唯一出口**：没有它，判活就会把"双实例"换成"零实例（静默停摆）"。
- `bin/ops-tickd.mjs --interval`：启动时先 `ensure()`，已有活实例 ⇒ 拒绝启动、退出码 `3`（绝不当第二个调度器）。
- `test/`：239 条断言 + 11 处变异测试（把四格 / 单实例守卫任意一条判定改反 ⇒ 夹具必须红）；夹具全用系统
  临时目录里的假 home / 假 profile / 假包 / 假 dump，**不起真进程**（用假 instance 日志数实例）。

### 四条诚实边界（已写进 detail 与 README）

1. `--dump-config` 只证明"组合树里有这一行"，**不证明"运行时没崩"** —— 后者只能人工起一次服务看日志。
2. 它抓不到"撞 id"以外的运行时冲突（不同 `id` 抢同一位置 ⇒ dump 两行、宿主不报错）⇒ 第 12 项只覆盖
   "同 id / 同 name"这一种，**别当万能判据**。
3. **Windows 上取不到"别的进程"的启动时间**（Linux 靠 `/proc/<pid>/stat`）⇒ pid 撞号判定走 fail-open 判活。
   这是安全侧（宁可不起第二个，也不删活锁），但**必须**配失败环；想判准就注入 `startTimeOf`（见 README §7.4）。
4. **fail-open 会用"静默停摆"换"双实例"** ⇒ `checkLiveness()` 不是可选装饰。锁主真死了却判活、第二个实例
   永不启动，调度就静默停摆 —— 不跑失败环，等于把病换了一种形态。

## 0.1.1 — 2026-10-20

**装完之后的自检（replica selfcheck）。**

### 新增

- `scripts/selfcheck-replica.mjs`：10 项「装完能不能用」自检 —— Node 版本 / 状态根可写 / DSH 主包 /
  DSH 端口 / 看板插件 / 记忆引擎 / 会话工具 / 状态文件 / tickd 跑一轮 / 生产-夹具隔离。
  人类可读表 + `--json`；退出码 `0` 无 FAIL · `3` 有 FAIL · `2` 用法错或安全拒跑。
- `--fix`：只跑一遍 `self-heal` 初始化缺失的状态文件（写入只在 home 内）；真实 home 需 `--allow-production`。
- `--home` / `--dsh-root` / `--api-base` / `--plugin-dir` / `--memory-cmd` / `--session-tool` / `--tickd`
  全部可显式指定，便于在夹具里逐项验证。**显式指定即断言**：指错就报 FAIL，不静默降级。
- 隔离自守：`REPLICA_GUARD=1` + `REPLICA_FIXTURE_ROOT` 时断言 home 在夹具树内，否则 `rc=2` 拒跑。

### 说明

- 找不到某件 = SKIP + 原因（不是 FAIL）；对真实 home 默认零写入（#2 用 W_OK 只读探测）。
- README §9 增「装完之后：10 项自检」+ 三个实测失败样例。
- 零运行时依赖不变；`verify-source` 四类全过。

## 0.1.0 — 2026-10-20

**最小可跑骨架首版（distilled skeleton first release）。**

### 新增

- `bin/ops-tickd`：跑一轮（`--once`，默认）/ 常驻（`--interval <秒>`）/ 只读体检（`--state`）；
  `--only` 挑 job、`--no-force` 只跑到期的、`--json` 只输出 JSON（日志走 stderr）。
- `bin/ops-autonomy`：查看档位与开关；`mode` / `module` / `job` / `auto` 四类写动作，均带 `by` / `why` 并落审计。
- `bin/ops-changelog`：一句话记账（`add --text`，默认按文本哈希去重），`tail` 查看。
- `src/scheduler.mjs`：轻量调度器——每个 job 独立隔离、执行前抢单例锁、单轮超时、状态落 `ops-tickd.json`（保留最近 50 次）。
- `src/autonomy.mjs`：自主矩阵——`observe` / `report` / `act` 三档 + `auto.*` 逐项开关，
  实际修复需**双闸**（`mode=act` 且 `auto.selfHeal=true`），fail-safe 一律按"关"处理。
- `src/store.mjs`：原子写（临时文件 → fsync → rename，失败重试且不退化）、读-改-写唯一入口、`wx` 单例锁。
- `src/audit.mjs`：append-only 审计流水 + `prev`/`hash` 哈希链，附链校验。
- `src/notify.mjs`：通知适配器——默认写本地 outbox；可选 `webhookNotifier` 由调用方显式传 URL（仓内零默认地址）。
- `src/jobs/`：`queue-notify`（去重发送）、`self-heal`（初始化状态 / 清过期锁）、`daily-report`（同日幂等）。
- `src/state-files.mjs`：状态文件清单的单一数据源（日报健康检查 / CLI / 文档共用）。
- `scripts/verify-source.mjs`：自检四类（语法 / 绝对路径 / 私有依赖 / 文件清单一致）。
- `examples/quickstart.ps1` · `examples/quickstart.sh`：一条命令跑一轮 `--once`，并把产物路径打出来。
- `docs/架构一页.md` · `docs/状态文件清单.md`：三层结构与逐文件处置。

### 说明

- **本版是提炼重写的最小骨架**：与任何"生产版大管家"的同名文件 sha 不同，多数没有同名源文件；
  保留的是纪律，不是代码。
- 零运行时依赖；不需要宿主进程；只写自己那几个 `ops-*` 文件。
- 不含：外发通道默认值、面板 UI、会话/看板/记忆管理、跨机同步、宿主生命周期管理。
