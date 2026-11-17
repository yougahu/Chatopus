# 从零部署与运行

本文把源码、私有配置和运行状态分开，适合首次部署和已有部署的维护。产品能力、Router/Worker 架构和后台概览请先看 [README](../README.md)。

安装教程中使用的示例路径是 Linux/macOS 上的普通用户目录；请替换为自己的路径。不要把 `.env`、`config.local.json`、SQLite、日志、外部 Skill 或工具放进源码仓库。

## 部署前准备

### 硬件与网络

优先支持 **Linux x64、Linux arm64、macOS arm64**，CI 为三个目标配置原生 runner，验证源码安装、默认后台和离线测试。本指南使用 Linux 的 Bash / zsh 命令，并提供 systemd 服务配置；macOS 可以使用同样的源码安装和终端命令，常驻服务另按 [运行维护](operations.md) 配置。需要持久化磁盘，以及能访问 npm 和所选模型服务的网络。浏览器和 OpenViking 有额外资源需求，各自验证对应平台的外部制品。

最简单的接法是让 QQ 接入端与 Chatopus 同机运行。CLI 的 OneBot 和管理后台都只监听回环地址；异机接入使用下文的 SSH 隧道。

### 必需软件

- Node.js **22.16.0 以上的 22.x 版本**，或者 Node.js 24.x 及更高版本（与 `package.json` 的 engines 一致）。
- npm（随 Node.js 一起安装）。
- Git（从源码仓库安装时需要）。
- [ripgrep](https://github.com/BurntSushi/ripgrep#installation)（命令为 `rg`，用于内置资源搜索）。

可以从 [Node.js 官方下载页](https://nodejs.org/en/download/) 安装 Node.js。确认版本：

```bash
node --version
npm --version
git --version
rg --version
```

### 按需准备的服务与可选软件

- 模型供应商：实际问答前需要与所选 API 协议兼容的服务（示例使用 OpenAI Responses API），或自己注册的兼容 Provider；模型和密钥可在后台补配，首次安装无需填写。
- QQ 接入端：接入群聊时才需要支持 OneBot 11 反向 WebSocket 的实现，例如 NapCat、go-cqhttp 或其他同类实现；仅启动后台或终端问答不需要。
- Python 3：内置 CSV 查询和部分外部能力需要；默认解释器为 `python3`，可通过顶层 `python` 指定。
- Playwright Chromium：只有在启用浏览器能力时才需要。
- OpenViking 或其他兼容服务：只有在启用长期记忆时才需要。仓库提供的原生制品安装流程优先支持 Linux x64、Linux arm64、macOS arm64；其他平台请自行提供并验证兼容后端。

## 从零完成一次部署

下面的流程把**源码、运行配置和运行状态分开**。示例使用 `/opt/chatopus` 保存源码，使用 `/var/lib/chatopus` 保存私有配置、能力和运行数据。它们是首次部署的新目录；已有安装请按 [备份、升级和迁移](#备份升级和迁移) 操作。

后续命令沿用 `CHATOPUS_SOURCE` 和 `CHATOPUS_DEPLOY` 两个变量，另开终端时需重新设置。所有 JSON 示例都是要合并到已有配置的片段，**不要用片段替换整份 `config.local.json`**。

首次安装可使用下面的安装脚本，或手动完成**步骤 1～4**，即可打开管理后台。模型和 QQ 接入均可稍后配置；步骤 5～10 按要使用的功能选择，不是首次安装的必选项。

### 可稍后在后台配置的可选项

| 配置项 | 后台入口 | 何时需要 |
| --- | --- | --- |
| Router、Worker 的模型、API 地址、协议、推理等级和 API Key | 模型 · 插件 | 实际模型问答前补齐；安装和启动后台时可保留占位模型与空密钥 |
| 业务提示词、人格、房间绑定和已注册的 Skill／扩展／成员字段选择 | 业务 · 提示词 | 按业务需要配置；默认通用助手可先保留空配置 |
| 唤起关键字（`botCallNames`） | 模型 · 插件 | 默认调用名可直接保留；自定义后需重启机器人 |

外部 Skill、扩展和成员字段仍需先在部署端安装或注册，后台负责选择和绑定。浏览器、长期记忆、定时任务也可留待后续按需启用，见步骤 8～10。

### 使用安装脚本（推荐）

准备好 Node.js、npm 和 `rg` 后，从仓库运行 [安装脚本](../scripts/install.mjs)：

```bash
git clone https://github.com/yougahu/Chatopus.git chatopus
cd chatopus
export CHATOPUS_SOURCE="$PWD"
export CHATOPUS_DEPLOY="$HOME/.local/share/chatopus"
chatopus() { "$CHATOPUS_DEPLOY/chatopus" "$@"; }
node scripts/install.mjs --deploy-dir "$CHATOPUS_DEPLOY" --start-admin
```

脚本支持 Linux 和 macOS，会检查必要命令、执行 `npm ci --include=dev`、创建私有配置及 `runtime/`、生成固定工作目录的 `chatopus` 启动命令，并运行 `doctor`。**无需提供 Router、Worker 的模型或密钥**；`--start-admin` 会在检查通过后启动后台，访问终端显示的回环地址，默认是 `http://127.0.0.1:8092`。远程服务器通过步骤 4 的 SSH 隧道访问。

默认部署目录为 `~/.local/share/chatopus`，与下方手动示例的 `/var/lib/chatopus` 二选一。脚本不需要 sudo，部署目录需当前用户可写。重复执行会保留已有 `.env`、`config.local.json` 和状态数据，仅更新由脚本生成的启动命令；自定义启动文件会提示冲突，避免覆盖。

可按需指定目录和端口，或复用当前源码已安装的依赖：

```bash
node scripts/install.mjs --deploy-dir /srv/chatopus --start-admin --port 8093
node scripts/install.mjs --deploy-dir "$CHATOPUS_DEPLOY" --skip-deps
node scripts/install.mjs --help
```

也可使用 `npm run setup -- <选项>`。不传 `--start-admin` 时，安装结束会输出后台启动与配置检查命令；按 Ctrl-C 停止后台后，仍可通过生成的启动命令再次运行。源码或 Node 路径改变后，重新运行脚本即可更新启动命令。下面的步骤 1～4 是手动安装方式；脚本完成后可直接按需继续步骤 5～10。

### 1. 下载源码并安装依赖

```bash
export CHATOPUS_SOURCE=/opt/chatopus
export CHATOPUS_DEPLOY=/var/lib/chatopus

# 首次创建目录，并交给当前普通用户管理。后续 npm / Node 命令不使用 sudo。
sudo install -d -m 755 -o "$(id -u)" -g "$(id -g)" "$CHATOPUS_SOURCE"
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" "$CHATOPUS_DEPLOY"

export CHATOPUS_REPOSITORY_URL=https://github.com/yougahu/Chatopus.git
git clone "$CHATOPUS_REPOSITORY_URL" "$CHATOPUS_SOURCE"
cd "$CHATOPUS_SOURCE"
npm ci
```

`npm ci` 按锁文件安装依赖。项目直接通过 `tsx` 运行 TypeScript，没有额外的构建步骤；不要使用 `npm ci --omit=dev`，运行入口需要其中的 `tsx`。安装后在源码目录执行一次默认部署验证：

```bash
npm run smoke:defaults
```

预期输出包含 `Default doctor, Chatopus admin, empty capabilities and local access controls passed`。它使用临时目录，不需要模型密钥，不连接 QQ。生产运行数据在下一步单独创建。

### 2. 创建仓库外的配置目录

```bash
mkdir -p "$CHATOPUS_DEPLOY/runtime"
cp "$CHATOPUS_SOURCE/.env.example" "$CHATOPUS_DEPLOY/.env"
cp "$CHATOPUS_SOURCE/config.example.json" "$CHATOPUS_DEPLOY/config.local.json"
chmod 700 "$CHATOPUS_DEPLOY"
chmod 600 "$CHATOPUS_DEPLOY/.env" "$CHATOPUS_DEPLOY/config.local.json"
```

`config.local.json` 中的相对路径以**启动时的当前工作目录**为基准。为了让所有运行数据固定在外置目录，把 `stateDir` 改成绝对路径：

```bash
node -e 'const fs=require("node:fs"); const [file,state]=process.argv.slice(1); const c=JSON.parse(fs.readFileSync(file,"utf8")); c.stateDir=state; fs.writeFileSync(file, JSON.stringify(c,null,2)+"\n");' \
  "$CHATOPUS_DEPLOY/config.local.json" "$CHATOPUS_DEPLOY/runtime"
```

然后进入部署目录。后面的配置命令都从这里执行：

```bash
cd "$CHATOPUS_DEPLOY"
```

> 不要把 `.env`、`config.local.json`、`runtime/`、模型缓存、浏览器缓存或外部能力目录提交到源码仓库。仓库内的 `config.example.json` 和 `.env.example` 只包含可公开的占位值。

### 3. 创建启动脚本并运行配置检查

源码、配置和运行目录分开后，先创建一个固定工作目录的启动脚本。它会把本机 Node 路径和源码路径写入脚本，使之后从任何目录启动都读取同一份私有配置：

```bash
cat > "$CHATOPUS_DEPLOY/chatopus" <<EOF
#!/bin/sh
set -eu
cd "$CHATOPUS_DEPLOY"
exec "$(command -v node)" "$CHATOPUS_SOURCE/node_modules/tsx/dist/cli.mjs" "$CHATOPUS_SOURCE/src/cli.ts" "\$@"
EOF
chmod 700 "$CHATOPUS_DEPLOY/chatopus"

"$CHATOPUS_DEPLOY/chatopus" doctor
```

`doctor` 会输出脱敏后的配置摘要，并检查已被业务 profile 引用的 Skill、扩展和浏览器命令，同时显示模型密钥是否已配置。它不会调用模型，也不会请求 OpenViking；遇到错误时先修复 `doctor` 报告的问题，再继续启动服务。

首次安装尚未配置密钥时，`routerApiConfigured` 和 `workerApiConfigured` 为 `false` 是正常的，模型也可暂时保留 `YOUR_MODEL_ID`；这些状态不阻止启动管理后台。后续补齐密钥后再检查对应标记为 `true`，并通过真实问答验证模型链路。

为了缩短当前终端中的后续命令，可以定义：

```bash
chatopus() {
  "$CHATOPUS_DEPLOY/chatopus" "$@"
}

chatopus doctor
```

另开终端可以直接运行 `/var/lib/chatopus/chatopus <命令>`。修改 Node 安装位置、源码目录或部署目录后，需要重新生成启动脚本。

### 4. 启动管理后台

```bash
chatopus admin --port 8092
```

管理后台默认只监听 `127.0.0.1`。在服务器上访问时，可以通过 SSH 隧道打开本地浏览器：

```bash
ssh -N -L 8092:127.0.0.1:8092 user@your-server
```

然后访问 `http://127.0.0.1:8092`。首次安装应看到空的消息和任务列表。**到这里已完成基础安装，无需提前填写模型、API Key 或 QQ 配置。** 后续可在“模型 · 插件”补配 Router、Worker 的模型和密钥，在“业务 · 提示词”配置人格、指引和能力选择；页面详细说明见 [管理后台](admin.md)。

前台命令会持续运行。完成后台配置后，可按 Ctrl-C 停止后台，再按需继续终端验证；需要同时运行时另开终端使用启动脚本。后台与机器人是两个独立进程，最终可一起注册为服务。

管理后台当前没有独立登录层，请保持端口只监听回环地址，或放在已经认证的反向代理之后，不要直接暴露到公网。

### 5. 配置模型和密钥（可选，可稍后在后台完成）

仅在准备使用终端问答或群聊 Agent 时需要完成本节；只安装和启动管理后台时可以跳过。

在后台“模型 · 插件”中，分别填写 Router 和 Worker 的模型名称、API Endpoint、协议、推理强度和 API Key，保存对应角色。后台会将模型配置写入私有 `config.local.json`，将密钥写入 `.env` 的 `ROUTER_API_KEY` / `WORKER_API_KEY`；新模型调用自动读取更新，正在执行的 Worker 保留启动时的配置。密钥不会回显，留空保存表示保留已有密钥。

#### 手动配置方式（可选，后台保存后无需重复）

也可以直接编辑 `$CHATOPUS_DEPLOY/.env`，填写 Router 和 Worker 使用的密钥。例如：

```dotenv
ROUTER_API_KEY=replace-with-router-key
WORKER_API_KEY=replace-with-worker-key
```

编辑 `$CHATOPUS_DEPLOY/config.local.json` 中的 `router` 和 `worker`，保留其他示例字段：

```json
{
  "router": {
    "provider": "boe-router",
    "model": "your-router-model",
    "api": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "ROUTER_API_KEY",
    "reasoningEffort": "low",
    "maxTokens": 1200
  },
  "worker": {
    "provider": "boe-worker",
    "model": "your-worker-model",
    "api": "openai-responses",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "WORKER_API_KEY",
    "reasoningEffort": "high",
    "maxTokens": 16000
  }
}
```

要点：

- `model` 必须是你的供应商实际支持的模型 ID。
- `baseUrl` 应指向与 `api` 协议对应的兼容地址；远程服务使用 HTTPS。
- 上面的 `openai-responses` 需要供应商支持 Responses API。仅支持 Chat Completions 的服务应使用 `openai-completions`，并按实际模型能力设置推理参数；不支持推理等级的模型可使用 `reasoningEffort: "off"`。
- `apiKeyEnv` 是环境变量名，不是密钥本身。
- Router 负责规划，Worker 负责执行；可以使用同一模型，也可以分别使用更快、更强或更便宜的模型。
- `.env` 中的值会覆盖当前进程继承的同名环境变量；即使值为空，也会覆盖继承值。
- 如果供应商需要自定义环境变量，可以修改 `apiKeyEnv`，并在 `.env` 中填写对应密钥。只设置 `OPENAI_API_KEY` 不会自动填充示例中的两个角色密钥。

完整字段说明见 [`docs/configuration.md`](configuration.md)。

### 6. 终端问答验证（可选，完成模型配置后）

本节会真实调用模型，需先完成步骤 5。尚未配置模型时可跳过，之后再验证。

```bash
chatopus ask "请用一句话说明你已经完成部署检查。"
```

预期终端出现一条模型回答。简单问题可能由 Router 直接完成；若要同时检查 Worker 和产物写入，再执行：

```bash
chatopus ask '请交给 Worker：计算每箱12支笔、3箱共有多少支；使用 artifact_write 将结果写入 verification.txt，再回答总数。'
```

预期回答包含 `36`，对应 `runtime/ask/` 子目录中有本次独立验证的状态和工作空间，可在后台切换到最近终端验证数据源核对 Worker、工具轨迹和产物。模型是否遵循指令需要检查实际结果，不能只看命令退出码。

`ask` 会产生真实模型用量，也会执行当前启用的能力；它使用独立状态子目录和内存投递器，不发送 QQ 消息。首次验证保持 Skill、扩展、浏览器、记忆和定时任务关闭，基础链路通过后再逐项启用。

### 7. 接入 OneBot 11 和 QQ 群（可选，仅群聊需要）

仅启动后台或使用终端问答时可跳过本节。启用群聊问答前，先完成步骤 5 的模型配置，再准备下面的 QQ 身份、访问令牌和允许群。

以 NapCat 为例：先按 [NapCat 文档仓库](https://github.com/NapNeko/NapCatDocs) 的安装与启动说明安装并登录机器人 QQ，让该账号加入测试群。然后在 WebUI 的网络配置中添加 **WebSocket 客户端（反向 WS）**，而不是 WebSocket 服务端；不同版本的配置页面和文档路径可能变化。

先在 `$CHATOPUS_DEPLOY/.env` 配置机器人身份和访问令牌：

```dotenv
QQ_SELF_ID=100000001
ONEBOT_ACCESS_TOKEN=replace-with-onebot-token
```

把示例 QQ 号替换为机器人登录账号，并设置一个独立的随机 Token；它不是模型 API Key。可以用 `node -p 'require("node:crypto").randomBytes(32).toString("hex")'` 生成，再将相同值填写到 `.env` 和 QQ 接入端。

再在 `$CHATOPUS_DEPLOY/config.local.json` 开启 QQ 适配器，并限制允许接入的群：

```json
{
  "qq": {
    "enabled": true,
    "allowedGroupIds": ["123456789"],
    "port": 8083
  },
  "botCallNames": ["助手", "机器人"]
}
```

Chatopus 会在回环地址提供 OneBot 11 反向 WebSocket 服务，默认地址为：

```text
ws://127.0.0.1:8083/onebot/v11/ws
```

在 NapCat、go-cqhttp 或其他 OneBot 11 客户端中填写：

- **连接类型**：反向 WebSocket。
- **目标地址**：上面的 WebSocket 地址。Chatopus CLI 固定只监听回环地址；如果 QQ 接入端在另一台机器，请在 QQ 接入端建立 SSH 本地转发，让它的 `127.0.0.1:8083` 转发到 Chatopus 主机的 `127.0.0.1:8083`，不要直接把 Chatopus 端口暴露到公网。
- **Access Token**：与 `ONEBOT_ACCESS_TOKEN` 完全一致。
- **请求头**：客户端必须发送 `Authorization: Bearer <token>` 和与 `QQ_SELF_ID` 一致的 `X-Self-ID`。Token 放在 URL 查询参数中不受支持。
- **消息格式**：使用 OneBot 11 标准数组消息格式（`messagePostFormat=array`）。
- **连接开关**：启用该 WebSocket 客户端，保存配置，并关闭自身消息上报（`reportSelfMessage=false`）。

异机接入端可以使用类似下面的隧道（命令在 QQ 接入端执行）：

```bash
ssh -N -L 8083:127.0.0.1:8083 user@chatopus-server
```

不同 OneBot 实现的配置界面和字段名略有差异，请以所用实现的反向 WebSocket 文档为准。Chatopus 只负责提供 OneBot 服务端，不会替你安装或登录 QQ 客户端。

启动群聊服务：

```bash
chatopus serve
```

启动时应看到 `Chatopus listening on 127.0.0.1:8083; 1 allowed group(s).`。这只证明服务正在监听；还需在 QQ 接入端确认 WebSocket 已连接，并在允许的测试群里真正选择机器人账号进行 @：

```text
@机器人 每箱12支笔，3箱共有多少支？
```

预期收到包含 `36` 的回复，后台出现这条群消息、路由记录以及状态为 `sent` 的回复投递。纯文本 `@机器人` 不等于 QQ 的真实 @；也可以发送 `助手，每箱12支笔，3箱共有多少支？` 验证调用名。

`allowedGroupIds` 必须填写至少一个允许的群 ID。Chatopus 接收允许群中的普通消息作为上下文，由 Router 决定是否回应，并忽略自己的消息与私聊。完成前台验证后按 Ctrl-C 停止，进入下文的常驻服务配置。

### 8. 接入外部 Skill、工具和插件（可选）

能力目录建议放在用户数据目录或专用部署目录，不要放进源码仓库。例如：

```bash
mkdir -p "$CHATOPUS_DEPLOY/skills" "$CHATOPUS_DEPLOY/tools"
```

在 `config.local.json` 中注册外部 Skill：

```json
{
  "skills": [
    {
      "id": "document-reader",
      "description": "检索文档并保留段落依据",
      "path": "./skills/document-reader"
    }
  ],
  "extensions": [
    {
      "id": "document-tools",
      "module": "./tools/document-tools.mjs",
      "version": "1",
      "enabled": true,
      "options": {}
    }
  ]
}
```

先将实际 Skill 放入 `skills/document-reader/`，其中必须有 `SKILL.md`；工具模块必须真实存在，并实现宿主扩展接口。[技能和工具文档](skills.md) 提供可直接创建的最小模块示例。若暂时没有扩展工具，删除上面的扩展注册，并把下面的 `extensionIds` 设为 `[]`。

这里的 `./skills` 与 `./tools` 以部署目录为基准，均在源码仓库外。也支持 `~/` 和绝对路径；JSON 不展开 `$HOME`。只注册能力还不会在当前业务中启用，必须同时修改 profile：

```json
{
  "business": {
    "defaultProfile": "default",
    "profiles": {
      "default": {
        "name": "通用助手",
        "commonInstructions": "回答要简洁，先给结论。",
        "routerInstructions": "需要检索和比对材料的任务交给 Worker。",
        "workerInstructions": "执行工具后核对结果。",
        "personaText": "语气自然，区分事实、推测与待确认事项。",
        "skillIds": ["document-reader"],
        "extensionIds": ["document-tools"],
        "memoryFields": []
      }
    },
    "roomProfiles": {
      "qq:100000001:123456789": "default"
    }
  }
}
```

房间键格式为 `qq:<机器人QQ号>:<群号>`，要与当前账号和群保持一致；未绑定的群使用 `defaultProfile`。能力注册和业务选择对后续新调用生效，已有任务保留启动快照。再次运行 `chatopus doctor`，确认所选 Skill 和扩展均可加载。

启用浏览器时，按 [浏览器接入](skills.md#内置工具浏览器与插件) 安装指定版本的 Playwright MCP 与 Chromium，并配置网络隔离。Cordis/dsh 插件通过顶层 `plugins` 加载，与按业务选择的扩展不同，见 [插件示例](runtime.md#可信-agent-插件)。外部模块属于可信本地代码，宿主不会把它们变成沙箱。

### 9. 启用 OpenViking 长期记忆（可选）

默认关闭记忆，不影响基本聊天。这项集成目前需要部署者自行提供并验证兼容后端。原生制品安装器优先支持 Linux x64、Linux arm64、macOS arm64，并按清单和 wheel tags 选择制品；它不下载制品，也不把 OpenViking 作为默认依赖。先阅读 [后端要求](openviking-operations.md#后端与平台要求)，准备后端后再合并：

```json
{
  "memory": {
    "enabled": true,
    "provider": "openviking",
    "baseUrl": "http://127.0.0.1:1933",
    "namespace": "chat-assistant",
    "rootKeyEnv": "OPENVIKING_ROOT_API_KEY",
    "timeoutMs": 15000,
    "recallBytes": 6000,
    "ingestBatchSize": 32,
    "ingestBatchWindowMs": 300000,
    "fields": []
  }
}
```

并在 `.env` 中设置：

```dotenv
OPENVIKING_ROOT_API_KEY=replace-with-openviking-root-key
```

先按后端文档检查 `/ready`，再重启机器人和后台；`doctor` 不会请求这个接口。随后在测试群明确表达一条偏好，并在后台记忆页核对摄取状态、实际画像和来源，不能只看“已配置”。首次启用不会自动导入全部历史消息。

`fields: []` 表示没有自定义字段，通用字段仍可用。自定义字段必须是定义对象，再由 profile 的 `memoryFields` 选择；完整可合并示例见 [成员字段](member-fields.md)。保留已有 namespace、根凭据与账号映射，具体运维见 [OpenViking](openviking-operations.md)。

### 10. 启用定时任务（可选）

默认关闭。确认服务稳定后再开启：

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

保存后重启机器人和后台。在后台“定时任务”中核对群聊角色权限，并创建一条发往测试群的一次性固定文字提醒，检查执行与投递状态。只有 `serve` 运行调度器，单独运行 `admin` 不会触发计划。

周期任务默认至少间隔一小时；一次性提醒不受这个周期限制。后台创建的计划是系统任务，群聊创建的计划受房间、所有者和角色权限限制。完整行为见 [定时任务](scheduled-tasks.md)。

## 让它长期运行

### systemd 示例

本节仅在需要开机自启和常驻运行时使用。若暂时只使用管理后台，可仅为 `admin` 创建服务（将下方循环改为 `for chatopus_role in admin`，并只启用 `chatopus-admin`）；机器人服务在完成模型和 QQ 配置后再添加。

在使用 systemd 的 Linux 主机上，先停止前台的 `serve` 和 `admin`，然后以完成安装的同一普通用户执行下面的命令。它为机器人和后台分别生成服务，自动填入当前用户、部署目录和 PATH：

```bash
for chatopus_role in serve admin; do
  cat > "$CHATOPUS_DEPLOY/chatopus-$chatopus_role.service" <<EOF
[Unit]
Description=Chatopus $chatopus_role
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$CHATOPUS_DEPLOY
Environment="PATH=$PATH"
ExecStart="$CHATOPUS_DEPLOY/chatopus" $chatopus_role
Restart=on-failure
RestartSec=5
TimeoutStopSec=120
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
  sudo install -m 644 "$CHATOPUS_DEPLOY/chatopus-$chatopus_role.service" /etc/systemd/system/
done

sudo systemctl daemon-reload
sudo systemctl enable --now chatopus-serve chatopus-admin
sudo systemctl status chatopus-serve chatopus-admin
sudo journalctl -u chatopus-serve -n 100 --no-pager
```

两个服务分别应显示 `active (running)`。`.env` 由应用从部署目录读取，不需要把密钥写进 unit；PATH 用于寻找 `rg`、Python 和可选 MCP 命令。后台仍只监听 `127.0.0.1:8092`，通过前述 SSH 隧道访问。Node 安装路径改变后，同时更新启动脚本与服务 PATH。

日常操作：

```bash
sudo systemctl restart chatopus-serve chatopus-admin
sudo systemctl stop chatopus-serve chatopus-admin
sudo journalctl -u chatopus-serve -f
sudo journalctl -u chatopus-admin -f
```

这两条 `journalctl -f` 是各自持续跟随日志的命令，按需单独执行。一个 `stateDir` 可以由机器人和其后台共享，但不能同时运行两个 `serve` 写入同一状态库。

## 部署后的验证清单

按已完成配置的范围验证；基础安装只需确认默认检查和管理后台可用，模型、QQ、常驻服务及可选能力留待启用后再验收。遇到失败就停在对应步骤排查：

```bash
# 1. 配置与能力加载；不验证远端模型和 OpenViking
chatopus doctor

# 2. 可选：完成模型配置后，进行终端真实问答（会产生模型调用）
chatopus ask "输出部署验证通过"

# 3. 查看运行状态、线程和 Outbox
chatopus inspect

# 4. 可选：接入 QQ 并配置 systemd 后，检查日志并在允许群里发送一次带调用名的消息
sudo journalctl -u chatopus-serve -n 100 --no-pager
```

按部署范围确认以下结果：

| 检查 | 适用范围 | 通过标准 |
| --- | --- | --- |
| 默认安装 | 基础安装必选 | `smoke:defaults` 通过，`doctor` 无配置错误，空后台正常；模型和密钥可暂未配置 |
| 模型与 Worker | 可选，完成模型配置后 | 真实 `ask` 得到结果；Worker 验证可核对执行轨迹及 `verification.txt` |
| QQ 输入与投递 | 可选，启用 QQ 后 | 接入端显示已连接；测试群有实际回复，后台投递状态为 `sent` |
| 常驻服务 | 可选，配置常驻运行后 | 已启用的 `chatopus-admin`／`chatopus-serve` 为 `active (running)`，停止前台进程后仍可使用 |
| 可选功能 | 仅验证已开启的能力 | 浏览器实际浏览、记忆来源查询、定时提醒到达测试群 |

`inspect` 在全新部署或没有 Worker 任务时返回空列表是正常现象；后台能打开、密钥显示已配置、命令退出码为零，分别只代表对应一步完成。

开发者在源码目录还可以运行：

```bash
cd "$CHATOPUS_SOURCE"
npm run check:release
npm run smoke:defaults
```

其中 `check:release` 会执行 TypeScript 检查、TypeScript 与 Python 离线测试、版权声明和公开文件检查，需要带 pip 的 Python 3；`smoke:defaults` 使用隔离的临时运行目录验证默认路径，不会向真实 QQ 群发消息。

## 配置速查

| 配置 | 作用 | 公开配置示例 |
| --- | --- | --- |
| `stateDir` | SQLite、Outbox、线程、锁和运行证据目录 | `~/.local/share/chatopus/runtime`；本文设置为部署目录下的 `runtime` |
| `router` | Router 模型、Provider、API 地址和密钥环境变量 | 可稍后在后台配置；实际模型问答前填写 |
| `worker` | Worker 模型、Provider、API 地址和密钥环境变量 | 可稍后在后台配置；执行 Worker 任务前填写 |
| `qq.enabled` | 是否启动 OneBot 反向 WebSocket | `false` |
| `qq.port` | OneBot 监听端口 | `8083` |
| `qq.allowedGroupIds` | 允许处理的群 ID 列表 | 空；启用 QQ 前必须至少填写一个 |
| `botCallNames` | 群聊中触发助手的调用名 | `["助手", "机器人"]`；可稍后在后台修改，真实 @ 也可唤起 |
| `skills` / `extensions` | 外部 Skill 和扩展工具 | 空 |
| `memory.enabled` | 是否启用 OpenViking 记忆 | `false` |
| `scheduledTasks.enabled` | 是否启用定时任务 | `false` |
| `business` | profile、房间绑定、人格和能力选择 | `default` profile；可稍后在后台配置 |
| `persistentRouter` | 每群持续 Router 会话 | `true` |
| `concurrency` | Worker 并发上限 | `5` |
| `routerTurnTimeoutMs` | 单轮 Router 超时 | `120000` |
| `routerQueueTimeoutMs` | Router 排队超时 | `180000` |

完整字段、代码回退值和热加载范围见 [配置参考](configuration.md)。模型和业务调整用于后续新调用；QQ、调用名、路径、时限、插件、浏览器、Python、记忆后端与定时任务部署参数变更需要重启相应进程。

## 备份、升级和迁移

### 备份

至少备份以下内容，并把密钥和用户数据放在受限权限的存储中：

- `$CHATOPUS_DEPLOY/.env`。
- `$CHATOPUS_DEPLOY/config.local.json`。
- `$CHATOPUS_DEPLOY/runtime/`，包括 SQLite、WAL、Outbox 和锁状态。
- 外部 Skill、扩展工具、插件和浏览器配置。
- OpenViking 服务端的对应命名空间和数据（如果启用）。

备份前停止机器人和后台写入，再复制完整部署目录；运行中仅复制 SQLite 主文件或把主文件与 WAL 分次复制，都不能保证一致性。需要在线备份时使用 SQLite 支持的一致性备份方式。

按本文目录部署时，可以这样创建离线备份：

```bash
sudo systemctl stop chatopus-serve chatopus-admin
umask 077
mkdir -p "$HOME/chatopus-backups"
tar -czf "$HOME/chatopus-backups/chatopus-$(date +%Y%m%d-%H%M%S).tar.gz" \
  -C "$CHATOPUS_DEPLOY" .
git -C "$CHATOPUS_SOURCE" rev-parse HEAD
sudo systemctl start chatopus-serve chatopus-admin
```

保存源码提交号、备份文件和该版本的锁文件。放在部署目录之外的 Skill、工具和 OpenViking 数据须另行备份。备份含密钥与聊天数据，不提交到 Git。

### 升级

```bash
# 先完成上一节备份，再把占位值改为目标版本标签或提交号。
export CHATOPUS_VERSION=REPLACE_WITH_TAG_OR_COMMIT
sudo systemctl stop chatopus-serve chatopus-admin
cd "$CHATOPUS_SOURCE"
git fetch --tags
git checkout "$CHATOPUS_VERSION"
npm ci
npm run check:release
"$CHATOPUS_DEPLOY/chatopus" doctor
sudo systemctl start chatopus-serve chatopus-admin
```

任一步检查失败时先保留服务停止状态并排查。升级保留外置配置和数据，先用独立测试部署确认兼容性；涉及状态迁移时按 [运行维护](operations.md#升级与迁移) 操作，全新部署不需要历史迁移。

### 回滚

停止服务，恢复上一版源码和 `package-lock.json`，恢复与该版本匹配的配置和运行目录，再运行 `doctor`。不要让新旧版本同时写入同一个 `stateDir`。

## 常见问题

| 现象 | 检查顺序 |
| --- | --- |
| `ask` 报模型、认证或协议错误 | 检查模型 ID、余额、`baseUrl`、`api`、推理能力和 `.env`；`doctor` 的密钥标记不验证凭据是否有效。 |
| QQ 客户端无法连接 | 确认 Chatopus 已启动、端口与 `qq.port` 一致、反向 WebSocket 路径正确、Token 一致、`QQ_SELF_ID` 与客户端自 ID 一致。 |
| 能连接但群里不回复 | 检查 `allowedGroupIds`、调用名、群消息类型和 Chatopus 日志；确认消息不是机器人自己发出的回声。 |
| `skill unavailable` 或扩展加载失败 | 检查路径是否存在、是否使用 `~/` 或绝对路径、模块依赖是否安装，并再次运行 `doctor`。 |
| OpenViking 未就绪 | 确认 `baseUrl` 可访问、`OPENVIKING_ROOT_API_KEY` 正确、服务的 `/ready` 正常；记忆关闭时不要误判为故障。 |
| 管理后台端口被占用 | 修改 `admin --port`，或停止占用端口的旧实例；不要把后台直接暴露公网。 |
| 出现 Outbox `unknown` 或投递超时 | 先保存日志和 Outbox 记录，核对群消息及平台回执后判断是否已投递；未知状态不自动重发。 |
| 服务不断重启 | 查看 `sudo journalctl -u chatopus-serve`，检查配置 JSON、启动脚本中的 Node 路径、PATH、外部模块、端口和状态目录权限。 |
| 手工启动正常，systemd 启动失败 | 确认 unit 的用户、部署目录及 PATH 正确，Node 路径仍存在，用户对源码与私有目录都有所需权限。 |

## 安全与运行边界

- `.env`、`config.local.json`、SQLite、Outbox 和日志可能包含密钥或聊天内容，应限制权限并安全备份，排除在公开源码和发布包之外。
- 管理后台默认没有独立登录层，保持回环监听，或放在可信的认证代理之后。
- 外部 Skill、扩展、插件和浏览器命令属于受信代码；加载前请审核来源、依赖、网络权限和文件权限。
- 生产环境应限制 `allowedGroupIds`，并为 Router、Worker、OpenViking 使用职责明确的密钥。
- 模型请求可能产生费用；`ask`、真实群消息、`replay` 和定时任务都可能触发模型调用。
- Chatopus 只提供 OneBot 适配层，不负责 QQ 账号登录、风控、验证码或第三方客户端维护。
- Chatopus 不自动重试不确定投递；需要人工核对 Outbox 和 OneBot 证据，避免重复回复。

## 文档导航

- [`docs/index.md`](index.md)：文档总览和推荐阅读顺序。
- [`docs/configuration.md`](configuration.md)：配置字段、路径、密钥和环境变量。
- [`docs/architecture.md`](architecture.md)：Router、Worker、线程、Outbox 和存储边界。
- [`docs/runtime.md`](runtime.md)：启动、运行、检查和维护。
- [`docs/scheduled-tasks.md`](scheduled-tasks.md)：定时任务权限和执行规则。
- [`docs/openviking-operations.md`](openviking-operations.md)：OpenViking 记忆服务运维。
- [`docs/skills.md`](skills.md)：Skill、扩展、插件和浏览器能力。
- [`SECURITY.md`](../SECURITY.md)：安全边界和敏感信息处理。
- [`docs/verification.md`](verification.md)：验证、回放和发布前检查。
- [`docs/releasing.md`](releasing.md)：发布前清单和版本流程。
