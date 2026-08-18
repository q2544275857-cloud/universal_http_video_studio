import http from 'node:http';

for (const key of ['PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'DEFAULT_PROXY', 'DISABLE_DEFAULT_PROXY']) {
  delete process.env[key];
}

const { httpRequest } = await import('../server/provider/httpRequest.js');

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    connection: 'close'
  });
  res.end(JSON.stringify({ ok: true, host: req.headers.host }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const port = server.address().port;
  const result = await httpRequest(`http://127.0.0.1:${port}/health`, {
    retries: 0,
    timeoutMs: 5000
  });
  const output = {
    ok: result.status === 200 && result.json?.ok === true,
    status: result.status,
    response: result.json
  };
  console.log(JSON.stringify(output, null, 2));
  server.closeAllConnections?.();
  server.close();
  process.exit(output.ok ? 0 : 1);
} catch (error) {
  console.error(error.stack || error.message || String(error));
  server.closeAllConnections?.();
  server.close();
  process.exit(1);
}
