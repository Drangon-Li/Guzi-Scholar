# macOS 平台层

macOS 与 Windows 共用 `apps/desktop/` 的 Electron、Web 和 Python 业务代码。

本目录预留 macOS 专属的签名、公证、图标和发布配置。当前开发启动入口仍是：

```sh
npm run desktop:dev
```

macOS Apple Silicon GitHub 发布包由 `apps/desktop` 的 `dist:mac:internal` 负责构建；当前 `v0.1.10` 是使用 ad-hoc 签名、未经过 Apple 公证的可追溯发布包。面向普通用户的 Apple 正式发行仍需要 Developer ID 和 Apple 公证凭据，不能把当前包描述为已公证版本。

CI 使用 OpenDataLoader PDF CLI `v2.5.1`，下载后会校验 ZIP 和 JAR 的 SHA-256，再交给 `prepare-mac-release.sh`。这一步不依赖仓库外的本地 `opendataloader-pdf` checkout。
