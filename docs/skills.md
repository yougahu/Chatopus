# 技能和可选扩展

宿主不默认启用任何领域技能。运营者在 `skills` 注册本地技能资源，在 `extensions` 注册可信本地模块；每个业务配置用 `skillIds` 和 `extensionIds` 选择其中的能力。

## 安装并启用本地技能

将可信技能和扩展工具放在源码仓库外，例如下面的目录。路径由配置指定；已有安装目录也可继续使用。

```text
~/.local/share/chatopus/
  skills/document-reader/
    SKILL.md
    references/
      citation-guide.md
  tools/
    document-tools.mjs
```

`SKILL.md` 写明用途、适用条件、工作步骤及附属资源路径。可带 `name`、`description` frontmatter 供后台显示；Worker 的 `skills_list` 使用注册项的 `description`，建议同时填写。Worker 先看到目录，再按需用 `resource_read` 读取说明，不会把全部技能正文自动塞入每轮提示词。

把以下片段合并到 `config.local.json`，保留现有模型、密钥引用及其他业务。只注册目录并未启用它，必须同时在业务中选择。若只需要读技能，不需要扩展，删除示例的扩展注册并将 `extensionIds` 设为空数组。

```json
{
  "skills": [
    { "id": "document-reader", "path": "~/.local/share/chatopus/skills/document-reader", "description": "检索文档并保留段落依据" }
  ],
  "extensions": [
    { "id": "document-tools", "module": "~/.local/share/chatopus/tools/document-tools.mjs", "version": "1", "enabled": true, "options": {} }
  ],
  "business": {
    "defaultProfile": "default",
    "roomProfiles": {},
    "profiles": {
      "default": {
        "name": "文档助手",
        "commonInstructions": "依据用户提供的材料回答。",
        "routerInstructions": "材料对照交给 Worker。",
        "workerInstructions": "给出结论及对应的原文依据。",
        "skillIds": ["document-reader"],
        "extensionIds": ["document-tools"],
        "memoryFields": []
      }
    }
  }
}
```

也可只编辑顶层注册表，再在后台“业务 · 提示词 → 技能与工具”选择。后台目前没有上传 ZIP、选择服务器目录或目录同步功能；更新文件由部署者在服务机器上完成。技能与扩展 ID 为小写字母开头、只含小写字母/数字/连字符的 1–80 字符字符串，每类最多 64 项。技能 ID 不能使用保留资源根 `workspace`、`run`、`history`。

技能目录含 `SKILL.md`，按需附带 `references/`、`scripts/`、数据或其他必要资源。通用文件工具将共享资源作为只读根；扩展可显式注册执行允许的持久化操作的专用工具，其业务校验和写入实现归属扩展或 skill，不放宽通用文件工具的写入范围。脚本不能隐式依赖旧机器人源码或个人绝对路径。已有技能的工具接入可以由扩展提供；仅注册目录不会自动运行其中任意脚本。

## 扩展工具最小示例

上述 `~/.local/share/chatopus/tools/document-tools.mjs` 可以先实现一个不依赖外部服务的示例工具：

```js
export async function createSession(options, context, host) {
  return {
    systemContext: '需要精确统计文本长度时使用 document_text_length。',
    tools: [{
      name: 'document_text_length',
      description: '按 Unicode 码点统计传入文本的长度。',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 10000 } },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(args, signal) {
        signal?.throwIfAborted();
        if (typeof args?.text !== 'string' || args.text.length > 10000) {
          throw new Error('Expected text with at most 10000 UTF-16 code units');
        }
        return { codePoints: [...args.text].length };
      },
    }],
    async close() {},
  };
}
```

扩展导出 `createSession(options, context, host)`，返回 `tools`、`systemContext` 和异步 `close()`。每次 Worker 运行创建独立会话；工具通过 `execute(args, signal)` 执行，需遵守取消和资源清理。`context` 提供任务/运行 ID、修订号、工作目录及取消信号，`host` 提供通用工具 SDK。模块会在服务进程内执行，只安装可信代码。

可选钩子包括 `prepareInputs`、`finalizeAnswer`、`finalizeReport`、`resolveImages`；模块可提供 `diagnose`、`routingFields` 和 `validateRoutingMetadata`。声明路由命名空间时必须提供验证器，工具名及命名空间不能重复。扩展不能覆盖宿主输入、修改报告的任务/运行/修订绑定，或把失败报告改成成功。接口以 [capabilities.ts](../src/capabilities.ts) 为准。业务计算、特定文件格式、站点规则以及领域结果校验归扩展和技能；宿主负责任务绑定、资源范围、取消、超时和最终投递。

## 内置工具、浏览器与插件

