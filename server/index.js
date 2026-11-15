import express from 'express';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { RoomManager } from './rooms.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

// A fingerprint of the client files. Each connection is told it, so a page
// left open across a deploy can tell it is running old code and reload.
function clientBuild(dir) {
  const hash = createHash('sha1');
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const file = path.join(d, e.name);
      if (e.isDirectory()) walk(file);
      else hash.update(e.name).update(readFileSync(file));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 12);
}

export function createApp({ timing } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (req, res) => res.type('text').send('ok'));
  app.use(express.static(publicDir));
  // Share links look like https://…/ABCD
  app.get('/:code', (req, res, next) => {
    if (/^[A-Za-z]{4}$/.test(req.params.code)) res.sendFile(path.join(publicDir, 'index.html'));
    else next();
  });

  const server = createServer(app);
  const io = new Server(server, {
    pingInterval: 10_000,
    pingTimeout: 15_000,
    maxHttpBufferSize: 64 * 1024,
  });
  const rooms = new RoomManager({ timing });
  const build = clientBuild(publicDir);
  io.on('connection', (socket) => {
    socket.emit('hello', { build });
    rooms.attach(socket);
  });
  return { app, server, io, rooms, build };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, io, rooms } = createApp();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`Kabo is running on http://localhost:${port}`));
  const stop = () => {
    rooms.close();
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
