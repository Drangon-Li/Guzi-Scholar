# 谷子学术（Guzi Scholar）

谷子学术是一个本地优先的学术 PDF 阅读器：把论文转换为连续、可检索的阅读页面，并在同一个桌面应用中提供文献管理、翻译、标注、笔记和文章助手。

项目现在面向开源桌面发行，目标平台是 macOS 和 Windows。论文、译文、笔记、标注、设置和 AI 配置默认保存在本机；AI 服务由用户自行填写 OpenAI-compatible API 地址、密钥和模型。

English documentation is coming soon. See [README.en.md](README.en.md) for the current English placeholder.

## 功能

- 导入 PDF，使用本地基础转换或自行配置的远端 GLM-OCR + MinerU 融合解析，生成结构化阅读页面
- 文献库、文件夹、自定义属性、阅读状态和关系图谱
- 原文、译文、笔记、标注和图片资产保存在本机
- 选区翻译、全文翻译、文章问答、阅读重点和表格复核
- macOS 与 Windows 共用同一套桌面应用代码
- macOS 与 Windows 使用同一套源码和独立的平台打包层

## 下载

前往 [Releases](https://github.com/Drangon-Li/Guzi-Scholar/releases) 下载对应平台的安装包：

| 平台 | 产物 | 当前状态 |
| --- | --- | --- |
| macOS Apple Silicon | `.dmg` | `v0.4.0` GitHub 发布版（未公证） |
| Windows x64 | NSIS `.exe` | 等待实机验证 |
| Windows x64 | 便携版 `.zip` | 等待实机验证 |

macOS `v0.4.0` 发布包内置 Python、Java、Pandoc 和 OpenDataLoader 运行时，使用 ad-hoc 签名，尚未通过 Apple Developer ID 签名或 Apple 公证。首次打开时如果遇到 Gatekeeper 提示，请在 Finder 中右键“谷子学术.app”并选择“打开”，再确认提示。当前版本只提供主动检查和浏览器下载，不承诺可靠的应用内自动更新。Windows 开发版当前需要 Python 3.9 或更高版本，正式安装包将在实机验证后发布。

## 远端解析服务器配置

远端融合解析是可选功能，需要你自己的 Linux NVIDIA GPU 服务器。安装包不附带公共解析服务器、访问凭据或模型权重。启用后，导入 PDF 和 AI 重新排版会把原 PDF 上传到指定服务器；结果下载后仍保存在本机。翻译和文章助手的 API 配置与解析服务器配置相互独立。

### 已有解析服务器：连接桌面端

向服务器管理员获取以下信息。这里的 `18770` 是**解析服务端口**，SSH 端口通常是 `22`，两者不要混用。

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| SSH 主机、端口、用户 | `parser.example.com`、`22`、`guzi` | 用于建立加密转发 |
| SSH 私钥路径 | `~/.ssh/guzi-parser` | 填本机文件路径，不填私钥内容 |
| 已验证的主机指纹文件 | `~/.ssh/known_hosts` | 先经可信渠道核对服务器指纹，再用 SSH 正常连接一次 |
| 远端解析端口 | `18770` | 服务只监听服务器的 `127.0.0.1` |
| 本机转发端口 | `18770` | 必须空闲，可改为其他空闲端口 |
| 解析 token | 管理员提供的私有 token | 与服务器 token 文件中的值相同；不是翻译 API key |

在桌面端状态目录创建 `remote-parser.config.json`。源码启动默认为 `apps/desktop/data/`；macOS 安装版为 Electron 用户数据目录下的 `state/`，通常位于 `~/Library/Application Support/谷子学术/state/` 或 `~/Library/Application Support/my-scholar/state/`（以实际已有的 `settings.json`、`renderer-state/` 所在目录为准）。自定义 `MY_SCHOLAR_DATA_DIR` 时使用该目录。不要将配置写入 `.app` 安装包。

```json
{
  "remote_parser": {
    "enabled": true,
    "base_url": "http://127.0.0.1:18770",
    "token": "REPLACE_WITH_PRIVATE_PARSER_TOKEN",
    "ssh": {
      "enabled": true,
      "host": "parser.example.com",
      "port": 22,
      "user": "guzi",
      "identity_file": "~/.ssh/guzi-parser",
      "known_hosts_file": "~/.ssh/known_hosts",
      "local_port": 18770,
      "remote_port": 18770
    }
  }
}
```

保存后将文件权限设为 `600`，重启应用，在 **设置 → 版面引擎 → 远端融合解析服务 → 连接并检测** 确认已连接，再导入 PDF 或点击 AI 重新排版。若更改本机端口，应同时更改 `base_url` 和 `local_port`。应用会管理自己创建的 SSH 隧道，不会接管已有端口上的进程。

配置路径优先级是：环境变量 `MY_SCHOLAR_REMOTE_PARSER_CONFIG` → 状态目录中的 `remote-parser.config.json` → 兼容旧源码配置 `apps/desktop/config.local.json`。需要指定其他位置时，可从终端启动源码版：

```sh
MY_SCHOLAR_REMOTE_PARSER_CONFIG="$HOME/.config/guzi-scholar/remote-parser.config.json" npm run desktop:dev
```

已有自行管理的安全隧道时，将 `ssh.enabled` 设为 `false`，并把 `base_url` 指向该本机端口。由管理员部署 HTTPS 网关时，也可使用 HTTPS 地址；不会接受公网明文 HTTP。私有配置和 token 不应提交 Git。

### 自行部署解析服务

这部分适用于已经安装 GLM-OCR、MinerU 和本地模型的服务器，**仅安装桌面 DMG 或 CPU 依赖不会自动下载 GPU 模型**。

1. 将仓库放在容量足够的数据盘，例如 `/srv/guzi-scholar`，或你自己的数据盘目录。运行前检查 `nvidia-smi`、`free -h` 和 `df -h`。当前服务按单 GPU 顺序运行两种引擎，每次 GPU 阶段要求空闲显存至少 **16 GiB**、可用内存至少 **32 GiB**、可用磁盘至少 **5 GiB**，并拒绝与现有 GPU 计算进程抢占；模型下载和完整环境需要额外空间。
2. 在该目录下创建独立 conda 环境，例如 `conda create -p /srv/guzi-scholar/conda/envs/guzi-scholar python=3.11`。已验证的 GPU 版本见 [`requirements-gpu.txt`](services/parser_service/requirements-gpu.txt)，CPU 依赖见 [`requirements-cpu.txt`](services/parser_service/requirements-cpu.txt)。先确认 CUDA 驱动与对应 PyTorch/vLLM 兼容，再安装。国内网络可优先使用清华 PyPI 镜像和 ModelScope；不要把模型或缓存放入系统根分区。
3. 准备完整本地模型及配置：`models/glm-models.json` 应含 `ocr.snapshot_path` 和 `layout.snapshot_path`，分别指向 GLM-OCR 与布局模型的绝对目录；`mineru4/config.yaml` 使用所装 MinerU 版本的本地模型配置，模型放在 `models/mineru4/`。GLM 布局模型也必须下载；服务运行时启用离线模式，不会临时联网补齐权重。推理包装脚本已包含在仓库 `scripts/glm/`、`scripts/mineru/` 与 `scripts/run_glm_job.py` 中。
4. 复制 [`config.example.json`](services/parser_service/config.example.json) 为服务器上的私有配置，替换 `base`、`python`、`cpu_dependencies` 与 `token_file`。路径都应落在选定的数据盘；`cpu_dependencies` 是安装 CPU 依赖的目录，例如 `python -m pip install -r services/parser_service/requirements-cpu.txt --target /srv/guzi-scholar/envs/fusion-auto-cpu`。创建私有 token 文件，至少 32 个无空白 ASCII 字符，权限必须为 `600`，且位于 `base` 之内。
5. 在仓库根目录使用配置的 Python 启动服务：

   ```sh
   /srv/guzi-scholar/conda/envs/guzi-scholar/bin/python -m services.parser_service.app --config /srv/guzi-scholar/config.local.json
   ```

   在服务器执行 `curl http://127.0.0.1:18770/health`，确认 `ready` 为 `true`。这表示服务和必要文件已就绪；首次真实解析还会检查模型加载和 GPU 资源。长期运行可交由管理员的 systemd 或容器进程管理，保留服务日志与数据目录。
6. 按上一节配置桌面端。用一篇短 PDF 验证上传、排队、解析、下载和阅读，再批量导入。

常见问题：`未配置` 检查配置文件位置和 `enabled`；`SSH 隧道启动失败` 检查 SSH 端口、用户名、私钥及可信主机指纹；`本机转发端口已被占用` 换空闲端口；`HTTP 401` 检查两端 token；`服务尚未就绪` 检查 `/health` 的缺失文件和服务日志；`Resource preflight failed` 释放资源后再试。启用远端后，连接失败会明确报错，不会悄悄切到本地 AI 引擎。

## 本地开发

```sh
npm ci
npm --prefix apps/desktop ci
npm run desktop:dev
```

常用命令：

```sh
npm run desktop:check:syntax
npm run desktop:check
npm run build:mac
npm run build:windows
npm run verify:windows
```

Windows 开发启动器位于 `platforms/windows/run-guzi-scholar.cmd`。完整的桌面服务、前端和测试代码位于 `apps/desktop/`。

macOS Release workflow 会自动准备 Temurin JDK 21、Python 3.11、`certifi`、PyInstaller，并下载固定版本的 OpenDataLoader CLI；当前 GitHub 发布使用 ad-hoc 签名，不需要 GitHub Secrets 中的 Apple Developer ID 或公证凭据。它是可追溯的 GitHub 发布版，但仍需在 Finder 中确认首次启动；未来购买 Apple Developer Program 后，可再启用 Apple 正式签名和公证路径。

## 项目结构

```text
apps/desktop/
├── electron/       # Electron 主进程、预加载、启动器和桌面 IPC
├── web/            # 阅读器、文献库、设置页和前端资源
├── *.py            # 本地 HTTP 服务、文献库、转换和 AI 适配器
├── scripts/        # 桌面构建、运行时准备和校验脚本
└── tests/          # Python、JavaScript 和桌面流程测试

platforms/
├── windows/        # Windows 安装器、便携包、启动和验收配置
└── macos/          # macOS 发布配置预留目录

android/ ios/       # 当前保留的移动展示壳，暂不参与桌面发行
webseit/             # 只读展示站资源和部署脚本
deploy/              # 私有部署与运维脚本
```

平台层只负责图标、安装器、Python 探测、进程终止、签名和发布配置；业务逻辑、渲染器和本地服务由 `apps/desktop` 共享。

## 数据与隐私

默认情况下，PDF、译文、笔记、标注和 AI 配置只写入当前设备。启用在线元数据检索时，论文标识符或元数据候选会发送到相应公共服务；使用翻译或文章助手时，选中的文本或文章上下文会发送到用户配置的 AI 服务。

不要把真实 API Key、用户数据、`data/`、`developer.tokens.json` 或本地构建产物提交到 Git。本项目自有代码按 [Apache License 2.0](LICENSE) 授权，发布衍生版本时请同时遵守 `NOTICE.md`、第三方依赖、字体、图标和论文内容的授权条款。

## 贡献

欢迎通过 Issue 和 Pull Request 反馈问题、提交适配和改进。涉及平台打包的改动请同时说明目标系统、架构、安装方式和验证结果。
