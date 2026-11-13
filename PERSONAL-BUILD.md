# Zettlr Personal：手动重新加载文档

这是基于 Zettlr 4.9.0 的个人派生版本。上游自动检测外部修改的逻辑保持原样；本分支提供一个直接从磁盘重新加载的入口，文档过期时可以使用它，无须关闭再打开。

## 使用

- 右键已打开的文档标签，选择“从磁盘重新加载”。
- 光标在正文编辑区时，按 **⌘⌥R**；Windows/Linux 对应 **Ctrl+Alt+R**。
- 也可以使用“文件”菜单中的同名命令。

重新加载更新正文和文章目录。存在未保存编辑时会先确认，默认取消；磁盘读取失败或读取、确认期间继续编辑，会保留原内容。

## 个人应用

应用名称为 **Zettlr Personal**，版本 **4.9.0-personal.1**，Bundle ID 与官方应用分开。个人构建禁用自动更新，避免被官方安装包替换。

启动器 `scripts/personal/launch-macos.command` 同时指定 Electron 和 Zettlr 的独立配置路径，默认使用此仓库的 `out/personal-profile`。它不会迁入官方配置或自动打开原有文档。需要另选配置目录时，可设置 `ZETTLR_PERSONAL_DATA_DIR`；配置目录应保留，不要在清理构建文件时一并删除。

macOS 构建使用本机 ad-hoc 签名，不包含上游开发者证书或 Apple 公证；首次启动可能需要通过 Finder 右键“打开”。

## 构建与验证

需要 Node.js 22.13 或更高版本、Corepack/Yarn，以及 macOS 的 Xcode Command Line Tools。

```sh
git clone --branch personal/reload-from-disk https://github.com/chenzixin1/Zettlr.git
cd Zettlr
corepack enable
yarn install --immutable

npm --prefix scripts/personal ci --ignore-scripts --no-audit --no-fund
npm --prefix scripts/personal test
yarn lint:types
yarn test

yarn package:personal:mac
./scripts/personal/launch-macos.command
```

个人打包命令面向 Apple Silicon，输出在 `out/Zettlr Personal-darwin-arm64/Zettlr Personal.app`。完整打包沿用上游资源及 Pandoc，不修改已安装的官方应用。

个人 GitHub Actions 工作流提供轻量回归；手动选择构建时，会生成 Apple Silicon 的压缩应用附件。它使用公开源码和临时签名，不需要上游的发布密钥。

## 范围与来源

本分支提供手动恢复入口，不宣称自动文件监听已经完全修好。故障排查中尝试的较大自动同步改动未包含在此版本中。

源码修改和测试由 OpenAI Codex 辅助完成；原项目作者、资源及 GPL-3.0 许可保留，见 [LICENSE](LICENSE) 和原项目说明。
