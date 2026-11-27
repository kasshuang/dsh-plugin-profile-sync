# dsh-plugin-profile-sync

把「装了哪些 DSH 插件」和白名单插件的设置同步到私有 GitHub 仓库或云盘目录，新机器对齐一次就能接着用。

- 同步内容：插件名、版本、启用状态；白名单设置命名空间的 JSON 值。
- 不同步内容：凭据、聊天记录、任何插件私有数据。
- 两种载体：私有 GitHub 仓库（推荐）、本地/云盘文件夹（OneDrive、iCloud 等）。

## 安装

在 DSH 里「设置 → 插件 → 安装」，填入 `dsh-plugin-profile-sync`；或：

```powershell
dsh plugin add dsh-plugin-profile-sync
```

安装后到「设置 → 云同步」。

## 连接 GitHub（推荐：一次授权，零配置）

1. 打开「设置 → 云同步」，载体选 **私有 GitHub 仓库**，点 **连接 GitHub**。
2. 弹窗给出一组 8 位码和一个链接：打开链接，输入码，点 Authorize。
3. 授权完成后插件自动：创建私有仓库 `<你的账号>/dsh-profile-sync-data`（已存在就复用，空仓库会补上首个提交）、保存 token、填好仓库/分支/文件路径。

之后只剩两个按钮：**推送到云端**、**从云端拉取**。

> 需要插件自带 OAuth App 的 Client ID，见文末「给插件作者」。

## 用云盘文件夹

载体选 **本地/云盘文件夹**，填一个会被同步的目录（例如 `C:\Users\you\OneDrive\dsh`）。不需要任何账号；多台机器靠网盘同步同一个 `dsh-profile-sync.json`。冲突以文件更新时间较新的一方为准。

## 从云端恢复

1. **从云端拉取** → 列出云端有、本机没有的插件，以及设置差异。
2. 勾选要恢复的条目 → **应用所选**。只会安装或覆盖勾选的内容，不会删除本机独有的插件。

## 状态与配置

状态文件：`%DSH_HOME%\profile-sync\state.json`（默认 `C:\Users\<you>\.dsh\profile-sync\state.json`）

| 字段 | 说明 |
| --- | --- |
| `adapter` | `repo` 或 `folder` |
| `repo` | `owner/repo` |
| `branch` / `docPath` | 默认 `main` / `dsh-profile-sync.json` |
| `folder` | 云盘目录绝对路径 |
| `autoSync` | 预留 |
| `lastPushAt` / `lastPullAt` / `lastError` | 最近一次操作 |

白名单设置目录：`%DSH_HOME%\plugin-settings\<namespace>.json`。

## 隐私

- token 走 DSH 的 credentials 服务，落在 `~/.dsh/.credentials.yaml`，**不会**写进同步文档。
- 同步文档里只有插件清单和白名单命名空间的设置值。
- 设备授权码只在内存里保存一次轮询周期，授权完成或取消即丢弃。
- 插件自己的 HTTP 路由（`/plugins/profile-sync/*`）先过 DSH 的请求门禁 `ctx.connection.requestRejection`：Host 栅栏 + 开启浏览器登录时的会话 cookie，未通过直接 401/403、路由不执行。浏览器里任意网页无法借用你的 cookie 读写同步状态。

## 给插件作者：注册 OAuth App（一次性，约一分钟）

1. GitHub → Settings → Developer settings → **OAuth Apps** → **New OAuth App**。
2. 填：
   - Application name：`DSH Profile Sync`
   - Homepage URL：仓库地址即可
   - Authorization callback URL：`http://127.0.0.1:1/callback`（Device Flow 不使用它，填个合法 URL 只为通过校验）
3. 创建后进入应用设置，勾选 **Enable Device Flow**。
4. 复制 **Client ID**，填到 `index.js` 顶部的 `DEFAULT_CLIENT_ID`；开发时也可以用环境变量 `DSH_PROFILE_SYNC_GITHUB_CLIENT_ID` 覆盖。

Client ID 是公开值，可以随包提交；**不要**把 Client Secret 放进来，Device Flow 不需要它。

授权范围只需要 `repo`（创建私有仓库 + 读写其内容）。

## 开发

```powershell
node test/device-flow.test.mjs   # 设备流状态机（stub fetch，不联网）
```

目录：`index.js`（Host：路由、GitHub API、设备流、文件夹读写）、`client.js`（Web 端设置页）、`locale/`、`icon.svg`。

## License

MIT
