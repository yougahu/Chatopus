# QQ 好友私聊

Chatopus 支持白名单内 QQ 好友的一对一对话、文件输入与输出、个人定时任务，以及投递查询、补发和人工核对。临时会话、陌生人消息、缺失或未知私聊子类型直接拒绝，不发送引导消息。真实桥接联调由部署者执行；本地验证使用合成消息与模拟 WebSocket，不会发送真实 QQ 消息。

## 开启与业务绑定

在现有 `config.local.json` 的 `qq` 中加入：

```json
{
  "privateChat": {
    "enabled": true,
    "allowedUserIds": ["10002"],
    "maxMessagesPerMinute": 30,
    "replyMode": "plain"
  }
}
```

QQ 总开关、机器人身份与 OneBot token 仍按 [部署说明](deployment.md) 配置。可以把 `allowedGroupIds` 留空；也允许私聊关闭且群名单为空的零目标启动。私聊默认关闭，新增好友必须显式进入白名单。

以上四个字段每秒检查一次，成功应用后生效。后台独立的「私聊」页可以保存同一配置，并显示磁盘值、最近成功应用、尚未结算的错误及服务是否在线。保存不代表应用成功。QQ 身份、监听端口、认证、群名单、文件桥接契约和附件容量设置需要重启。

会话 ID 为 `qq:<机器人QQ>:private:<好友QQ>`。在 `business.roomProfiles` 中按完整 ID 绑定已有业务，例如：

```json
{
  "business": {
    "defaultProfile": "default",
    "roomProfiles": {
      "qq:10001:private:10002": "document-assistant"
    }
  }
}
```

示例业务必须已在 `business.profiles` 注册；这只是既有配置的局部示例。未绑定会话使用 `defaultProfile`。业务绑定不会授予私聊权限，也不会把群聊历史、另一机器人或另一好友的数据带进来。同一私聊当前只有一个业务，不创建多份按业务分叉的历史。

## 对话与控制

好友输入无需 @ 或称呼唤起，仍保留真实 `isMentioned`。`plain` 默认不在 QQ 上显示引用，宿主保留来源；`quote` 只引用真实平台消息 ID。没有平台消息 ID 的文件通知使用宿主来源键，不伪造 QQ 消息 ID。私聊不能设置额外 `recipientIds`。

普通输入超限后，以下精确命令仍使用独立的每分钟 10 次额度，不调用模型。重复输入先去重再计数；限流提示最多每分钟一次。

| 命令 | 行为 |
| --- | --- |
| `/status [任务ID]` | 用简短进度说明展示本人任务状态；完成后提示结果是否已发出 |
| `/cancel [任务ID]` | 取消一个本人普通任务；有多个候选时先列出 |
| `/schedule list` | 查看本人个人计划 |
| `/schedule pause ID` | 暂停计划 |
| `/schedule stop ID` | 停止一次执行，保留未来计划 |
| `/schedule cancel ID` | 取消计划 |
| `/delivery list` | 列出待处理的投递与项目 |
| `/delivery received 投递ID [项目ID]` | 确认未知送达的项目已收到 |
| `/delivery abandon 投递ID [项目ID]` | 放弃仍需处理的项目 |

自然语言可以创建、修改、恢复和归档个人计划，查询投递或明确请求补发。系统计划仅供后台管理员管理。一次执行结束不等于已送达；`unknown` 不自动重试。补发使用新 Outbox 和原内容的固定关联，不重新跑 Worker。未知结果须先明确确认仍然补发。确认收到/放弃独立记录，不改写原平台回执；所有项目结案后，循环计划仍需明确恢复，只安排未来时刻。

## 双向文件与桥接契约

每次最多四个文件，单个 10 MiB、合计 20 MiB，同时检查元数据与实际字节。模型只能用宿主 `attachmentId` 选择同会话文件；文件工具不接受任意 URL 或路径，不自动执行脚本、宏或上传材料。私聊图片缓存与文件快照都纳入受控附件存储。下载只允许可信 QQ 域名、公网地址和最多三次经重新校验的跳转，最长 60 秒。下载失败不会在后台无限重试，重新上传产生新版本。

