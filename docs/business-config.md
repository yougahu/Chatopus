# 业务配置

`config.local.json` 的 `business` 保存领域无关的配置结构：

```json
{
  "business": {
    "defaultProfile": "default",
    "roomProfiles": { "qq:机器人账号:群号": "documents" },
    "profiles": {
      "default": {
        "name": "通用助手",
        "commonInstructions": "",
        "routerInstructions": "",
        "workerInstructions": "",
        "skillIds": [],
        "extensionIds": []
      },
      "documents": {
        "name": "文档助手",
        "commonInstructions": "依据用户提供的材料回答。",
        "routerInstructions": "材料对照和查证交给 Worker。",
        "workerInstructions": "给出结论及对应的原文依据。",
        "skillIds": ["document-reader"],
        "extensionIds": [],
        "memoryFields": []
      }
    }
  }
}
```

示例 `document-reader` 必须先在顶层 `skills` 中声明本地路径。业务配置只选择已注册能力；技能文件是否可用在运行及 doctor 阶段检查。未绑定的会话使用默认配置，会话绑定是完整 ID 精确匹配。`personaText` 仅属于所在业务，直接保存人格正文，最多 8,000 个 Unicode 字符；空白正文不加载额外人格。旧 `personaFile` 作为兼容输入继续读取，后台会载入正文，并在保存后迁移为 `personaText`，不修改原文件。

注册并启用的完整操作见 [技能和扩展](skills.md)；自定义字段先在 `memory.fields` 声明，再通过业务 `memoryFields` 选择，见 [成员字段](member-fields.md)。安装目录、扩展模块及字段定义仍由部署者在配置文件中管理。

后台编辑页分别呈现共同背景、Router 指引和 Worker 指引。业务指引描述工作范围和交付，不替代宿主协议、身份归属、资源隔离和工具校验。详细知识与脚本说明应放在 skill 中按需读取。

编辑页分为「业务提示词」「技能与工具」「记忆与风格」「群与默认配置」。新增按钮打开创建弹窗，可从空白开始或复制已有业务；创建后先形成草稿，点击「保存全部配置」才生效。技能、工具扩展和自定义成员字段从已注册目录勾选，会话绑定以可编辑行维护。

切换业务、切换后台页面和页内刷新都会保留未保存草稿；关闭或重新加载浏览器页面时会提示尚未保存。草稿仅保存在当前页面内存中。使用「放弃草稿」并确认后重新读取服务端配置。保存状态和错误提示始终显示在底部操作栏，提示词预览使用当前草稿。

保存使用内容 hash 校验当前版本。发生并发修改时返回409，不覆盖他人的更新。保存仅更新 `business`，保留模型、密钥引用、平台和其他配置。历史保存于状态目录的 `business-config-history`，不复制其他配置或凭据；回退生成当前配置的新应用状态，新调用生效。

后台能力列表可用 `config.local.json` 中的 `admin.capabilityLabels` 设置易读名称和简短说明：

```json
{
  "admin": {
    "capabilityLabels": {
      "skills": { "document-reader": { "name": "文档阅读", "description": "根据资料查证并引用原文。" } },
      "extensions": { "document-tools": { "name": "文档工具", "description": "检索文档并校验引用。" } }
    }
  }
}
```

这些标签仅覆盖已注册能力在后台的展示，不修改技能目录工具 `skills_list` 的描述、提示词或运行能力。未填写时沿用技能元数据或 ID；空值及非法元数据会被忽略。名称最多 120 字符，说明最多 2,000 字符。业务保存和回退会保留整个 `admin` 配置。

| API | 行为 |
| --- | --- |
| GET `/api/business-config` | 返回 settings、revision、appliesTo、catalog（已注册技能/扩展/成员字段）及 personaLoadErrors；可读的旧人格正文带入 settings，revision 仍对应已保存配置 |
| POST `/api/business-config` | 接受 `{settings, revision}`，校验后保存 |
| GET `/api/business-config/history` | 最近100个历史配置快照的版本及名称 |
| POST `/api/business-config/rollback` | 接受 `{targetRevision, revision}`，回退整个业务配置和会话绑定 |
| POST `/api/business-config/preview` | 接受 `{settings, roomId?, profileId?}`，预览未保存配置，不调用模型或工具 |

预览包含基础规则、渠道格式、业务指引和人格。动态工具 schema、成员字段、当前称呼及任务上下文仍由实际调用注入；预览会明确标注这个边界。修改工具集合或业务语义时，运行时使用配置指纹处理持续会话恢复，在途任务使用原快照。

全新部署的 catalog 不含技能、扩展或自定义成员字段，默认不配置人格；可复制仓库内中性模板的正文后按业务调整。后台列表、描述与已选状态来自当前私有部署配置和已注册资源；核心没有业务预设。

“记忆与风格”直接编辑当前业务的人格正文，使用与业务提示词一致的编辑区；多行内容、字符数和未保存草稿随业务切换保留。清空后不加载额外人格。旧文件读取失败时仍可查看其他配置，原引用会保留；需填写替代正文或明确清空，不能通过无关修改悄悄丢失原人格。详情见 [人格配置](persona.md)。
