const http = require('http');
const net = require('net');

const DEFAULT_HOST = process.env.POS_PRINTER_HOST || '192.168.1.5';
const DEFAULT_PORT = Number(process.env.POS_PRINTER_PORT || 9100);
const LISTEN_HOST = process.env.POS_AGENT_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.POS_AGENT_PORT || 17777);

function sendCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error('Payload demasiado grande'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendToPrinter(buffer, host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(buffer);
      socket.end();
    });
    socket.setTimeout(5000);
    socket.on('close', () => resolve({ ok: true, metodo: `local-tcp:${host}:${port}` }));
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, mensaje: `Tiempo agotado conectando a ${host}:${port}` });
    });
    socket.on('error', err => resolve({ ok: false, mensaje: err.message }));
  });
}

function json(res, status, payload) {
  sendCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  sendCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, host: DEFAULT_HOST, port: DEFAULT_PORT });
    return;
  }

  if (req.method === 'POST' && req.url === '/print') {
    try {
      const body = await readJson(req);
      const data = body.data || '';
      const host = String(body.host || DEFAULT_HOST).trim();
      const port = Number(body.port || DEFAULT_PORT);
      if (!data) return json(res, 400, { ok: false, mensaje: 'Falta data base64' });
      if (!host || !Number.isFinite(port)) return json(res, 400, { ok: false, mensaje: 'Host o puerto invalido' });

      const buffer = Buffer.from(data, 'base64');
      const result = await sendToPrinter(buffer, host, port);
      json(res, result.ok ? 200 : 500, result);
    } catch (err) {
      json(res, 500, { ok: false, mensaje: err.message });
    }
    return;
  }

  json(res, 404, { ok: false, mensaje: 'Ruta no encontrada' });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Agente POS local listo en http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Impresora destino: ${DEFAULT_HOST}:${DEFAULT_PORT}`);
});
