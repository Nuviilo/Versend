import express from 'express';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const PAIR_CODE_TTL_MS = 180_000; // 3 minutes
const PAIR_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

type PlatformType = 'Windows' | 'Android' | 'Other';

interface ConnectedClient {
  deviceId: string;
  name: string;
  platform: PlatformType;
  pairedDeviceIds: Set<string>;
  ws: WebSocket;
  isAlive: boolean;
}

interface PairingEntry {
  code: string;
  creatorDeviceId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

const clients = new Map<string, ConnectedClient>();
const socketToDeviceId = new Map<WebSocket, string>();
const pairingCodes = new Map<string, PairingEntry>();
const deviceActiveCode = new Map<string, string>();

function generatePairCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    const idx = crypto.randomInt(0, PAIR_CODE_ALPHABET.length);
    code += PAIR_CODE_ALPHABET[idx];
  }
  return code;
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sanitizePlatform(raw: unknown): PlatformType {
  if (raw === 'Windows' || raw === 'Android') {
    return raw;
  }
  return 'Other';
}

function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Unnamed Device';
  const trimmed = raw.trim().slice(0, 48);
  return trimmed || 'Unnamed Device';
}

function notifyPairedPeersStatus(client: ConnectedClient, online: boolean): void {
  for (const [otherId, otherClient] of clients.entries()) {
    if (otherId === client.deviceId) continue;
    if (client.pairedDeviceIds.has(otherId) || otherClient.pairedDeviceIds.has(client.deviceId)) {
      sendJson(otherClient.ws, {
        type: 'peer:status',
        deviceId: client.deviceId,
        name: client.name,
        platform: client.platform,
        online,
      });
    }
  }
}

function clearDeviceCode(deviceId: string): void {
  const existingCode = deviceActiveCode.get(deviceId);
  if (existingCode) {
    const entry = pairingCodes.get(existingCode);
    if (entry) {
      clearTimeout(entry.timer);
      pairingCodes.delete(existingCode);
    }
    deviceActiveCode.delete(deviceId);
  }
}

function createPairingEntryForDevice(deviceId: string): PairingEntry {
  clearDeviceCode(deviceId);

  let code = generatePairCode();
  while (pairingCodes.has(code)) {
    code = generatePairCode();
  }

  const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
  const timer = setTimeout(() => {
    const current = pairingCodes.get(code);
    if (current && current.creatorDeviceId === deviceId) {
      pairingCodes.delete(code);
      deviceActiveCode.delete(deviceId);
      const client = clients.get(deviceId);
      if (client) {
        sendJson(client.ws, { type: 'pair:expired', code });
      }
    }
  }, PAIR_CODE_TTL_MS);

  const entry: PairingEntry = { code, creatorDeviceId: deviceId, expiresAt, timer };
  pairingCodes.set(code, entry);
  deviceActiveCode.set(deviceId, code);
  return entry;
}

const FORWARDABLE_TYPES = new Set([
  'rtc:offer',
  'rtc:answer',
  'rtc:ice-candidate',
  'transfer:offer',
  'transfer:accept',
  'transfer:decline',
  'transfer:cancel',
  'transfer:resume-offer',
  'transfer:file-complete',
  'transfer:complete',
  'transfer:pause',
]);

