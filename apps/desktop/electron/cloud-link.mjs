// 谷子云端连接（桌面端共享模块，零依赖，ES module）。
// 规范来源：guzi-cloud/clients/guzi-cloud-link.mjs —— 三个桌面应用各自复制一份，改动请先改这里再同步。
// CommonJS 主进程（谷子画图、谷子学术）直接用 require 加载本文件即可（Node 22.12+ 支持 require ESM）；
// 谷子助手由 electron-vite 打包。
//
// 职责：统一账号登录 / 注册 / 退出；保存会话；保持到 wss://mcp.guzilab.com 的设备长连接
// （断线指数退避重连、应用层心跳）；把云端转来的 MCP 工具调用交给应用执行；管理本软件的 MCP token。
// 应用只需提供：工具列表 tools.list()、工具执行 tools.call()、持久化 storage（会话 token 请加密保存）。

import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'

export const PROTOCOL = 1
const DEFAULT_ACCOUNT_ORIGIN = 'https://account.guzilab.com'
const DEFAULT_MCP_ORIGIN = 'https://mcp.guzilab.com'
const PING_INTERVAL_MS = 30000
const PONG_TIMEOUT_MS = 15000
const MAX_RESULT_BYTES = 15 * 1024 * 1024
const APPS = new Set(['assistant', 'scholar', 'graph'])

export class CloudError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message)
    this.status = status
    this.code = code
  }
}

