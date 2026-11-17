# 可选 OpenViking 记忆服务

此为需自行提供兼容后端的实验性可选集成，后端不属于默认安装。长期记忆默认关闭。安装器和启动器的离线契约测试包含在 CI 中，后端原生安装与真实模型链路仍须另行验证。宿主通过配置中的 `memory.baseUrl` 连接 OpenViking，使用根凭据进行账号准备及后台管理配置，以群 USER 凭据读写内容；不开启此能力不影响基本聊天。

## 后端与平台要求

本仓库不分发 OpenViking、嵌入模型或 Python 二进制。可选安装器 [openviking-install.py](../scripts/openviking-install.py) 用于校验并安装一组固定版本的外部制品，固定 OpenViking 提交为 `9ac008f9b86c91b79d6e93eb8df8ea7f4d48cecb`、OpenViking 版本为 `0.5.3.dev0+g9ac008f9b86c`、llama-cpp-python 版本为 `0.3.36`。安装器优先支持 **Linux x64、Linux arm64、macOS arm64**，要求同系统、同架构且带 pip 的完整独立 Python 3.12 目录。它使用 pip 随附的 packaging 检查 wheel 的 Python、ABI 和平台 tags，包括 manylinux 的 glibc 下限与 macOS 最低系统版本。Windows、Linux 其他架构和 macOS x64 不在本地安装支持范围内。

| 平台清单键 | 识别的原生架构 | 制品要求 |
| --- | --- | --- |
| `linux-x64` | `x86_64` / `amd64` | 对应 x86_64 的 Linux wheel，满足所标记的 glibc / musl 要求 |
| `linux-arm64` | `aarch64` / `arm64` | 对应 aarch64 的 Linux wheel，满足所标记的 glibc / musl 要求 |
| `macos-arm64` | `arm64` | 对应 arm64 或兼容 universal2 wheel，满足两个 wheel 中更高的 macOS 版本要求 |

不能通过重命名 wheel 绕过兼容性要求。未提供制品的最低 OS 版本不在安装器中猜测或固定；旧的内置 llama-cpp wheel 标记为 macOS 27，较早的 macOS 必须换用真实为该系统构建的 wheel。

这组固定制品没有公开下载地址或完整构建流程，因此该安装器仍只适用于已备齐制品的环境。Linux x64、Linux arm64、macOS arm64 各自必须提供对应的原生 wheel；没有对应制品时，安装器会在创建目录前失败。其他部署需另外取得或构建并验证后端，不能仅执行 `pip install openviking` 就声称具备相同接口与行为。

制品目录必须包含 `wheels/` 下目标平台的两个 wheel、`models/` 下指定的 GGUF 模型、内容为固定提交号的 `source.commit`、精确版本依赖文件和 `manifest.json`。清单采用以下结构（示例是结构模板，wheel 文件名和 SHA-256 的占位值必须替换后才能使用；只保留已经备齐的目标）：

```json
{
  "schemaVersion": 1,
  "commit": "9ac008f9b86c91b79d6e93eb8df8ea7f4d48cecb",
  "version": "0.5.3.dev0+g9ac008f9b86c",
  "model": {"filename": "bge-small-zh-v1.5-f16.gguf", "sha256": "ab9b81d9cd329c712eee379cf0068eabe6a5e2a01d0def61535eba9384085e2c"},
  "requirements": {"filename": "requirements-installed.txt", "sha256": "..."},
  "targets": {
    "linux-x64": {"openviking": {"filename": "...manylinux...x86_64.whl", "sha256": "..."}, "llama": {"filename": "...manylinux...x86_64.whl", "sha256": "..."}},
    "linux-arm64": {"openviking": {"filename": "...manylinux...aarch64.whl", "sha256": "..."}, "llama": {"filename": "...manylinux...aarch64.whl", "sha256": "..."}},
    "macos-arm64": {"openviking": {"filename": "...macosx...arm64.whl", "sha256": "..."}, "llama": {"filename": "...macosx...arm64.whl", "sha256": "..."}}
  }
}
```

顶层 `requirements` 是默认依赖文件；每个 `targets` 条目可用同结构的 `requirements` 覆盖，例如 `{"filename":"requirements-linux-arm64.txt","sha256":"实际哈希"}`，使各平台保留独立锁定结果。依赖文件每行使用 `package==version`，从对应平台已验证的独立环境导出；安装器安装本地 wheel，忽略 freeze 文件中的 OpenViking 本地路径行和 llama-cpp-python 版本行。不要把其他平台或含无关开发包的环境直接 freeze 后复用。

使用可信发布者提供的哈希核对制品；自己构建时在复核来源后用 Python `hashlib.sha256` 生成清单。安装器验证固定提交和模型、所选平台的文件名与 SHA-256、依赖文件 SHA-256、两个 wheel 的发行版、OpenViking wheel 版本，以及当前 Python 的兼容 tags。SHA-256 只证明文件与清单一致，不证明清单发布者可信。旧的 macOS arm64 审计制品仍可在没有 `manifest.json` 的旧目录中使用；Linux 安装必须提供清单。安装器还会通过 pip 安装精确版本的依赖，可能访问包源；不是完全离线安装器。

```sh
python3.12 scripts/openviking-install.py --root /absolute/new-installation --runtime-source /absolute/standalone-python --artifacts /absolute/artifacts --artifact-manifest /absolute/artifacts/manifest.json --dry-run
```

