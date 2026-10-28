# Windows

与 macOS 版共用同一份应用代码（`../../apps/desktop`），本目录只放 Windows 专属的构建配置与启动脚本。

Windows 版本暂缓日常持续迭代，但不会终止开发。后续按照项目大版本的目标和需求，集中推进适配、测试与发布，仅在关键版本更新，不跟随每次 macOS 小版本同步发行。源码与手动构建入口继续保留；发布前仍须完成 Windows 构建和升级验收。

## 构建安装包（可在 macOS 上交叉构建）

```sh
./platforms/windows/build.sh          # NSIS 安装包 + 便携版 zip
./platforms/windows/build.sh --dir    # 仅解包目录（快速冒烟）
```

以上命令从仓库根目录执行。

产物：
- `platforms/windows/dist/谷子学术 Setup 0.1.0.exe`（安装包，可选安装目录、自动创建桌面与开始菜单快捷方式）
- `platforms/windows/dist/谷子学术-0.1.0-win.zip`（免安装便携版）

## 运行前置

Windows 机器需要 **Python 3.9+** 来启动本地 API 服务。安装包不内置解释器，首次启动会按 `py -3` → `python` → `python3` 顺序探测；可用环境变量 `MY_SCHOLAR_PYTHON` 指定绝对路径覆盖。

交叉构建脚本会先运行 macOS 主工程测试，因此构建机 PATH 中的 `python3` 也必须提供 `hashlib.scrypt`。

安装版首次启动使用独立空库，不包含项目开发数据。若要阅读已有库，需要先复制数据目录或显式设置 `MY_SCHOLAR_DATA_DIR`；同一数据目录不得由多个实例同时写入。

**导入新 PDF 还需要单独配置转换工具链**：

- 预计算 content-list：设置 `MY_SCHOLAR_LAYOUT_JSON`。
- MinerU 可执行文件：设置 `MY_SCHOLAR_MINERU` 或加入 PATH。
- OpenDataLoader：安装 Java 11+，并通过 `MY_SCHOLAR_ODL_JAR` 指向 CLI JAR。

这些依赖体积较大且未打进安装包。也可以在 macOS 完成转换后，把文献库副本复制到 Windows 阅读；项目没有自动跨设备同步。

## 已做的平台适配

- **不启用 asar**：Python 解释器必须从真实路径读取 `server.py`，打进归档会导致进程启动即失败
- **数据目录**：安装版把文献库放在 Electron `userData` 目录下的 `library/`，而非安装目录。具体 Windows 路径尚待实机确认，可用 `MY_SCHOLAR_DATA_DIR` 覆盖
- 数据目录锁：`fcntl` 之外提供 `msvcrt` 字节区间锁（`server.py: DataRootLock`）
- Python 解释器发现：探测并校验版本，跳过 Microsoft Store 的伪 `python.exe`
- 进程终止：`taskkill /T` 连带结束解释器的子进程，避免残留转换任务
- 窗口与任务栏图标使用 `.ico`，子进程窗口隐藏（`windowsHide`）
- 开发模式 Ctrl-C 用 `taskkill /T` 结束整棵进程树，避免 Python 服务孤儿化占住文献库锁

## 开发模式

```cmd
platforms\windows\run-guzi-scholar.cmd
```

## 打包校验

```sh
./platforms/windows/verify-package.sh
```

校验产物文件完整性、无凭证/用户数据泄漏，并**用打包后的真实目录结构实际启动一次服务**（这一步能拦住 asar 之类导致安装版必崩的问题）。

## 待实机验证

安装包在 macOS 上交叉构建，已通过上述校验，但**尚未在 Windows 实机运行过**。首次在 Windows 上使用时请确认：安装向导、桌面快捷方式、Python 探测、退出后无残留进程。
