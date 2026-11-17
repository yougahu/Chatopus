# 发布

Chatopus 以 MIT 发布源码。`package.json` 的 `private: true` 防止误发 npm 包，不影响在代码托管平台公开源码。本项目目前不提供 npm 包、容器镜像或一键部署制品。

## 验证源码

1. 执行 `npm ci`、`npm run check:release`、`npm run smoke:defaults` 和 `npm audit`。
2. 运行 `npm run check:public -- --export=/absolute/new-directory`，导出目录须位于仓库外且不存在。
3. 在导出目录重新执行安装、完整检查和默认后台探针，确认没有加载本机私有配置或能力。
4. 审查待发布差异、可达 Git 历史、素材来源和依赖许可证。依赖变更后运行 `npm run notices:write` 并复核生成声明。

`check:public` 校验当前 Git 候选文件、公开文件范围、配置模板、MIT 声明、锁文件、Markdown 链接和 npm 打包清单。它识别常见凭据及私有路径特征，只在检查通过后复制源码；不检查整个 Git 历史，也不替代人工安全或授权审查。

## 源码与部署数据

公开内容包括通用宿主、合成 fixture、中性人格模板及配置说明。`.env`、`config.local*.json`、运行状态、聊天、凭据、审计、已安装业务资源和私有人格留在部署目录，不提交或打包。忽略规则不能移除已提交的数据，发现泄漏需先撤销凭据并处理已发布副本。

运行数据、skill、工具扩展与插件均可配置到仓库外，见 [路径配置](configuration.md#路径与凭据)。默认示例不启用领域能力、QQ 或长期记忆。公开演示使用合成数据，不使用真实群聊或生产截图；仓库内的后台概览图来自空配置临时实例，不含用户数据。

源码导出不复制 Git 历史。需要保留历史发布时，单独检查全部分支、标签及旧制品。检查导出与发布授权分别处理，导出命令不会创建仓库、提交或推送。

## 托管与版本

- 正式仓库为 [yougahu/Chatopus](https://github.com/yougahu/Chatopus)，问题反馈使用 [Issues](https://github.com/yougahu/Chatopus/issues)，版本发布使用 [Releases](https://github.com/yougahu/Chatopus/releases)。
- 开启私密漏洞报告、可用的 secret scanning 和主分支保护，将 CI 设为合并检查。
- CI 目标为 Linux x64 Node 22.16 / 24 / 26、Linux arm64 Node 24、macOS arm64 Node 24，包含 Python 安装器回归与依赖审计，不使用生产秘密或自托管生产 runner。发布前核对三个平台的实际运行结果。
- 发布说明写明功能、安装要求、验证范围、已知限制和必要升级步骤，再创建版本标签及源码 release。

## 部署兼容

升级前备份并停止共享状态目录的机器人及后台，保留账号映射、持久 ID 和 memory namespace；恢复须使用匹配的源码与完整状态。具体操作见 [运行维护](operations.md)。

OpenViking 为需自行提供兼容后端的可选集成，其固定制品安装器没有公开制品分发渠道，不能作为开箱即用安装承诺。浏览器也需另行提供运行环境；参见 [OpenViking](openviking-operations.md) 与 [能力接入](skills.md)。