function handleJsonMessage(ws: WebSocket, rawText: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(rawText);
  } catch {
    return;
  }

  const type = typeof msg.type === 'string' ? msg.type : '';
  if (!type) return;

  if (type === 'register') {
    const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.trim().slice(0, 64) : '';
    if (!deviceId) return;

    const existing = clients.get(deviceId);
    if (existing && existing.ws !== ws) {
      socketToDeviceId.delete(existing.ws);
      try {
        existing.ws.close(4000, 'Replaced by newer session');
      } catch {
        // ignore
      }
    }

    const pairedList = Array.isArray(msg.pairedDeviceIds)
      ? msg.pairedDeviceIds.filter((id): id is string => typeof id === 'string' && id.length > 0).slice(0, 200)
      : [];

    const client: ConnectedClient = {
      deviceId,
      name: sanitizeName(msg.name),
      platform: sanitizePlatform(msg.platform),
      pairedDeviceIds: new Set(pairedList),
      ws,
      isAlive: true,
    };

    clients.set(deviceId, client);
    socketToDeviceId.set(ws, deviceId);

    const onlinePeers: Array<{ deviceId: string; name: string; platform: PlatformType; online: boolean }> = [];
    for (const peerId of client.pairedDeviceIds) {
      const peer = clients.get(peerId);
      if (peer) {
        onlinePeers.push({
          deviceId: peer.deviceId,
          name: peer.name,
          platform: peer.platform,
          online: true,
        });
      }
    }

    sendJson(ws, {
      type: 'registered',
      deviceId,
      onlinePeers,
    });

    notifyPairedPeersStatus(client, true);
    return;
  }

  const senderId = socketToDeviceId.get(ws);
  if (!senderId) return;
  const sender = clients.get(senderId);
  if (!sender) return;

  if (type === 'device:update') {
    sender.name = sanitizeName(msg.name);
    if (msg.platform) {
      sender.platform = sanitizePlatform(msg.platform);
    }
    notifyPairedPeersStatus(sender, true);
    return;
  }

  if (type === 'pair:create') {
    const entry = createPairingEntryForDevice(sender.deviceId);
    sendJson(ws, {
      type: 'pair:code',
      code: entry.code,
      expiresAt: entry.expiresAt,
    });
    return;
  }

  if (type === 'pair:redeem') {
    const rawCode = typeof msg.code === 'string' ? msg.code : '';
    const normalized = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!normalized) {
      sendJson(ws, { type: 'pair:error', message: 'Enter a valid 6-character connection code.' });
      return;
    }

    const entry = pairingCodes.get(normalized);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entry) {
        clearTimeout(entry.timer);
        pairingCodes.delete(normalized);
        deviceActiveCode.delete(entry.creatorDeviceId);
      }
      sendJson(ws, { type: 'pair:error', message: 'Connection code is invalid or has expired.' });
      return;
    }

    if (entry.creatorDeviceId === sender.deviceId) {
      sendJson(ws, { type: 'pair:error', message: 'Cannot pair a device with itself.' });
      return;
    }

    const creator = clients.get(entry.creatorDeviceId);
    if (!creator) {
      sendJson(ws, { type: 'pair:error', message: 'The other device is no longer online.' });
      return;
    }

    clearDeviceCode(creator.deviceId);
    creator.pairedDeviceIds.add(sender.deviceId);
    sender.pairedDeviceIds.add(creator.deviceId);

    sendJson(sender.ws, {
      type: 'pair:success',
      peer: {
        deviceId: creator.deviceId,
        name: creator.name,
        platform: creator.platform,
        online: true,
      },
    });

    sendJson(creator.ws, {
      type: 'pair:success',
      peer: {
        deviceId: sender.deviceId,
        name: sender.name,
        platform: sender.platform,
        online: true,
      },
    });
    return;
  }

  if (type === 'pair:unpair') {
    const targetId = typeof msg.targetDeviceId === 'string' ? msg.targetDeviceId : '';
    if (!targetId) return;
    sender.pairedDeviceIds.delete(targetId);
    const target = clients.get(targetId);
    if (target) {
      target.pairedDeviceIds.delete(sender.deviceId);
      sendJson(target.ws, {
        type: 'pair:removed',
        deviceId: sender.deviceId,
      });
    }
    return;
  }

  if (FORWARDABLE_TYPES.has(type)) {
    const targetId = typeof msg.targetDeviceId === 'string' ? msg.targetDeviceId : '';
    if (!targetId) return;
    const target = clients.get(targetId);
    if (!target || target.ws.readyState !== WebSocket.OPEN) {
      if (type === 'transfer:offer' || type === 'transfer:resume-offer') {
        sendJson(sender.ws, {
          type: 'transfer:peer-offline',
          targetDeviceId: targetId,
          transferId: msg.transferId,
        });
      }
      return;
    }

    if (!sender.pairedDeviceIds.has(targetId) && !target.pairedDeviceIds.has(sender.deviceId)) {
      return;
    }

    sendJson(target.ws, {
      ...msg,
      fromDeviceId: sender.deviceId,
    });
  }
}

