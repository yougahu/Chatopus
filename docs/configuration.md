# 配置参考

命令从项目工作目录读取 `config.local.json` 和 `.env`，不是从可执行文件所在目录自动寻找配置。首次复制 [config.example.json](../config.example.json) 与 [.env.example](../.env.example)；已有部署只合并需要的字段，不覆盖私有配置。JSON 不支持注释，也不展开 `${VARIABLE}`。密钥通过 `apiKeyEnv` 等环境变量名引用。

## 路径与凭据

运行数据和外部能力的目录均可配置，无需放在源码仓库中。示例将 `stateDir` 设为 `~/.local/share/chatopus/runtime`；数据库、Router 会话、Worker 工作空间、审计和缓存都跟随这个目录。省略 `stateDir` 的旧配置仍回退到 `.runtime`，已有数据应保留原路径或按下述方式迁移。

| 配置 | 仓库外路径示例 |
| --- | --- |
| `stateDir` | `~/.local/share/chatopus/runtime` |
| `skills[].path` | `~/.local/share/chatopus/skills/document-reader` |
| `extensions[].module` | `~/.local/share/chatopus/tools/document-tools.mjs` |
| `plugins[].module` | `~/.local/share/chatopus/tools/prompt-plugin.mjs` |

这些字段均支持绝对路径和 `~/`（运行服务的操作系统账号的主目录），也保留相对路径。相对路径以读取 `config.local.json` 的工作目录为基准。扩展与插件还支持 `file:` URL 和从配置目录解析的已安装 npm 包，不支持远端模块 URL。外部模块的依赖应安装在该模块所在目录或其父目录；使用包名注册时，包必须可从配置目录解析。扩展 `options` 中的路径由扩展自行定义，宿主不会改写。

更改 `stateDir` 前停止机器人和后台，备份并复制完整状态目录，再修改配置并重启；只修改路径会创建另一份空状态，不会自动搬迁已有数据。skill、扩展和插件文件由部署者放入所配置位置，宿主不会自动安装或移动它们。配置文件和密钥也可放在独立部署目录，从该目录调用源码中的 CLI，详见 [运行维护](operations.md)。

`.env` 中显式设置的值覆盖进程同名环境变量，空值也会覆盖。角色凭据依次选择角色的 `apiKeyEnv`、对应 `providers` 条目的 `apiKeyEnv`，最后才是 `ROUTER_API_KEY` / `WORKER_API_KEY`。只有明确使用兼容提供方名 `boe-openai` 时，默认凭据名才是 `OPENAI_API_KEY`；其他提供方不会隐式借用它。

| 环境变量 | 用途 |
| --- | --- |
| `ROUTER_API_KEY`、`WORKER_API_KEY` | 两个角色默认的独立凭据 |
| `OPENAI_BASE_URL` | 公共端点回退，优先于顶层 `baseUrl`；角色显式端点可覆盖此回退 |
| `OPENAI_API_KEY` | 兼容提供方 `boe-openai` 的凭据兼容入口 |
| `QQ_SELF_ID`、`ONEBOT_ACCESS_TOKEN` | 机器人身份与 OneBot 反向 WebSocket 认证 |
| `QQ_IMAGE_CACHE_ROOT` | 允许读取的桥接本地图片缓存根，优先于 `qq.imageCacheRoot` |
| `OPENVIKING_ROOT_API_KEY` | 可选记忆后端的账号准备和管理配置；内容操作使用独立群 USER 凭据 |

## 模型

`router`、`worker` 分别支持 `provider`、`model`、`api`、`baseUrl`、`apiKeyEnv`、`reasoningEffort` 和 `maxTokens`。示例使用 `openai-responses`，也支持配置 `openai-completions`；协议及模型能力必须与真实提供方匹配。`maxTokens` 是单次输出限制，不是任务累计 token 预算。

未设置模型时使用待填 ID `YOUR_MODEL_ID`，不能用于真实调用。Router 默认 `low` / 1200 输出 token，Worker 默认 `high` / 16000。高级 `providers` 结构沿用 dsh provider profile，其中端点字段是 **`baseURL`**，与角色字段 **`baseUrl`** 大小写不同。高级模型列表需包含所选模型；视觉和推理支持必须显式准确声明。详见 [运行时](runtime.md)。

## 调度与上下文

下表为省略字段时的回退值。示例显式设置 `persistentRouter: true`，启用持续 Router；省略时回退为兼容模式 `false`。运行边界见 [Router 上下文](router-context.md)。

