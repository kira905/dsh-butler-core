# Changelog

本仓遵循语义化版本（`MAJOR.MINOR.PATCH`）。条目按版本倒序，最新在上。

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
