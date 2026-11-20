/**
 * Client half of the profile-sync bundle: one settings page that shows the
 * cloud snapshot, the differences against this machine, and the three actions
 * (push, pull, apply). All work happens in the Host half behind our own routes.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-profile-sync',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const BASE = '/plugins/profile-sync'
    let clientCtx = null

    function activeLocale() {
      const snapshot = clientCtx?.locale?.getLocale?.()
      return typeof snapshot?.active === 'string' ? snapshot.active : ''
    }

    function isChinese() {
      return activeLocale().toLowerCase().startsWith('zh')
    }

    const COPY = {
      zh: {
        title: '云同步',
        subtitle: '把「装了哪些插件」和白名单里的插件设置同步到私有仓库或云盘目录；新机器对齐后一样能用。',
        adapter: '同步载体',
        adapterRepo: '私有 GitHub 仓库',
        adapterFolder: '本地/云盘文件夹',
        repo: '仓库（owner/repo）',
        repoPlaceholder: 'kasshuang/dsh-profile-sync-data',
        branch: '分支',
        docPath: '文件路径',
        folder: '文件夹路径',
        folderPlaceholder: 'C:\\Users\\you\\OneDrive\\dsh',
        token: 'GitHub Token（Fine-grained，Contents: Read and write）',
        tokenSaved: '已保存 token，留空表示不修改',
        tokenPlaceholder: 'github_pat_…',
        save: '保存配置',
        test: '测试连接',
        push: '推送到云端',
        pull: '从云端拉取',
        apply: '应用所选',
        autoSync: '自动同步（默认关）',
        device: '本机',
        last: '上次同步',
        never: '从未',
        revision: '云端版本',
        noRemote: '云端还没有快照',
        saved: '已保存',
        testing: '正在连接…',
        working: '处理中…',
        pushDone: '已推送',
        pullDone: '已拉取',
        appliedDone: '已应用',
        missing: '待安装（云端有、本机没有）',
        drift: '版本/启用状态不同',
        extra: '仅本机有（不会删除）',
        settingsDiff: '设置差异',
        noDiff: '与云端一致',
        selectAll: '全选',
        bundles: '插件',
        settings: '设置',
        local: '本机',
        remote: '云端',
        hint: '应用只会安装或覆盖这里勾选的内容；凭据永远不同步。',
        failed: '操作失败',
        retry: '重试',
        errFolder: '还没填文件夹路径',
        errRepo: '还没填仓库（owner/repo）',
        errToken: '还没保存 GitHub Token',
        errNoRemote: '云端还没有快照，先推送一次',
        errForbidden: '跨站请求被拒绝',
        errLock: '插件目录被占用，请先关闭占用它的程序后重试',
      },
      en: {
        title: 'Cloud sync',
        subtitle: 'Mirror which plugins are installed and whitelisted plugin settings to a private repo or a synced folder.',
        adapter: 'Transport',
        adapterRepo: 'Private GitHub repository',
        adapterFolder: 'Local / synced folder',
        repo: 'Repository (owner/repo)',
        repoPlaceholder: 'you/dsh-profile-sync-data',
        branch: 'Branch',
        docPath: 'Document path',
        folder: 'Folder',
        folderPlaceholder: 'C:\\Users\\you\\OneDrive\\dsh',
        token: 'GitHub token (fine-grained, Contents: Read and write)',
        tokenSaved: 'Token stored — leave empty to keep it',
        tokenPlaceholder: 'github_pat_…',
        save: 'Save',
        test: 'Test connection',
        push: 'Push',
        pull: 'Pull',
        apply: 'Apply selected',
        autoSync: 'Auto sync (off by default)',
        device: 'This machine',
        last: 'Last sync',
        never: 'never',
        revision: 'Cloud revision',
        noRemote: 'Nothing in the cloud yet',
        saved: 'Saved',
        testing: 'Connecting…',
        working: 'Working…',
        pushDone: 'Pushed',
        pullDone: 'Pulled',
        appliedDone: 'Applied',
        missing: 'Missing here (in the cloud only)',
        drift: 'Different version / enabled state',
        extra: 'Only on this machine (never removed)',
        settingsDiff: 'Settings differences',
        noDiff: 'In sync with the cloud',
        selectAll: 'Select all',
        bundles: 'Plugins',
        settings: 'Settings',
        local: 'local',
        remote: 'cloud',
        hint: 'Applying only installs or overwrites what you select here; credentials never sync.',
        failed: 'Action failed',
        retry: 'Retry',
      },
    }

    function copy() {
      return COPY[isChinese() ? 'zh' : 'en']
    }

    async function call(action, body) {
      const response = await fetch(`${BASE}/${action}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        signal: AbortSignal.timeout(40_000),
      })
      const text = await response.text()
      let payload = null
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${response.status}`)
      }
      if (!response.ok || (payload && payload.ok === false)) {
        throw new Error((payload && payload.error) || `HTTP ${response.status}`)
      }
      return payload
    }

    /* The Host reports operator-grade English strings; map the common ones so the
       panel never mixes languages. */
    function humanError(message, t) {
      const text = String(message || '')
      const table = [
        ['No sync folder configured', t.errFolder],
        ['No repository configured', t.errRepo],
        ['No GitHub token stored', t.errToken],
        ['No snapshot in the cloud yet', t.errNoRemote],
        ['Cross-origin request rejected', t.errForbidden],
        ['EPERM', t.errLock],
        ['EBUSY', t.errLock],
      ]
      for (const [needle, replacement] of table) {
        if (text.includes(needle)) return replacement
      }
      return text
    }

    function fmtTime(value, t) {      if (!value) return t.never
      try {
        return new Intl.DateTimeFormat(isChinese() ? 'zh-CN' : 'en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }).format(new Date(value))
      } catch {
        return String(value)
      }
    }

    function Field(props) {
      return h(
        'label',
        { className: 'dps-field' },
        h('span', { className: 'dps-field__label' }, props.label),
        props.children,
      )
    }

    function Row(props) {
      return h(
        'div',
        { className: 'dps-row' },
        h('span', { className: 'dps-row__name' }, props.name),
        h('span', { className: 'dps-row__meta' }, props.meta || ''),
      )
    }

    function SyncSection() {
      const t = useMemo(copy, [activeLocale()])
      const [snapshot, setSnapshot] = useState({ loading: true })
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState({ kind: '', text: '' })
      const [picked, setPicked] = useState({ install: [], enable: [], settings: [] })
      const [diff, setDiff] = useState(null)

      const load = useCallback(async () => {
        try {
          const payload = await call('state')
          setSnapshot(payload)
          setForm((current) => current || { ...payload.state, token: '' })
          if (payload.diff) setDiff(payload.diff)
        } catch (error) {
          setSnapshot({ loading: false, error: humanError(error.message || error, t) })
        }
      }, [])

      useEffect(() => {
        load()
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') load()
        }, 30_000)
        return () => clearInterval(timer)
      }, [load])

      const run = async (label, action, body, done) => {
        setBusy(label)
        setNotice({ kind: '', text: '' })
        try {
          const payload = await call(action, body)
          if (done) done(payload)
          setNotice({ kind: 'ok', text: done ? '' : '' })
          await load()
        } catch (error) {
          setNotice({ kind: 'error', text: humanError(error.message || error, t) })
        } finally {
          setBusy('')
        }
      }

      const save = () =>
        run('save', 'config', {
          adapter: form.adapter,
          repo: form.repo,
          branch: form.branch,
          docPath: form.docPath,
          folder: form.folder,
          autoSync: form.autoSync,
          ...(form.token ? { token: form.token } : {}),
        }, () => {
          setForm((current) => ({ ...current, token: '' }))
          setNotice({ kind: 'ok', text: t.saved })
        })

      const test = () =>
        run('test', 'test', {}, (payload) => {
          setNotice({
            kind: 'ok',
            text: payload.exists ? `${t.revision} ${payload.revision} · ${payload.bundles} ${t.bundles}` : t.noRemote,
          })
        })

      const push = () =>
        run('push', 'push', {}, (payload) => {
          setNotice({ kind: 'ok', text: `${t.pushDone} · ${payload.bundles} ${t.bundles} · ${t.revision} ${payload.revision || '—'}` })
        })

      const pull = () =>
        run('pull', 'pull', {}, (payload) => {
          setDiff(payload.diff)
          setPicked({
            install: payload.diff.missing.map((row) => row.spec || row.name),
            enable: [],
            settings: payload.diff.settings.filter((row) => row.state === 'remote-newer' || row.state === 'missing-local').map((row) => row.ns),
          })
          setNotice({ kind: 'ok', text: t.pullDone })
        })

      const apply = () =>
        run('apply', 'apply', {
          install: picked.install,
          enable: picked.enable,
          settings: (diff?.settings || [])
            .filter((row) => picked.settings.includes(row.ns))
            .map((row) => ({ ns: row.ns })),
        }, (payload) => {
          const text = payload.failed?.length ? `${t.failed}: ${payload.failed[0].error || payload.failed[0].spec}` : t.appliedDone
          setNotice({ kind: payload.failed?.length ? 'error' : 'ok', text })
          setDiff(null)
          setPicked({ install: [], enable: [], settings: [] })
        })

      if (!form) {
        return h('section', { className: 'dps' }, h('div', { className: 'dps-loading' }, t.working))
      }

      const state = snapshot.state || form
      const isRepo = form.adapter === 'repo'

      const toggle = (kind, value) =>
        setPicked((current) => {
          const list = current[kind]
          return {
            ...current,
            [kind]: list.includes(value) ? list.filter((item) => item !== value) : [...list, value],
          }
        })

      return h(
        'section',
        { className: 'dps' },
        h('header', { className: 'dps-head' },
          h('h3', { className: 'dps-title' }, t.title),
          h('p', { className: 'dps-sub' }, t.subtitle),
        ),

        h('div', { className: 'dps-card' },
          h('div', { className: 'dps-card__head' },
            h('span', { className: 'dps-card__title' }, t.adapter),
            h('span', { className: 'dps-badge' }, `${t.device} ${snapshot.device?.name || '—'}`),
          ),
          h('div', { className: 'dps-seg' },
            ['folder', 'repo'].map((value) =>
              h('button', {
                key: value,
                type: 'button',
                className: 'dps-seg__item',
                'data-active': form.adapter === value ? 'true' : 'false',
                onClick: () => setForm({ ...form, adapter: value }),
              }, value === 'repo' ? t.adapterRepo : t.adapterFolder),
            ),
          ),
          isRepo
            ? h(React.Fragment, null,
                h(Field, { label: t.repo }, h('input', {
                  className: 'dps-input',
                  value: form.repo,
                  placeholder: t.repoPlaceholder,
                  onChange: (event) => setForm({ ...form, repo: event.target.value }),
                })),
                h('div', { className: 'dps-grid' },
                  h(Field, { label: t.branch }, h('input', {
                    className: 'dps-input',
                    value: form.branch,
                    onChange: (event) => setForm({ ...form, branch: event.target.value }),
                  })),
                  h(Field, { label: t.docPath }, h('input', {
                    className: 'dps-input',
                    value: form.docPath,
                    onChange: (event) => setForm({ ...form, docPath: event.target.value }),
                  })),
                ),
                h(Field, { label: state.hasToken ? `${t.token} · ${t.tokenSaved}` : t.token }, h('input', {
                  className: 'dps-input',
                  type: 'password',
                  value: form.token,
                  placeholder: t.tokenPlaceholder,
                  onChange: (event) => setForm({ ...form, token: event.target.value }),
                })),
              )
            : h(Field, { label: t.folder }, h('input', {
                className: 'dps-input',
                value: form.folder,
                placeholder: t.folderPlaceholder,
                onChange: (event) => setForm({ ...form, folder: event.target.value }),
              })),

          h('div', { className: 'dps-actions' },
            h('button', { className: 'dps-btn dps-btn--primary', type: 'button', onClick: save, disabled: busy !== '' }, t.save),
            h('button', { className: 'dps-btn', type: 'button', onClick: test, disabled: busy !== '' }, t.test),
            h('button', { className: 'dps-btn', type: 'button', onClick: push, disabled: busy !== '' }, t.push),
            h('button', { className: 'dps-btn', type: 'button', onClick: pull, disabled: busy !== '' }, t.pull),
            busy ? h('span', { className: 'dps-busy' }, t.working) : null,
          ),

          h('div', { className: 'dps-meta' },
            h('span', null, `${t.last} · ${fmtTime(Math.max(state.lastPushAt || 0, state.lastPullAt || 0), t)}`),
            snapshot.remote ? h('span', null, `${t.revision} · ${snapshot.remote.revision}`) : h('span', null, t.noRemote),
          ),
          snapshot.remoteError ? h('div', { className: 'dps-error' }, snapshot.remoteError) : null,
          notice.text ? h('div', { className: notice.kind === 'error' ? 'dps-error' : 'dps-ok' }, notice.text) : null,
        ),

        diff
          ? h('div', { className: 'dps-card' },
              h('div', { className: 'dps-card__head' },
                h('span', { className: 'dps-card__title' }, t.pullDone),
                h('span', { className: 'dps-badge' }, snapshot.remote ? `${t.revision} ${snapshot.remote.revision}` : ''),
              ),
              diff.missing.length
                ? h('div', { className: 'dps-group' },
                    h('div', { className: 'dps-group__title' }, t.missing),
                    diff.missing.map((row) =>
                      h('label', { key: row.name, className: 'dps-check' },
                        h('input', {
                          type: 'checkbox',
                          checked: picked.install.includes(row.spec || row.name),
                          onChange: () => toggle('install', row.spec || row.name),
                        }),
                        h('span', { className: 'dps-check__name' }, row.name),
                        h('span', { className: 'dps-check__meta' }, row.version || ''),
                      ),
                    ),
                  )
                : null,
              diff.drift.length
                ? h('div', { className: 'dps-group' },
                    h('div', { className: 'dps-group__title' }, t.drift),
                    diff.drift.map((row) =>
                      h(Row, { key: row.name, name: row.name, meta: `${row.local} → ${row.remote}` }),
                    ),
                  )
                : null,
              diff.settings.length
                ? h('div', { className: 'dps-group' },
                    h('div', { className: 'dps-group__title' }, t.settingsDiff),
                    diff.settings.map((row) =>
                      h('label', { key: row.ns, className: 'dps-check' },
                        h('input', {
                          type: 'checkbox',
                          checked: picked.settings.includes(row.ns),
                          onChange: () => toggle('settings', row.ns),
                        }),
                        h('span', { className: 'dps-check__name' }, row.ns),
                        h('span', { className: 'dps-check__meta' }, row.state),
                      ),
                    ),
                  )
                : null,
              diff.extraOnlyLocal.length
                ? h('div', { className: 'dps-group' },
                    h('div', { className: 'dps-group__title' }, t.extra),
                    diff.extraOnlyLocal.map((row) => h(Row, { key: row.name, name: row.name, meta: row.version || '' })),
                  )
                : null,
              !diff.missing.length && !diff.drift.length && !diff.settings.length
                ? h('div', { className: 'dps-ok' }, t.noDiff)
                : null,
              h('div', { className: 'dps-actions' },
                h('button', { className: 'dps-btn dps-btn--primary', type: 'button', onClick: apply, disabled: busy !== '' }, t.apply),
              ),
            )
          : null,

        h('p', { className: 'dps-hint' }, t.hint),
      )
    }

    const CSS = `
.dps { display:flex; flex-direction:column; gap:14px; padding:4px 0 24px; color:var(--dsw-alias-label-primary); }
.dps-head { display:flex; flex-direction:column; gap:6px; }
.dps-title { margin:0; font-size:16px; font-weight:600; }
.dps-sub { margin:0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.dps-card { display:flex; flex-direction:column; gap:12px; padding:16px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.dps-card__head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dps-card__title { font-size:13px; font-weight:600; }
.dps-badge { font-size:11px; padding:2px 8px; border-radius:999px; background:var(--dsw-alias-bg-skeleton); color:var(--dsw-alias-label-secondary); }
.dps-seg { display:inline-flex; gap:4px; padding:3px; border-radius:9px; background:var(--dsw-alias-bg-skeleton); align-self:flex-start; }
.dps-seg__item { border:0; background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; padding:5px 12px; border-radius:7px; cursor:pointer; }
.dps-seg__item[data-active="true"] { background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); box-shadow:0 1px 2px rgba(0,0,0,.08); }
.dps-field { display:flex; flex-direction:column; gap:6px; }
.dps-field__label { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dps-input { width:100%; box-sizing:border-box; padding:8px 10px; font-size:12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dps-input:focus { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dps-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.dps-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.dps-btn { padding:7px 14px; font-size:12px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); cursor:pointer; }
.dps-btn:hover { background:var(--dsw-alias-bg-skeleton); }
.dps-btn--primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
.dps-btn[disabled] { opacity:.55; cursor:default; }
.dps-busy { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dps-meta { display:flex; flex-wrap:wrap; gap:14px; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dps-error { font-size:12px; color:var(--dsw-alias-state-error-primary); }
.dps-ok { font-size:12px; color:var(--dsw-alias-state-success-primary); }
.dps-group { display:flex; flex-direction:column; gap:6px; }
.dps-group__title { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dps-check { display:flex; align-items:center; gap:8px; font-size:12px; padding:4px 0; cursor:pointer; }
.dps-check__name { flex:1; }
.dps-check__meta { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dps-row { display:flex; justify-content:space-between; gap:8px; font-size:12px; padding:4px 0; }
.dps-row__meta { font-size:11px; color:var(--dsw-alias-label-secondary); }
.dps-hint { margin:0; font-size:11px; line-height:1.6; color:var(--dsw-alias-label-secondary); }
.dps-loading { font-size:12px; color:var(--dsw-alias-label-secondary); padding:12px 0; }
@media (max-width: 720px) { .dps-grid { grid-template-columns:1fr; } }
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = 'dsh-profile-sync-style'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        })
        ctx.effect(() => {
          if (typeof ctx.on !== 'function') return () => {}
          const dispose = ctx.on('locale/change', () => {})
          return () => dispose()
        })
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'profile-sync',
              order: 20,
              label: () => (isChinese() ? '云同步' : 'Cloud sync'),
            },
            SyncSection,
          ),
        )
      },
    }
  },
})
