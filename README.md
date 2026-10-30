# dsh-butler-core · 最小可跑运维骨架

> 本仓是命令行/库（3 个命令），其中 **`ops-tickd` 是常驻调度** —— 装完不是"跑一次就完"，要起进程并常驻；另外两个（`ops-autonomy` / `ops-changelog`）才是一次性命令。

## 装完自检（三条只读验法）

`<profile>` 换成你实际用的 profile（默认 `web`），`<数据根>` 换成你的 DSH 数据根（默认 `~/.dsh`）。

```powershell
# ① 组合树里有没有它（只读、约 0.6 秒、不启服务）
dsh --profile <profile> --dump-config | Select-String "dsh-butler-core"
# 期望：bundle 层出现一行 "# == <登记名>"、insert 层出现 "- id: <entry>"（问的都是「它挂上没」）；
#       本仓包名 @kira905/dsh-butler-core —— 带 scope 装的写带 scope 名、老工装 / 手写的可能是裸名，两种都搜一遍
#       ⚠️ 若该包会 insert 一行，还要数一遍"同一个 id 出现了几次"，必须 == 1

# ② 组合列表里有没有它（只读）
Get-Content <数据根>/profiles/<profile>/package.json | Select-String "@kira905/dsh-butler-core"
# 期望：dependencies 与 dsh.profile.bundles 两处都有（CLI 类只需要 dependencies；bundles 里也可能写裸名 dsh-butler-core）

# ③ 命令在不在 —— 【只查存在，不执行】
Test-Path <数据根>/profiles/<profile>/node_modules/.bin/ops-autonomy.CMD   # 装进 profile 的
Test-Path <npm 全局 bin 目录>/ops-autonomy.CMD                             # npm i -g 装的
# 期望：True。两条路径按你实际用的装法挑一条
# <npm 全局 bin 目录> 用 `npm prefix -g` 查（Windows 上通常是 node 安装目录旁边那个 npm 目录）
```

> 探针只做存在性检查（只看命令文件在不在，不执行任何命令）。
> 要不要用 `--help` 验，见本仓当前说明与该命令的参数表。

---

> 一个**零运行时依赖**的 Node.js 小骨架：定时调度 + 自主闸门 + 通知队列 + 日报 + 审计链。
> 它给「长期在自己机器上跑 agent」的人用——先让一个循环能跑起来、能留下可查的痕迹，再谈自动化。

**English README**: [README.en.md](./README.en.md)

---

## 0. 先说边界（很重要）

**这是一份 distilled skeleton —— 提炼重写的最小骨架，不是生产全家桶的逐字副本。**

- 代码是**独立重写**的：与任何一个"生产版大管家"里同名文件的 sha 都不同，多数没有同名源文件。
  它保留的是**同一套纪律**（原子写 / 单例锁 / 哈希链审计 / fail-safe 闸门 / 幂等判据），
  而不是同一批代码。
- 它**不依赖** DSH 主包，也不需要宿主进程：`node` 直接跑，零 `dependencies`。
- 它**只做**调度与记账，**不做**会话管理、看板、记忆、插件装载、面板 UI、跨机同步。

如果你要的是"装完就能接管一整套 DSH 生态"，那不是一个包的事，看生态里的其它组件；
如果你要的是"读得完、改得动、能嵌进自己脚本里"的最小运维环，这个包就是。

---

## 1. 给谁看

| 你 | 你会用到它做什么 |
|---|---|
| 在自有机器上跑长期 agent 的人 | 让"每天该做的事"有个调度骨架：出日报、发通知、清过期锁 |
| 想读一个不依赖框架的调度器的人 | 全套 17 个运行期 `.mjs`、一个文件一件事，没有隐式依赖 |
| 想给自己的项目加"可追责自动化"的人 | 审计链（每条带 `prev`/`hash`）+ 双闸放行，抄走即可 |

