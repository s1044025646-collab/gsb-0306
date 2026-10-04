# Buddy 内存分配模拟器（教学用后端）

用 TypeScript + Node.js + SQLite 实现的 Buddy（伙伴）内存块分配模拟器，仅提供 HTTP API 与 CLI，无前端、无 Docker、无外部在线依赖。

## 算法范围与寻址单位

- **寻址单位**：字节。所有偏移与长度都是精确整数（Number 安全整数范围内）。
- **模拟范围**：只模拟地址空间与分配元数据。**不分配真实内存、不扫描本机内存、不实现页置换、磁盘交换或操作系统驱动**。
- 管理一块从偏移 0 开始、大小为 2 的整数次幂的连续区域（最大 2^30 字节，即阶数上限 30）。
- 单区域分配数量上限 100000，防止滥用。

## 阶数约定与选择规则

- **阶（order）**：块大小 = 2^order 字节。区域大小 2^maxOrder。
- **申请**：请求字节数先向上取整到 2 的幂；从满足请求的最小可用阶开始找空闲块；同阶多个候选取**偏移最小**者。
- **拆分**：每次对半拆分，**低地址半块**继续用于本次申请，高地址半块放回对应阶的空闲表。
- **合并**：释放后仅当**同阶伙伴**空闲时合并。伙伴偏移 = `offset XOR 块大小`（由块大小与地址对齐关系唯一确定），相邻但非伙伴的同大小块**不会**被合并。合并递归向上，直到伙伴不可合并或到达整片区域。
- **内部碎片**：返回 `实际占用 - 请求字节数`。
- **失败语义**：空闲总量足够但缺少足够大的连续块时申请失败，报告最大空闲块；不搬移已有分配（无紧凑化）。失败申请不改变空闲表，也不占用请求编号。

## 不变量核验

`verify` 从当前块清单**重新计算**（不信任操作返回值）：

- 所有块互不重叠，完整覆盖 `[0, totalSize)`；
- 偏移按块大小对齐，块大小为 2 的幂；
- 不存在仍可合并的空闲伙伴对；
- 空分配表下全部内存恢复为一个最大块。

## 持久化与历史

- SQLite（Node 内置 `node:sqlite`，WAL 模式）原子保存块清单、分配记录与事件：每次成功操作在一个事务里写入新状态 + 追加事件。
- 每个事件保存**操作前后完整快照与拆分/合并步骤**，历史快照不会被后续释放改写，支持逐步回放（`replay?to=N`）。
- 服务重启后从数据库恢复，可继续释放；多个区域的编号与地址空间各自独立。

## 运行要求

- Windows 本地，Node.js >= 22.5（使用内置 `node:sqlite`，无需原生编译）。

## 命令

```powershell
npm install        # 安装 devDependencies（typescript、@types/node）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API 服务（默认自动选择空闲端口；PORT=8080 可指定）
npm run demo       # 运行演示（16B 区域，两种释放顺序 + 重启续放）
```

数据目录默认为项目内 `./data`，可用环境变量 `BUDDY_DATA_DIR` 覆盖。

## CLI

```powershell
node dist/src/cli.js create <sizeBytes> [name]    # 创建区域
node dist/src/cli.js list                         # 列出区域
node dist/src/cli.js alloc <region> <reqId> <n>   # 申请
node dist/src/cli.js free <region> <reqId>        # 释放
node dist/src/cli.js status <region>              # 区间表（占用/空闲）
node dist/src/cli.js query <region> <offset>      # 查询偏移归属
node dist/src/cli.js events <region>              # 操作历史
node dist/src/cli.js replay <region> [toSeq]      # 逐步回放
node dist/src/cli.js verify <region>              # 不变量核验
node dist/src/cli.js export <region>              # 导出 JSON
```

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/regions` | 创建区域 `{sizeBytes, name?}` |
| GET | `/regions` | 列出区域 |
| GET | `/regions/:id` | 区域 + 当前快照 |
| GET | `/regions/:id/status` | 状态 + 空闲总量 + 最大空闲块 + 核验 |
| POST | `/regions/:id/allocations` | 申请 `{requestId, bytes}` |
| POST | `/regions/:id/free` | 释放 `{requestId}` |
| GET | `/regions/:id/address?offset=N` | 查询偏移归属（分配或空闲块） |
| GET | `/regions/:id/events[/seq]` | 历史事件（含前后快照与步骤） |
| GET | `/regions/:id/replay?to=N` | 逐步回放到第 N 步 |
| GET | `/regions/:id/verify` | 不变量核验 |
| GET | `/regions/:id/export` | 导出 JSON |

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_REGION_SIZE` / `REGION_TOO_LARGE` | 区域大小非 2 的幂 / 超阶数上限 |
| `INVALID_REQUEST_ID` / `DUPLICATE_REQUEST_ID` / `UNKNOWN_REQUEST_ID` | 编号非法 / 重复 / 未知或已释放 |
| `INVALID_SIZE` | 零长度、小数、负数、非数字 |
| `REQUEST_EXCEEDS_REGION` | 请求超出区域大小 |
| `NO_CONTIGUOUS_BLOCK` | 无足够大的连续空闲块（附 `maxFreeBlock`） |
| `INVALID_OFFSET` | 地址查询偏移越界或非整数 |
| `REGION_NOT_FOUND` / `EVENT_NOT_FOUND` / `NOT_FOUND` | 资源不存在 |
| `TOO_MANY_ALLOCATIONS` | 超出单区域请求数量上限 |

## 演示内容

`npm run demo` 在 16 字节区域上连续申请 3B、3B、5B（实际占用 4B、4B、8B），分别按 `a→b→c` 与 `c→b→a` 两种顺序释放，展示局部合并与最终恢复为单个 16B 块；随后演示关闭数据库（模拟重启）后继续释放，历史事件完整保留。

## 测试覆盖

- 相邻但非伙伴的同大小块**不**合并；
- 跨多阶递归合并与最终恢复单块；
- 全满失败、空闲总量够但连续块不足（报告最大空闲块）；
- 内部碎片计算、最小偏移候选选择、低地址半块优先拆分；
- 零长度/小数/超区域/重复编号/重复释放等校验，失败前后状态完全一致；
- 小区域逐字节占用图核对覆盖与不重叠；多组固定序列每步不变量；
- SQLite 重启恢复、历史快照不可变、失败操作不落库、多区域独立。

## 限制

- 单进程服务，未做并发请求锁（同一区域并发写由 SQLite 事务串行化，但内存态按请求加载，极端并发下以后提交为准）。
- 地址用 Number 表示，区域上限 2^30 字节。
- `node:sqlite` 在 Node 25 仍标记为 experimental（会打印一条警告，不影响功能）。