function clip(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export class CloudLink extends EventEmitter {
  /**
   * @param {object} options
   * @param {'assistant'|'scholar'|'graph'} options.app
   * @param {string} options.appVersion
   * @param {string} options.platform
   * @param {() => string} options.deviceName
   * @param {{ read(): Promise<object|null>, write(state: object): Promise<void> }} options.storage
   * @param {{ list(): Promise<object[]>, call(name: string, args: object, context: { signal: AbortSignal }): Promise<object> }} options.tools
   */
  constructor(options) {
    super()
    if (!APPS.has(options.app)) throw new Error('未知应用')
    this.app = options.app
    this.appVersion = clip(options.appVersion, 32)
    this.platform = clip(options.platform, 32)
    this.deviceName = options.deviceName
    this.storage = options.storage
    this.tools = options.tools
    this.accountOrigin = (options.accountOrigin || DEFAULT_ACCOUNT_ORIGIN).replace(/\/+$/, '')
    this.mcpOrigin = (options.mcpOrigin || DEFAULT_MCP_ORIGIN).replace(/\/+$/, '')
    this.WebSocket = options.WebSocket || globalThis.WebSocket
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis)
    this.log = options.log || (() => {})
    this.minDelay = options.reconnectMinMs || 1000
    this.maxDelay = options.reconnectMaxMs || 60000

    this.persisted = { version: 1, deviceId: '', enabled: false, everSignedIn: false, session: null }
    this.connection = 'idle'
    this.error = ''
    this.socket = null
    this.attempt = 0
    this.reconnectTimer = null
    this.pingTimer = null
    this.pongTimer = null
    this.calls = new Map()
    this.disposed = false
  }

  // ---------- 状态 ----------

  async initialize() {
    try {
      const saved = await this.storage.read()
      if (saved && saved.version === 1) {
        this.persisted.deviceId = typeof saved.deviceId === 'string' ? saved.deviceId : ''
        this.persisted.enabled = saved.enabled === true
        this.persisted.everSignedIn = saved.everSignedIn === true
        const session = saved.session
        if (session && typeof session.token === 'string' && session.token.startsWith('gzs_')) {
          this.persisted.session = { token: session.token, user: session.user || null }
        }
      }
    } catch (error) {
      this.log(`[cloud] 读取云端设置失败：${error.message}`)
    }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(this.persisted.deviceId)) {
      this.persisted.deviceId = randomBytes(18).toString('base64url')
      await this.save()
    }
    this.sync()
    return this
  }

  getState() {
    const session = this.persisted.session
    return {
      app: this.app,
      signedIn: !!session,
      user: session ? session.user : null,
      enabled: this.persisted.enabled,
      connection: !session ? 'signed_out' : !this.persisted.enabled ? 'disabled' : this.connection,
      error: this.error,
      deviceId: this.persisted.deviceId,
      endpoint: `${this.mcpOrigin}/${this.app}`,
      accountUrl: this.accountOrigin
    }
  }

  emitState() {
    this.emit('state', this.getState())
  }

  async save() {
    await this.storage.write({ ...this.persisted })
  }

  // ---------- 账号 HTTP ----------

  async request(method, path, body, { auth = false } = {}) {
    const headers = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth) {
      if (!this.persisted.session) throw new CloudError('请先登录谷子账号。', { status: 401, code: 'unauthorized' })
      headers.Authorization = `Bearer ${this.persisted.session.token}`
    }
    let response
    try {
      response = await this.fetch(this.accountOrigin + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      })
    } catch {
      throw new CloudError('无法连接谷子账号服务，请检查网络。', { code: 'network' })
    }
    let data = {}
    try {
      data = await response.json()
    } catch {}
    if (!response.ok) {
      if (auth && response.status === 401) await this.dropSession('登录已失效，请重新登录。')
      throw new CloudError(data.message || `请求失败（${response.status}）`, { status: response.status, code: data.error })
    }
    return data
  }

  device() {
    return {
      app: this.app,
      deviceId: this.persisted.deviceId,
      deviceName: clip(this.deviceName(), 64),
      platform: this.platform,
      appVersion: this.appVersion
    }
  }

  async adoptSession(result) {
    this.persisted.session = { token: result.token, user: result.user }
    // 首次登录默认打开云端 MCP：用户登录的目的就是用它。之后尊重用户的开关。
    if (!this.persisted.everSignedIn) this.persisted.enabled = true
    this.persisted.everSignedIn = true
    this.error = ''
    await this.save()
    this.sync()
    return this.getState()
  }

  requestCode({ purpose, email }) {
    return this.request('POST', '/api/v1/auth/code', { purpose, channel: 'email', target: email })
  }

  async register({ username, password, email, code }) {
    const result = await this.request('POST', '/api/v1/auth/register', { username, password, channel: 'email', target: email, code, client: 'desktop', device: this.device() })
    return this.adoptSession(result)
  }

  async login({ identifier, password }) {
    const result = await this.request('POST', '/api/v1/auth/login', { identifier, password, client: 'desktop', device: this.device() })
    return this.adoptSession(result)
  }

  async loginWithCode({ email, code }) {
    const result = await this.request('POST', '/api/v1/auth/login/code', { channel: 'email', target: email, code, client: 'desktop', device: this.device() })
    return this.adoptSession(result)
  }

  async logout() {
    if (this.persisted.session) {
      try {
        await this.request('POST', '/api/v1/auth/logout', {}, { auth: true })
      } catch {
        // 网络失败也照样在本机退出；服务端会话会在过期后失效，或由用户在网页上移除。
      }
    }
    await this.dropSession('')
    return this.getState()
  }

  async dropSession(reason) {
    this.persisted.session = null
    this.error = reason
    this.disconnect()
    await this.save()
    this.emitState()
  }

  async setEnabled(enabled) {
    this.persisted.enabled = enabled === true
    this.error = ''
    await this.save()
    this.sync()
    return this.getState()
  }

  async refreshProfile() {
    const result = await this.request('GET', '/api/v1/me', undefined, { auth: true })
    if (this.persisted.session) {
      this.persisted.session.user = result.user
      await this.save()
      this.emitState()
    }
    return this.getState()
  }

  async listTokens() {
    const result = await this.request('GET', '/api/v1/mcp-tokens', undefined, { auth: true })
    return result.tokens.filter((token) => token.app === this.app)
  }

  createToken({ name, bindDevice = false }) {
    return this.request('POST', '/api/v1/mcp-tokens', { app: this.app, name, deviceId: bindDevice ? this.persisted.deviceId : undefined }, { auth: true })
  }

  revokeToken(id) {
    return this.request('DELETE', `/api/v1/mcp-tokens/${encodeURIComponent(id)}`, undefined, { auth: true })
  }

  // ---------- 设备长连接 ----------

  /** 根据当前状态决定连接还是断开。 */
  sync() {
    if (this.disposed) return
    const want = !!this.persisted.session && this.persisted.enabled
    if (want && !this.socket && !this.reconnectTimer) this.connect()
    if (!want) this.disconnect()
    this.emitState()
  }

  /** 网络恢复、系统唤醒时调用：跳过退避等待立刻重连。 */
  nudge() {
    if (!this.persisted.session || !this.persisted.enabled || this.socket) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.attempt = 0
    this.connect()
  }

  /** 工具列表变化（插件启停、权限调整）时调用，在线时立即推送。 */
  async toolsChanged() {
    if (this.connection !== 'online' || !this.socket) return
    try {
      this.send({ type: 'tools', tools: await this.tools.list() })
    } catch (error) {
      this.log(`[cloud] 推送工具列表失败：${error.message}`)
    }
  }

  connect() {
    if (this.disposed || !this.WebSocket) return
    const url = `${this.mcpOrigin.replace(/^http/, 'ws')}/v1/device/connect`
    let socket
    try {
      socket = new this.WebSocket(url)
    } catch (error) {
      this.error = `无法建立云端连接：${error.message}`
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.connection = this.attempt === 0 ? 'connecting' : 'reconnecting'
    this.emitState()

    socket.addEventListener('open', async () => {
      if (this.socket !== socket) return
      let tools = []
      try {
        tools = await this.tools.list()
      } catch (error) {
        this.log(`[cloud] 读取工具列表失败：${error.message}`)
      }
      if (this.socket !== socket || !this.persisted.session) return
      this.send({
        type: 'hello',
        protocol: PROTOCOL,
        token: this.persisted.session.token,
        appVersion: this.appVersion,
        deviceName: clip(this.deviceName(), 64),
        platform: this.platform,
        tools
      })
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      this.onMessage(message)
    })
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.onClose(event.code)
    })
    socket.addEventListener('error', () => {})
  }

  send(message) {
    if (this.socket && this.socket.readyState === 1) this.socket.send(JSON.stringify(message))
  }

  onMessage(message) {
    if (message.type === 'welcome') {
      this.connection = 'online'
      this.error = ''
      this.attempt = 0
      if (message.username && this.persisted.session?.user) this.persisted.session.user.username = message.username
      this.startHeartbeat()
      this.emitState()
      this.log(`[cloud] 已连接 ${this.mcpOrigin}/${this.app}`)
      return
    }
    if (message.type === 'pong') {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
      return
    }
    if (message.type === 'cancel' && typeof message.id === 'string') {
      this.calls.get(message.id)?.abort()
      return
    }
    if (message.type === 'call' && typeof message.id === 'string' && message.method === 'tools/call') {
      void this.runCall(message.id, message.params || {})
    }
  }

  async runCall(id, params) {
    const controller = new AbortController()
    this.calls.set(id, controller)
    let reply
    try {
      const name = typeof params.name === 'string' ? params.name : ''
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}
      const result = await this.tools.call(name, args, { signal: controller.signal })
      reply = { type: 'result', id, result }
      if (Buffer.byteLength(JSON.stringify(reply)) > MAX_RESULT_BYTES) {
        reply = { type: 'result', id, error: { code: 'RESULT_TOO_LARGE', message: '结果太大，无法经云端返回，请缩小范围。' } }
      }
    } catch (error) {
      reply = { type: 'result', id, error: { code: error.code || 'failed', message: error.message || '执行失败。' } }
    } finally {
      this.calls.delete(id)
    }
    if (!controller.signal.aborted) this.send(reply)
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.pingTimer = setInterval(() => {
      if (this.pongTimer) return
      this.send({ type: 'ping' })
      this.pongTimer = setTimeout(() => {
        this.log('[cloud] 心跳超时，重新连接')
        this.socket?.close()
        this.onClose(1006)
      }, PONG_TIMEOUT_MS)
      this.pongTimer.unref?.()
    }, PING_INTERVAL_MS)
    this.pingTimer.unref?.()
  }

  stopHeartbeat() {
    clearInterval(this.pingTimer)
    clearTimeout(this.pongTimer)
    this.pingTimer = null
    this.pongTimer = null
  }

  abortCalls() {
    for (const controller of this.calls.values()) controller.abort()
    this.calls.clear()
  }

  onClose(code) {
    this.socket = null
    this.stopHeartbeat()
    this.abortCalls()
    if (code === 4401) {
      void this.dropSession('登录已失效或已在其他地方退出，请重新登录。')
      return
    }
    if (code === 4409) {
      this.connection = 'error'
      this.error = '同一账号在这台电脑的另一个窗口里已连接云端。'
      this.emitState()
      return
    }
    if (code === 4400) this.error = '云端拒绝了连接（协议错误），稍后自动重试。'
    this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (this.disposed || !this.persisted.session || !this.persisted.enabled) {
      this.emitState()
      return
    }
    this.connection = 'reconnecting'
    const base = Math.min(this.maxDelay, this.minDelay * 2 ** this.attempt)
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.attempt += 1
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
    this.emitState()
  }

  disconnect() {
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopHeartbeat()
    this.abortCalls()
    const socket = this.socket
    this.socket = null
    this.connection = 'idle'
    this.attempt = 0
    if (socket && socket.readyState <= 1) socket.close(1000, 'client_closing')
  }

  dispose() {
    this.disposed = true
    this.disconnect()
    this.removeAllListeners()
  }
}

/**
 * 基于文件的持久化：会话 token 交给 encrypt/decrypt（Electron 用 safeStorage）加密后再落盘。
 * @param {{ file: string, encrypt?: (text: string) => string, decrypt?: (text: string) => string, writeFile: (file: string, text: string) => Promise<void> }} options
 */
export function createFileStorage({ file, encrypt, decrypt, writeFile }) {
  return {
    async read() {
      let raw
      try {
        raw = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return null
        throw error
      }
      if (raw && raw.session && typeof raw.session.sealed === 'string') {
        try {
          raw.session = { token: decrypt ? decrypt(raw.session.sealed) : raw.session.sealed, user: raw.session.user || null }
        } catch {
          raw.session = null // 钥匙串不可用或换了机器：需要重新登录
        }
      }
      return raw
    },
    async write(state) {
      const copy = { ...state }
      if (copy.session) copy.session = { sealed: encrypt ? encrypt(copy.session.token) : copy.session.token, user: copy.session.user || null }
      await writeFile(file, JSON.stringify(copy))
    }
  }
}
