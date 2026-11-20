# Changelog

## 0.1.0 — 2026-11-20

首个可用版本。

- 新的设置页 **设置 → 云同步**：同步载体、连接测试、推送、拉取、差异核对与应用。
- 两种载体：本地/云盘文件夹（原子写入）与私有 GitHub 仓库（Contents API，含 409 冲突重试）。
- 同步内容：非内置插件的包名/版本/启用状态，以及 `~/.dsh/plugin-settings/*.json` 白名单设置；合并按 `updatedAt` 取较新一侧。
- 差异分四组：待安装、版本与启用状态不同、设置差异、仅本机有（永不删除）。
- 应用阶段走 DSH 的 `pluginManager`，按 `ChangeResult.application` 如实上报 `applied` / `restart-required` / `failed`。
- 安全：同源校验（跨站 403）、请求体上限 512 KB、GitHub token 只进 DSH 凭据库。
