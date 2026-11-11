import { createServer } from 'node:http';

export function createLoopbackServer(handle, { allowWrites = false, browserLogin = false } = {}) {
  if (typeof handle !== 'function') throw new Error('Request handler required');
  if (typeof allowWrites !== 'boolean' || typeof browserLogin !== 'boolean') throw new Error('Invalid server configuration');
  const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    const sendError = (status) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'invalid_request' }));
    };
    try {
      const authCount = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'authorization').length;
      const cookieCount = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'cookie').length;
      const originCount = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'origin').length;
      const lengthText = request.headers['content-length'];
      const logout = browserLogin && request.method === 'POST' && request.url === '/auth/logout';
      if (authCount > 1 || cookieCount > 1 || originCount > 1 || request.headers['transfer-encoding'] || (request.method === 'POST' && !allowWrites && !logout) ||
          !request.url?.startsWith('/') || request.url.length > 2048 ||
          (request.method === 'POST' ? !/^\d{1,5}$/.test(lengthText ?? '') || Number(lengthText) < (logout ? 0 : 1) || Number(lengthText) > (logout ? 0 : 8192)
            : lengthText && lengthText !== '0')) {
        request.resume();
        return sendError(400);
      }
      let body;
      if (request.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 8192) return sendError(400);
          chunks.push(chunk);
        }
        if (size !== Number(lengthText)) return sendError(400);
        body = Buffer.concat(chunks);
      }
      const url = new URL(`http://127.0.0.1${request.url}`);
      const headers = new Headers();
      if (request.headers.authorization) headers.set('authorization', request.headers.authorization);
      if (request.headers['content-type']) headers.set('content-type', request.headers['content-type']);
      if (browserLogin && request.headers.cookie) headers.set('cookie', request.headers.cookie);
      if (browserLogin && request.headers.origin) headers.set('origin', request.headers.origin);
      const result = await handle(new Request(url, { method: request.method, headers, body }));
      const outputHeaders = Object.fromEntries(result.headers);
      const cookies = result.headers.getSetCookie();
      if (cookies.length) outputHeaders['set-cookie'] = cookies;
      response.writeHead(result.status, outputHeaders);
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (!response.headersSent) sendError(500);
      else response.destroy();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  return server;
}
