/**
 * Behaviour test for the one-click GitHub connection (OAuth device flow).
 *
 * Runs the real Host route handler with a stubbed `fetch`, so the whole state
 * machine (start → pending → slow down → authorized → repo bootstrap) is
 * exercised without touching GitHub.
 *
 *   node test/device-flow.test.mjs
 */

import assert from 'node:assert/strict'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-sync-device-'))
process.env.DSH_HOME = home
process.env.DSH_PROFILE_SYNC_GITHUB_CLIENT_ID = 'test-client-id'
process.env.PS_TRANSPORT = 'fetch'

const requests = []
const script = { device: null, token: [], user: null, repo: null, createRepo: null }

const reply = (status, payload) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() {
    return payload === null || payload === undefined ? '' : JSON.stringify(payload)
  },
  async json() {
    return payload
  },
})

globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  const method = (init && init.method) || 'GET'
  const body = init && init.body ? String(init.body) : ''
  requests.push({ href, method, body })

  if (href === 'https://github.com/login/device/code') {
    assert.equal(method, 'POST')
    assert.match(body, /client_id=test-client-id/)
    assert.match(body, /scope=repo/)
    return reply(200, script.device)
  }
  if (href === 'https://github.com/login/oauth/access_token') {
    assert.match(body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/)
    return reply(200, script.token.shift() || { error: 'authorization_pending' })
  }
  if (href === 'https://api.github.com/user') {
    return reply(script.user?.status || 200, script.user?.payload ?? { login: 'tester' })
  }
  if (href === 'https://api.github.com/repos/tester/dsh-profile-sync-data') {
    return reply(script.repo?.status || 404, script.repo?.payload ?? { message: 'Not Found' })
  }
  if (href === 'https://api.github.com/user/repos') {
    return reply(script.createRepo?.status || 201, script.createRepo?.payload ?? { default_branch: 'main' })
  }
  if (/\/git\/(blobs|trees|commits|refs)$/.test(href)) {
    return reply(201, { sha: `sha-${href.split('/').pop()}` })
  }
  throw new Error(`unexpected fetch ${method} ${href}`)
}

const store = {
  record: null,
  async readRecord() {
    return this.record
  },
  async modifyRecord(_key, factory) {
    this.record = await factory()
    return this.record
  },
  async deleteRecord() {
    this.record = null
  },
}

let handler = null
let connectionStub = undefined
const ctx = {
  webServer: {
    register(entry) {
      handler = entry.handler
      return () => {}
    },
  },
  get(name) {
    if (name === 'credentials') return store
    if (name === 'connection') return connectionStub
    return undefined
  },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
}

const plugin = await import(pathToFileURL(path.join(import.meta.dirname, '..', 'index.js')).href)
plugin.apply(ctx)
assert.equal(typeof handler, 'function', 'Host registered its web route')