不适合：要开箱即用的运维平台、要图形界面、要跨机编排的人。

---

## 2. 三分钟跑起来

需要 Node.js **>= 20**。不需要 `npm install`（零依赖）。

### Windows（PowerShell）

```powershell
git clone <本仓地址>
cd dsh-butler-core
powershell -ExecutionPolicy Bypass -File .\examples\quickstart.ps1
```

### Linux / macOS

```sh
git clone <本仓地址>
cd dsh-butler-core
sh ./examples/quickstart.sh
```

### 或者直接一条命令

```sh
node bin/ops-tickd.mjs --once --home ./.ops-demo-home
```

> `quickstart` 默认把状态写到**当前目录下的 `.ops-demo-home`**，**不会碰你的 `~/.dsh`**。
> 想换个位置：`-StateHome <目录>`（PowerShell）或 `OPS_CORE_HOME=<目录>`（sh）。

跑完你会看到类似：

```
ops-tickd：home=.../.ops-demo-home · 档位=observe · 强制
job            状态  耗时ms  说明
queue-notify   ok    3       ok
self-heal      ok    5       ok
daily-report   ok    8       ok

产物：.../.ops-demo-home/ops-reports/2026-10-20.md
审计：.../.ops-demo-home/ops-audit

档位：observe（只观察：写日报/审计/本地 outbox，不做修复）· 自主动作：全部关闭
```

再跑一次同一条命令：日报**不会重写**（内容逐字节相同就跳过），这就是幂等判据。

---

## 3. 一轮 tick 会留下什么

| 产物 | 位置 | 一句话 |
|---|---|---|
| 日报 | `ops-reports/<日期>.md` | 档位 / 上一次 job 状态 / 状态文件健康 / 队列统计 / 告警条数 |
| 审计流水 | `ops-audit/<年-月>.jsonl` | append-only，一行一条 JSON，带 `prev` + `hash` 哈希链 |
| 通知产物 | `ops-notify-outbox.jsonl` | 默认通道 = 本地文件，一行一条"本该发出去的通知" |
| 告警 | `ops-alert.log` | 组件自身故障（不是业务告警） |
| 调度状态 | `ops-tickd.json` | 最近 50 次 tick 的读数 + 每个 job 的上次状态 |
| 自愈流水 | `ops-heal-log.jsonl` | 初始化了哪些状态文件、清了哪些过期锁 |

**想让它真的有东西可发**：往 `ops-queue.json` 里放一条
`{ "items": [{ "level": "info", "message": "hello" }] }`，下一轮就会进 `ops-notify-outbox.jsonl`，
并记进 `ops-notify-state.json` 的 `processed[]`（同一条不会发第二次）。

---

## 4. 状态文件清单（缺了会怎样）

全部状态都在一个根目录下（`--home` > `OPS_CORE_HOME` > `DSH_HOME` > `~/.dsh`）。
逐项的完整说明（谁写 / 是什么 / 备份 / 能不能出机器）见
[docs/状态文件清单.md](./docs/状态文件清单.md)。

| 文件 | 谁写 | 缺了会怎样 |
|---|---|---|
| `ops-autonomy.json` | `ops-autonomy` / `ops-tickd` | 自动建默认（`observe` + 全关）；**删了等于丢放行记录**（安全但麻烦） |
| `ops-tickd.json` | `ops-tickd` | 自动建空状态；只影响"上次跑到哪"的参考值 |
| `ops-queue.json` | **你**（唯一由使用者喂数据的文件） | 自动建空队列；没有它就没有通知可发 |
| `ops-notify-state.json` | `queue-notify` job | 自动建空去重表；**手删会重发历史通知** |
| `ops-notify-outbox.jsonl` | `queue-notify` job | 首次通知时自动创建；是产物，不是状态 |
| `ops-audit/<年-月>.jsonl` | 所有写动作 | 首次写审计时自动建；**别删**，排障与追责的唯一凭据 |
| `ops-alert.log` | 组件自身 | 首次告警时自动建；是产物 |
| `ops-reports/<日期>.md` | `daily-report` job | 下一轮自动重建当天那份 |
| `ops-locks/*.lock` | 调度器 | 首次加锁时自动建；进程崩溃会留过期锁（由自愈清理） |
| `ops-heal-log.jsonl` | `self-heal` job | 首次修复动作时自动建；是产物 |
| `ops-changelog/<年-月>.md` | `ops-changelog add` | 第一次记账时自动建 |

