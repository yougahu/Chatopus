# 验证方法

## 离线检查

开发环境需要 Node.js、npm、ripgrep 和带 pip 的 Python 3；CI 使用 Python 3.12。

```sh
npm ci
npm run check:release
npm run smoke:defaults
```

`check:release` 执行类型检查、TypeScript 与 Python 离线测试、依赖声明和公开文件检查。测试使用临时目录、合成消息、本地模拟服务端与扩展替身，不需要真实模型凭据、QQ 账号或用户目录中的业务资源。CI 配置 Linux x64（Node 22.16 / 24 / 26）、Linux arm64（Node 24）和 macOS arm64（Node 24），并核对 Node 与 Python 的实际系统、架构；工作流配置本身不代表远端已通过。

`smoke:defaults` 在独立临时部署中启动 CLI doctor 和后台，检查空能力配置、仓库外运行目录及本地访问控制，结束后清理。默认后台应显示一个通用业务、空 skill/扩展、自定义字段为空且未设置人格。

OpenViking 安装器、来源保护和启动配置的离线检查已包含在 `check:release` 中，也可单独执行，不安装或启动后端：

```sh
npm run test:python
```

安装器测试覆盖三个目标的清单选择与 dry-run、每平台依赖锁、SHA-256、错误版本/模型、路径与覆盖保护，以及实际解释器的 wheel tags。跨平台用例使用模拟元数据；在本机运行不等于在另两种架构上运行。原生后端集成需要匹配依赖，不能由这些离线检查推断其可用性；默认测试显式排除需已安装 OpenViking 的 `NativeIntegrationTest`。

## 干净安装

执行 `npm run check:public -- --export=/absolute/new-directory` 导出源码，进入该目录重新安装并运行上述检查。目标须不存在且位于源码仓库外。导出不包含私有配置、运行数据、依赖目录或 Git 历史；规则与限制见 [发布](releasing.md)。

## 真实模型与可选集成

配置专用测试模型和凭据后，可执行：

```sh
npm run replay -- --fixture fixtures/group-replay.json
```

回放直接调用 Router，使用合成消息和任务卡，会产生 API 用量，不向真实群发送消息。它验证动作选择，不创建 Coordinator、Worker 或真实 Outbox，也不覆盖持久 turn 的恢复及端到端交付。合成群使用默认业务，需核对所选配置。

`scripts/router-compaction-validation.ts` 使用真实 Router、合成上下文和降低的压缩阈值验证压缩及重启，会产生模型费用。浏览器后台探针需要单独安装 Playwright/Chrome，并准备带任务和工具轨迹的合成审计数据，适用条件见 [后台](admin.md)。

浏览器、QQ 桥接和 OpenViking 各自验证实际部署环境。恢复、远端写入及服务重启测试使用明确选定的隔离部署；真实记录不混入合成 fixture。

## 记录结果

报告记录源码版本、配置范围、执行命令、通过/失败/跳过数量及覆盖限制。保留失败和重跑范围，不把单次成功解释为全部模型、平台和对话质量的保证。仅修改文档时检查链接、路径和配置示例即可，无需重启生产服务或调用真实模型。
