/**
 * Host half of the profile-sync bundle.
 *
 * Owns the cloud document (profile bundles + whitelisted plugin settings),
 * the two transports (private GitHub repository, local synced folder), and the
 * apply step that installs bundles through the `pluginManager` service.
 *
 * The Client half only renders what this side reports and asks it to act; all
 * filesystem, credential, and network work lives here.
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const inject = ['webServer']

const ROUTE = '/plugins/profile-sync'
const SCHEMA = 1
const DOC_FILE = 'dsh-profile-sync.json'
const TOKEN_KEY = 'dsh-plugin-profile-sync/github-token'
const MAX_DOC_BYTES = 512 * 1024

/* One-click GitHub connection: OAuth App + Device Flow, so the user never has
   to create a token or a repository by hand. Register the app once (Device Flow
   enabled) and paste its public client id here; nothing else is needed. */
const DEFAULT_CLIENT_ID = 'Ov23litezrV48E7HFG8X'
const CLIENT_ID = String(process.env.DSH_PROFILE_SYNC_GITHUB_CLIENT_ID || DEFAULT_CLIENT_ID).trim()
const SYNC_REPO = 'dsh-profile-sync-data'
const DEVICE_SCOPE = 'repo'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const DEVICE_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const MISSING_CLIENT_ID =
  'GitHub OAuth client id is not configured: register an OAuth App with Device Flow enabled and set DEFAULT_CLIENT_ID or DSH_PROFILE_SYNC_GITHUB_CLIENT_ID'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_DIR = path.join(HOME, 'profile-sync')
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const SETTINGS_DIR = path.join(HOME, 'plugin-settings')

const DEFAULTS = {
  adapter: 'folder',
  repo: '',
  branch: 'main',
  docPath: DOC_FILE,
  folder: '',
  autoSync: false,
  lastPullAt: 0,
  lastPushAt: 0,
  lastError: '',
}

/* ------------------------------------------------------------------ storage */

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...DEFAULTS, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULTS }
  }
}

async function writeState(next) {
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2), 'utf8')
}

async function readSettingsNamespaces() {
  const out = {}
  let names = []
  try {
    names = await fs.readdir(SETTINGS_DIR)
  } catch {
    return out
  }
  for (const file of names) {
    if (!file.endsWith('.json')) continue
    const ns = file.slice(0, -5)
    try {
      const raw = await fs.readFile(path.join(SETTINGS_DIR, file), 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.values && typeof parsed.values === 'object') {
        out[ns] = { updatedAt: Number(parsed.updatedAt) || 0, values: parsed.values }
      }
    } catch {
      /* a half-written settings file is not worth failing the sync for */
    }
  }
  return out
}

/* --------------------------------------------------------------- github API */

function githubBase(repo, branch, docPath) {
  return `https://api.github.com/repos/${repo}/contents/${docPath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`
}

/* --------------------------------------------------------------- networking */
/* Node's fetch ignores the Windows system proxy, and many desktops (Clash,
   V2Ray, company gateways) only reach github.com through one. Resolve the proxy
   once and let curl do the request, so TLS, chunking and redirects stay correct. */

let proxyCache

async function proxyUrl() {
  if (proxyCache !== undefined) return proxyCache
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY
    || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
  if (env) {
    proxyCache = env.includes('://') ? env : `http://${env}`
    return proxyCache
  }
  proxyCache = ''
  if (process.platform === 'win32') {
    try {
      const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
      const { stdout } = await execFileAsync('reg', ['query', key], { windowsHide: true })
      if (/ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)) {
        const found = stdout.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)
        if (found) {
          const httpsEntry = found[1].match(/(?:https|http)=([^;]+)/i)
          const value = httpsEntry ? httpsEntry[1] : found[1].split(';')[0]
          if (value) proxyCache = value.includes('://') ? value : `http://${value}`
        }
      }
    } catch {
      proxyCache = ''
    }
  }
  return proxyCache
}

