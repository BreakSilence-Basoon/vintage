import { createServer } from 'node:http';

export function createLoopbackServer(handle) {
  if (typeof handle !== 'function') throw new Error('Request handler required');
  const server = createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    const sendError = (status) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: 'invalid_request' }));
    };
    try {
      const authCount = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === 'authorization').length;
      if (authCount > 1 || request.headers['transfer-encoding'] ||
          (request.headers['content-length'] && request.headers['content-length'] !== '0') ||
          !request.url?.startsWith('/') || request.url.length > 2048) {
        request.resume();
        return sendError(400);
      }
      const url = new URL(`http://127.0.0.1${request.url}`);
      const headers = new Headers();
      if (request.headers.authorization) headers.set('authorization', request.headers.authorization);
      const result = await handle(new Request(url, { method: request.method, headers }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
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
