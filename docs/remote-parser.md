# 远端解析服务器配置

远端融合解析是可选功能，需要你自己的 Linux NVIDIA GPU 服务器。安装包不附带公共解析服务器、访问凭据或模型权重。启用后，导入 PDF 和 AI 重新排版会把原 PDF 上传到指定服务器；结果下载后仍保存在本机。翻译和文章助手的 API 配置与解析服务器配置相互独立。

## 已有解析服务器：连接桌面端

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

## 自行部署解析服务

这部分适用于已经安装 GLM-OCR、MinerU 和本地模型的服务器，**仅安装桌面 DMG 或 CPU 依赖不会自动下载 GPU 模型**。

1. 将仓库放在容量足够的数据盘，例如 `/srv/guzi-scholar`，或你自己的数据盘目录。运行前检查 `nvidia-smi`、`free -h` 和 `df -h`。当前服务按单 GPU 顺序运行两种引擎，每次 GPU 阶段要求空闲显存至少 **16 GiB**、可用内存至少 **32 GiB**、可用磁盘至少 **5 GiB**，并拒绝与现有 GPU 计算进程抢占；模型下载和完整环境需要额外空间。
2. 在该目录下创建独立 conda 环境，例如 `conda create -p /srv/guzi-scholar/conda/envs/guzi-scholar python=3.11`。已验证的 GPU 版本见 [`requirements-gpu.txt`](../services/parser_service/requirements-gpu.txt)，CPU 依赖见 [`requirements-cpu.txt`](../services/parser_service/requirements-cpu.txt)。先确认 CUDA 驱动与对应 PyTorch/vLLM 兼容，再安装。国内网络可优先使用清华 PyPI 镜像和 ModelScope；不要把模型或缓存放入系统根分区。
3. 准备完整本地模型及配置：`models/glm-models.json` 应含 `ocr.snapshot_path` 和 `layout.snapshot_path`，分别指向 GLM-OCR 与布局模型的绝对目录；`mineru4/config.yaml` 使用所装 MinerU 版本的本地模型配置，模型放在 `models/mineru4/`。GLM 布局模型也必须下载；服务运行时启用离线模式，不会临时联网补齐权重。推理包装脚本已包含在仓库 `scripts/glm/`、`scripts/mineru/` 与 `scripts/run_glm_job.py` 中。
4. 复制 [`config.example.json`](../services/parser_service/config.example.json) 为服务器上的私有配置，替换 `base`、`python`、`cpu_dependencies` 与 `token_file`。路径都应落在选定的数据盘；`cpu_dependencies` 是安装 CPU 依赖的目录，例如 `python -m pip install -r services/parser_service/requirements-cpu.txt --target /srv/guzi-scholar/envs/fusion-auto-cpu`。创建私有 token 文件，至少 32 个无空白 ASCII 字符，权限必须为 `600`，且位于 `base` 之内。
5. 在仓库根目录使用配置的 Python 启动服务：

   ```sh
   /srv/guzi-scholar/conda/envs/guzi-scholar/bin/python -m services.parser_service.app --config /srv/guzi-scholar/config.local.json
   ```

   在服务器执行 `curl http://127.0.0.1:18770/health`，确认 `ready` 为 `true`。这表示服务和必要文件已就绪；首次真实解析还会检查模型加载和 GPU 资源。长期运行可交由管理员的 systemd 或容器进程管理，保留服务日志与数据目录。
6. 按上一节配置桌面端。用一篇短 PDF 验证上传、排队、解析、下载和阅读，再批量导入。

常见问题：`未配置` 检查配置文件位置和 `enabled`；`SSH 隧道启动失败` 检查 SSH 端口、用户名、私钥及可信主机指纹；`本机转发端口已被占用` 换空闲端口；`HTTP 401` 检查两端 token；`服务尚未就绪` 检查 `/health` 的缺失文件和服务日志；`Resource preflight failed` 释放资源后再试。启用远端后，连接失败会明确报错，不会悄悄切到本地 AI 引擎。