> 本包**不读不写**任何凭据文件（例如宿主 home 里的 `.credentials.yaml`）；
> 仓库与默认运行路径里**没有任何外发地址**。

---

## 5. 自主矩阵：谁可以自己动手

默认值是**刻意保守**的：能写产物，不能修东西。

| 项 | 默认 | 含义 |
|---|---|---|
| `mode` | `observe` | 只观察：写日报 / 审计 / 本地 outbox |
| `mode=act` | 需显式切 | 允许"实际修复动作"发生（但还受下一行管） |
| `auto.selfHeal` | `false` | 即使 `act`，也要这一项为 `true` 才清过期锁 |

也就是说，自愈的实际动手需要**双闸**：`mode=act` **且** `auto.selfHeal=true`。
判据 fail-safe：文件缺失 / 解析失败 / 字段不是 `true`，一律按"关"处理。

```sh
node bin/ops-autonomy.mjs status                       # 看档位与开关
node bin/ops-autonomy.mjs mode act --why "手动清一次过期锁"
node bin/ops-autonomy.mjs auto on selfHeal --why "同上"
node bin/ops-autonomy.mjs module off daily-report      # 关掉某个 job（改开关，不改代码）
```

每次开关写盘都带 `by` / `why`，并落一行审计。

---

## 6. 接自己的通知通道

默认通道只写本地 outbox。要发到自己的系统，**显式传入地址**（仓库内零默认地址）：

```js
import { makeQueueNotifyJob, webhookNotifier } from '@kira905/dsh-butler-core';

const job = makeQueueNotifyJob({
  home: '/path/to/home',
  notifier: webhookNotifier({ url: process.env.MY_HOOK_URL, headers: { authorization: `Bearer ${process.env.MY_HOOK_TOKEN}` } }),
});
```

`webhookNotifier` 只发一行 JSON（`source` / `level` / `message` / `at`），失败返回 `{ ok:false }`，**不抛错**；
发送失败不会标记 `processed`，下一轮自动重试（同时落一条告警）。

---

## 7. 三条工程纪律（为什么它敢动你的目录）

1. **原子写**：先写同目录临时文件 → `fsync` → `rename` 覆盖；失败重试 3 次，仍失败就保留 `.tmp` 并抛错，
   **绝不退化为直接写目标**。
2. **哈希链审计**：每条审计记录带 `prev`（上一条 hash）与自身 `hash`；任何删除/改写都会在
   `ops-tickd --state` 的链校验里暴露。
3. **单例锁 + 幂等**：每个 job 执行前用 `wx` 原子抢锁；抢不到 = 本轮跳过（不是失败）。
   日报"内容相同就不写"，通知"同一条只发一次" —— 重复跑不产生重复记账。

---

## 8. 目录结构

