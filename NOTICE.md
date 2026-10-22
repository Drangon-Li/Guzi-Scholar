# 谷子学术来源说明

本项目基于谷子学术（Guzi Scholar / My Scholar）开源代码整理发布。

本项目自有代码按 Apache License 2.0 授权，具体条款见根目录 `LICENSE`。

二次开发、再发布或制作衍生作品时，请保留以下来源信息：

> 谷子学术（Guzi Scholar）\
> Source: https://github.com/Drangon-Li/Guzi-Scholar

构建或发行包中可能包含 OpenDataLoader PDF CLI；该第三方组件按其自身 Apache-2.0 许可证及 NOTICE/THIRD_PARTY 文件发行。

构建或发行包中可能包含 Pandoc；该第三方组件按 GNU GPL v2 或更高版本发行，安装包同时携带其 `COPYING.md` 授权文本。

v0.5.0 macOS 发行包内置 PyMuPDF 1.28.2 及 MuPDF 1.28.2，用于 PDF 字形提取。上游包级授权为 GNU Affero General Public License v3 或 Artifex 商业许可双许可；本发行材料提供其公开开源许可文本，不声明已取得商业许可。部分 PyMuPDF 源文件另带 `GPL-3.0-only` 标头，相关原始声明与完整 GPL v3 文本一并保留。

安装包的 `Contents/Resources/python-server/_internal/licenses/pdf-runtime/` 包含上游授权声明、完整 AGPL v3 / GPL v3 文本、MuPDF 第三方声明，以及 `SOURCES.txt` 中的对应源码下载地址、校验值和本项目构建脚本地址。两份未经修改的上游源码归档随 v0.5.0 GitHub Release 提供：https://github.com/Drangon-Li/Guzi-Scholar/releases/tag/v0.5.0 。本项目自有代码的许可与这些第三方组件的许可分别列示。

前端内置 KaTeX（位于 `apps/desktop/web/vendor/katex/`）用于阅读器公式渲染；该第三方组件按 MIT License 发行（https://github.com/KaTeX/KaTeX）。

前端内置 Cytoscape.js（位于 `apps/desktop/web/vendor/cytoscape.min.js`）用于关系图谱；该第三方组件按 MIT License 发行（https://github.com/cytoscape/cytoscape.js）。

本文件是来源与署名说明，不替代项目许可证；同时请遵守第三方依赖、字体、图标和论文内容各自的授权条款。
