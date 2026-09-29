const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function cargarEnvLocal() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  lines.forEach(line => {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) return;
    const idx = clean.indexOf('=');
    if (idx === -1) return;
    const key = clean.slice(0, idx).trim();
    const value = clean.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

cargarEnvLocal();

const LISTEN_HOST = process.env.FINGERPRINT_AGENT_HOST || '127.0.0.1';
const LISTEN_PORT = Number(process.env.FINGERPRINT_AGENT_PORT || 17778);
const DEVICE_NAME = process.env.FINGERPRINT_DEVICE_NAME || 'ZK9500';
const CAPTURE_COMMAND = String(process.env.FINGERPRINT_CAPTURE_COMMAND || '').trim();
const CAPTURE_ARGS = String(process.env.FINGERPRINT_CAPTURE_ARGS || '').trim();
const MATCH_COMMAND = String(process.env.FINGERPRINT_MATCH_COMMAND || '').trim();
const MATCH_ARGS = String(process.env.FINGERPRINT_MATCH_ARGS || '').trim();
const DEMO_MODE = process.env.FINGERPRINT_DEMO === '1';
const POWERSHELL_COMMAND = process.env.FINGERPRINT_POWERSHELL || 'powershell.exe';
const SDK_BRIDGE = path.join(__dirname, 'zkfinger-sdk.ps1');

function sendCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, payload) {
  sendCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
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

function splitArgs(raw) {
  if (!raw) return [];
  const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return matches.map(part => part.replace(/^["']|["']$/g, ''));
}

function runSdkBridge(action, payload, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ...extraEnv,
      FINGERPRINT_CAPTURE_PAYLOAD: action === 'capture' ? JSON.stringify(payload || {}) : undefined,
      FINGERPRINT_MATCH_PAYLOAD: action === 'match' ? JSON.stringify(payload || {}) : undefined
    };
    if (action !== 'capture') delete env.FINGERPRINT_CAPTURE_PAYLOAD;
    if (action !== 'match') delete env.FINGERPRINT_MATCH_PAYLOAD;
    execFile(
      POWERSHELL_COMMAND,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SDK_BRIDGE, '-Action', action],
      { env, windowsHide: true, timeout: action === 'health' ? 15000 : 60000 },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (!out) {
          resolve({ ok: false, codigo: 'BRIDGE_FAILED', mensaje: stderr || (err && err.message) || 'El adaptador del SDK no devolvio datos' });
          return;
        }
        try {
          resolve(JSON.parse(out));
        } catch (_parseErr) {
          resolve({ ok: false, codigo: 'BRIDGE_INVALID_JSON', mensaje: stderr || out });
        }
      }
    );
  });
}

function parseCaptureResult(stdout, stderr, err) {
  const out = String(stdout || '').trim();
  if (!out) return { ok: false, mensaje: stderr || (err && err.message) || 'El capturador ZKT no devolvio datos' };
  try {
    const parsed = JSON.parse(out);
    return {
      ok: Boolean(parsed.ok !== false),
      template: parsed.template || parsed.template_base64 || parsed.data,
      quality: parsed.quality || parsed.calidad || null,
      device: parsed.device || parsed.dispositivo || DEVICE_NAME,
      mensaje: parsed.mensaje || parsed.message || null,
      muestras: parsed.muestras || null,
      codigo: parsed.codigo || null
    };
  } catch (_err) {
    return { ok: true, template: out, quality: null, device: DEVICE_NAME };
  }
}

function runCaptureCommand(body) {
  if (!CAPTURE_COMMAND && fs.existsSync(SDK_BRIDGE)) {
    return runSdkBridge('capture', body);
  }
  return new Promise((resolve) => {
    if (!CAPTURE_COMMAND) {
      resolve({
        ok: false,
        mensaje: 'Falta configurar FINGERPRINT_CAPTURE_COMMAND con el capturador del SDK ZKT'
      });
      return;
    }

    const env = {
      ...process.env,
      FINGERPRINT_PURPOSE: String(body.purpose || 'capture'),
      FINGERPRINT_DEDO: String(body.dedo || 'indice_derecho'),
      FINGERPRINT_STUDENT_ID: String(body.estudiante_id || ''),
      FINGERPRINT_PAYLOAD: JSON.stringify(body || {})
    };

    execFile(CAPTURE_COMMAND, splitArgs(CAPTURE_ARGS), { env, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, mensaje: stderr || err.message });
        return;
      }

      const out = String(stdout || '').trim();
      if (!out) {
        resolve({ ok: false, mensaje: 'El capturador ZKT no devolvio datos' });
        return;
      }

      resolve(parseCaptureResult(out, stderr, null));
    });
  });
}