```
.
├── bin/
│   ├── ops-tickd.mjs        # 跑一轮 / 常驻 / 只看状态
│   ├── ops-autonomy.mjs     # 档位与开关
│   └── ops-changelog.mjs    # 一句话记账（带幂等键）
├── src/
│   ├── paths.mjs            # 路径解析单点（home / 各状态文件）
│   ├── store.mjs            # 原子写 / 读改写 / 单例锁
│   ├── audit.mjs            # 审计链唯一写入口
│   ├── alert.mjs            # 告警通道
│   ├── autonomy.mjs         # 自主矩阵（档位 / 模块 / 自动动作）
│   ├── scheduler.mjs        # 轻量调度器（无常驻进程）
│   ├── registry.mjs         # 三个 job 的装配与顺序
│   ├── state-files.mjs      # 状态文件清单的单一数据源
│   ├── notify.mjs           # 通知适配器（file / webhook）
│   ├── cli.mjs              # 极简参数解析与表格
│   ├── index.mjs            # 程序化入口
│   └── jobs/
│       ├── queue-notify.mjs # 队列 → outbox（去重）
│       ├── self-heal.mjs    # 初始化状态 / 清过期锁（双闸）
│       └── daily-report.mjs # 日报（同日幂等）
├── docs/
│   ├── 架构一页.md
│   └── 状态文件清单.md
├── examples/
│   ├── quickstart.ps1
│   └── quickstart.sh
├── scripts/
│   ├── verify-source.mjs    # 发布前自检（语法 / 绝对路径 / 私有依赖 / 文件清单）
│   ├── selfcheck-replica.mjs # 装完之后自检（13 项，见 §9）
│   └── lib/                 # 自检用的零依赖件（清单校验 / 版本区间 / 路径解析 / dump 解析 / 探针计划）
│       ├── manifest.mjs     #   清单校验（与安装器同源；每条错误带行号）
│       ├── semver.mjs       #   版本区间三态判定（yes / no / unknown）
│       ├── global-paths.mjs #   全局安装位置解析（**零 spawn**，只读盘）
│       ├── dump-parse.mjs   #   --dump-config 解析 + 挂载四格判定（纯函数）
│       ├── probe-plan.mjs   #   探针该不该跑（禁跑未核 --help）+ 整批墙钟
│       └── default-manifest.mjs # 内置兜底清单（3 项）
└── test/
    └── run-all.mjs          # 夹具总入口（假 home / 假 profile / 假包 / 假 dump，全部临时目录）
```

程序化用法：

```js
import { createOpsScheduler } from '@kira905/dsh-butler-core';

const { scheduler } = createOpsScheduler({ home: process.env.OPS_CORE_HOME });
const run = await scheduler.tickOnce({ force: true });
console.log(run.executed, run.failed);
```

---

## 9. 自检

```sh
node scripts/verify-source.mjs
```

它会检查四类事，任一不满足即 `rc != 0`：

1. 所有 `.mjs` 过 `node --check`；
2. 源码与脚本里**没有写死的绝对路径**（盘符 / 用户主目录 / 临时目录）；
3. **没有私有依赖**：`dependencies` 为空，所有 `import` 只指向 `node:` 内置或本仓相对路径；
4. `package.json` 与**文件清单一致**：`files` / `bin` / `main` / `exports` 指到的文件都存在。

### 装完之后：13 项自检

`verify-source` 管的是"这份源码能不能发"；装完之后还想知道**"这套环境装成了没有"**，跑这个：

```sh
node scripts/selfcheck-replica.mjs --home <你的状态根>
# 自动化/机读：
node scripts/selfcheck-replica.mjs --home <你的状态根> --json
# 按装机清单逐项判（推荐：清单跟安装器共用同一份）
node scripts/selfcheck-replica.mjs --home <你的状态根> --manifest <suite-manifest.json> --profile web
```

它按"装完能不能用"排了 13 项 —— 前 10 项判"这套骨架本身"，后 3 项按**清单**判"你装的那些组件"：

