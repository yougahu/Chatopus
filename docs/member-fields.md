# 自定义成员字段

成员字段用于记录成员明确表达、可追溯来源的资料。通用字段始终在记忆 schema 中可用：`preferredName`、`language`、`responseDetail`、`formatPreference`、`terminology`、`interests`、`experience`、`learningGoals`。额外字段由部署者注册，业务只选择已注册的字段，核心没有预设领域字段。

## 注册与选择

1. 在 `config.local.json` 的 `memory.fields` 中定义字段。
2. 在后台“业务 · 提示词 → 记忆与风格”勾选，或填写对应业务的 `memoryFields` 并保存。
3. 要实际记录、读取成员资料，还须启用并配置 [OpenViking](openviking-operations.md)。仅声明字段不会开启记忆后端。修改后端配置需重启机器人及后台；修改字段定义后重启后台，使查询服务使用同一注册表。

下面是可合并到现有配置的完整注册与选择片段。合并时保留已有 `memory` 参数和其他业务，不要用这个片段覆盖整份配置：

```json
{
  "memory": {
    "fields": [
      { "key": "documentPreference", "label": "文档阅读偏好", "type": "text-or-list", "maxLength": 200 }
    ]
  },
  "business": {
    "defaultProfile": "default",
    "roomProfiles": {},
    "profiles": {
      "default": {
        "name": "通用助手",
        "commonInstructions": "",
        "routerInstructions": "",
        "workerInstructions": "",
        "skillIds": [],
        "extensionIds": [],
        "memoryFields": ["documentPreference"]
      }
    }
  }
}
```

后台支持选择字段和查看有来源的值，**没有创建字段定义的管理表单**。也不提供手工修改成员事实、删除远端资料或批量重建的入口。新增或改名定义通过私有配置文件完成；移除字段前先移除所有业务中的引用。

## 字段契约

| 属性 | 要求 |
| --- | --- |
| `key` | 英文字母开头，随后为字母、数字、`_`、`.`、`-`，最多 80 字符；不能重名、覆盖通用字段或使用系统保留键 |
| `label` | 非空单行名称，最多 80 字符，无控制字符 |
| `type` | `text`、`text-list`、`text-or-list` |
| `maxLength` | 1–400 的整数，用于限制文本值长度 |
| `scopeKeys` | 可选，最多 8 个不重复的作用域键；高级集成使用，须由调用方提供匹配作用域，声明本身不会自动生成业务上下文 |

最多定义 56 个自定义字段，加上 8 个通用字段总数不超过 64。列表值须包含 1–8 个不重复的非空字符串，每项最多 `min(120, maxLength)` 个字符。`text-or-list` 接受单个文本或这种列表。完整校验规则见 [memory/types.ts](../src/memory/types.ts)。

实际可用字段为通用字段，加上当前业务 `memoryFields` 选择的自定义字段。未选择的自定义字段不能被该业务继续注入为有效资料；定义变更不会自动迁移远端已有值。当前任务条件优先于长期资料，已清除、过期或超出作用域的值不能沿用。字段和值都不能授权工具操作，也不能替代本轮明确请求。

后台记忆页展示的是已知群成员及后端实际保存的资料，不是字段初始化结果；没有画像、未配置后端或后端失败会分别显示。业务选择与历史回退见 [业务配置](business-config.md)，查看方式见 [本地后台](admin.md)。
