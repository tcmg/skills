import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';

const MAX_JSON_BODY_BYTES = 15 * 1024 * 1024; // 15 MB (covers 10 MB base64 uploads)
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;

// TODO(security): 'unsafe-inline' is enabled for script-src/style-src because dist/editor.html
// is compiled by vite-plugin-singlefile into a self-contained single-file HTML bundle so the
// exact same artifact can also be served over MCP Apps `ui://` without external script tags.
const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'"
].join('; ');

function applyCommonSecurityHeaders(res, isApi = false) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (isApi) {
    res.setHeader('Cache-Control', 'no-store');
  }
}

function sendJson(res, statusCode, payload, isApi = true) {
  applyCommonSecurityHeaders(res, isApi);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        const err = new Error('Request payload too large.');
        err.statusCode = 413;
        req.destroy(err);
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        const err = new Error('Invalid JSON payload.');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => reject(err));
  });
}

function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Start a hardened local-only HTTP server on 127.0.0.1 for standalone or browser verification mode.
 */
export async function startHttpFallbackServer({
  getHtml,
  handlers,
  port
}) {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const rateBuckets = new Map();

  const resolvedPort =
    port !== undefined
      ? Number(port)
      : Number(process.env.PORT || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 3489);

  function checkRateLimit(remoteAddress) {
    const key = remoteAddress || '127.0.0.1';
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateBuckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= RATE_LIMIT_MAX_REQUESTS;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!checkRateLimit(req.socket?.remoteAddress)) {
        sendJson(res, 429, { error: 'Rate limit exceeded.' });
        return;
      }

      const method = (req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        applyCommonSecurityHeaders(res, true);
        res.setHeader('Allow', 'GET, POST');
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Method not allowed.' }));
        return;
      }

      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = reqUrl.pathname;

      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true }, true);
        return;
      }

      if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        const baseHtml = await getHtml();
        const htmlWithCsrf = baseHtml.replace(
          '<!--SIDECAR_PRELOAD-->',
          `<meta name="x-studio-csrf" content="${csrfToken}">`
        );
        applyCommonSecurityHeaders(res, false);
        res.setHeader('Content-Security-Policy', HTML_CSP);
        res.setHeader('Cache-Control', 'no-store');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlWithCsrf);
        return;
      }

      if (method === 'GET' && pathname === '/api/asset') {
        const project = reqUrl.searchParams.get('project') || '';
        const file = reqUrl.searchParams.get('file') || '';
        try {
          const asset = await handlers.readAssetBinary({ project, filename: file });
          applyCommonSecurityHeaders(res, false);
          res.setHeader('Content-Type', asset.mimeType);
          res.setHeader('Cache-Control', 'private, max-age=300');
          res.writeHead(200);
          res.end(asset.buffer);
        } catch (err) {
          const status = err?.code === 'ENOENT' ? 404 : 400;
          sendJson(res, status, { error: 'Asset not found or invalid.' }, true);
        }
        return;
      }

      if (method === 'POST' && pathname.startsWith('/api/')) {
        const presentedToken = req.headers['x-studio-csrf'];
        if (!tokensEqual(typeof presentedToken === 'string' ? presentedToken : '', csrfToken)) {
          sendJson(res, 403, { error: 'Forbidden: invalid or missing CSRF token.' }, true);
          return;
        }

        const body = await readJsonBody(req);
        const routes = {
          '/api/init': handlers.init,
          '/api/read': handlers.read,
          '/api/save': handlers.save,
          '/api/create': handlers.create,
          '/api/mtime': handlers.mtime,
          '/api/focus': handlers.focusPost,
          '/api/upload-asset': handlers.uploadAsset,
          '/api/read-asset': handlers.readAssetDataUrl,
          '/api/site-theme': handlers.siteTheme
        };

        const handler = routes[pathname];
        if (!handler) {
          sendJson(res, 404, { error: 'Unknown API endpoint.' }, true);
          return;
        }

        const result = await handler(body);
        sendJson(res, 200, result, true);
        return;
      }

      sendJson(res, 404, { error: 'Not found.' }, true);
    } catch (err) {
      const statusCode =
        typeof err?.statusCode === 'number'
          ? err.statusCode
          : err?.code === 'ENOENT'
            ? 404
            : err instanceof Error && /invalid|unsupported|security|exceeds|already exists|must be/i.test(err.message)
              ? 400
              : 500;
      const safeMessage = statusCode === 500 ? 'Internal server error.' : err.message;
      sendJson(res, statusCode, { error: safeMessage }, true);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(resolvedPort, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : resolvedPort;

  return {
    server,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    csrfToken,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