| # | 检查 | 判据 | 找不到时 |
|---|---|---|---|
| 1 | Node 版本 | ≥ `engines`（20） | — |
| 2 | 状态根可写 | 能建/删临时文件（真实 home 只做 W_OK 只读探测） | FAIL |
| 3 | DSH 主包在 | `--dsh-root` / **读全局 `node_modules` 的 `package.json`** / `dsh --version` / `npm ls -g` | SKIP |
| 4 | DSH 端口活着 | 任意 HTTP 响应都算活着（401 = 服务在但要凭据） | SKIP |
| 5 | 看板插件加载 | 插件 entry 存在 + API 返回 tasks 数组（无凭据时 401 也算 entry 通过） | SKIP |
| 6 | 记忆引擎可用 | `--memory-cmd` 的 `--probe` 退出码 0 | SKIP |
| 7 | 会话工具在 | `session-mark --help` 退出码 0 | SKIP |
| 8 | 状态文件就位 | 按 `docs/状态文件清单.md` 逐项判（必需件 + 坏 JSON） | FAIL |
| 9 | tickd 能跑一轮 | `--once --json` 退出码 0、job 齐、日报产出 | SKIP（真实 home 需 `--allow-production`） |
| 10 | 生产/夹具隔离 | 写闸 3 条自测 + 本次写入全在 home 内 | FAIL |
| 11 | 包在不在 / 版本对不对 | **分两路**：`plugin` 类读 profile 的 `dependencies` + 实体 `package.json` 的 `version`；`cli` 类查全局（也看 profile）。两处都没有才 FAIL | FAIL |
| 12 | 挂载生效没 | 四格：包自己的 `dsh.bundle` × profile 的 `dsh.profile.bundles` × `--dump-config` 的组合树；外加"登记了但包没声明""撞 id/同 name""抢同一个记忆位置" | FAIL |
| 13 | 关键能力能不能跑 | 每项探针由清单给：`existence`（只查存在，零执行）/ `help`（**仅限核过 `--help` 的命令**）/ `cmd`（清单指定的只读命令）；统一 8 秒超时 + 整批墙钟 30 秒 | FAIL |

**第 11/12/13 项是清单驱动的**，清单优先取 `--manifest`；不给就自动找全局装着的
`@kira905/dsh-butler-install/suite-manifest.json`（和安装器读同一份真相）；都没有才用**内置 3 项兜底**，
输出里会写明用的是哪一份。旧 10 项不读清单，行为与以前一致。

第 11 项的 `cli` 类 detail 会写清**装在哪**（全局 / profile / 都没有），因为"不知道该往哪看"正是它要回答的问题。
版本判定是三态：区间内 / 区间外 / **无法判定**（带预发布后缀的实体版本本工具不猜，一律不算通过）。

**第 12 项的两条诚实边界（结论要跟这两句一起读）**：

1. 它判的是**组合**，不是运行时 —— `--dump-config` 只证明"组合树里有这一行"，
   **不证明"运行时没崩"**。真要验"没崩"，只能人工起一次 `dsh web --no-open` 看日志。
2. `--dump-config` 抓不到**"撞 id"以外的运行时冲突** —— 两个不同 `id` 抢同一位置时 dump 里是两行、
   宿主也不报错（要等插件自己抛 "already registered"）。所以第 12 项只覆盖"同 id / 同 name"这一种，
   **别把它当万能判据**。

```sh
# 第 12 项相关的两个开关（离线核对 / 不想起子进程时用）
node scripts/selfcheck-replica.mjs --dump-config-file <一份 dump 文本>   # 零执行，只解析
node scripts/selfcheck-replica.mjs --no-dump                            # 组合树维度直接降级 SKIP
```

**退出码**：`0` = 无 FAIL（SKIP 不阻断）· `3` = 有 FAIL · `2` = 用法错 / 安全拒跑。

**只读为主**：默认唯一的写是 home 内一个临时探测文件（写完立刻删）；**真实 home 连它都不写**。
要初始化缺失的状态文件用 `--fix` —— 它只跑一遍 `self-heal`，写入全在 home 内；
对**真实 home**（`<用户主目录>/.dsh`）做写入型动作，必须再显式加 `--allow-production`。

**找不到不是失败，指定了才算断言**：没装那件就是 SKIP（带原因 + 建议）。
但只要**显式指定**了 `--dsh-root` / `--plugin-dir` / `--memory-cmd` / `--session-tool`，无效就报 FAIL
—— 静默降级会骗人。

