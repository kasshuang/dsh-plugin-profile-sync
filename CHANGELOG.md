# Changelog

## 0.2.3 — 2026-11-27

- 补上 DSH 自己的请求门禁：`/plugins/profile-sync/*` 的每个请求先过 `ctx.connection.requestRejection(req)`（Host 栅栏 + 开启浏览器登录时的会话 cookie），被拒时回 401/403，路由逻辑根本不执行。之前只有同源校验，浏览器里随便一个网页都能用你的 cookie 读走同步状态。
- 以方法形式调用（`gate.call(connection, request)`），不会因为丢了 `this` 把设置页自己也挡在外面；没有 connection 服务的旧版 Host 退回 loopback 白名单。
- 测试补 6 条门禁用例（含 `this` 绑定、401 拒绝、异常 fail-closed、旧版回退），`node test/device-flow.test.mjs` 19/19。

## 0.2.2 — 2026-11-23

- 修复空仓库首次推送失败：GitHub 对「分支还不存在」的写入返回 409 `Git Repository is empty`。现在遇到 409 会去掉 `branch` 重试一次，这一下就成为仓库的首个提交，之后 `main` 分支自然存在，`推送到云端` 一次成功（本机实测 revision `2eeedac`，13 个 bundle、1 个设置命名空间）。
- 测试不再依赖 curl：`PS_TRANSPORT=fetch` 时走平台 fetch，`node test/device-flow.test.mjs` 恢复 13/13。

## 0.2.1 — 2026-11-23

- 修复「连接 GitHub」报 `fetch failed`：Node 自带的 fetch 不读 Windows 系统代理，Clash/V2Ray 这类环境下连不上 github.com。现在 Host 会依次读 `HTTPS_PROXY`/`HTTP_PROXY` 与注册表 `Internet Settings`，再用 curl 带 `--proxy` 发请求；`/connect/*` 与全部 GitHub 读写都走这条通道。
- 界面不再假装「已连接」：上次请求返回 401/403 时改为「授权已过期，请重新连接」，不再和红色 403 同时出现。
- 默认 OAuth App client id 换成启用 Device Flow 的那个（`Ov23litezrV48E7HFG8X`）。

## 0.2.0 — 2026-11-20

一键连接 GitHub，不再需要手工建 token、建仓库、填字段。

- 新增 **连接 GitHub**：OAuth Device Flow。点按钮 → 弹窗给出 8 位码与链接 → 浏览器授权 → 自动拿到 token。
- 连接完成后自动：创建私有仓库 `<login>/dsh-profile-sync-data`（已存在则复用；空仓库通过 Git Data API 补首个提交）、写入凭据库、填好仓库/分支/文件路径。
- 仓库模式默认只显示连接状态；仓库、分支、路径、手工 token 收进「高级」折叠区。
- 新增 `POST /connect/start`、`POST /connect/poll`、`POST /connect/cancel` 三个路由，设备码只在 Host 内存中保存。
- 新增 `test/device-flow.test.mjs`：stub 网络覆盖 start/pending/slow_down/授权成功/空仓库播种/过期/取消。

## 0.1.0 — 2026-11-20

首个可用版本。

- 新的设置页 **设置 → 云同步**：同步载体、连接测试、推送、拉取、差异核对与应用。
- 两种载体：本地/云盘文件夹（原子写入）与私有 GitHub 仓库（Contents API，含 409 冲突重试）。
- 同步内容：非内置插件的包名/版本/启用状态，以及 `~/.dsh/plugin-settings/*.json` 白名单设置；合并按 `updatedAt` 取较新一侧。
- 差异分四组：待安装、版本与启用状态不同、设置差异、仅本机有（永不删除）。
- 应用阶段走 DSH 的 `pluginManager`，按 `ChangeResult.application` 如实上报 `applied` / `restart-required` / `failed`。
- 安全：同源校验（跨站 403）、请求体上限 512 KB、GitHub token 只进 DSH 凭据库。