通用资源工具包括 `skills_list`、`resource_read`、`resource_files`、`resource_search`、`artifact_write`、`artifact_publish`、`json_query`、`csv_query`、`web_fetch`。文件搜索需要 `rg`，CSV 查询需要配置的 `python`。共享技能只读；`workspace` 为本话题持久产物，`run` 为本次运行目录，`history` 为以往运行的只读产物。

需要交付群文件时，Worker 先通过 `artifact_write` 或已启用工具生成产物，再调用 `artifact_publish({path, root?: 'workspace' | 'run', name?})` 登记。`path` 是所选产物根下的相对路径；`name` 是可选的群文件展示名。工具返回 `artifactId`，Worker 在最终报告的 `files` 数组中选择本轮登记的 ID。生成文件或登记成功本身不会发送到群，宿主接受当前有效报告后才逐文件上传；模型不能把本地路径或外部 URL 直接当作文件附件。

每次回复最多 4 个文件，单个最多 10 MiB，合计最多 20 MiB。普通任务和定时 Worker 均可交付。所有文件上传确认后发送回复正文；部分成功时保留逐文件回执，重试跳过已经成功的文件，结果未知时停止自动投递。实际群文件上传取决于 QQ 桥接能力及群权限，详见 [平台投递](platform.md#qq-group-files)。

配置顶层 `browser` 后才提供 `browser_tools`、`browser_call`：

```json
{
  "browser": {
    "command": "npx",
    "args": ["--yes", "@playwright/mcp@0.0.85", "--headless", "--browser", "chromium"],
    "networkIsolation": "managed",
    "env": {},
    "timeoutMs": 90000,
    "allowedTools": ["browser_navigate", "browser_snapshot", "browser_take_screenshot"]
  }
}
```

默认受管模式只接受固定版本的 Playwright MCP（此例已验证 CLI 参数），需要先安装该版本对应的 Chromium：`npx --yes --package @playwright/mcp@0.0.85 playwright install chromium`。宿主管理独立浏览器、认证出站代理、回环代理绕过规则及 service worker 开关，拒绝覆盖这些设置的启动参数或环境变量。每个任务结束后关闭浏览器和代理。代理逐连接校验全部 DNS 结果并连接已验证地址，网页跳转及子资源也受相同限制；HTTP/HTTPS 仅使用默认端口。

已有自定义 MCP 配置须选择受管方式，或在部署者已提供独立网络隔离后显式设置 `networkIsolation: "external"`；该模式不启动宿主代理。仅靠导航 URL 检查或 Playwright 的 origin 允许列表不能隔离跳转和子资源。不要让浏览器连接可访问管理后台或其他私有服务的网络。

内置网页访问与受管浏览器都要求 DNS 返回真实公网地址。若本地代理的 fake-IP 模式将网站解析到 `198.18.0.0/15` 等保留网段，请为运行进程配置返回真实地址的 DNS/代理规则；这些地址会被明确拒绝，不按域名外观放行。

子进程工作目录是任务工作区，因此自定义脚本参数应使用绝对路径。MCP 默认继承有限环境变量，并叠加 `env` 的字面值；它不是 `${ENV}` 插值器。配置允许列表还会与宿主 [浏览器策略](../src/tools/browser-policy.ts) 相交，并非任意 MCP 工具都能接入。需要图片回复时，调用 `browser_take_screenshot` 不传 `filename`，使 Playwright MCP 返回图片内容；指定文件名只保存文件，不会登记可发送图片。返回的截图 ID 可在 Worker 报告中选择发送；截图本身不触发群发送，最终附件由本轮宿主产物记录解析和验证。

顶层 `plugins` 装载的是 Cordis/dsh 插件，可选择 Router、Worker 或两者，详见 [插件示例](runtime.md#可信-agent-插件)。它不参与业务 `extensionIds` 选择；需要按业务启用的工具应实现为扩展。浏览器配置同样不是业务扩展注册项。

## 验证与更新

运行 `npm run doctor` 检查**所有业务配置引用**的技能和扩展，即使某业务暂未绑定群。它检查技能文件存在性、导入扩展及执行可选 `diagnose`，并检查已配置浏览器命令；不能据此认定模型凭据或每项工具实际可用。真实调用可在模型配置完成后用终端 `ask` 验证，会产生 API 用量和启用工具的实际操作。

新调用加载新注册及业务选择，`SKILL.md` 和扩展入口文件参与能力版本识别。在途 Worker 保持原配置；扩展依赖文件、Python 环境或 npm 包升级后重启服务。更新业务数据、算法和脚本也须执行扩展自身的回归，不能只看宿主测试通过。

禁用扩展前先移除各业务引用，再设置 `enabled: false`；删除技能前也先移除 `skillIds` 引用。启用但不可用的必需扩展会明确报错，不能静默跳过校验。外部领域回归与其实现一起维护，宿主测试验证通用契约和隔离。
