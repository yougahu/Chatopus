# 致谢

Chatopus 的架构灵感来自 DeepSeek 团队公开的 [Super-agent 原型](https://github.com/deepseek-ai/dsh-superagent-prototype)：持续接收输入的 Router 协调独立 Worker，配合任务状态、工具执行与会话恢复，服务多人群聊。

项目使用 DeepSeek 发布的 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` npm 包。具体版本以 [锁文件](package-lock.json) 为准，各包许可证保留在安装制品中。

Chatopus 是独立项目，与 DeepSeek 没有官方隶属关系；“inspired by” 表示架构参考。Chatopus 的群聊平台、业务配置、调度、管理后台和安全边界由本项目维护，不代表上游的实现或承诺。

感谢 Model Context Protocol、Playwright MCP 及其他开源依赖的维护者。依赖清单和许可证见 [第三方声明](THIRD_PARTY_NOTICES.md)。
