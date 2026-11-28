# 私聊实现核对与联调

核对日期：2026-11-26。范围为 [设计文档](private-chat-design.md) 的好友私聊、文件、个人计划、热更新与人工投递核对，以及私聊配置页面、进度文案和 Router 图片输入。本次公开源码验证未启动真实 QQ 桥接、未调用真实模型、未向真实用户发送消息。真实 QQ 联调由部署者负责。

## 本地检查

已运行完整发布检查 `npm run check:release`，包括 TypeScript、97 个测试文件中的 1292 项 Vitest 测试、28 项 Python 检查、399 个依赖的声明核对和公开文件检查；另在干净源码导出目录安装，并运行完整发布检查与 `npm run smoke:defaults`，默认 doctor、独立后台、空能力配置及本地访问限制通过。检查使用临时数据和中性 fixture，未读取生产聊天内容。

主要新增测试为 `private-chat.test.ts`、`private-attachments.test.ts`、`private-file-platform.test.ts`、`private-delivery.test.ts`、`admin-private-chat-ui.test.ts` 和 `router-vision.test.ts`。既有 `scheduled-coordinator.test.ts`、`file-delivery.test.ts`、`admin.test.ts` 也补了私聊、截止时间、跟进和后台场景。全量回归继续验证原有群消息、文件、计划、持久 Router、记忆和业务配置。

下表覆盖设计编号的实现核对入口与代表测试。编号范围不表示每一个场景都有独立的自动化故障注入用例；涉及实际 QQ 行为的项目还需要完成下一节联调。

| 设计编号 | 核对结果与证据 |
| --- | --- |
| C01–C04 | 完整 bot/peer 会话 ID、畸形目标拒绝、旧群和零目标兼容；conversation、OneBot、Store，private-chat 与 platform 回归 |
| I01–I07 | 好友直聊、真实 mention/角色、临时类型入正文前拒绝、持久去重先于限流、独立控制额度；private-chat、平台认证回归 |
| R01–R04 | 复用既有引用、修订、取消、队列和预算；私聊提示说明直接参与，状态分开显示执行与投递；Coordinator、Router、Worker 回归 |
| H01–H03 | 四字段热更新、非法配置保留有效策略、非热字段单独提示重启；private-chat、admin 配置测试 |
| H04–H12 | 旧 AbortSignal 永久失效、事务撤权、失败清理集合保留、重新加回不复活、恢复先于接入、历史路由不阻塞配置轮询；private-chat 与持久 Router/恢复回归；进程崩溃组合仍按服务恢复规则核对 |
| F01–F03 | 文件消息主来源或版本固定的 go-cqhttp 通知；通知要求好友证据，事件时间稳定去重，无平台 ID 不伪造；private-file-platform 合成契约测试，真实事件形状待联调 |
| F04–F08 | 数量/字节/路径校验、QQ 公网来源、跳转上限、撤权取消、同会话选择、摘要核验、符号链接拒绝；private-attachments、public-network、文件工具回归 |
| F09–F10 | 明确版本与传输契约、同步空回执限定实现、逐文件确认、未知停止、发送中途到期保留已发事实；private-file-platform、file-delivery；真实回执待联调 |
| F11–F14 | 独立受管清单、有效引用保护、七天保留、并发容量预留、只清理已登记快照、临时写入记录和恢复；private-attachments 与文件/图片工具回归 |
| S01–S04 | 本人 actor 不查群角色；跨会话、系统权限、全局开关、旧命令/提案绑定由既有 Service 检查；private schedules、scheduled-tasks-core/authorization 回归 |
| S05–S10 | 共用提醒/Worker 调度、固定时区和频率、撤权阻塞、系统输出隔离、好友失败延后与非好友阻塞；scheduled-coordinator 与平台测试 |
| S11–S12 | 实例固定截止时间；迟到结果保存、未发投递过期、未知仍需核对；scheduled-coordinator、file-delivery、private-delivery |
| S13–S17 | 显式 attachmentIds 冻结版本；新实例与旧实例材料独立，缺失阻塞；缺条件后的普通跟进携带原条件并保留关联，原实例不改写；attachments、scheduled-coordinator、原计划生命周期回归 |
| S18–S19 | 统一 effective outstanding；部分核对继续阻塞，全结案后暂停且明确恢复，单次结束不复活，恢复重新检查文件和能力；private-delivery、scheduled-tasks-core |
| M01–M02 | 继续使用完整 room 的远端账号和成员作用域；摘要/摄取/资料/偏好异步路径捕获失效信号；记忆隔离、room-memory-worker、openviking-ingestion 回归及代码核对 |
| O01–O04 | 显示引用与宿主来源独立、非空私聊收件人拒绝、断线/超时/异步回执不混同、固定去重载荷；private-chat、platform、platform-files |
| O05–O08 | 状态不把 idle 当作已送达；补发新 Outbox、不重跑 Worker，未知需再次确认；更正/撤权/缺文件拒绝，历史定时结果注明时间；private-delivery、file-delivery、Coordinator |
| O09–O14 | received/abandon/resent 独立记录，原始回执保留；发送中拒绝、事务版本/幂等、固定项目映射、恢复仅补真实成功；private-delivery、admin |
| U01–U03 | 服务端先筛会话再分页、会话业务绑定、配置保存/应用/在线分开；共享核对事务和管理员身份；admin API/UI、business-config 回归 |
| D01–D02 | 默认关闭、群回归、SQLite 版本 3 与未来版本拒绝；完整发布检查、默认安装冒烟、admin-schedules |

实施保持一套调度器、一套 Outbox、一份进程内私聊策略；没有新增权限数据库、用户公平调度或业务分叉历史。需要额外部署配置的是非标准文件桥接契约；受管文件清单是本地附件索引，不是第二份授权来源。

## 真实 QQ 联调清单

仅在专用测试机器人和明确同意接收测试的好友间执行，记录桥接 `app_name`、`app_version`、文件主事件来源及脱敏后的实际回执。无需在报告中保留 token、文件下载 URL 或真实账号记录。

1. 确认版本与 `qq.privateFiles` 相符。验证普通私聊、连续追问、引用、图片及仅文件输入；好友消息无 @ 也能参与。
2. 用临时会话、缺失/未知子类型、未列入白名单的用户测试拒绝：没有入库正文、下载、模型请求或 QQ 回复。
3. 双向发送一个文件和多个文件；验证实际传输方式、文件 ID / 同步空回执、文件通知重放和双重上报。空/异步/超时回执必须进入 unknown，不自动补发。
4. 在部分文件成功后断线，确认成功项不重传；再分别核对收到、放弃、明确补发，后台的原平台事实仍保留。发送进行中不能结案。
5. 创建本人提醒、Worker 计划和绑定文件的计划；同名重传不自动换版本。删除好友时计划阻塞，暂时无法取得好友列表时延后；重连重新验证证据。
6. 离线超过交付截止再恢复：旧结果不自动发送，未来周期不被已过期未发项占用；未知项目仍需处理。Worker 缺条件时补充只形成普通跟进，计划保持暂停。
7. 执行和上传等待期间移出白名单，再立即加回：旧任务不复活，已发生发送保留回执，剩余文件不发送。确认后台最近应用记录和错误状态准确。
8. 分别测试 plain/quote，确认无平台 ID 的通知不引用伪造 ID。检查同一好友的群/私聊、不同机器人和其他好友的数据隔离与业务绑定。

以上真实结果由部署者确认前，不把本地模拟通过写成“QQ 联调通过”。
