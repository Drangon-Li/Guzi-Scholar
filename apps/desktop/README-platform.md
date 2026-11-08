# macOS（参考实现）

本目录是谷子学术的**主工程**：完整的桌面应用（Electron 壳 + Python 本地服务 + 前端），也是其他平台共用的代码来源。

- `../../platforms/windows/` 通过 electron-builder 打包本目录
- `../../webseit/` 通过 rsync 白名单部署本目录的只读服务端与前端
- `../../ios/`、`../../android/` 是加载远程只读展示站的 Capacitor 壳，不包含本地 Python 服务或可写文献库

桌面与 Web 业务代码主要在本目录修改；平台目录保存各自的原生工程、构建、部署和校验配置。

## 运行

```sh
npm run dev      # 启动桌面应用
npm run check    # 语法检查 + 自动发现的 Python 单元测试
```

桌面应用需要 Python 3.9+。执行完整测试时，解释器还必须提供 `hashlib.scrypt`；运行测试时请确保 PATH 中的 `python3` 指向兼容解释器。
