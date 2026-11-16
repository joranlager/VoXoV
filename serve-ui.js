// Serves the VoXoV web page on its own, separate from the VoXoV server.
// The page talks to the server at http://localhost:8090 (start it with `npm start`).
//
//   npm run ui   ->   http://localhost:5500

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.UI_PORT || 5500);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`VoXoV web page: http://localhost:${PORT}`);
    console.log('It uses the VoXoV server at http://localhost:8090 — start that with "npm start".');
  });
