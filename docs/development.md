# 开发与发布

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
```

完整的桌面服务、前端和测试代码位于 `apps/desktop/`。默认开发与运行时、界面验收在 macOS 上进行；共享代码的静态检查可使用 Linux CI。Windows 启动器及 `build:windows` / `verify:windows` 命令保留，供关键版本的集中适配、构建和验收使用，不属于日常默认验收范围。

macOS Release workflow 会自动准备 Temurin JDK 21、Python 3.11、`certifi`、PyInstaller，并下载固定版本的 OpenDataLoader CLI；当前 GitHub 发布使用 ad-hoc 签名，不需要 GitHub Secrets 中的 Apple Developer ID 或公证凭据。它是可追溯的 GitHub 发布版，但仍需在 Finder 中确认首次启动；未来购买 Apple Developer Program 后，可再启用 Apple 正式签名和公证路径。

默认 Release 只构建 macOS 产物，并要求对应版本的签名、资产完整性检查及真实 macOS 升级验收通过后才能发布。Windows CI 只接受手动触发；纳入大版本计划的 Windows 候选版本，仍须完成 Windows 构建和升级验收后才能发布。

产品页 s.guzilab.com 不在这个仓库里，由维护者另行管理。发布新版本后，维护者会把安装包同步到国内下载镜像 `download.guzilab.com`，并更新产品页上的下载链接；这一步不需要改动本仓库。

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