**它自己会红的三个样例**（都是实测输出，路径用 `<…>` 隐去）：

```
# ① 缺件：home 里没有 ops-autonomy.json，且 job 注册表少了 daily-report
8   状态文件就位        FAIL  必需件缺失 1 个（ops-autonomy.json）
9   tickd 能跑一轮      FAIL  跑通了，但缺 job：daily-report（实际 queue-notify、self-heal）
结果：PASS 3 · SKIP 5 · FAIL 2  ⇒  有未通过的检查项

# ② 显式指定了坏目标（显式即断言）
3   DSH 主包在          FAIL  --dsh-root 下没有 @deepseek-ai/dsh：<dir>
4   DSH 端口活着        FAIL  http://127.0.0.1:39871：连接失败（ECONNREFUSED）
5   看板插件加载        FAIL  --plugin-dir 下没有可加载的 entry：<dir>
6   记忆引擎可用        FAIL  召回探针 rc=4：<probe 的 stderr>
结果：PASS 3 · SKIP 0 · FAIL 7  ⇒  有未通过的检查项

# ③ 写闸：对真实 home 加 --fix（不带 --allow-production）必须拒跑、零写入
[REFUSE] --fix 拒写：home = <真实 home>（判定 production，原因 HOME_IS_PRODUCTION_WITHOUT_ALLOW）
[REFUSE] 真实 home 需要显式 --allow-production；夹具 home 走 REPLICA_GUARD 执行器。零写入退出。
（退出码 2）
```

**隔离自守**：在夹具/演练环境里跑时，执行器会注入 `REPLICA_GUARD=1` + `REPLICA_FIXTURE_ROOT`；
本脚本据此断言 home 落在夹具树内，否则 `rc=2` 拒跑。直接裸跑（普通安装）时这两个变量不存在，按普通安装处理。

**改了这个仓的判据之后**：先跑夹具，再谈交付。

```sh
node test/run-all.mjs
```

166 条断言，覆盖：清单校验 / 版本三态 / 段解析与撞车口径 / 跳过归因 / 四格每一格 /
W1 的零 spawn 探测 / 旧 10 项不受清单影响 / 第 11–13 项端到端（假 home + 假包 + 假 dump）/
**变异测试**（把四格任意一条判定改反 ⇒ 夹具必须红）。夹具只用系统临时目录里的假件，
不读也不写任何真实安装。

---

## 10. 它不做什么（避免误会）

- 不提供**外发通道默认值**（企业微信 / 钉钉 / Slack 之类一概不带，只留一个显式 webhook 适配器）；
- 不提供**定时器守护**：常驻循环只有 `--interval`，进程崩了要靠系统的计划任务 / systemd 拉起；
- 不管理**宿主生命周期**（不启动、不重启、不杀任何服务）；
- 不做**跨机同步**、不做**数据迁移**；
- 不扫描、不读取、不上传你的任何文件——它只写自己那几个 `ops-*` 文件。

---

## 11. 许可

**AGPL-3.0-only + 商业授权（双许可）**，见 [LICENSE](./LICENSE)。

- 个人、学习、开源项目：按 **AGPL-3.0** 自由使用与修改（衍生作品需同样以 AGPL 开源）。
- 需要在**闭源 / 商业场景**使用（AGPL 的传染条款不适用）：可另行获取**商业授权**。
  本仓暂无公开联系邮箱，**请通过本仓 Issue 联系**。

> 说明：**AGPL / MIT / Apache 本身都不禁止商用**；这里的"双许可"含义是
> 「**要么按 AGPL 开源衍生作品，要么购买商业授权**」，与"文档侧禁商用"不是一回事。

---

<sub>本仓是「最小可跑骨架」：先把循环跑起来并留下痕迹，再往上加东西。</sub>
