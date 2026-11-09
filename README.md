# Stigmergy for DeepSeek Harness

**痕迹协作** —— 让一棵委派树里的 Agent 通过「改变环境、留下痕迹」来协作，而不是互相发消息。

受生物学里的 *stigmergy*（痕迹协作）启发：蚂蚁从不告诉另一只蚂蚁食物在哪，它只是在路上留下信息素；后来的蚂蚁沿着痕迹自己走过去。信息在环境里，不在消息里。

## 它解决什么

多个 Agent 协作，最大的误区是把人类大厂那套「汇报、对齐、审批」搬给 AI。Agent 数量翻一倍，彼此通报的沟通量就翻四倍。真正的 AI Native 协作是：共享同一个鲜活的上下文环境，直接改状态、留痕迹、触发下一步。

这个插件给一棵委派树（主 Agent + 它启动的所有 subagent，含多层）一片共享的**痕迹场**：

- 每个 Agent 在**每一步**开始前，都会在自己的 runtime context 里看到当前痕迹场（有界、自动蒸发）；
- 所以 A 留下的痕迹，B 在**自己的下一步**就能看到——没有 `send_message`，没有主 Agent 转述，没有 N² 的消息图；
- 痕迹按 `key` 覆盖，所以痕迹场是**当前状态**，不是聊天记录；
- 痕迹会**蒸发**（默认 90 分钟），过期的信息自己消失，不需要谁来清理。

## 安装

```powershell
# 在 DSH 里
plugin_manager → install_bundle，target = 本目录
```

或用 Creator 模式安装，然后重启 DSH。

## 工具

| 工具 | 作用 |
| --- | --- |
| `stigmergy_leave` | 写/覆盖一条痕迹：`key`（槽位）、`text`（同伴需要的事实）、`kind`、`author`、`ttl_minutes` |
| `stigmergy_read` | 读整片痕迹场，或按 `keys` 读全文（context 里的是截断摘要） |
| `stigmergy_clear` | 在蒸发前收回一条痕迹 |

`kind` 取值：`note` · `decision` · `finding` · `task` · `question` · `done`。

## 怎么工作

1. **痕迹场**按 colony 分组。默认 `scope: tree`，colony = 这棵委派树的根 session；`scope: workspace` 则整个工作目录共享一片场。
2. **注入**：插件注册一个 `systemPrompt.context`，在每次请求组装时把痕迹场渲染进 runtime context。DSH 每次请求都会刷新 runtime context，所以这是「鲜活」的，不是启动时快照。
3. **落盘**：痕迹同时以追加日志写到 `<cwd>/.dsh-stigmergy/<colony>.jsonl`，重启后还在，用普通 `read` / `grep` 也能看。外部修改会在下次读取时被采纳。
4. **蒸发**：`expiresAt` 到期即从场里消失；日志超过 200 条会压缩一次。

## 配置

`cordis.patch.yml` 里的 `config`，可在你自己的 profile patch 层覆盖：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `directory` | `.dsh-stigmergy` | 落盘目录（相对 colony 根的工作目录）；`""` 表示只留内存 |
| `scope` | `tree` | `tree`（一棵委派树）或 `workspace`（一个工作目录） |
| `maxEntries` | `12` | 注入 context 的最多痕迹条数 |
| `maxTextChars` | `280` | 每条痕迹在摘要里的截断长度 |
| `defaultTtlMinutes` | `90` | 默认蒸发时间；0 表示不蒸发 |
| `promptSection` | `true` | 是否在系统提示里加一段协作约定 |

## 验证

```powershell
node test/check.mjs
```

假 Cordis context 的回归检查，覆盖：树内共享、外树隔离、同 key 覆盖、摘要截断、全文读取、收回、落盘重放、外部改写采纳、配置归一化。

2026-11-09 在本机 DSH 实测：

1. 主 Agent 写入 `demo/handoff`；一个正在 `Start-Sleep` 的子 Agent，在等待后的下一步 runtime snapshot 里看到了这条痕迹——**没有调用 `stigmergy_read`，也没有收到任何消息**。
2. 子 Agent 写入 `demo/decision`；主 Agent 下一步的 runtime context 里出现。
3. 主 Agent 撤销 `demo/handoff`；子 Agent 最后一步看到的场里它已经消失。

## 边界

- 工具是**全局**注册的，任何继承了全局工具的 preset 都能用。像「老板模式」这种主动屏蔽全局工具的 preset，主 Agent 看不到痕迹，但它派生的 `standard` 子 Agent 能看到——这正好是痕迹协作生效的地方。
- 痕迹是给「同一棵树里正在跑的 Agent」看的，不替代 subagent 的最终报告：报告仍然回到父 Agent，痕迹是**平级共享**的那一层。
- 落盘用 Host 进程直接写文件，不受模型工具沙箱约束；写失败只会降级成内存态，不会让工具调用失败。

## License

[MIT](LICENSE)
