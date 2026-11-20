# dsh-plugin-profile-sync — 实现说明

## 它解决的具体问题

DSH 的插件按机器安装：`~/.dsh/profiles/<profile>/package.json` 里记着依赖和 `dsh.profile.bundles`，`node_modules` 是 pnpm 装出来的。换台电脑，这份清单不会跟着走；插件设置（若存在浏览器 `localStorage`）同样只在那一台机器上有效。

这个插件只做一件事：把「插件清单 + 白名单设置」变成一份可放进云盘或私有仓库的 JSON，并在另一台机器上做差异核对与选择性应用。

## 两个半边

### Host（`index.js`）

- `export const inject = ['webServer']`，注册 **prefix 路由** `/plugins/profile-sync`（用 Node 风格 `handler(request, response)`，因为要处理 POST；`resource` 只支持 GET/HEAD）。
- 动作：
  - `GET  /state` → 本机插件清单、白名单设置、已保存配置、云端快照摘要
  - `POST /config` → 保存载体配置（文件夹模式存路径；仓库模式存 repo/branch/path；token 单独进凭据库）
  - `POST /test` → 读一次云端文档，验证路径/权限
  - `POST /push` → 生成本机快照并写云端（合并后写入）
  - `POST /pull` → 读云端并返回差异
  - `POST /apply` → 应用勾选的安装/启用/设置（只传 `{ns}` 时会先用云端快照补齐 values）
- 状态与凭据：
  - `~/.dsh/profile-sync/state.json`：载体、仓库信息、上次同步时间、云端 revision。
  - 凭据键 `dsh-plugin-profile-sync/github-token`（`credentials.modifyRecord()`，不写配置文件）。
- 插件清单来源：`ctx.get('pluginManager').listBundles()`，过滤掉 `official === true`、`installed === false`、`availability === 'missing'` 的条目。
- 设置来源：`~/.dsh/plugin-settings/<ns>.json`，结构 `{updatedAt, values}`；写入用临时文件 + rename 原子替换。

### Client（`client.js`）

- `window.__ModuleLoader__.load({ id: 'dsh-plugin-profile-sync', factory })`，`inject: ['slots','locale']`。
- 注册 `settings.section`（id `profile-sync`，order 20），左侧设置导航出现「云同步」。
- 单页完成：载体分段控件 → 位置字段 → 保存/测试/推送/拉取 → 差异分组（可勾选）→ 应用所选。
- 样式全部使用主题 token（`--dsw-alias-*`），跟随浅色/深色。

## 同步文档格式

```json
{
  "format": 1,
  "updatedAt": 1795148904306,
  "device": "WIN-XXXX",
  "bundles": [
    { "name": "dsh-plugin-balance-usage", "version": "1.0.1", "enabled": true, "spec": "dsh-plugin-balance-usage@1.0.1" }
  ],
  "settings": {
    "balance-usage": { "updatedAt": 1795148904306, "values": { "primary": { "provider": "deepseek-account", "model": "deepseek-flash" } } }
  }
}
```

- `bundles[].spec` 优先取 `installTarget.spec`，缺失时回退到 `name@version`。
- 合并规则：`settings` 按 namespace 逐个比较 `updatedAt`，取较新的一侧；`bundles` 以云端为基准，本机独有的条目只出现在「仅本机有」分组、永不删除。

## 差异与应用

`computeDiff` 产出：

| 分组 | 含义 | 可应用 |
| --- | --- | --- |
| `missing` | 云端有、本机没有 | 安装 |
| `drift` | 版本或启用状态不同 | 安装/切换启用 |
| `settings` | `missing-local` / `remote-newer` / `local-newer` | 写入本机设置 |
| `extraOnlyLocal` | 仅本机有 | 否（永不删除） |

应用阶段调用 `pluginManager.installBundle(spec)` 与 `setBundleEnabled(name, enabled)`，然后按返回的 `ChangeResult.application` 判定：

- `applied` → 成功
- `restart-required` → 成功但提示重启
- `failed` / `cancelled` 或带 `error` → 失败，计入 `failed` 计数并回传原因

> 注意：`installBundle` 对不存在的包**不会抛异常**，而是返回 `application: 'failed'`。只 try/catch 会误报成功，必须读 `ChangeResult`。

## 安全边界

- 同源校验：`sec-fetch-site` 不是 `same-origin`/`none` 时拒绝；`origin.host` 与请求 host 不一致时拒绝（403）。
- 请求体上限 512 KB。
- token 只在 Host 侧用于 `api.github.com` 调用，不回传给 Client。
- 同步文档里不含 token、登录态、会话、附件、绝对路径。

## 已知限制

- 只支持一棵云端快照，没有历史版本与冲突合并（按时间戳取新）。
- GitHub 仓库需用户自建；token 需要 Fine-grained + Contents 读写。
- 云端文件被其他机器同时写入时，GitHub 采用 sha 校验 + 一次 409 重试；极端并发仍可能覆盖。

## 验证记录（0.1.0）

- 文件夹载体：`config → push → pull` 往返，`missing=0`；手工塞入假插件与设置后，`pull` 正确报出 `missing=1`、`settings=1`；`apply` 写出 `~/.dsh/plugin-settings/balance-usage.json`。
- 应用失败路径：对不存在的包 `apply` 返回 `ok=false applied=0 failed=1 error='operation-error'`。
- 同源校验：`sec-fetch-site: cross-site` → 403。
- 真实 GUI（`http://127.0.0.1:61563`）：设置页渲染、载体切换、错误文案本地化（「还没填文件夹路径」）均正常。
