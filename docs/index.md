# 文档导航

首次使用从 [README](../README.md) 开始。

## 使用与部署

| 文档 | 内容 |
| --- | --- |
| [从零部署与运行](deployment.md) | 安装、外置配置、QQ 接入、常驻运行、备份、升级和排障 |
| [配置参考](configuration.md) | 模型、路径、环境变量、默认值与生效方式 |
| [运行维护](operations.md) | 启停、常驻服务、备份、升级和排障 |
| [管理后台](admin.md) | 配置编辑、任务管理、审计与用量 |
| [QQ 平台](platform.md) | OneBot 接入、消息、附件和投递 |
| [定时任务](scheduled-tasks.md) | 计划、角色权限、执行与本地结果 |
| [业务配置](business-config.md) | 提示词、能力选择、群绑定与配置回退 |
| [技能和工具](skills.md) | 外部 skill、工具扩展与浏览器接入 |
| [人格配置](persona.md) | 业务人格、正文编辑与模板 |
| [成员字段](member-fields.md) | 字段类型、业务选择与来源 |
| [可选长期记忆](openviking-operations.md) | OpenViking 后端、摄取与维护 |

## 开发与维护

| 文档 | 内容 |
| --- | --- |
| [架构](architecture.md) | Router、Worker、任务状态与能力边界 |
| [QQ 私聊接入设计](private-chat-design.md) | 首版设计草案：好友私聊、文件收发、个人定时任务、配置热更新与临时会话拒绝 |
| [原生运行时](runtime.md) | dsh 装配、模型调用与可信插件 |
| [Router 上下文](router-context.md) | 持续会话、召回、预算与恢复 |
| [验证方法](verification.md) | 离线检查、干净安装和可选集成测试 |
| [发布](releasing.md) | 源码导出、依赖、私有数据与托管配置 |

贡献约定见 [CONTRIBUTING](../CONTRIBUTING.md)，安全边界见 [SECURITY](../SECURITY.md)，职责约束见 [AGENTS](../AGENTS.md)。

- [QQ 私聊使用说明](private-chat.md)
- [私聊实现核对与联调](private-chat-verification.md)