**OneBot v11 本身不统一私聊文件扩展。** 配置 `qq.privateFiles` 固定部署中已核对的契约；每次连接首次使用时通过 `get_version_info` 精确核对 `app_name` / `app_version`。未配置或版本不匹配时，私聊文件上传返回 `private_file_unsupported`，文字能力仍可使用。

以下是 go-cqhttp 的共享路径契约示例；版本值必须替换为实际返回值，路径必须同时对宿主和桥接可见，并包含宿主受控工作区：

```json
{
  "qq": {
    "privateFiles": {
      "implementation": "go-cqhttp",
      "version": "v1.2.0",
      "transport": "shared_path",
      "sharedRoot": "/srv/chatopus/runtime/workspaces",
      "receipt": "synchronous",
      "source": "offline_file"
    }
  }
}
```

该模式按 [go-cqhttp 上传 API](https://docs.go-cqhttp.org/api/#上传私聊文件) 和 [离线文件事件](https://docs.go-cqhttp.org/event/#接收到离线文件)处理：只取 `offline_file` 主来源，先通过真实好友证据校验，使用事件时间和文件元数据生成稳定去重键；显式临时子类型仍拒绝。上传使用已校验的宿主共享文件路径，只有匹配契约的同步 `ok/0` 才接受无文件 ID 的成功。

若桥接经部署者验证支持 base64 上传并返回真实 `file_id`，使用其实际 `implementation` / `version`，选择 `transport: "base64"`、`receipt: "file_id"`、`source: "message"`，不填写 `sharedRoot`。空回执视为未知。仅 go-cqhttp 可选择当前支持的同步无 ID / 离线通知契约；不能为了适配未验证桥接而放宽判据。本文不宣称任何 NapCat 版本已经真实联调通过。

输出经 `artifact_publish` 固定内容摘要与来源路径，发送前重新校验。文件逐个持久化回执，出现未知、撤权或交付过期立即停止后续项目。已成功项目不重复上传。后台投递详情可逐项确认收到或放弃，正在发送时不能结案。

## 个人计划与文件保留

本人私聊计划不要求群角色；全局 `scheduledTasks.enabled` 仍控制执行。计划显式选择 `attachmentIds` 后固定来源、名称、大小和 SHA-256；后续同名上传不替换旧版本。后台只能绑定同会话已经下载并核验的快照，不接受任意路径。缺失或篡改的材料阻塞执行，需重传、更新绑定并明确恢复。

每次实例固定 `deliveryExpiresAt = min(计划时间 + catchUpWindowMs, expiresAt)`。离线、重启、补跑不会顺延。到期前已发/未知的事实保留，到期后不开始剩余投递；迟到 Worker 结果保留在本地。`needs_input` 暂停计划，用户补充本次条件时创建带原条件与材料的普通跟进任务，保留原计划/实例关联，不改写已发生的实例或自动恢复计划。

默认配置：

```json
{
  "attachments": {
    "retentionDays": 7,
    "maxStorageBytes": 10737418240,
    "minFreeDiskBytes": 536870912
  }
}
```

持锁服务在启动及每小时清理已登记附件，有效任务、计划、提案、实例和待投递引用会保护快照。释放后保留七天，查询不续期。10 GiB 上限计入在途预留和物理副本，写入后保留 512 MiB 空间；容量不足先清理到期项目，再拒绝写入。元数据保存在 `stateDir/attachments/manifest.json`，消息、计划和投递继续使用既有数据库 JSON。只管理已登记文件，不扫描删除整个工作区或桥接缓存。

## 撤权、上线与回退

关闭私聊或移除好友会中断旧访问标记，并在事务中终止该会话的待处理输入、任务、结果、计划和未发投递。清理失败时会话保持关闭并重试；即使立即重新加入，旧异步工作也不能借新授权复活。已发生的发送仍保存真实回执。

数据库版本升级至 3。上线前停止写入并一致性备份 SQLite（含 WAL）、配置与附件。先用受控好友完成 [联调清单与本地验证记录](private-chat-verification.md)，再扩大白名单。二进制降级需要恢复升级前的匹配备份，不要手改数据库版本。