async function rawRequest(target, init = {}) {
  const method = String(init.method || 'GET').toUpperCase()
  const headers = { 'user-agent': 'dsh-plugin-profile-sync', ...(init.headers || {}) }
  const body = init.body === undefined || init.body === null ? null : String(init.body)
  /* Tests run without curl and without a proxy: PS_TRANSPORT=fetch swaps the
     transport for the platform fetch so the suite can stub the network. */
  if (process.env.PS_TRANSPORT === 'fetch') {
    const response = await fetch(target, { method, headers, body: body === null ? undefined : body })
    return { status: response.status, text: await response.text() }
  }
  const proxy = await proxyUrl()
  const args = ['-sS', '--max-time', '40', '--url', target, '-X', method, '-w', '\n%{http_code}']
  if (proxy) args.push('--proxy', proxy)
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`)
  if (body !== null) args.push('--data-binary', body)
  let stdout = ''
  try {
    const result = await execFileAsync('curl', args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })
    stdout = result.stdout
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('cannot run curl, which this plugin needs to reach GitHub')
    const detail = String(error.stderr || error.message || '').trim().slice(0, 300)
    throw new Error(`network error: ${detail || 'request failed'}`)
  }
  const cut = stdout.lastIndexOf('\n')
  const status = cut === -1 ? 0 : Number(stdout.slice(cut + 1)) || 0
  return { status, text: cut === -1 ? stdout : stdout.slice(0, cut) }
}

async function ghFetch(target, init = {}) {
  const { status, text } = await rawRequest(target, init)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (text ? JSON.parse(text) : null),
  }
}

function githubHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-plugin-profile-sync',
    'x-github-api-version': '2022-11-28',
  }
}

async function readGithubDoc(state, token) {
  const response = await ghFetch(githubBase(state.repo, state.branch, state.docPath), {
    headers: githubHeaders(token),
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 300)}`)
  const payload = await response.json()
  const text = Buffer.from(String(payload.content || '').replace(/\s+/g, ''), 'base64').toString('utf8')
  const doc = JSON.parse(text.replace(/^\uFEFF/, ''))
  return { doc, sha: payload.sha, revision: String(payload.sha || '').slice(0, 7) }
}

async function writeGithubDoc(state, token, doc) {
  const body = {
    message: `sync: profile snapshot from ${os.hostname()} at ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(doc, null, 2), 'utf8').toString('base64'),
    branch: state.branch,
  }
  const url = `https://api.github.com/repos/${state.repo}/contents/${state.docPath.split('/').map(encodeURIComponent).join('/')}`
  /* GitHub answers 409 "Git Repository is empty" for writes that name a branch
     that does not exist yet. Omitting the branch on the retry turns the write
     into the repository's first commit, which is the only documented way to
     authorise a brand new repository through the contents API. */
  let firstCommit = false
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await ghFetch(`${url}?ref=${encodeURIComponent(state.branch)}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(20_000),
    })
    const withSha = { ...body }
    if (firstCommit) delete withSha.branch
    if (current.ok) {
      const meta = await current.json()
      withSha.sha = meta.sha
    }
    const response = await ghFetch(url, {
      method: 'PUT',
      headers: { ...githubHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify(withSha),
      signal: AbortSignal.timeout(25_000),
    })
    if (response.ok) {
      const saved = await response.json()
      return String(saved.content?.sha || '').slice(0, 7)
    }
    if (response.status === 409 && !firstCommit) {
      firstCommit = true
      continue
    }
    throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 300)}`)
  }
  throw new Error('GitHub write raced twice; try again')
}

/* --------------------------------------------------------------- device flow */

let deviceSession = null