async function invokeRaw(action, { host = '127.0.0.1:1234', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const request = {
    url: `/plugins/profile-sync/${action}`,
    method: body === undefined ? 'GET' : 'POST',
    headers: { host, 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  const out = { status: 0, text: '' }
  const response = {
    writeHead(status) {
      out.status = status
    },
    end(text) {
      out.text = text
    },
  }
  await handler(request, response)
  return out
}

async function invoke(action, body) {
  const out = await invokeRaw(action, { body })
  let json = null
  try {
    json = out.text ? JSON.parse(out.text) : null
  } catch {
    json = { raw: out.text }
  }
  return { status: out.status, json }
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push({ name, ok: true })
  } catch (error) {
    results.push({ name, ok: false, error: String((error && error.message) || error) })
  }
}

/* 1. Polling before starting is a clean error, not a crash. */
{
  const out = await invoke('connect/poll', {})
  check('poll without session is rejected', () => {
    assert.equal(out.status, 500)
    assert.match(out.json.error, /No GitHub connection in progress/)
  })
}

/* 2. Full happy path: repo missing → created. */
{
  script.device = {
    device_code: 'dc-1',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  }
  script.token = [{ error: 'authorization_pending' }, { error: 'slow_down' }, { access_token: 'gho_test' }]
  script.user = { status: 200, payload: { login: 'tester' } }
  script.repo = { status: 404, payload: { message: 'Not Found' } }
  script.createRepo = { status: 201, payload: { default_branch: 'main' } }
  requests.length = 0

  const started = await invoke('connect/start', {})
  check('start returns the user code and link', () => {
    assert.equal(started.status, 200)
    assert.equal(started.json.userCode, 'ABCD-1234')
    assert.equal(started.json.verificationUri, 'https://github.com/login/device')
    assert.equal(started.json.interval, 5)
    assert.ok(started.json.expiresIn > 800)
  })

  const pending = await invoke('connect/poll', {})
  check('pending authorization is reported as pending', () => {
    assert.equal(pending.status, 200)
    assert.equal(pending.json.status, 'pending')
  })

  const slow = await invoke('connect/poll', {})
  check('slow_down widens the poll interval', () => {
    assert.equal(slow.json.status, 'slow')
    assert.equal(slow.json.interval, 10)
  })

  const ok = await invoke('connect/poll', {})
  check('authorization completes and creates the repo', () => {
    assert.equal(ok.status, 200)
    assert.equal(ok.json.status, 'ok')
    assert.equal(ok.json.login, 'tester')
    assert.equal(ok.json.repo, 'tester/dsh-profile-sync-data')
  })
  check('the created repo is private and auto initialised', () => {
    const create = requests.find((row) => row.href === 'https://api.github.com/user/repos')
    assert.ok(create, 'POST /user/repos was called')
    const payload = JSON.parse(create.body)
    assert.equal(payload.name, 'dsh-profile-sync-data')
    assert.equal(payload.private, true)
    assert.equal(payload.auto_init, true)
  })
  check('the token is stored in the credential store', () => {
    assert.equal(store.record?.payload?.token, 'gho_test')
  })
  check('the sync state points at the new repository', () => {
    const raw = readFileSync(path.join(home, 'profile-sync', 'state.json'), 'utf8')
    const state = JSON.parse(raw)
    assert.equal(state.adapter, 'repo')
    assert.equal(state.repo, 'tester/dsh-profile-sync-data')
    assert.equal(state.branch, 'main')
    assert.equal(state.docPath, 'dsh-profile-sync.json')
  })
}

/* 3. An existing but empty repository gets its first commit. */
{
  script.device = {
    device_code: 'dc-2',
    user_code: 'EFGH-5678',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  }
  script.token = [{ access_token: 'gho_empty' }]
  script.user = { status: 200, payload: { login: 'tester' } }
  script.repo = { status: 200, payload: { size: 0, default_branch: 'main' } }
  requests.length = 0

  await invoke('connect/start', {})
  const ok = await invoke('connect/poll', {})
  check('an empty repository is seeded with a first commit', () => {
    assert.equal(ok.json.status, 'ok')
    const git = requests.filter((row) => /\/git\/(blobs|trees|commits|refs)$/.test(row.href))
    assert.deepEqual(
      git.map((row) => row.href.split('/').pop()),
      ['blobs', 'trees', 'commits', 'refs'],
    )
    const ref = git[3]
    assert.equal(JSON.parse(ref.body).ref, 'refs/heads/main')
  })
}

/* 4. Expiry and cancellation never leave a session behind. */
{
  const realNow = Date.now
  script.device = {
    device_code: 'dc-3',
    user_code: 'IJKL-9012',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  }
  await invoke('connect/start', {})
  Date.now = () => realNow() + 20 * 60 * 1000
  const expired = await invoke('connect/poll', {})
  Date.now = realNow
  check('an expired device code ends the session', () => {
    assert.equal(expired.json.status, 'expired')
  })
  const after = await invoke('connect/poll', {})
  check('a second poll after expiry asks to start again', () => {
    assert.equal(after.status, 500)
    assert.match(after.json.error, /No GitHub connection in progress/)
  })

  script.device = { ...script.device, device_code: 'dc-4' }
  await invoke('connect/start', {})
  const cancelled = await invoke('connect/cancel', {})
  check('cancel clears the session', () => assert.equal(cancelled.json.ok, true))
  const dead = await invoke('connect/poll', {})
  check('poll after cancel asks to start again', () => {
    assert.equal(dead.status, 500)
    assert.match(dead.json.error, /No GitHub connection in progress/)
  })
}

/* 5. The host's own request gate guards every route. */
{
  const gateCalls = []
  const connection = {
    marker: 'connection',
    requestRejection(request) {
      gateCalls.push({ self: this, host: request.headers.host })
      return request.headers.host === 'evil.example:1234' ? 401 : undefined
    },
  }
  connectionStub = connection

  const allowed = await invokeRaw('state')
  check('the host gate is consulted as a method of the connection service', () => {
    assert.equal(gateCalls.length, 1, 'requestRejection was called')
    assert.equal(gateCalls[0].self, connection, 'this stayed bound to the connection service')
  })
  check('a request the host gate accepts reaches the route', () => {
    assert.equal(allowed.status, 200)
    assert.equal(JSON.parse(allowed.text).ok, true)
  })

  const denied = await invokeRaw('state', { host: 'evil.example:1234' })
  check('a request the host gate rejects is answered 401 and never runs the route', () => {
    assert.equal(denied.status, 401)
    assert.equal(denied.text, 'unauthorized')
  })

  const throwing = {
    requestRejection() {
      throw new Error('gate exploded')
    },
  }
  connectionStub = throwing
  const crashedGate = await invokeRaw('state')
  check('a gate that throws fails closed', () => assert.equal(crashedGate.status, 403))

  /* Older hosts have no connection service: keep the loopback fence. */
  connectionStub = undefined
  const loopback = await invokeRaw('state')
  check('without a connection service a loopback host still works', () => assert.equal(loopback.status, 200))
  const remote = await invokeRaw('state', { host: '192.168.1.20:1234' })
  check('without a connection service a LAN host is refused', () => assert.equal(remote.status, 403))
}

const failed = results.filter((row) => !row.ok)
for (const row of results) {
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.name}${row.ok ? '' : ` :: ${row.error}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
await fs.rm(home, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