`--artifact-manifest` 可以省略，默认读取制品目录中的 `manifest.json`；显式指定的文件无效时不会退回旧制品。源码目录、制品目录、Python 来源目录与安装根目录应彼此独立，制品和运行数据放在 Chatopus 仓库外。

即使 `--dry-run` 也会运行提供的 Python 来校验版本、原生系统/架构、独立前缀和 wheel tags，并核对文件及哈希；因此只使用可信的 Python runtime。缺少制品时不会生成安装计划。确认后删除 `--dry-run` 才安装，目标根目录必须不存在；安装器不启动服务。安装器只复制并安装与当前平台匹配的一组制品，运行 `pip check` 并尝试导入 OpenViking 和 llama-cpp 原生模块后才标记安装成功。tag 检查不替代原生加载、`/ready`、嵌入和记忆读写验证。

`scripts/openviking-serve.py` 管理单个本地进程的私有配置。先运行 `--help`，使用独立目录，通过 `--dry-run` 核对路径与配置，再启动服务。已有 `ov.conf` 中的 **`vlm` 模型配置**优先于首次初始化模型参数；其余服务器、存储、嵌入及模板配置由脚本重建，并非原样保留旧配置。再次执行时应保持所需的 `--workspace`、端口和根目录参数。根密钥、模型凭据和配置文件必须保留在私有目录。

首次初始化需在独立私有环境文件中填写 `OPENVIKING_VLM_API_KEY`，并显式选择可用的模型和端点：

```sh
python3 scripts/openviking-serve.py --root /absolute/installation --env-file /absolute/private/openviking.env --vlm-model YOUR_MODEL_ID --vlm-base-url https://YOUR-PROVIDER/v1 --port 1933 --dry-run
```

`--prepare-only` 会创建私有配置、根凭据等文件但不启动服务；去掉模式参数才启动。脚本要求安装目录已具有服务程序和指定嵌入模型，不负责下载安装或注册 systemd/launchd。`--workspace` 可指定数据目录，默认安装根下的 `data/`。初始化后将 `root-api-key` 中的值配置到宿主私有 `.env` 的 `OPENVIKING_ROOT_API_KEY`；不要把 VLM 模型密钥误作根凭据。

宿主自定义模板位于 `scripts/openviking-memory-templates/`，来源归属保护见 `openviking-memory-guard.py`。后端升级需验证原生接口、模板和引用归属，不应假定任意版本兼容。

## 宿主配置

在私有配置中设置 `memory.enabled=true`、实际后端地址和独立 namespace。保持已有 namespace 和账号映射，避免升级后读到另一套记忆。环境变量 `OPENVIKING_ROOT_API_KEY` 保存根凭据。

默认摄取批次上限为 32 条，等待窗口为 300000 毫秒。该窗口只控制合并等待；模型处理及索引可见性另需时间。已确认偏好和历史语义记忆分开管理。普通临时请求、助手假设或他人转述不能变成用户长期事实。

首次启用从启用时的新来源开始摄取，不会自动把整个历史数据库导入。启用、地址、namespace 或根凭据变更后重启机器人及后台；随后用测试群的明确偏好与一条历史检索分别验证。字段注册和业务选择见 [自定义成员字段](member-fields.md)。

`shared_memory` 先 `search` 再 `read` 历史条目。读取结果的 `sources` 从当前群的本地原始消息核对来源 ID、发言人内部标识、原文及时间，返回发言时的 `authorName`、平台账号 `authorId`（QQ 平台即 QQ 号）和 `timestamp`。这允许回答“谁说过这句话”，不扩大其他成员的画像访问范围。`member_…` 是记忆内部标识，不是 QQ 号，也不是 `profile` 参数。只有可核对的来源会附带身份；旧的无来源条目、原文不一致、跨群或本次读取工具创建后才接收的消息均不附带身份。`sources` 为空不代表数据库没有保存身份；历史正文仍按原有规则作为未核实材料。

## 模型配置与维护

后台只显示可编辑模型字段和凭据是否已配置。支持的后端可以通过“保存并应用”执行版本校验、维护租约和受控重启；不支持时由部署者重启。已经冻结的摄取批次保持状态，新批次在维护期间暂停。

表单编辑的是后端 `vlm` 提炼模型，不修改 embedding。当前只支持单个 OpenAI 兼容提供方；多凭据、备用提供方、环境变量引用、只读文件或 `vlm` 集群覆盖等配置会显示不可编辑。后台依赖 `/api/v1/admin/configuration` 等管理接口，后端版本不支持时不会通过表单强行覆盖配置。

备份需要包括后端数据、私有配置、根凭据和账号映射。先恢复到隔离目录和端口，核对当前偏好、来源记录及语义检索，再切换业务。备份脚本 `openviking-backup-smoke.ts` 会暂停指定 launchd 服务并执行恢复探针，只适用于显式选择的 macOS 测试部署；它不属于默认测试或安装步骤。

该脚本要求 `OPENVIKING_BACKUP_INSTALLATION` 指定后端安装目录、`OPENVIKING_BACKUP_SERVICE` 指定测试服务的 launchd label、`OPENVIKING_BACKUP_RESTORE_PORT` 指定空闲恢复端口。源端口从所选安装目录的 `ov.conf` 读取，必须与恢复端口不同。缺少参数时立即退出。偏好展示探针 `openviking-preferences-smoke.ts` 则要求两个位置参数：已通过的 Worker 结果文件、测试后端配置文件；没有预选历史运行记录。

安装模型和后端依赖前，另外检查其许可证与再分发要求。本项目源码发布不会包含这些制品或已有用户记忆。