async function githubApi(token, url, init = {}) {
  const response = await ghFetch(url, {
    method: init.method || 'GET',
    headers: {
      ...githubHeaders(token),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(25_000),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { message: text.slice(0, 300) }
  }
  return { status: response.status, payload }
}

async function deviceRequest(url, fields) {
  const response = await ghFetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'dsh-plugin-profile-sync',
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { error: 'invalid_response', error_description: text.slice(0, 300) }
  }
  if (!response.ok && !payload?.error) {
    throw new Error(`GitHub ${response.status}: ${text.slice(0, 200) || 'device flow request failed'}`)
  }
  return payload || {}
}

async function deviceStart() {
  if (!CLIENT_ID) throw new Error(MISSING_CLIENT_ID)
  const payload = await deviceRequest(DEVICE_CODE_URL, { client_id: CLIENT_ID, scope: DEVICE_SCOPE })
  if (!payload.device_code) {
    throw new Error(`GitHub device flow refused: ${payload.error_description || payload.error || 'no device code'}`)
  }
  const interval = Math.max(5, Number(payload.interval) || 5)
  deviceSession = {
    deviceCode: String(payload.device_code),
    userCode: String(payload.user_code || ''),
    verificationUri: String(payload.verification_uri || 'https://github.com/login/device'),
    interval,
    expiresAt: Date.now() + (Number(payload.expires_in) || 900) * 1000,
  }
  return {
    userCode: deviceSession.userCode,
    verificationUri: deviceSession.verificationUri,
    interval,
    expiresIn: Math.max(0, Math.round((deviceSession.expiresAt - Date.now()) / 1000)),
  }
}

async function githubLogin(token) {
  const who = await githubApi(token, 'https://api.github.com/user')
  const login = who.payload?.login
  if (who.status !== 200 || !login) {
    throw new Error(`GitHub ${who.status}: ${who.payload?.message || 'cannot read the authorized account'}`)
  }
  return String(login)
}

async function seedEmptyRepo(token, repo, branch) {
  const blob = await githubApi(token, `https://api.github.com/repos/${repo}/git/blobs`, {
    method: 'POST',
    body: {
      content: Buffer.from('# DSH profile snapshot\n\nManaged by dsh-plugin-profile-sync. Do not edit by hand.\n', 'utf8').toString('base64'),
      encoding: 'base64',
    },
  })
  if (blob.status !== 201) throw new Error(`GitHub ${blob.status}: ${blob.payload?.message || 'cannot seed the repository'}`)
  const tree = await githubApi(token, `https://api.github.com/repos/${repo}/git/trees`, {
    method: 'POST',
    body: { tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.payload.sha }] },
  })
  if (tree.status !== 201) throw new Error(`GitHub ${tree.status}: ${tree.payload?.message || 'cannot seed the repository'}`)
  const commit = await githubApi(token, `https://api.github.com/repos/${repo}/git/commits`, {
    method: 'POST',
    body: { message: 'init: profile sync snapshot', tree: tree.payload.sha },
  })
  if (commit.status !== 201) throw new Error(`GitHub ${commit.status}: ${commit.payload?.message || 'cannot seed the repository'}`)
  const ref = await githubApi(token, `https://api.github.com/repos/${repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${branch}`, sha: commit.payload.sha },
  })
  if (ref.status !== 201 && ref.status !== 422) {
    throw new Error(`GitHub ${ref.status}: ${ref.payload?.message || 'cannot seed the repository'}`)
  }
  return branch
}

/* Make sure <login>/dsh-profile-sync-data exists and has at least one commit,
   creating and initialising it on first connect. */
async function ensureSyncRepo(token, login) {
  const repo = `${login}/${SYNC_REPO}`
  const found = await githubApi(token, `https://api.github.com/repos/${repo}`)
  if (found.status === 200) {
    const branch = String(found.payload?.default_branch || 'main')
    if (Number(found.payload?.size) === 0) {
      await seedEmptyRepo(token, repo, branch)
    }
    /* The settings page promises a private snapshot; flip an existing public
       repository rather than silently pushing plugin data into the open. GitHub
       rejects this on an empty repository, hence the seed first. */
    if (found.payload?.private !== true) {
      try {
        await githubApi(token, `https://api.github.com/repos/${repo}`, { method: 'PATCH', body: { private: true } })
      } catch {
        /* visibility is a nicety; never fail the connection over it */
      }
    }
    return { repo, branch }
  }
  if (found.status === 401 || found.status === 403) {
    throw new Error(`GitHub ${found.status}: ${found.payload?.message || 'the token cannot read repositories'}`)
  }
  const created = await githubApi(token, 'https://api.github.com/user/repos', {
    method: 'POST',
    body: {
      name: SYNC_REPO,
      description: 'DSH profile snapshot (dsh-plugin-profile-sync)',
      private: true,
      auto_init: true,
    },
  })
  if (created.status === 201) return { repo, branch: String(created.payload?.default_branch || 'main') }
  /* 422 means somebody already created it between the two calls. */
  if (created.status === 422) return { repo, branch: 'main' }
  throw new Error(`GitHub ${created.status}: ${created.payload?.message || 'cannot create the repository'}`)
}

