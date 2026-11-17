# 运行维护

首次安装、外置配置、QQ 接入和常驻服务的完整流程见[从零部署与运行](deployment.md)。本文只保留部署完成后的日常启停、检查、备份和升级步骤，避免和安装教程重复。

## 启动与停止

安装脚本会在私有部署目录生成 `chatopus` 启动命令。下面的 `CHATOPUS_DEPLOY` 换成实际部署目录：

```bash
export CHATOPUS_DEPLOY="$HOME/.local/share/chatopus"
chatopus() { "$CHATOPUS_DEPLOY/chatopus" "$@"; }

chatopus doctor
chatopus admin --port 8092
```

后台和 QQ 服务是两个独立进程。需要接入 QQ 时，在另一个终端运行：

```bash
chatopus serve
```

`admin` 和 `serve` 都只监听回环地址；远程访问使用 SSH 隧道或已经认证的反向代理。不要把后台或 OneBot 端口直接暴露到公网，也不要让两个 `serve` 进程同时写同一个 `stateDir`。终端进程可用 Ctrl-C 停止；停止前先确认没有需要继续投递的任务。

如果没有安装脚本生成的启动命令，也可以从部署目录直接调用源码 CLI：

```bash
cd "$CHATOPUS_DEPLOY"
node --import /absolute/source/node_modules/tsx/dist/loader.mjs \
  /absolute/source/src/cli.ts doctor
```

把 `/absolute/source` 替换为源码目录，并按需将 `doctor` 换成 `admin`、`serve`、`ask` 或 `inspect`。相对配置路径以当前部署目录为基准。

## 常用检查

```bash
chatopus doctor
chatopus inspect
chatopus ask "输出一条部署验证结果"
```

`doctor` 检查被业务引用的 Skill、扩展和浏览器命令，并显示模型密钥是否已配置；它不会调用模型或 OpenViking。`inspect` 只读当前状态库中的话题和 Outbox。`ask` 使用独立的 `stateDir/ask/` 子目录验证模型链路，只输出到终端，不发送 QQ 消息，并会产生模型用量。

模型、业务提示词、人格正文、能力选择和 provider profile 对后续新调用生效；已经开始的 Worker 保留启动时的配置快照。唤起关键字、QQ、并发、时限、步骤、持续 Router、存储、插件、浏览器、Python 解释器以及 OpenViking 连接参数需要重启相应进程。详细范围见[配置参考](configuration.md#何时生效)。

## 定时任务

定时任务默认关闭。启用后只有持有状态目录锁的 `serve` 进程扫描和执行计划；后台负责保存计划、权限和操作请求，不独立启动 Worker。目标群必须位于 `qq.allowedGroupIds` 中，模型、能力和业务绑定也必须满足执行条件。

修改 `scheduledTasks` 的部署参数后重启机器人和后台。计划、角色策略和执行记录保存在状态库；后台写入后对新操作生效，运行中的执行由机器人服务按版本和取消规则处理。关闭功能会暂停未结束计划，重新启用不会自动恢复已暂停计划，应在后台检查原因后逐项恢复。

## 常驻服务

Linux 的 systemd unit 生成方式和开机自启步骤见[从零部署与运行](deployment.md#让它长期运行)。该示例会把当前用户、部署目录和 PATH 写入 unit；`.env` 和 `config.local.json` 仍由启动命令从部署目录读取，不要把密钥写入 unit。后台仍只监听 `127.0.0.1:8092`，通过 SSH 隧道访问。修改源码或 Node 路径后重新运行安装脚本，再更新 unit。

```bash
sudo systemctl restart chatopus-serve chatopus-admin
sudo systemctl stop chatopus-serve chatopus-admin
sudo journalctl -u chatopus-serve -n 100 --no-pager
sudo journalctl -u chatopus-admin -n 100 --no-pager
```

macOS 可以使用 launchd 或其他进程管理器实现同样的生命周期；服务定义应引用生成的启动命令，并把 `WorkingDirectory` 固定为部署目录。OpenViking 的 launchd 维护另见[可选长期记忆](openviking-operations.md)。

## 状态、日志与备份

运行数据都在配置的 `stateDir`，包括 SQLite、Router 会话、Worker 工作空间、Outbox、图片、日志和配置历史。它们可能包含用户资料，不属于公开源码。更改 `stateDir` 前停止机器人和后台，复制完整目录再修改配置；只改路径会创建另一份空状态，不会自动搬迁数据。

备份前停止所有写入进程，或使用 SQLite 支持的一致性备份方法。必须同时保留数据库、WAL/SHM、会话、相关工作空间、配置、账号映射和 OpenViking namespace；不能只复制正在使用的数据库主文件。示例：

```bash
sudo systemctl stop chatopus-serve chatopus-admin
mkdir -p "$HOME/chatopus-backups"
tar -czf "$HOME/chatopus-backups/chatopus-$(date +%Y%m%d-%H%M%S).tar.gz" \
  -C "$CHATOPUS_DEPLOY" .
sudo systemctl start chatopus-serve chatopus-admin
```

恢复时先解压到隔离目录，运行 `chatopus doctor` 并核对数据库完整性、账号映射、待投递回复和计划，再切换服务目录。不要覆盖新版本已经产生的消息，也不要让两个版本同时写同一个 `stateDir`。

## 升级与迁移

停止机器人和后台写入，先备份源码、私有配置和完整状态，再切换源码版本并重新安装锁定依赖：

```bash
sudo systemctl stop chatopus-serve chatopus-admin
cd /absolute/source
git fetch --tags
git checkout VERSION_OR_COMMIT
npm ci
node scripts/install.mjs --deploy-dir "$CHATOPUS_DEPLOY" --skip-deps
"$CHATOPUS_DEPLOY/chatopus" doctor
sudo systemctl start chatopus-serve chatopus-admin
```

回退时使用与状态库匹配的源码和锁文件，保留切换后产生的新消息。兼容 Router 模式的已有状态切换到持续 Router 前，执行：

```bash
npx tsx scripts/migrate-router-context.ts /absolute/state/directory
```

脚本会获取实例锁、创建一致性备份、迁移 schema，并检查业务表数量和完整性。核对生成的 `migration.json` 后再启动服务；全新部署不需要迁移。

## 图片与网页能力

图片缓存和任务产物属于私有状态。QQ 桥接本地图片目录只能配置为明确的受信根目录，不能把整个用户目录作为来源。网页工具只访问公开 HTTPS 地址，并会校验 DNS 和重定向；遇到验证页或 JavaScript 外壳时，应使用配置好的浏览器能力或其他来源，并在答复中说明未取得的内容。外部 Skill、扩展、插件和 MCP 是受信本地代码，升级前审核其来源、依赖和网络权限。

## 排障顺序

1. 运行 `chatopus doctor`，先修复 JSON、路径、外部模块和端口配置错误。
2. 检查 `stateDir` 权限、SQLite/WAL 是否完整，以及是否有另一个进程持有实例锁。
3. 查看 `journalctl` 或进程标准错误，区分模型、工具、OneBot 连接和投递回执错误。
4. 对异常任务先在后台查看原始输入、模型轨迹、工具结果和 Outbox 状态；`unknown` 投递不要盲目重发。
5. 需要复现时使用临时状态目录运行 `chatopus ask`、`npm run replay` 或[验证方法](verification.md)中的离线检查，避免在生产状态上重复执行有副作用的任务。