| 字段 | 回退值 | 含义 |
| --- | --- | --- |
| `persistentRouter` | `false` | `true` 使用持久 turn、调用预算和重建机制 |
| `concurrency` | `5` | 并发 Worker 话题数，多余任务排队 |
| `maxWorkerSteps` | `96` | 单次 Worker 运行的模型步骤上限，含格式修复 |
| `workerTimeoutMs` | `3600000` | 同一任务版本的 Worker 总时限，包含重试，见下文 |
| `routerTimeoutMs` | `30000` | 回复偏好重排等辅助请求的重试时限基数，不是持续 Router 总时限 |
| `routerTurnTimeoutMs` | `120000` | 持续 Router 单 turn 总时限，包含重试、压缩和恢复 |
| `routerQueueTimeoutMs` | `180000` | 持续 Router 从消息入库开始的排队/处理截止时限 |
| `routerContextChars` | `48000` | 模型容量缺失时的上下文回退参数，不是本轮原文上限 |
| `routerSessionMaxBytes` | `4000000` | 触发 Router 物理会话日志换代的大小阈值，不是历史日志总磁盘配额 |
| `recentMessageLimit` | `16` | 普通最近消息窗口 |
| `threadCardLimit` | `12` | 普通任务卡窗口；必要引用另行固定 |
| `threadIdleTtlMs` | `21600000` | 话题空闲时长阈值，6 小时 |
| `routerBatchWindowMs` | `150` | 路由合批等待窗口，可为 0 |
| `routerBatchSize` | `8` | 每批条数，最大 20 |

Coordinator 为同一任务版本维护固定的 Worker 截止时间，默认从首次启动起一小时，后续重试和格式修复共享这段时间及步骤预算，不因为重试延长。定时 Worker 采用 `workerTimeoutMs` 与该任务 `timeoutMs` 的较小值；超时和取消使结果失效，不保证每次运行都能完成固定次数的重试。持续 Router 使用自身的 turn 截止时间。

## 定时任务

`scheduledTasks` 是部署配置，默认关闭。启用后由机器人服务扫描持久化计划；独立后台只保存计划和操作请求，不启动 Worker。目标群必须在 `qq.allowedGroupIds` 中，后台从机器人身份与允许群组合出 `qq:<selfId>:<groupId>`，不能随意填写其他群。

```json
{
  "scheduledTasks": {
    "enabled": true,
    "defaultTimezone": "Asia/Shanghai",
    "minIntervalMs": 3600000,
    "scanIntervalMs": 1000,
    "concurrency": 1
  }
}
```

| `scheduledTasks` 字段 | 回退值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用定时任务执行与群聊登记工具 |
| `defaultTimezone` | `Asia/Shanghai` | 新建计划缺省 IANA 时区；可在具体计划中覆盖 |
| `minIntervalMs` | `3600000` | 周期任务实际执行间隔下限，不得小于一小时 |
| `scanIntervalMs` | `1000` | 到期计划扫描间隔 |
| `concurrency` | `1` | 定时 Worker 并发上限，同时受全局 Worker 并发约束 |
| `maxPerOwner` | `20` | 同群同请求人的未结束用户计划上限 |
| `maxPerRoom` | `100` | 同群未结束用户计划上限 |
| `maxSchedules` | `1000` | 当前状态库未结束计划总上限，含系统计划 |
| `failureThreshold` | `3` | 连续执行失败达到此值时暂停计划 |
| `catchUpWindowMs` | `86400000` | 默认补跑有效窗口，一天；具体计划可覆盖 |
| `timeoutMs` | `3600000` | 默认定时 Worker 硬超时，同时受 `workerTimeoutMs` 限制 |
| `commandTtlMs` | `300000` | 立即执行请求有效期，过期后拒绝执行 |
| `roleMaxAgeMs` | `300000` | 群角色证据有效期，上限五分钟，可设置更短 |

数值配置必须为正安全整数。角色证据到期后需重新核验；角色不明、身份不匹配或平台查询失败均不会当作普通成员放行。群主与管理员统一为 `group_admin`，成员为 `member`；群聊登记／管理许可在后台配置并持久化到数据库，支持多选或全不选，不放在上述部署 JSON 中。角色策略立即生效；请求人仍能查询自己的计划。系统任务仅后台可管理，与群聊角色无关。

单次任务没有周期频率限制，可以登记一小时内的提醒。周期任务的自动触发、补跑和立即执行共用 `minIntervalMs`，编辑计划不会重置执行间隔。固定间隔和受限五字段 cron 均可预览；cron 的分钟字段必须为一个数字。补跑可选择合并一次或跳过，避免服务恢复时堆积历史触发。