function hashTemplate(template) {
  return crypto.createHash('sha256').update(String(template || '').trim(), 'utf8').digest('hex');
}

function runMatchCommand(body) {
  if (!MATCH_COMMAND && fs.existsSync(SDK_BRIDGE)) {
    return runSdkBridge('match', body);
  }
  return new Promise((resolve) => {
    if (!MATCH_COMMAND) {
      const probeHash = hashTemplate(body.probe || body.template);
      const candidates = Array.isArray(body.candidates) ? body.candidates : [];
      const found = candidates.find(c => hashTemplate(c.template) === probeHash);
      resolve(found
        ? { ok: true, matched: true, candidateId: found.id, score: 100, mode: 'exact-hash' }
        : { ok: true, matched: false, score: 0, mode: 'exact-hash' });
      return;
    }

    const env = {
      ...process.env,
      FINGERPRINT_MATCH_PAYLOAD: JSON.stringify(body || {})
    };

    execFile(MATCH_COMMAND, splitArgs(MATCH_ARGS), { env, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, mensaje: stderr || err.message });
        return;
      }

      try {
        const parsed = JSON.parse(String(stdout || '').trim());
        resolve({
          ok: Boolean(parsed.ok !== false),
          matched: Boolean(parsed.matched || parsed.encontrado),
          candidateId: parsed.candidateId || parsed.candidate_id || parsed.id || null,
          score: Number(parsed.score || parsed.puntaje || 0),
          mensaje: parsed.mensaje || parsed.message || null,
          mode: 'sdk-command'
        });
      } catch (_err) {
        resolve({ ok: false, mensaje: 'El comparador ZKT no devolvio JSON valido' });
      }
    });
  });
}

function demoCapture(body) {
  const key = String(body.demoKey || body.cedula || body.estudiante_id || 'demo');
  const template = crypto.createHash('sha256').update(`demo:${key}`).digest('base64');
  return {
    ok: true,
    template,
    quality: 80,
    device: `${DEVICE_NAME} DEMO`
  };
}

const server = http.createServer(async (req, res) => {
  sendCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    const sdk = (!CAPTURE_COMMAND && !DEMO_MODE && fs.existsSync(SDK_BRIDGE))
      ? await runSdkBridge('health', {})
      : null;
    json(res, 200, {
      ok: true,
      configurado: Boolean(CAPTURE_COMMAND || DEMO_MODE || sdk?.ok),
      matchingConfigurado: Boolean(MATCH_COMMAND || DEMO_MODE || sdk?.ok),
      sdkConfigurado: Boolean(sdk?.ok),
      deviceDetectado: Number(sdk?.deviceCount || 0) > 0,
      codigo: sdk?.codigo || null,
      device: DEVICE_NAME,
      agentPort: LISTEN_PORT,
      modo: CAPTURE_COMMAND ? 'sdk-command' : (DEMO_MODE ? 'demo' : 'zkfinger-sdk'),
      mensaje: CAPTURE_COMMAND || DEMO_MODE
        ? 'Agente listo'
        : (sdk?.mensaje || 'Instala el SDK ZKFinger para Windows y el driver del ZK9500')
    });
    return;
  }

  if (req.method === 'POST' && (req.url === '/capture' || req.url === '/identify')) {
    try {
      const body = await readJson(req);
      const result = DEMO_MODE ? demoCapture(body) : await runCaptureCommand(body);
      json(res, result.ok ? 200 : 500, result);
    } catch (err) {
      json(res, 500, { ok: false, mensaje: err.message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/match') {
    try {
      const body = await readJson(req);
      const result = DEMO_MODE
        ? await runMatchCommand(body)
        : await runMatchCommand(body);
      json(res, result.ok ? 200 : 500, result);
    } catch (err) {
      json(res, 500, { ok: false, mensaje: err.message });
    }
    return;
  }

  json(res, 404, { ok: false, mensaje: 'Ruta no encontrada' });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`Agente de huella listo en http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Dispositivo: ${DEVICE_NAME}`);
  console.log(CAPTURE_COMMAND ? `Capturador: ${CAPTURE_COMMAND}` : 'Capturador ZKT no configurado');
});