function handleBinaryMessage(ws: WebSocket, data: RawData): void {
  const senderId = socketToDeviceId.get(ws);
  if (!senderId) return;
  const sender = clients.get(senderId);
  if (!sender) return;

  const buf = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);

  if (buf.length < 4) return;
  const targetIdLen = buf.readUInt16BE(0);
  if (targetIdLen === 0 || buf.length < 2 + targetIdLen) return;

  const targetId = buf.subarray(2, 2 + targetIdLen).toString('utf8');
  const target = clients.get(targetId);
  if (!target || target.ws.readyState !== WebSocket.OPEN) return;

  if (!sender.pairedDeviceIds.has(targetId) && !target.pairedDeviceIds.has(sender.deviceId)) {
    return;
  }

  const senderIdBuf = Buffer.from(sender.deviceId, 'utf8');
  const payload = buf.subarray(2 + targetIdLen);
  const outBuf = Buffer.allocUnsafe(2 + senderIdBuf.length + payload.length);
  outBuf.writeUInt16BE(senderIdBuf.length, 0);
  senderIdBuf.copy(outBuf, 2);
  payload.copy(outBuf, 2 + senderIdBuf.length);

  target.ws.send(outBuf, { binary: true });
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  app.use('/api', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, connectedDevices: clients.size });
  });

  app.get('/api/ice-servers', (_req, res) => {
    const iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun.cloudflare.com:3478',
        ],
      },
    ];

    if (process.env.TURN_URL) {
      const turnEntry: { urls: string; username?: string; credential?: string } = {
        urls: process.env.TURN_URL,
      };
      if (process.env.TURN_USERNAME) turnEntry.username = process.env.TURN_USERNAME;
      if (process.env.TURN_CREDENTIAL) turnEntry.credential = process.env.TURN_CREDENTIAL;
      iceServers.push(turnEntry);
    }

    res.json({ iceServers });
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 16 * 1024 * 1024,
  });

  wss.on('connection', (ws: WebSocket) => {
    ws.on('pong', () => {
      const deviceId = socketToDeviceId.get(ws);
      if (deviceId) {
        const client = clients.get(deviceId);
        if (client && client.ws === ws) {
          client.isAlive = true;
        }
      }
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        handleBinaryMessage(ws, data);
      } else {
        handleJsonMessage(ws, data.toString('utf8'));
      }
    });

    ws.on('close', () => {
      const deviceId = socketToDeviceId.get(ws);
      socketToDeviceId.delete(ws);
      if (!deviceId) return;

      const current = clients.get(deviceId);
      if (current && current.ws === ws) {
        clients.delete(deviceId);
        clearDeviceCode(deviceId);
        notifyPairedPeersStatus(current, false);
      }
    });

    ws.on('error', () => {
      // handled on close
    });
  });

  const heartbeatInterval = setInterval(() => {
    for (const [deviceId, client] of clients.entries()) {
      if (!client.isAlive) {
        socketToDeviceId.delete(client.ws);
        clients.delete(deviceId);
        clearDeviceCode(deviceId);
        notifyPairedPeersStatus(client, false);
        try {
          client.ws.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      client.isAlive = false;
      try {
        client.ws.ping();
      } catch {
        // ignore
      }
    }
  }, 25_000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Versend server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Versend server:', err);
  process.exit(1);
});
