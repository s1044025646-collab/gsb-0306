# buddy-sim：Buddy 内存块分配与相邻伙伴合并回放模拟器

教学用 Buddy 内存分配模拟器后端（TypeScript + Node.js + SQLite），仅提供 HTTP API 与 CLI，无图形界面。

## 算法范围与寻址单位（重要）

- **只模拟地址与分配元数据**：不分配真实内存、不扫描本机内存、不涉及页置换、磁盘交换文件或操作系统驱动。
- **寻址单位**：字节。所有偏移与长度都是精确整数（`Number.isSafeInteger` 校验），区域从偏移 `0` 开始。
- **阶（order）约定**：块大小 = `2^order` 字节；区域大小必须是 `2^maxOrder`（上限 `2^30`）；可选 `minOrder` 限制最小块。
- **伙伴判定**：大小为 `size`、偏移为 `offset` 的块，其伙伴偏移 = `offset XOR size`。只有同阶且互为伙伴的空闲块才能合并——任意相邻的同大小块**不**一定是伙伴。
- **选择规则**：申请字节数先向上取整到 2 的幂（且不小于 `2^minOrder`）；从满足请求的最小可用阶取块，同阶多个候选取偏移最小者；拆分时低地址半块继续用于本次申请，高地址半块放回空闲表。
- **合并规则**：释放后若同阶伙伴空闲则合并，并递归向上，直到伙伴不可用或到达整片区域。
- **失败语义**：空闲总量足够但缺少足够大的连续块时申请失败，报告 `maxFreeBlock` 与原因；不搬移已有分配（无紧凑化）；失败操作通过 SQLite 事务回滚，不改变空闲表与分配编号。

## 环境要求

- Windows 本地运行，Node.js >= 22.5（使用内置 `node:sqlite`，无需原生编译依赖）。
- 不依赖 Docker、WSL、付费服务或任何外部在线 API。

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm run demo       # 运行演示（16 字节区域、改变释放顺序、模拟重启）
npm start          # 启动 HTTP API（默认自动选择空闲端口）
```

数据目录默认为项目内 `./data/buddy.sqlite`，可用 `--db=路径` 覆盖。服务重启后继续使用相同区域；多个区域的编号与地址空间各自独立。

## HTTP API

启动：`node dist/src/server.js [--port=8080] [--db=路径]`（默认端口 0 = 自动选空闲端口，也可用环境变量 `PORT`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/regions` `{size, minOrder?}` | 创建区域（size 须为 2 的幂） |
| GET | `/regions` | 列出区域 |
| GET | `/regions/:id/state` | 当前块清单、空闲总量、最大空闲块 |
| POST | `/regions/:id/alloc` `{requestId, bytes}` | 申请，返回偏移、实际占用、内部碎片与拆分步骤 |
| POST | `/regions/:id/free` `{requestId}` | 释放，返回合并步骤 |
| GET | `/regions/:id/lookup?offset=N` | 查询偏移属于哪项分配或哪块空闲区 |
| GET | `/regions/:id/verify` | 独立不变量核验 |
| GET | `/regions/:id/events` | 事件历史（含不可变前后状态快照） |
| GET | `/regions/:id/replay?to=SEQ` | 逐步回放（读取历史快照，不受后续释放影响） |
| GET | `/regions/:id/export` | 导出完整 JSON |

错误响应统一为 `{ "error": { "code", "message", "detail" } }`，错误码：`INVALID_PARAM`(400)、`ALLOC_NOT_FOUND`(404)、`DUPLICATE_REQUEST`(409)、`OUT_OF_MEMORY`(409)、`LIMIT_EXCEEDED`、`INTERNAL`(500)。

## CLI

```powershell
node dist/src/cli.js create --size=1024 [--min-order=0]
node dist/src/cli.js alloc --region=1 --id=req1 --bytes=100
node dist/src/cli.js free --region=1 --id=req1
node dist/src/cli.js state --region=1        # 区间表展示占用与空闲
node dist/src/cli.js lookup --region=1 --offset=64
node dist/src/cli.js verify --region=1
node dist/src/cli.js history --region=1
node dist/src/cli.js replay --region=1 [--to=3]
node dist/src/cli.js export --region=1 [--out=export.json]
node dist/src/cli.js serve [--port=0]
```

所有命令支持 `--db=路径` 指定数据库文件。

## 不变量核验

`verify` 从当前块清单**重新计算**，不信任操作返回值：

- 所有块互不重叠且完整覆盖 `[0, size)`；
- 每个块偏移按自身块大小对齐、大小为 2 的幂、不小于 `2^minOrder`；
- 不存在仍可合并的空闲伙伴对。

空分配表下，全部内存最终恢复为一个最大块（`[{offset:0, size:区域大小}]`）。

## 测试覆盖

- 相邻但非伙伴的块不合并；跨多阶递归合并；全满失败；内部碎片计算；最大空闲块不足的失败；
- 小区域逐字节独立占用图核对覆盖与不重叠；
- 多组固定操作序列每步核验不变量；
- 失败申请前后状态完全一致（含数据库事件数不变）；
- 事件快照不可被后续释放改写；重启后从 SQLite 恢复并继续释放；HTTP API 端到端。

## 已知限制

- 单进程写 SQLite（`BEGIN IMMEDIATE` 事务），未做多进程并发控制；
- 区域上限 `2^30` 字节、单区域分配数上限 100 万（防滥用）；
- `node:sqlite` 在 Node 25 仍标记为实验特性（会有启动警告），API 未来可能微调；
- 仅监听 `127.0.0.1`，无认证，仅供本地教学使用。