async function devicePoll(ctx) {
  if (!CLIENT_ID) throw new Error(MISSING_CLIENT_ID)
  if (!deviceSession) throw new Error('No GitHub connection in progress; start it again')
  if (Date.now() > deviceSession.expiresAt) {
    deviceSession = null
    return { status: 'expired' }
  }
  const payload = await deviceRequest(DEVICE_TOKEN_URL, {
    client_id: CLIENT_ID,
    device_code: deviceSession.deviceCode,
    grant_type: DEVICE_GRANT,
  })

  if (payload.access_token) {
    const token = String(payload.access_token)
    deviceSession = null
    /* Persist the grant before touching repositories: GitHub returns 409 on
       write attempts against an empty repository, and losing a valid token to
       that response would force the user through the device flow again. */
    await saveToken(ctx, token)
    const login = await githubLogin(token)
    let repo = ''
    let branch = 'main'
    let repoError = ''
    try {
      const ensured = await ensureSyncRepo(token, login)
      repo = ensured.repo
      branch = ensured.branch
    } catch (error) {
      repoError = String((error && error.message) || error)
    }
    const next = {
      ...(await readState()),
      adapter: 'repo',
      repo: repo || `${login}/${SYNC_REPO}`,
      branch,
      docPath: DOC_FILE,
      lastError: repoError,
    }
    await writeState(next)
    return { status: 'ok', login, repo: next.repo, branch, repoError }
  }

  const error = String(payload.error || '')
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'slow_down') {
    if (deviceSession) deviceSession.interval += 5
    return { status: 'slow', interval: deviceSession ? deviceSession.interval : 10 }
  }
  if (error === 'expired_token') {
    deviceSession = null
    return { status: 'expired' }
  }
  if (error === 'access_denied') {
    deviceSession = null
    return { status: 'denied' }
  }
  throw new Error(`GitHub authorization failed: ${payload.error_description || error || 'unknown error'}`)
}

/* ------------------------------------------------------------- folder store */

function folderFile(state) {
  if (!state.folder) throw new Error('No sync folder configured')
  return path.join(state.folder, state.docPath)
}

