'use strict';

// A local git smart-HTTP server for tests: it serves the bare repositories under ROOT through `git http-backend` and
// answers 401 to every request that does not carry the basic-auth password TOKEN, so a push can only succeed when the
// token reached the transport. It runs in its own process because the code under test blocks while it runs git.
// Usage: node authenticated-git-http-server.cjs ROOT TOKEN AUTH_LOG. It prints its port on stdout when it listens.

const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');

const [root, token, authLog] = process.argv.slice(2);
const wanted = `Basic ${Buffer.from(`user:${token}`).toString('base64')}`;

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== wanted) {
    fs.appendFileSync(authLog, 'denied\n');
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
    res.end();
    return;
  }
  fs.appendFileSync(authLog, 'allowed\n');
  const url = new URL(req.url, 'http://localhost');
  const backend = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method,
      PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: req.headers['content-length'] ?? '', REMOTE_USER: 'user', REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(backend.stdin);
  const chunks = [];
  backend.stdout.on('data', (chunk) => chunks.push(chunk));
  backend.on('close', () => {
    const out = Buffer.concat(chunks);
    const cut = out.indexOf('\r\n\r\n');
    const headers = {};
    let status = 200;
    for (const line of out.subarray(0, cut).toString().split('\r\n')) {
      const at = line.indexOf(':');
      const key = line.slice(0, at);
      const value = line.slice(at + 1).trim();
      if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10); else headers[key] = value;
    }
    res.writeHead(status, headers);
    res.end(out.subarray(cut + 4));
  });
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