关闭功能后，机器人启动会暂停未结束计划，使在途定时执行及尚未发送结果失效，保留历史记录。重新启用不自动恢复已暂停计划，应在后台检查原因并恢复。固定文字提醒直接进入 Outbox；需要处理和查询的任务由 Worker 执行，再投递到绑定群。执行前检查当前业务绑定、所需能力与 Worker 配置，条件不满足时阻塞并记录原因。后台操作与审计见 [定时任务管理](admin.md#定时任务管理)。

## 业务、能力与记忆

`business` 选择默认业务、按群绑定及提示词；`skills` / `extensions` 注册能力，业务中的 `skillIds` / `extensionIds` 决定启用范围。`plugins` 是按角色装载的 Cordis 插件，`browser` 是 Worker 的浏览器 MCP 配置，二者不等同于可按业务选择的扩展。`python` 默认 `python3`，供 CSV 等工具使用。浏览器默认采用 `networkIsolation: "managed"`，要求固定版本的 Playwright MCP 并通过宿主公网代理访问；自定义 MCP 需由部署者隔离网络并显式选择 `external`。具体配置见 [浏览器接入](skills.md)。

`botCallNames` 代码回退为 `["机器人"]`，示例为 `["助手", "机器人"]`；空数组表示只通过 @ 唤起。最多 32 个，每个不超过 80 字符。技能、扩展、自定义字段与人格均无内置业务预选。人格正文保存在 `business.profiles.<id>.personaText`，支持 Markdown，最多 8,000 个 Unicode 字符，留空不加载额外人格。未设置正文时兼容读取旧 `personaFile`；后台载入旧正文后可直接编辑并保存迁移。

| `memory` 字段 | 回退值 | 含义 |
| --- | --- | --- |
| `enabled` | `false` | 是否连接 OpenViking，开启时必须有根凭据 |
| `provider` | `openviking` | 当前唯一实现 |
| `baseUrl` | `http://127.0.0.1:1933` | 记忆后端地址 |
| `namespace` | `brain-of-exile-2` | 账号隔离身份；示例显式使用 `chat-assistant`，已有部署勿随意更换 |
| `rootKeyEnv` | `OPENVIKING_ROOT_API_KEY` | 根凭据环境变量名 |
| `timeoutMs` | `15000` | 后端请求超时，最大 120000 |
| `recallBytes` | `6000` | 召回字节预算，4–32000 |
| `ingestBatchSize` | `32` | 摄取批次上限，1–100 |
| `ingestBatchWindowMs` | `300000` | 合并等待，0–3600000；0 为不等待 |
| `fields` | 无自定义字段 | 定义注册表，仍需业务选择启用 |

`memory.enabled=false` 关闭的是 OpenViking。兼容模式 `persistentRouter=false` 仍可能运行本地群摘要 Worker；它与成员长期记忆不是同一机制。成员字段配置见 [完整示例](member-fields.md)，后端要求见 [OpenViking](openviking-operations.md)。

`qq.enabled` 默认 `false`，`allowedGroupIds` 默认空，端口默认 `8083`。启用前必须设置非空身份、token 和允许群列表。CLI 固定监听 `127.0.0.1`，不是通过 `qq.host` 开放外部监听。身份环境变量优先于 `qq.selfId`。

## 何时生效

| 变更 | 生效方式 |
| --- | --- |
| 模型、端点、角色密钥、provider profile | 新调用热加载；在途 Worker 保留启动快照 |
| 业务指引、能力选择、业务人格正文及旧文件引用、技能和扩展注册、成员字段定义 | 新调用加载新配置；后台编辑目录按当前配置读取 |
| 兼容的旧人格文件内容、SKILL.md、扩展入口文件 | 后续调用读取；扩展传递依赖或安装依赖变更后应重启以清除模块缓存 |
| 唤起称呼、QQ、并发/时限/步骤、持续 Router 开关、存储、plugins、browser、python | 重启机器人 |
| `scheduledTasks` 部署开关、时区及额度／频率／并发／超时参数 | 重启机器人及后台；已登记计划保留各自时间规则及参数 |
| 后台定时任务计划与群聊角色策略 | 写入状态库后生效；执行和运行中止由机器人服务处理 |
| OpenViking 开关、地址、namespace、根凭据、摄取参数 | 重启机器人及后台；后台记忆查询也持有启动配置 |
| 后台端口或源码 | 重启相应进程 |

热加载不替代合法性校验；删除仍被某业务引用的能力或字段会导致配置错误。先移除引用再删除注册。后台的字段查询服务持有启动配置，修改字段定义后也应重启后台，保持查询展示与新调用一致。

## CLI

| 命令 | 行为 |
| --- | --- |
| `npm run admin -- --port 8092` | 独立本地后台，缺少模型凭据也能启动 |
| `npm run doctor` | 检查所有业务配置引用的技能文件、扩展诊断及已配置浏览器命令；不调用模型验证凭据 |
| `npm run dev -- ask '问题'` | 在独立 `stateDir/ask/` 子目录运行 Router/Worker，终端输出，不发 QQ；会调用模型及启用能力 |
| `npm run replay -- --fixture fixtures/group-replay.json --limit 10 --concurrency 3` | 使用真实 Router 的受控回放，不发 QQ；结果写入状态目录的 `verification/` |
| `npm run dev -- inspect` | 查看当前状态库的任务和 Outbox 状态列表 |
| `npm run dev -- serve` | 启动 QQ 消息服务，要求已启用 QQ；持有状态目录独占锁 |
| `npm run dev -- help` | 查看 CLI 用法 |

`doctor` 成功不证明模型 ID、API Key 或生产端点可用，也不完整验证兼容的旧人格文件及所有工具依赖。扩展诊断会导入可信模块；`ask` / `replay` 会使用当前业务与能力配置，不等于无副作用的离线测试。重复回放可能覆盖同名结果文件，需保留报告时先归档。离线检查与真实模型验证见 [验证方法](verification.md)。