async function readFolderDoc(state) {
  const file = folderFile(state)
  try {
    const raw = await fs.readFile(file, 'utf8')
    const doc = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return { doc, sha: '', revision: `mtime:${(await fs.stat(file)).mtimeMs.toFixed(0)}` }
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function writeFolderDoc(state, _token, doc) {
  const file = folderFile(state)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
  await fs.rename(tmp, file)
  return 'folder'
}

function transportFor(state, token) {
  if (state.adapter === 'repo') {
    if (!state.repo) throw new Error('No repository configured')
    if (!token) throw new Error('No GitHub token stored')
    return { read: () => readGithubDoc(state, token), write: (doc) => writeGithubDoc(state, token, doc) }
  }
  return { read: () => readFolderDoc(state), write: (doc) => writeFolderDoc(state, token, doc) }
}

/* ------------------------------------------------------------------ collect */

async function collectBundles(ctx) {
  const manager = ctx.get('pluginManager')
  if (!manager || typeof manager.listBundles !== 'function') return []
  const rows = await manager.listBundles()
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && row.installed !== false && row.availability !== 'missing' && row.official !== true)
    .map((row) => ({
      name: String(row.name || ''),
      version: row.version ? String(row.version) : '',
      enabled: row.enabled !== false,
      spec: row.installTarget?.spec || String(row.name || ''),
    }))
    .filter((row) => row.name)
}

function deviceInfo() {
  return { id: os.hostname(), name: os.hostname(), platform: `${process.platform} ${process.arch}` }
}

async function collectDocument(ctx) {
  const bundles = await collectBundles(ctx)
  const settings = await readSettingsNamespaces()
  return {
    schema: SCHEMA,
    updatedAt: new Date().toISOString(),
    device: deviceInfo(),
    bundles,
    settings,
  }
}

/* -------------------------------------------------------------------- merge */

function mergeDocuments(local, remote) {
  const merged = {
    schema: SCHEMA,
    updatedAt: new Date().toISOString(),
    device: local.device,
    bundles: [],
    settings: {},
  }
  const byName = new Map()
  for (const row of Array.isArray(remote?.bundles) ? remote.bundles : []) byName.set(row.name, { ...row })
  for (const row of local.bundles) byName.set(row.name, { ...byName.get(row.name), ...row })
  merged.bundles = [...byName.values()].filter((row) => row && row.name)

  const names = new Set([...Object.keys(remote?.settings || {}), ...Object.keys(local.settings)])
  for (const ns of names) {
    const a = remote?.settings?.[ns]
    const b = local.settings?.[ns]
    const newer = (b?.updatedAt || 0) >= (a?.updatedAt || 0) ? b : a
    if (newer && newer.values) merged.settings[ns] = { updatedAt: newer.updatedAt || Date.now(), values: newer.values }
  }
  return merged
}

/* --------------------------------------------------------------------- diff */

function computeDiff(localBundles, localSettings, remoteDoc) {
  const remoteBundles = Array.isArray(remoteDoc?.bundles) ? remoteDoc.bundles : []
  const localByName = new Map(localBundles.map((row) => [row.name, row]))
  const remoteByName = new Map(remoteBundles.map((row) => [row.name, row]))

  const missing = []
  const drift = []
  for (const row of remoteBundles) {
    const mine = localByName.get(row.name)
    if (!mine) {
      missing.push({ name: row.name, version: row.version, spec: row.spec || row.name })
      continue
    }
    if (row.version && mine.version && row.version !== mine.version) {
      drift.push({ name: row.name, local: mine.version, remote: row.version, spec: row.spec || row.name })
    } else if (row.enabled === false && mine.enabled !== false) {
      drift.push({ name: row.name, local: 'on', remote: 'off', spec: row.spec || row.name })
    }
  }
  const extraOnlyLocal = localBundles
    .filter((row) => !remoteByName.has(row.name))
    .map((row) => ({ name: row.name, version: row.version }))

  const settingsDiff = []
  for (const [ns, value] of Object.entries(remoteDoc?.settings || {})) {
    const mine = localSettings[ns]
    if (!mine) {
      settingsDiff.push({ ns, state: 'missing-local', updatedAt: value.updatedAt || 0 })
    } else if (JSON.stringify(mine.values) !== JSON.stringify(value.values)) {
      settingsDiff.push({
        ns,
        state: (value.updatedAt || 0) > (mine.updatedAt || 0) ? 'remote-newer' : 'local-newer',
        updatedAt: value.updatedAt || 0,
      })
    }
  }

  return {
    missing,
    drift,
    extraOnlyLocal,
    settings: settingsDiff,
    remoteUpdatedAt: remoteDoc?.updatedAt || '',
    remoteDevice: remoteDoc?.device?.name || '',
  }
}

/* ---------------------------------------------------------------- transport */

async function loadToken(ctx) {
  const store = ctx.get('credentials')
  if (!store || typeof store.readRecord !== 'function') return ''
  try {
    const record = await store.readRecord(TOKEN_KEY)
    const token = record && record.kind === 'grant' ? record.payload?.token : ''
    return typeof token === 'string' ? token : ''
  } catch {
    return ''
  }
}

async function saveToken(ctx, token) {
  const store = ctx.get('credentials')
  if (!store || typeof store.modifyRecord !== 'function') throw new Error('Credentials service unavailable')
  if (!token) {
    await store.deleteRecord(TOKEN_KEY)
    return
  }
  await store.modifyRecord(TOKEN_KEY, async () => ({
    kind: 'grant',
    payload: { version: 1, token },
  }))
}

/* -------------------------------------------------------------------- routes */

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function sameOrigin(request) {
  const site = request.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = request.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_DOC_BYTES) throw new Error('Request body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/* --------------------------------------------------------------------- apply */

async function applyPlan(ctx, plan) {
  const manager = ctx.get('pluginManager')
  if (!manager) throw new Error('pluginManager service unavailable')
  const applied = []
  const failed = []

  const describe = (result) => {
    const error = result && result.error
    if (error) return String(error.message || error.code || JSON.stringify(error))
    return String((result && result.application) || 'unknown failure')
  }
  const broken = (result) =>
    !result || result.application === 'failed' || result.application === 'cancelled' || Boolean(result.error)

  for (const spec of Array.isArray(plan.install) ? plan.install : []) {
    try {
      const result = await manager.installBundle(String(spec))
      if (broken(result)) failed.push({ kind: 'install', spec, error: describe(result) })
      else applied.push({ kind: 'install', spec, version: result.version, stage: result.stage })
    } catch (error) {
      failed.push({ kind: 'install', spec, error: String((error && error.message) || error) })
    }
  }

  for (const row of Array.isArray(plan.enable) ? plan.enable : []) {
    try {
      const result = await manager.setBundleEnabled(String(row.name), row.enabled !== false)
      if (broken(result)) failed.push({ kind: 'enable', name: row.name, error: describe(result) })
      else applied.push({ kind: 'enable', name: row.name })
    } catch (error) {
      failed.push({ kind: 'enable', name: row.name, error: String((error && error.message) || error) })
    }
  }

  await fs.mkdir(SETTINGS_DIR, { recursive: true })
  for (const entry of Array.isArray(plan.settings) ? plan.settings : []) {
    try {
      const values = entry?.values && typeof entry.values === 'object' ? entry.values : null
      if (!values || !entry.ns) continue
      const file = path.join(SETTINGS_DIR, `${String(entry.ns)}.json`)
      await fs.writeFile(
        file,
        JSON.stringify({ updatedAt: Number(entry.updatedAt) || Date.now(), values }, null, 2),
        'utf8',
      )
      applied.push({ kind: 'settings', ns: entry.ns })
    } catch (error) {
      failed.push({ kind: 'settings', ns: entry.ns, error: String(error && error.message || error) })
    }
  }

  return { applied, failed }
}

/* --------------------------------------------------------------------- setup */

export function apply(ctx) {
  const handle = async (request, response) => {
    if (!sameOrigin(request)) return json(response, 403, { ok: false, error: 'Cross-origin request rejected' })

    const url = new URL(request.url || ROUTE, 'http://localhost')
    const action = url.pathname.slice(ROUTE.length).replace(/^\//, '') || 'state'
    const state = await readState()

    try {
      if (request.method === 'GET' && action === 'state') {
        const token = await loadToken(ctx)
        const bundles = await collectBundles(ctx)
        const settings = await readSettingsNamespaces()
        let remote = null
        let remoteError = ''
        if (state.adapter === 'repo' ? state.repo && token : state.folder) {
          try {
            remote = await transportFor(state, token).read()
          } catch (error) {
            remoteError = String((error && error.message) || error)
          }
        }
        return json(response, 200, {
          ok: true,
          state: { ...state, hasToken: Boolean(token) },
          device: deviceInfo(),
          local: { bundles, settings: Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.updatedAt])) },
          remote: remote
            ? { revision: remote.revision, doc: { updatedAt: remote.doc?.updatedAt || '', device: remote.doc?.device || null, bundles: (remote.doc?.bundles || []).length, settings: Object.keys(remote.doc?.settings || {}) } }
            : null,
          remoteError,
          diff: remote ? computeDiff(bundles, settings, remote.doc) : null,
        })
      }

      if (request.method === 'POST' && action === 'connect/start') {
        return json(response, 200, { ok: true, ...(await deviceStart()) })
      }

      if (request.method === 'POST' && action === 'connect/poll') {
        return json(response, 200, { ok: true, ...(await devicePoll(ctx)) })
      }

      if (request.method === 'POST' && action === 'connect/cancel') {
        deviceSession = null
        return json(response, 200, { ok: true })
      }

      if (request.method === 'POST' && action === 'config') {
        const body = await readBody(request)
        const next = { ...state }
        if (typeof body.adapter === 'string') next.adapter = body.adapter === 'repo' ? 'repo' : 'folder'
        if (typeof body.repo === 'string') next.repo = body.repo.trim()
        if (typeof body.branch === 'string') next.branch = body.branch.trim() || 'main'
        if (typeof body.docPath === 'string') next.docPath = body.docPath.trim() || DOC_FILE
        if (typeof body.folder === 'string') next.folder = body.folder.trim()
        if (typeof body.autoSync === 'boolean') next.autoSync = body.autoSync
        if (typeof body.token === 'string') await saveToken(ctx, body.token.trim())
        next.lastError = ''
        await writeState(next)
        return json(response, 200, { ok: true, state: { ...next, hasToken: Boolean(await loadToken(ctx)) } })
      }

      if (request.method === 'POST' && action === 'test') {
        const token = await loadToken(ctx)
        const remote = await transportFor(state, token).read()
        await writeState({ ...state, lastError: '' })
        return json(response, 200, {
          ok: true,
          exists: Boolean(remote),
          revision: remote ? remote.revision : '',
          remoteUpdatedAt: remote?.doc?.updatedAt || '',
          bundles: (remote?.doc?.bundles || []).length,
        })
      }

      if (request.method === 'POST' && action === 'push') {
        const token = await loadToken(ctx)
        const transport = transportFor(state, token)
        let remote = null
        try {
          remote = await transport.read()
        } catch {
          remote = null
        }
        const local = await collectDocument(ctx)
        const merged = remote ? mergeDocuments(local, remote.doc) : local
        const revision = await transport.write(merged)
        await writeState({ ...state, lastPushAt: Date.now(), lastError: '' })
        return json(response, 200, {
          ok: true,
          revision,
          bundles: merged.bundles.length,
          settings: Object.keys(merged.settings),
        })
      }

      if (request.method === 'POST' && action === 'pull') {
        const token = await loadToken(ctx)
        const remote = await transportFor(state, token).read()
        if (!remote) return json(response, 404, { ok: false, error: 'No snapshot in the cloud yet' })
        const bundles = await collectBundles(ctx)
        const settings = await readSettingsNamespaces()
        const diff = computeDiff(bundles, settings, remote.doc)
        await writeState({ ...state, lastPullAt: Date.now(), lastError: '' })
        return json(response, 200, { ok: true, revision: remote.revision, diff, doc: remote.doc })
      }

      if (request.method === 'POST' && action === 'apply') {
        const body = (await readBody(request)) || {}
        /* The Client sends only namespaces it wants; the values live in the snapshot,
           so resolve them here instead of trusting the browser to echo them back. */
        if (Array.isArray(body.settings) && body.settings.length > 0) {
          const needsValues = body.settings.some((entry) => !entry || !entry.values)
          if (needsValues) {
            const token = await loadToken(ctx)
            const remote = await transportFor(state, token).read()
            const cloud = (remote && remote.doc && remote.doc.settings) || {}
            body.settings = body.settings
              .map((entry) => {
                if (!entry || !entry.ns) return null
                if (entry.values) return entry
                const row = cloud[entry.ns]
                if (!row || !row.values) return null
                return { ns: entry.ns, values: row.values, updatedAt: row.updatedAt }
              })
              .filter(Boolean)
          }
        }
        const result = await applyPlan(ctx, body)
        await writeState({ ...state, lastError: result.failed.length ? JSON.stringify(result.failed[0]) : '' })
        return json(response, 200, { ok: result.failed.length === 0, ...result })
      }

      return json(response, 404, { ok: false, error: `Unknown action: ${action}` })
    } catch (error) {
      const message = String((error && error.message) || error)
      try {
        await writeState({ ...state, lastError: message })
      } catch {
        /* ignore */
      }
      return json(response, 500, { ok: false, error: message })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: handle }))
}
