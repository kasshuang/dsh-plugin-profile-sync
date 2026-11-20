# dsh-plugin-profile-sync

同步「这台电脑装了哪些 DSH 插件」和登记过的插件设置——通过**私有 GitHub 仓库**或**本地/云盘文件夹**，换台电脑对齐后立刻能用同款环境。

它不是账号系统，也不碰会话数据：只搬运插件名称、版本、启用状态和你在白名单里登记过的设置项。

## 为什么需要它

DSH 的插件装在**每台电脑各自**的 profile 里（`~/.dsh/profiles/<name>`），没有账号级同步。于是：

- 换电脑要一个个重装插件；
- 插件设置（比如余额插件的主线模型、折叠的运营商）存在浏览器 `localStorage`，换机就回到默认值。

这个插件把这两件事变成两条 JSON 记录，放进你自己的云盘目录或私有仓库，新机器上拉取、核对差异、点一下应用即可。

## 安装

在 DSH 里：**插件 → 添加插件 → 安装 npm 包**，填：

```
dsh-plugin-profile-sync
```

也可以添加索引源，之后在插件市场里点安装：

```
https://cdn.jsdelivr.net/gh/kasshuang/dsh-plugin-profile-sync@main/market/index.json
```

装好后打开 **设置 → 云同步**。

## 用法

1. **选载体**：本地/云盘文件夹（OneDrive、坚果云、Syncthing 都行）或私有 GitHub 仓库。
2. **填位置并保存**：
   - 文件夹模式：填一个已同步目录，例如 `C:\Users\you\OneDrive\dsh`；插件会在里面写 `dsh-profile-sync.json`。
   - 仓库模式：填 `owner/repo`、分支（默认 `main`）、文件路径（默认 `dsh-profile-sync.json`），再粘贴一个 **Fine-grained token**，权限只需要 *Contents: Read and write*。token 存在 DSH 凭据库，不写进配置文件、不同步。
3. **推送到云端**：把这台机器的插件清单和白名单设置写上去。
4. **从云端拉取**（新机器）：读取云端快照，跟本机比对，列出三类差异：
   - 待安装（云端有、本机没有）
   - 版本/启用状态不同
   - 设置差异（本机没有、云端更新、本机更新）
   - 另外会单列「仅本机有」——这些**永远不会被删除**。
5. **应用所选**：只安装/覆盖你勾选的行。安装走 DSH 的 `pluginManager`，和界面里手动安装同一条路径（所以该要的重启、该失败的失败都如实反馈）。

默认**不自动同步**，每次都是「拉取 → 看差异 → 点应用」，避免某台机器把整个环境带偏。

## 设置白名单

插件设置按 DSH 的约定存放在：

```
~/.dsh/plugin-settings/<namespace>.json
```

结构是 `{ "updatedAt": <毫秒时间戳>, "values": { ... } }`。任何插件把自己的设置写到这里，就会被云同步带上（合并时按 `updatedAt` 取较新的一侧）。

余额用量插件 `dsh-plugin-balance-usage` 从 1.0.1 起已经这么做了——它的「主线模型」「折叠的运营商」就是存在这个文件里的。

## 同步什么、不同步什么

| 会同步 | 不同步 |
| --- | --- |
| 插件包名、版本、启用状态 | 账号登录态、token、API key |
| `~/.dsh/plugin-settings/*.json` 里的白名单设置 | 会话记录、聊天内容、附件 |
| 快照时间戳 | 任何本机路径之外的文件 |

## 安全

- 所有请求必须同源（`sec-fetch-site` / `origin` 校验），跨站请求一律 403。
- GitHub token 存在 DSH 凭据库（`credentials`），不落配置文件、不出现在同步文档里。
- 私有仓库里只有插件清单和设置值——如果某个设置本身就是敏感值，请不要把它登记进白名单。
- 应用阶段只做「安装/覆盖」，不做删除。

## 已知限制

- GitHub 仓库模式需要你自己建仓库并给 token；插件不会替你创建仓库。
- 云端快照只有一份（无历史版本），冲突时按 `updatedAt` 取较新的一侧。
- 应用插件安装时，某些插件可能提示需要重启 DSH 才完全生效（返回 `restart-required`）。
- 不同机器的路径不同，插件只同步标识符与设置值，不同步绝对路径。

## 卸载

**插件 → 已安装 → 云同步 → 移除**。`~/.dsh/profile-sync/state.json` 与云端快照可以保留，重装后继续用；如果不再需要，自行删除这两个文件即可。

## 许可

MIT，见 [LICENSE](LICENSE)。问题请提到 [issues](https://github.com/kasshuang/dsh-plugin-profile-sync/issues)。
