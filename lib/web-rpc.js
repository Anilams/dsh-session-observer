/**
 * 自定义 RPC 通道的宿主侧挂载。
 *
 * 为什么不直接用 `ctx.connection.rpc.handle()`：
 *
 *   `rpc.handle()` 内部会执行 `owner.webServer.register(route)`，而 `owner` 是
 *   cordis 跟踪代理给出的 ctx。在 dsh 0.1.7-rc.1 上，无论本插件 `inject` 里有没有
 *   `webServer`，这一步都会抛：
 *
 *     cannot get property "webServer" without inject
 *
 *   结果是**整个 apply 抛错、插件静默降级**——界面上只剩一句「观察未接通」，
 *   客户端 POST 拿到 405。这个问题 dsh-pocket 也撞过并记录了同样的结论。
 *
 * 所以这里自己挂：直接 `webServer.register({kind:'prefix', path: channel, handler})`，
 * 并把 Connection 的 wire 语义（信封校验、状态码分支、鉴权栅栏）逐条复刻。
 * 线上协议与 /api 通道逐字节一致，客户端那边一行都不用改。
 *
 * 鉴权用 `connection.requestRejection(req)`——它是 dsh 自己的 Host/Origin 栅栏 +
 * 浏览器 cookie 认证。没有这个方法的旧版 dsh 退回到 loopback 白名单。
 */

/** endpoint 段允许的字符，与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 对齐。 */
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** 信封非法时用的兜底 rpcId，与 dsh 内部约定一致。 */
const INVALID_REQUEST_RPC_ID = 'invalid-request'

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** `/session-observer/<endpoint>` → endpoint；段非法返回 undefined。 */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  for (const segment of endpoint.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return undefined
    if (!ENDPOINT_SEGMENT_PATTERN.test(segment)) return undefined
  }
  return endpoint
}

const envelope = (rpcId, result) => JSON.stringify({ type: 'server-response', rpcId, result })

const jsonResponse = (rpcId, result) => new Response(envelope(rpcId, result), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

/** 旧版 dsh 的兜底栅栏：只放行 loopback，并拒绝跨站 fetch。 */
function isTrustedLoopbackRequest(req) {
  const host = req.headers?.host
  if (host === undefined) return false
  if (!LOOPBACK_HOSTNAMES.has(host.split(':')[0])) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 把 handler 包成 fetch 形态，逐分支复刻 dsh-client-connection 的 rpcFetchHandler：
 * 404 / 415 / 400 / bad-request / 500 / 200，错误码与措辞保持一致。
 */
function createFetchHandler(channel, handler) {
  return {
    async fetch(request) {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID
      const method = typeof body?.method === 'string' ? body.method : null
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) {
        return jsonResponse(INVALID_REQUEST_RPC_ID, {
          ok: false,
          error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: [] } },
        })
      }
      if (body.type !== 'client-request') {
        return jsonResponse(rpcId, {
          ok: false,
          error: { code: 'bad-request', message: 'invalid client-request message', details: { issues: [] } },
        })
      }
      if (method !== endpoint) {
        return jsonResponse(rpcId, {
          ok: false,
          error: {
            code: 'bad-request',
            message: `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: { issues: [] },
          },
        })
      }
      try {
        return jsonResponse(rpcId, await handler(endpoint, body.payload, request.signal))
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

/**
 * node:http → fetch handler → node:http 的桥接。
 * 缓冲式读取（本通道的载荷都是小控制 JSON），带一个上限防止无界缓冲。
 */
async function bridge(req, res, fetchHandler, maxBodyBytes) {
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })

  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > maxBodyBytes) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    req.destroy()
    return
  }

  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.length
    if (received > maxBodyBytes) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      req.destroy()
      return
    }
    chunks.push(chunk)
  }

  const init = {
    method: req.method ?? 'GET',
    headers: Object.fromEntries(
      Object.entries(req.headers).filter(([, value]) => typeof value === 'string'),
    ),
    signal: abort.signal,
  }
  if (chunks.length > 0) init.body = Buffer.concat(chunks)

  const response = await fetchHandler.fetch(
    new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url}`, init),
  )
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => { res.off('drain', done); res.off('close', done); resolve() }
        res.once('drain', done)
        res.once('close', done)
      })
    }
    if (res.writableEnded) break
  }
  res.end()
}

/**
 * 把通道挂到 webServer 上。
 *
 * @returns 幂等的清理函数；环境里没有 webServer 时也返回一个空函数
 * （那种环境下这个插件本来就没有视图可画）。
 */
export function mountRoute(ctx, { channel, handler, maxBodyBytes = 2 * 1024 * 1024 }) {
  const webServer = ctx?.webServer
  if (typeof webServer?.register !== 'function') return () => {}

  const connection = ctx?.connection
  const fetchHandler = createFetchHandler(channel, handler)

  const registered = webServer.register({
    kind: 'prefix',
    path: channel,
    handler: async (req, res) => {
      let rejection
      if (typeof connection?.requestRejection === 'function') {
        try {
          // 必须绑回 connection:它是类方法，内部读 this.trustedHosts / this.browserAuth。
          rejection = connection.requestRejection(req)
        } catch {
          rejection = 403
        }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await bridge(req, res, fetchHandler, maxBodyBytes)
    },
  })

  // register 可能返回 disposer、Promise<disposer> 或什么也不返回。
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    try {
      if (typeof registered === 'function') registered()
      else if (registered && typeof registered.then === 'function') {
        void registered.then((dispose) => { if (typeof dispose === 'function') dispose() }).catch(() => {})
      }
    } catch {
      /* 已经清理过了 */
    }
  }
}
