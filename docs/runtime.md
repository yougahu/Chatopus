# 原生 dsh 运行时

Router 和 Worker 使用 `@deepseek-ai/dsh-agent` 与 `dsh-agent-loop`。Chatopus 装配 Agent，管理业务任务及交付，模型调用和工具循环由 dsh 执行。核心装配位于 [native.ts](../src/runtime/native.ts)，角色运行池位于 [pool.ts](../src/runtime/pool.ts)。

dsh 依赖固定为同一组 `0.2.2-rc.1` 版本，Cordis 为 `4.1.0`。升级时统一验证 LLM、会话、投影、提示词、工具执行器、附件存储及压缩插件，避免混装不匹配的版本。

## 调用与重试

模型请求共享一个重试调度：等待 1、5、10、10、30 秒，最多五次重试、六次尝试。适配器自身不再独立重试。认证、额度、参数和传输失败可以进入该调度；取消、上下文超限及 Router 的调用或时限边界走对应的停止或恢复路径。

失败响应中的部分内容在交给 Agent 前丢弃，不能执行其工具。工具和宿主错误不属于模型传输重试。模型重试耗尽记录最终错误并明确反馈，不启动新的普通重试周期；已保存的 Worker 结果不会因结果路由失败而丢失。

所有重试、报告修复和恢复共用所属任务的剩余预算。Worker 默认最多 96 步，一个任务修订版的总时限为一小时；定时 Worker 同时遵守计划中更短的时限。持续 Router 的时限和调用预算见 [Router 上下文](router-context.md)。

## 模型与配置版本

Router 和 Worker 分别配置 `provider`、`model`、`api`、`baseUrl`、`apiKeyEnv`、`reasoningEffort` 和 `maxTokens`。协议交给 dsh 适配器，模型的视觉、推理和上下文能力须按供应商实际支持情况声明。高级 `providers` 配置中的模型列表必须包含所选模型。

角色运行池按完整路由、模型和凭据快照延迟创建原生宿主。新调用读取配置更新，在途 Worker 保留启动时的模型、密钥、业务指引及能力，不被后续保存影响。旧宿主在最后一个调用结束后清理。逻辑任务和持久输入不因模型切换而改变。

模型、业务、人格、skill 和扩展支持新调用热加载；存储、步骤和时限、插件等运行参数需要重启。完整范围及环境变量优先级见 [配置参考](configuration.md#何时生效)。

## 可信 Agent 插件

插件通过运营者配置装载到真实 Cordis Agent 作用域。群聊不能安装或修改插件。插件与业务工具扩展不同：插件直接使用 Agent 服务，扩展通过宿主能力契约提供工具。

```json
{
  "plugins": [{
    "module": "~/.local/share/chatopus/tools/guidance.mjs",
    "scope": "worker",
    "options": { "text": "保持解释简洁。" }
  }]
}
```

`scope` 可为 `router`、`worker`（默认）或 `both`，`enabled: false` 禁用。模块支持绝对路径、`~/`、相对配置目录路径、`file:` URL 和可解析的 npm 包；远端 URL 被拒绝。将模块及其依赖安装到所配置的外部目录，包依赖须与宿主 dsh/Cordis 版本匹配。修改插件代码后重启。

上述 `guidance.mjs` 可使用：

```js
export const name = 'guidance';
export const inject = ['systemPrompt'];
export function apply(ctx, options) {
  ctx.systemPrompt.section({
    name: 'guidance', order: 20,
    text: options.text, interpolate: false,
  });
}
```

Agent 首次处理消息前等待插件装配完成。销毁 Agent 时，Cordis 清理所属插件的工具、提示词、监听器及 `ctx.effect()` 资源。普通插件不应使用 `complete: true` 替换完整系统提示词，除非部署明确需要该行为。

本宿主加载显式模块，不解释 dsh CLI 的完整 profile/bundle 配置。安装到另一个 CLI profile 不会自动启用这里的插件。插件属于可信本地代码，安全边界见 [SECURITY](../SECURITY.md)。

## 上下文与资源

Worker 的原始输入持久化保存，初始上下文有界提供，较长输入通过任务工具分页读取。需求检查点与历史原文分别验证，省略的材料不能被视为已读。字符、字节和 token 限额各自约束不同环节，不等于供应商精确用量。

每个 Thread 有持续产物目录 `root=workspace`，当前执行空间为 `root=run`，历史执行资料通过 `root=history` 读取。三者位于配置的 `stateDir` 下；skill 作为共享只读资源。通用写入校验真实路径，拒绝越界和符号链接逃逸。

扩展只能提供其声明的工具与业务字段，不能替换宿主输入、修改报告的任务/执行/修订绑定，或把失败报告改成成功。多个扩展的 `hostTools` 限制取交集，不能增添宿主权限。接口与示例见 [能力接入](skills.md)。

MCP 图片由原生附件存储接纳，以图片块提供给支持视觉的模型，工具文本不重复携带其 base64。输出图片与文件还需经过宿主校验、产物登记及平台回执；详见 [平台接入](platform.md)。

## 验证

离线测试覆盖模型与密钥快照、会话独占、角色隔离、插件装配及清理、上下文、压缩、取消和交付。配置中的实际模型或第三方 MCP 可用性需单独验证，参见 [验证方法](verification.md)。
