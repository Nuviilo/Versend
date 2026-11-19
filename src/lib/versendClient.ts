import { getApiUrl, getWsUrl } from './serverUrl';
import {
  decodeDataChunk,
  decodeRelayPacket,
  encodeDataChunk,
  encodeRelayPacket,
} from './binaryFrame';
import { finalizeCrc32, initCrc32, updateCrc32 } from './crc32';
import { createDestinationSession, type DestinationSession, type FileSink } from './fileHelpers';
import type {
  ActiveTransfer,
  DeviceIdentity,
  IncomingOffer,
  PairedDevice,
  PlatformType,
  QueuedFileItem,
  ReceivedFileDownload,
  TransferFileMeta,
} from '../types/versend';

const CHUNK_SIZE = 64 * 1024; // 64 KB — optimal for WebRTC SCTP & WebSocket relay
const DC_HIGH_WATER = 2 * 1024 * 1024; // 2 MB
const DC_LOW_WATER = 512 * 1024; // 512 KB
const WS_HIGH_WATER = 2 * 1024 * 1024;
const P2P_CONNECT_TIMEOUT_MS = 5500;

export interface VersendCallbacks {
  onWsConnectedChange: (connected: boolean) => void;
  onPairedDevicesChange: (devices: PairedDevice[]) => void;
  onPairingCode: (code: string, expiresAt: number) => void;
  onPairingExpired: () => void;
  onPairingError: (message: string) => void;
  onPairingSuccess: (peer: PairedDevice) => void;
  onIncomingOffer: (offer: IncomingOffer | null) => void;
  onTransfersChange: (transfers: ActiveTransfer[]) => void;
}

interface OutgoingSession {
  transferId: string;
  peerDeviceId: string;
  files: QueuedFileItem[];
  fileMetas: TransferFileMeta[];
  totalBytes: number;
  cancelled: boolean;
  paused: boolean;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  remoteDescSet: boolean;
  useRelay: boolean;
  completedBytesBeforeFile: number[];
  lastSampleTime: number;
  lastSampleBytes: number;
  speedEma: number;
}

interface IncomingSession {
  transferId: string;
  peerDeviceId: string;
  files: TransferFileMeta[];
  totalBytes: number;
  destSession: DestinationSession | null;
  currentFileIndex: number;
  currentSink: FileSink | null;
  currentCrc: number;
  currentFileBytes: number;
  completedBytes: number;
  writeChain: Promise<void>;
  cancelled: boolean;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  remoteDescSet: boolean;
  downloads: ReceivedFileDownload[];
  allVerified: boolean;
  lastSampleTime: number;
  lastSampleBytes: number;
  speedEma: number;
  isResume?: boolean;
}

export class VersendClient {
  private identity: DeviceIdentity;
  private pairedDevices: PairedDevice[];
  private callbacks: VersendCallbacks;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;

  private iceServers: RTCIceServer[] = [
    {
      urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
      ],
    },
  ];

  private transfers = new Map<string, ActiveTransfer>();
  private outgoingSessions = new Map<string, OutgoingSession>();
  private incomingSessions = new Map<string, IncomingSession>();
  private pendingOffers = new Map<string, IncomingOffer>();
  private pendingPairCreate = false;

  constructor(
    identity: DeviceIdentity,
    initialPaired: PairedDevice[],
    callbacks: VersendCallbacks
  ) {
    this.identity = identity;
    this.pairedDevices = initialPaired.map((d) => ({ ...d, online: false }));
    this.callbacks = callbacks;
    void this.fetchIceServers();
    this.connectWs();
  }

  private async fetchIceServers(): Promise<void> {
    try {
      const res = await fetch(getApiUrl('/api/ice-servers'));
      if (!res.ok) return;
      const data = (await res.json()) as { iceServers?: RTCIceServer[] };
      if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
        this.iceServers = data.iceServers;
      }
    } catch {
      // keep default STUN servers
    }
  }

  private connectWs(): void {
    if (this.destroyed) return;
    const wsUrl = getWsUrl();

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.callbacks.onWsConnectedChange(true);
        this.sendJson({
          type: 'register',
          deviceId: this.identity.deviceId,
          name: this.identity.name,
          platform: this.identity.platform,
          pairedDeviceIds: this.pairedDevices.map((d) => d.deviceId),
        });
      };

      ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) {
          this.handleRelayBinary(ev.data);
        } else if (typeof ev.data === 'string') {
          this.handleSignalJson(ev.data);
        }
      };

      ws.onclose = () => {
        this.callbacks.onWsConnectedChange(false);
        this.pairedDevices = this.pairedDevices.map((d) => ({ ...d, online: false }));
        this.callbacks.onPairedDevicesChange([...this.pairedDevices]);

        // Mark relay-dependent or pending transfers interrupted
        for (const [tid, out] of this.outgoingSessions.entries()) {
          if (out.useRelay && !out.cancelled) {
            const tr = this.transfers.get(tid);
            if (tr && tr.status === 'transferring') {
              out.paused = true;
              this.updateTransfer(tid, {
                status: 'interrupted',
                canResume: true,
                speedBytesPerSec: 0,
                errorMessage: 'Connection interrupted. Ready to resume when online.',
              });
            }
          }
        }

        if (!this.destroyed) {
          const delay = Math.min(1000 * Math.pow(1.6, this.reconnectAttempt), 8000);
          this.reconnectAttempt++;
          this.reconnectTimer = setTimeout(() => this.connectWs(), delay);
        }
      };

      ws.onerror = () => {
        // handled by onclose
      };
    } catch {
      if (!this.destroyed) {
        this.reconnectTimer = setTimeout(() => this.connectWs(), 2000);
      }
    }
  }

  public destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const sess of this.outgoingSessions.values()) {
      sess.cancelled = true;
      this.cleanupPc(sess.pc, sess.dc);
    }
    for (const sess of this.incomingSessions.values()) {
      sess.cancelled = true;
      this.cleanupPc(sess.pc, sess.dc);
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
  }

  private sendJson(payload: Record<string, unknown>): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  public updateIdentity(identity: DeviceIdentity): void {
    this.identity = identity;
    this.sendJson({
      type: 'device:update',
      name: identity.name,
      platform: identity.platform,
    });
  }

  public reconnectWithNewServer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      try {
        oldWs.onclose = null;
        oldWs.onerror = null;
        oldWs.onmessage = null;
        oldWs.onopen = null;
        oldWs.close();
      } catch {
        // ignore
      }
    }
    this.callbacks.onWsConnectedChange(false);
    void this.fetchIceServers();
    this.connectWs();
  }

  public createPairingCode(): void {
    const sent = this.sendJson({ type: 'pair:create' });
    this.pendingPairCreate = !sent;
  }

  public redeemPairingCode(code: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.callbacks.onPairingError('Connecting to signaling service. Please try again in a moment.');
      return;
    }
    this.sendJson({ type: 'pair:redeem', code });
  }

  public removePairedDevice(deviceId: string): void {
    this.sendJson({ type: 'pair:unpair', targetDeviceId: deviceId });
    this.pairedDevices = this.pairedDevices.filter((d) => d.deviceId !== deviceId);
    this.callbacks.onPairedDevicesChange([...this.pairedDevices]);
  }

  public async startTransfer(peer: PairedDevice, items: QueuedFileItem[]): Promise<string | null> {
    if (items.length === 0) return null;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;

    const transferId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const fileMetas: TransferFileMeta[] = items.map((item, idx) => ({
      fileIndex: idx,
      name: item.name,
      relativePath: item.relativePath,
      size: item.size,
      mimeType: item.mimeType,
    }));

    let cumulative = 0;
    const completedBytesBeforeFile: number[] = [];
    for (const m of fileMetas) {
      completedBytesBeforeFile.push(cumulative);
      cumulative += m.size;
    }

    const totalBytes = cumulative;

    const session: OutgoingSession = {
      transferId,
      peerDeviceId: peer.deviceId,
      files: items,
      fileMetas,
      totalBytes,
      cancelled: false,
      paused: false,
      pc: null,
      dc: null,
      pendingIce: [],
      remoteDescSet: false,
      useRelay: false,
      completedBytesBeforeFile,
      lastSampleTime: performance.now(),
      lastSampleBytes: 0,
      speedEma: 0,
    };

    this.outgoingSessions.set(transferId, session);

    this.setTransfer({
      transferId,
      direction: 'send',
      peerDeviceId: peer.deviceId,
      peerName: peer.name,
      peerPlatform: peer.platform,
      files: fileMetas,
      totalBytes,
      transferredBytes: 0,
      currentFileIndex: 0,
      currentFileName: fileMetas[0].relativePath,
      speedBytesPerSec: 0,
      status: 'waiting-approval',
      transport: 'connecting',
      integrityVerified: null,
    });

    this.sendJson({
      type: 'transfer:offer',
      targetDeviceId: peer.deviceId,
      transferId,
      senderName: this.identity.name,
      senderPlatform: this.identity.platform,
      files: fileMetas,
      totalSize: totalBytes,
    });

    return transferId;
  }

  public resumeTransfer(transferId: string): void {
    const sess = this.outgoingSessions.get(transferId);
    const tr = this.transfers.get(transferId);
    if (!sess || !tr) return;

    sess.paused = false;
    sess.cancelled = false;
    sess.useRelay = false;
    this.cleanupPc(sess.pc, sess.dc);
    sess.pc = null;
    sess.dc = null;
    sess.pendingIce = [];
    sess.remoteDescSet = false;

    this.updateTransfer(transferId, {
      status: 'waiting-approval',
      transport: 'connecting',
      errorMessage: undefined,
      canResume: false,
    });

    this.sendJson({
      type: 'transfer:resume-offer',
      targetDeviceId: sess.peerDeviceId,
      transferId,
      senderName: this.identity.name,
      senderPlatform: this.identity.platform,
      files: sess.fileMetas,
      totalSize: sess.totalBytes,
    });
  }

  /**
   * Must be called directly inside the user's Save click event handler so
   * window.showDirectoryPicker / showSaveFilePicker gets the user activation gesture.
   */
  public async acceptIncomingOffer(transferId: string): Promise<void> {
    const offer = this.pendingOffers.get(transferId);
    if (!offer) return;

    const existingSession = this.incomingSessions.get(transferId);

    // Check if this is resuming an interrupted incoming session that already has a destSession
    if (offer.isResume && existingSession && existingSession.destSession) {
      this.pendingOffers.delete(transferId);
      this.showNextPendingOffer();

      existingSession.cancelled = false;
      this.cleanupPc(existingSession.pc, existingSession.dc);
      existingSession.pc = null;
      existingSession.dc = null;
      existingSession.pendingIce = [];
      existingSession.remoteDescSet = false;

      this.updateTransfer(transferId, {
        status: 'connecting',
        transport: 'connecting',
        errorMessage: undefined,
        canResume: false,
      });

      this.sendJson({
        type: 'transfer:accept',
        targetDeviceId: offer.fromDeviceId,
        transferId,
        resumeFrom: {
          fileIndex: existingSession.currentFileIndex,
          byteOffset: existingSession.currentFileBytes,
          partialCrc: existingSession.currentCrc,
        },
      });
      return;
    }

    // Prompt destination folder/file immediately within user gesture
    let destSession: DestinationSession;
    try {
      destSession = await createDestinationSession(
        offer.files.length,
        offer.files[0]?.name
      );
    } catch (err) {
      const domErr = err as DOMException;
      if (domErr && domErr.name === 'AbortError') {
        // User cancelled folder picker — keep offer open so they can retry Save or click Decline
        return;
      }
      throw err;
    }

    this.pendingOffers.delete(transferId);
    this.showNextPendingOffer();

    const session: IncomingSession = {
      transferId,
      peerDeviceId: offer.fromDeviceId,
      files: offer.files,
      totalBytes: offer.totalSize,
      destSession,
      currentFileIndex: 0,
      currentSink: null,
      currentCrc: initCrc32(),
      currentFileBytes: 0,
      completedBytes: 0,
      writeChain: Promise.resolve(),
      cancelled: false,
      pc: null,
      dc: null,
      pendingIce: [],
      remoteDescSet: false,
      downloads: [],
      allVerified: true,
      lastSampleTime: performance.now(),
      lastSampleBytes: 0,
      speedEma: 0,
    };

    this.incomingSessions.set(transferId, session);

    this.setTransfer({
      transferId,
      direction: 'receive',
      peerDeviceId: offer.fromDeviceId,
      peerName: offer.senderName,
      peerPlatform: offer.senderPlatform,
      files: offer.files,
      totalBytes: offer.totalSize,
      transferredBytes: 0,
      currentFileIndex: 0,
      currentFileName: offer.files[0]?.relativePath || '',
      speedBytesPerSec: 0,
      status: 'connecting',
      transport: 'connecting',
      integrityVerified: null,
    });

    this.sendJson({
      type: 'transfer:accept',
      targetDeviceId: offer.fromDeviceId,
      transferId,
      resumeFrom: {
        fileIndex: 0,
        byteOffset: 0,
        partialCrc: initCrc32(),
      },
    });
  }

  public declineIncomingOffer(transferId: string): void {
    const offer = this.pendingOffers.get(transferId);
    if (!offer) return;
    this.pendingOffers.delete(transferId);
    this.showNextPendingOffer();

    this.sendJson({
      type: 'transfer:decline',
      targetDeviceId: offer.fromDeviceId,
      transferId,
    });
  }

  public cancelTransfer(transferId: string): void {
    const out = this.outgoingSessions.get(transferId);
    if (out) {
      out.cancelled = true;
      this.cleanupPc(out.pc, out.dc);
      this.sendJson({
        type: 'transfer:cancel',
        targetDeviceId: out.peerDeviceId,
        transferId,
      });
      this.updateTransfer(transferId, {
        status: 'cancelled',
        speedBytesPerSec: 0,
        canResume: false,
      });
      return;
    }

    const inc = this.incomingSessions.get(transferId);
    if (inc) {
      inc.cancelled = true;
      this.cleanupPc(inc.pc, inc.dc);
      inc.writeChain = inc.writeChain.then(async () => {
        if (inc.currentSink) {
          await inc.currentSink.abort();
          inc.currentSink = null;
        }
        if (inc.destSession?.cleanup) {
          await inc.destSession.cleanup();
        }
      });
      this.sendJson({
        type: 'transfer:cancel',
        targetDeviceId: inc.peerDeviceId,
        transferId,
      });
      this.updateTransfer(transferId, {
        status: 'cancelled',
        speedBytesPerSec: 0,
        canResume: false,
      });
    }
  }

  public dismissTransfer(transferId: string): void {
    const tr = this.transfers.get(transferId);
    if (tr?.downloads) {
      for (const d of tr.downloads) {
        if (d.blobUrl) URL.revokeObjectURL(d.blobUrl);
      }
    }
    this.transfers.delete(transferId);
    this.outgoingSessions.delete(transferId);
    this.incomingSessions.delete(transferId);
    this.emitTransfers();
  }

  private showNextPendingOffer(): void {
    const next = this.pendingOffers.values().next().value as IncomingOffer | undefined;
    this.callbacks.onIncomingOffer(next ?? null);
  }

  private setTransfer(transfer: ActiveTransfer): void {
    this.transfers.set(transfer.transferId, transfer);
    this.emitTransfers();
  }

  private updateTransfer(transferId: string, patch: Partial<ActiveTransfer>): void {
    const cur = this.transfers.get(transferId);
    if (!cur) return;
    this.transfers.set(transferId, { ...cur, ...patch });
    this.emitTransfers();
  }

  private emitTransfers(): void {
    this.callbacks.onTransfersChange(Array.from(this.transfers.values()).reverse());
  }

  private handleSignalJson(rawText: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(rawText);
    } catch {
      return;
    }

    const type = typeof msg.type === 'string' ? msg.type : '';

    switch (type) {
      case 'registered': {
        const onlinePeers = Array.isArray(msg.onlinePeers)
          ? (msg.onlinePeers as Array<{ deviceId: string; name: string; platform: PlatformType }>)
          : [];
        const onlineMap = new Map(onlinePeers.map((p) => [p.deviceId, p]));
        this.pairedDevices = this.pairedDevices.map((d) => {
          const live = onlineMap.get(d.deviceId);
          return live
            ? { ...d, name: live.name, platform: live.platform, online: true }
            : { ...d, online: false };
        });
        this.callbacks.onPairedDevicesChange([...this.pairedDevices]);
        if (this.pendingPairCreate) {
          this.pendingPairCreate = false;
          this.sendJson({ type: 'pair:create' });
        }
        break;
      }

      case 'peer:status': {
        const deviceId = String(msg.deviceId || '');
        const online = Boolean(msg.online);
        const name = typeof msg.name === 'string' ? msg.name : undefined;
        const platform = msg.platform as PlatformType | undefined;

        let changed = false;
        this.pairedDevices = this.pairedDevices.map((d) => {
          if (d.deviceId !== deviceId) return d;
          changed = true;
          return {
            ...d,
            online,
            name: name ?? d.name,
            platform: platform ?? d.platform,
          };
        });
        if (changed) {
          this.callbacks.onPairedDevicesChange([...this.pairedDevices]);
        }

        // If a peer went offline mid-transfer, mark resumable if on relay
        if (!online) {
          for (const [tid, out] of this.outgoingSessions.entries()) {
            if (out.peerDeviceId === deviceId && !out.cancelled) {
              const tr = this.transfers.get(tid);
              if (tr && (tr.status === 'waiting-approval' || tr.status === 'connecting')) {
                this.updateTransfer(tid, {
                  status: 'interrupted',
                  canResume: true,
                  speedBytesPerSec: 0,
                  errorMessage: 'Recipient went offline.',
                });
              }
            }
          }
        }
        break;
      }

      case 'pair:code': {
        this.callbacks.onPairingCode(String(msg.code || ''), Number(msg.expiresAt || 0));
        break;
      }

      case 'pair:expired': {
        this.callbacks.onPairingExpired();
        break;
      }

      case 'pair:error': {
        this.callbacks.onPairingError(String(msg.message || 'Pairing failed.'));
        break;
      }

      case 'pair:success': {
        const peerRaw = msg.peer as { deviceId: string; name: string; platform: PlatformType; online: boolean };
        if (!peerRaw?.deviceId) break;
        const peer: PairedDevice = {
          deviceId: peerRaw.deviceId,
          name: peerRaw.name,
          platform: peerRaw.platform,
          online: true,
          addedAt: Date.now(),
        };
        const exists = this.pairedDevices.some((d) => d.deviceId === peer.deviceId);
        this.pairedDevices = exists
          ? this.pairedDevices.map((d) => (d.deviceId === peer.deviceId ? peer : d))
          : [peer, ...this.pairedDevices];
        this.callbacks.onPairedDevicesChange([...this.pairedDevices]);
        this.callbacks.onPairingSuccess(peer);
        break;
      }

      case 'pair:removed': {
        const removedId = String(msg.deviceId || '');
        this.pairedDevices = this.pairedDevices.filter((d) => d.deviceId !== removedId);
        this.callbacks.onPairedDevicesChange([...this.pairedDevices]);
        break;
      }

      case 'transfer:offer':
      case 'transfer:resume-offer': {
        const transferId = String(msg.transferId || '');
        const fromDeviceId = String(msg.fromDeviceId || '');
        if (!transferId || !fromDeviceId) break;

        const offer: IncomingOffer = {
          transferId,
          fromDeviceId,
          senderName: String(msg.senderName || 'Paired Device'),
          senderPlatform: (msg.senderPlatform as PlatformType) || 'Other',
          files: Array.isArray(msg.files) ? (msg.files as TransferFileMeta[]) : [],
          totalSize: Number(msg.totalSize || 0),
          isResume: type === 'transfer:resume-offer',
        };
        this.pendingOffers.set(transferId, offer);
        this.showNextPendingOffer();
        break;
      }

      case 'transfer:accept': {
        const transferId = String(msg.transferId || '');
        const resumeFrom = (msg.resumeFrom as { fileIndex: number; byteOffset: number }) || {
          fileIndex: 0,
          byteOffset: 0,
        };
        void this.handleTransferAccepted(transferId, resumeFrom.fileIndex || 0, resumeFrom.byteOffset || 0);
        break;
      }

      case 'transfer:decline': {
        const transferId = String(msg.transferId || '');
        const out = this.outgoingSessions.get(transferId);
        if (out) {
          out.cancelled = true;
          this.cleanupPc(out.pc, out.dc);
          this.updateTransfer(transferId, {
            status: 'declined',
            speedBytesPerSec: 0,
            errorMessage: 'Transfer was declined by the recipient.',
          });
        }
        break;
      }

      case 'transfer:peer-offline': {
        const transferId = String(msg.transferId || '');
        const out = this.outgoingSessions.get(transferId);
        if (out) {
          this.updateTransfer(transferId, {
            status: 'interrupted',
            canResume: true,
            speedBytesPerSec: 0,
            errorMessage: 'Recipient is offline. You can resume when they reconnect.',
          });
        }
        break;
      }

      case 'transfer:cancel': {
        const transferId = String(msg.transferId || '');
        if (this.pendingOffers.has(transferId)) {
          this.pendingOffers.delete(transferId);
          this.showNextPendingOffer();
        }
        const out = this.outgoingSessions.get(transferId);
        if (out) {
          out.cancelled = true;
          this.cleanupPc(out.pc, out.dc);
          this.updateTransfer(transferId, {
            status: 'cancelled',
            speedBytesPerSec: 0,
            canResume: false,
          });
        }
        const inc = this.incomingSessions.get(transferId);
        if (inc) {
          inc.cancelled = true;
          this.cleanupPc(inc.pc, inc.dc);
          inc.writeChain = inc.writeChain.then(async () => {
            if (inc.currentSink) {
              await inc.currentSink.abort();
              inc.currentSink = null;
            }
          });
          this.updateTransfer(transferId, {
            status: 'cancelled',
            speedBytesPerSec: 0,
            canResume: false,
          });
        }
        break;
      }

      case 'rtc:offer': {
        void this.handleRtcOffer(msg);
        break;
      }

      case 'rtc:answer': {
        void this.handleRtcAnswer(msg);
        break;
      }

      case 'rtc:ice-candidate': {
        void this.handleRtcIceCandidate(msg);
        break;
      }

      case 'transfer:file-complete': {
        const transferId = String(msg.transferId || '');
        const fileIndex = Number(msg.fileIndex);
        const expectedCrc32 = Number(msg.expectedCrc32);
        this.enqueueFileComplete(transferId, fileIndex, expectedCrc32);
        break;
      }

      case 'transfer:complete': {
        const transferId = String(msg.transferId || '');
        this.enqueueTransferComplete(transferId);
        break;
      }
    }
  }

  private async handleTransferAccepted(
    transferId: string,
    startFileIndex: number,
    startByteOffset: number
  ): Promise<void> {
    const sess = this.outgoingSessions.get(transferId);
    if (!sess || sess.cancelled) return;

    this.updateTransfer(transferId, {
      status: 'connecting',
      transport: 'connecting',
    });

    const connectedViaP2P = await this.negotiateSenderWebRTC(sess);
    if (sess.cancelled) return;

    if (connectedViaP2P && sess.dc && sess.dc.readyState === 'open') {
      sess.useRelay = false;
      this.updateTransfer(transferId, {
        status: 'transferring',
        transport: 'webrtc',
      });
    } else {
      // Seamless automatic fallback to zero-storage WebSocket relay
      this.cleanupPc(sess.pc, sess.dc);
      sess.pc = null;
      sess.dc = null;
      sess.useRelay = true;
      this.updateTransfer(transferId, {
        status: 'transferring',
        transport: 'relay',
      });
    }

    await this.streamFiles(sess, startFileIndex, startByteOffset);
  }

  private negotiateSenderWebRTC(sess: OutgoingSession): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(ok);
      };

      const timeoutId = setTimeout(() => {
        finish(false);
      }, P2P_CONNECT_TIMEOUT_MS);

      try {
        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        sess.pc = pc;

        const dc = pc.createDataChannel('versend-data', { ordered: true });
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = DC_LOW_WATER;
        sess.dc = dc;

        dc.onopen = () => {
          finish(true);
        };

        dc.onclose = () => {
          if (!settled) {
            finish(false);
          } else if (!sess.cancelled && !sess.useRelay) {
            const tr = this.transfers.get(sess.transferId);
            if (tr && tr.status === 'transferring') {
              sess.paused = true;
              this.updateTransfer(sess.transferId, {
                status: 'interrupted',
                canResume: true,
                speedBytesPerSec: 0,
                errorMessage: 'Peer connection dropped. Click Resume to continue.',
              });
            }
          }
        };

        dc.onerror = () => {
          if (!settled) finish(false);
        };

        pc.onicecandidate = (ev) => {
          if (ev.candidate) {
            this.sendJson({
              type: 'rtc:ice-candidate',
              targetDeviceId: sess.peerDeviceId,
              transferId: sess.transferId,
              role: 'sender',
              candidate: ev.candidate.toJSON(),
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'failed') {
            finish(false);
          }
        };

        void (async () => {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          this.sendJson({
            type: 'rtc:offer',
            targetDeviceId: sess.peerDeviceId,
            transferId: sess.transferId,
            sdp: offer,
          });
        })().catch(() => finish(false));
      } catch {
        finish(false);
      }
    });
  }

  private async handleRtcOffer(msg: Record<string, unknown>): Promise<void> {
    const transferId = String(msg.transferId || '');
    const fromDeviceId = String(msg.fromDeviceId || '');
    const sdp = msg.sdp as RTCSessionDescriptionInit | undefined;
    const sess = this.incomingSessions.get(transferId);
    if (!sess || sess.cancelled || !sdp) return;

    try {
      this.cleanupPc(sess.pc, sess.dc);
      const pc = new RTCPeerConnection({ iceServers: this.iceServers });
      sess.pc = pc;
      sess.remoteDescSet = false;

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this.sendJson({
            type: 'rtc:ice-candidate',
            targetDeviceId: fromDeviceId,
            transferId,
            role: 'receiver',
            candidate: ev.candidate.toJSON(),
          });
        }
      };

      pc.ondatachannel = (ev) => {
        const dc = ev.channel;
        dc.binaryType = 'arraybuffer';
        sess.dc = dc;

        dc.onopen = () => {
          this.updateTransfer(transferId, {
            status: 'transferring',
            transport: 'webrtc',
          });
        };

        dc.onmessage = (msgEv) => {
          if (msgEv.data instanceof ArrayBuffer) {
            const chunk = decodeDataChunk(msgEv.data);
            if (chunk) {
              this.enqueueIncomingChunk(chunk.transferId, chunk.fileIndex, chunk.byteOffset, chunk.payload);
            }
          }
        };

        dc.onclose = () => {
          const tr = this.transfers.get(transferId);
          if (tr && tr.status === 'transferring' && !sess.cancelled) {
            this.updateTransfer(transferId, {
              status: 'interrupted',
              canResume: true,
              speedBytesPerSec: 0,
              errorMessage: 'Connection interrupted. Waiting for sender to resume.',
            });
          }
        };
      };

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      sess.remoteDescSet = true;
      for (const cand of sess.pendingIce) {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      }
      sess.pendingIce = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.sendJson({
        type: 'rtc:answer',
        targetDeviceId: fromDeviceId,
        transferId,
        sdp: answer,
      });
    } catch {
      // Relay fallback will take over seamlessly if WebRTC fails
    }
  }

  private async handleRtcAnswer(msg: Record<string, unknown>): Promise<void> {
    const transferId = String(msg.transferId || '');
    const sdp = msg.sdp as RTCSessionDescriptionInit | undefined;
    const sess = this.outgoingSessions.get(transferId);
    if (!sess || !sess.pc || !sdp) return;

    try {
      await sess.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      sess.remoteDescSet = true;
      for (const cand of sess.pendingIce) {
        await sess.pc.addIceCandidate(new RTCIceCandidate(cand));
      }
      sess.pendingIce = [];
    } catch {
      // ignore
    }
  }

  private async handleRtcIceCandidate(msg: Record<string, unknown>): Promise<void> {
    const transferId = String(msg.transferId || '');
    const role = String(msg.role || '');
    const candidate = msg.candidate as RTCIceCandidateInit | undefined;
    if (!candidate) return;

    const sess =
      role === 'sender'
        ? this.incomingSessions.get(transferId)
        : this.outgoingSessions.get(transferId);
    if (!sess || !sess.pc) return;

    try {
      if (sess.remoteDescSet) {
        await sess.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } else {
        sess.pendingIce.push(candidate);
      }
    } catch {
      // ignore invalid candidate
    }
  }

  private async waitForSendBufferDrain(sess: OutgoingSession): Promise<void> {
    if (!sess.useRelay && sess.dc) {
      const dc = sess.dc;
      if (dc.bufferedAmount <= DC_HIGH_WATER) return;
      await new Promise<void>((resolve) => {
        const onLow = () => {
          dc.removeEventListener('bufferedamountlow', onLow);
          clearInterval(poll);
          resolve();
        };
        const poll = setInterval(() => {
          if (sess.cancelled || sess.paused || dc.readyState !== 'open' || dc.bufferedAmount <= DC_LOW_WATER) {
            dc.removeEventListener('bufferedamountlow', onLow);
            clearInterval(poll);
            resolve();
          }
        }, 25);
        dc.addEventListener('bufferedamountlow', onLow);
      });
    } else if (this.ws) {
      const ws = this.ws;
      while (!sess.cancelled && !sess.paused && ws.readyState === WebSocket.OPEN && ws.bufferedAmount > WS_HIGH_WATER) {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }

  private async streamFiles(
    sess: OutgoingSession,
    startFileIndex: number,
    startByteOffset: number
  ): Promise<void> {
    for (let fileIdx = startFileIndex; fileIdx < sess.files.length; fileIdx++) {
      if (sess.cancelled || sess.paused) return;

      const item = sess.files[fileIdx];
      const file = item.file;
      let offset = fileIdx === startFileIndex ? startByteOffset : 0;

      // Compute CRC32 across the whole file incrementally (if resuming from offset > 0, hash prefix fast first)
      let crc = initCrc32();
      if (offset > 0) {
        let prefixPos = 0;
        while (prefixPos < offset) {
          if (sess.cancelled) return;
          const end = Math.min(prefixPos + 512 * 1024, offset);
          const buf = new Uint8Array(await file.slice(prefixPos, end).arrayBuffer());
          crc = updateCrc32(crc, buf);
          prefixPos = end;
        }
      }

      this.updateTransfer(sess.transferId, {
        currentFileIndex: fileIdx,
        currentFileName: item.relativePath,
      });

      if (file.size === 0) {
        // Send a 0-byte frame so receiver opens and creates the empty file cleanly
        const emptyFrame = encodeDataChunk(sess.transferId, fileIdx, 0, new Uint8Array(0));
        this.sendBinaryFrame(sess, emptyFrame);
      }

      while (offset < file.size) {
        if (sess.cancelled || sess.paused) return;

        if (!sess.useRelay && (!sess.dc || sess.dc.readyState !== 'open')) {
          sess.paused = true;
          this.updateTransfer(sess.transferId, {
            status: 'interrupted',
            canResume: true,
            speedBytesPerSec: 0,
            errorMessage: 'Peer connection interrupted. Ready to resume.',
          });
          return;
        }

        if (sess.useRelay && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
          sess.paused = true;
          this.updateTransfer(sess.transferId, {
            status: 'interrupted',
            canResume: true,
            speedBytesPerSec: 0,
            errorMessage: 'Relay connection interrupted. Ready to resume.',
          });
          return;
        }

        await this.waitForSendBufferDrain(sess);
        if (sess.cancelled || sess.paused) return;

        const nextEnd = Math.min(offset + CHUNK_SIZE, file.size);
        const sliceBuf = new Uint8Array(await file.slice(offset, nextEnd).arrayBuffer());
        crc = updateCrc32(crc, sliceBuf);

        const frame = encodeDataChunk(sess.transferId, fileIdx, offset, sliceBuf);
        this.sendBinaryFrame(sess, frame);

        offset = nextEnd;
        const totalSent = sess.completedBytesBeforeFile[fileIdx] + offset;

        const now = performance.now();
        const elapsedMs = now - sess.lastSampleTime;
        if (elapsedMs >= 300 || totalSent === sess.totalBytes) {
          const deltaBytes = totalSent - sess.lastSampleBytes;
          const instantSpeed = elapsedMs > 0 ? (deltaBytes / elapsedMs) * 1000 : 0;
          sess.speedEma = sess.speedEma === 0 ? instantSpeed : sess.speedEma * 0.65 + instantSpeed * 0.35;
          sess.lastSampleTime = now;
          sess.lastSampleBytes = totalSent;

          this.updateTransfer(sess.transferId, {
            transferredBytes: totalSent,
            speedBytesPerSec: Math.round(sess.speedEma),
          });
        }
      }

      const expectedCrc32 = finalizeCrc32(crc);
      this.sendJson({
        type: 'transfer:file-complete',
        targetDeviceId: sess.peerDeviceId,
        transferId: sess.transferId,
        fileIndex: fileIdx,
        expectedCrc32,
      });
    }

    if (sess.cancelled || sess.paused) return;

    this.sendJson({
      type: 'transfer:complete',
      targetDeviceId: sess.peerDeviceId,
      transferId: sess.transferId,
    });

    this.updateTransfer(sess.transferId, {
      transferredBytes: sess.totalBytes,
      speedBytesPerSec: 0,
      status: 'completed',
      integrityVerified: true,
      canResume: false,
    });
    this.cleanupPc(sess.pc, sess.dc);
    sess.pc = null;
    sess.dc = null;
  }

  private sendBinaryFrame(sess: OutgoingSession, frame: Uint8Array): void {
    if (!sess.useRelay && sess.dc && sess.dc.readyState === 'open') {
      sess.dc.send(frame as unknown as ArrayBuffer);
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const relayPacket = encodeRelayPacket(sess.peerDeviceId, frame);
      this.ws.send(relayPacket as unknown as ArrayBuffer);
    }
  }

  private handleRelayBinary(raw: ArrayBuffer): void {
    const decoded = decodeRelayPacket(raw);
    if (!decoded) return;
    const { chunk } = decoded;

    const sess = this.incomingSessions.get(chunk.transferId);
    if (sess && !sess.cancelled) {
      const tr = this.transfers.get(chunk.transferId);
      if (tr && (tr.status === 'connecting' || tr.transport !== 'relay')) {
        this.updateTransfer(chunk.transferId, {
          status: 'transferring',
          transport: 'relay',
        });
      }
    }

    this.enqueueIncomingChunk(chunk.transferId, chunk.fileIndex, chunk.byteOffset, chunk.payload);
  }

  private enqueueIncomingChunk(
    transferId: string,
    fileIndex: number,
    byteOffset: number,
    payload: Uint8Array
  ): void {
    const sess = this.incomingSessions.get(transferId);
    if (!sess || sess.cancelled || !sess.destSession) return;

    // Copy payload view because underlying ArrayBuffer might be reused if sliced
    const chunkCopy = new Uint8Array(payload.byteLength);
    chunkCopy.set(payload);

    sess.writeChain = sess.writeChain.then(async () => {
      if (sess.cancelled || !sess.destSession) return;
      const fileMeta = sess.files[fileIndex];
      if (!fileMeta) return;

      if (!sess.currentSink || sess.currentFileIndex !== fileIndex) {
        if (sess.currentSink) {
          await sess.currentSink.close();
          sess.currentSink = null;
        }
        sess.currentFileIndex = fileIndex;
        sess.currentCrc = initCrc32();
        sess.currentFileBytes = byteOffset;
        sess.currentSink = await sess.destSession.openFile(
          fileMeta.relativePath,
          fileMeta.mimeType,
          byteOffset
        );
        this.updateTransfer(transferId, {
          currentFileIndex: fileIndex,
          currentFileName: fileMeta.relativePath,
        });
      }

      if (chunkCopy.byteLength > 0) {
        await sess.currentSink.writeChunk(byteOffset, chunkCopy);
        sess.currentCrc = updateCrc32(sess.currentCrc, chunkCopy);
        sess.currentFileBytes = byteOffset + chunkCopy.byteLength;
        sess.completedBytes += chunkCopy.byteLength;
      }

      const now = performance.now();
      const elapsedMs = now - sess.lastSampleTime;
      if (elapsedMs >= 250 || sess.completedBytes >= sess.totalBytes) {
        const delta = sess.completedBytes - sess.lastSampleBytes;
        const instantSpeed = elapsedMs > 0 ? (delta / elapsedMs) * 1000 : 0;
        sess.speedEma = sess.speedEma === 0 ? instantSpeed : sess.speedEma * 0.65 + instantSpeed * 0.35;
        sess.lastSampleTime = now;
        sess.lastSampleBytes = sess.completedBytes;

        this.updateTransfer(transferId, {
          transferredBytes: Math.min(sess.completedBytes, sess.totalBytes),
          speedBytesPerSec: Math.round(sess.speedEma),
        });
      }
    });
  }

  private enqueueFileComplete(transferId: string, fileIndex: number, expectedCrc32: number): void {
    const sess = this.incomingSessions.get(transferId);
    if (!sess || sess.cancelled) return;

    sess.writeChain = sess.writeChain.then(async () => {
      if (sess.cancelled || !sess.destSession) return;
      const fileMeta = sess.files[fileIndex];
      if (!fileMeta) return;

      if (!sess.currentSink) {
        sess.currentSink = await sess.destSession.openFile(fileMeta.relativePath, fileMeta.mimeType, 0);
        sess.currentCrc = initCrc32();
      }

      const actualCrc = finalizeCrc32(sess.currentCrc);
      const verified = actualCrc === (expectedCrc32 >>> 0);
      if (!verified) {
        sess.allVerified = false;
      }

      const closed = await sess.currentSink.close();
      sess.currentSink = null;

      sess.downloads.push({
        fileIndex,
        name: fileMeta.name,
        relativePath: fileMeta.relativePath,
        size: fileMeta.size,
        verified,
        blobUrl: closed.blobUrl,
        savedDirectly: closed.savedDirectly,
      });
    });
  }

  private enqueueTransferComplete(transferId: string): void {
    const sess = this.incomingSessions.get(transferId);
    if (!sess || sess.cancelled) return;

    sess.writeChain = sess.writeChain.then(async () => {
      if (sess.cancelled) return;
      if (sess.currentSink) {
        await sess.currentSink.close();
        sess.currentSink = null;
      }
      this.cleanupPc(sess.pc, sess.dc);
      sess.pc = null;
      sess.dc = null;

      this.updateTransfer(transferId, {
        transferredBytes: sess.totalBytes,
        speedBytesPerSec: 0,
        status: 'completed',
        integrityVerified: sess.allVerified,
        downloads: [...sess.downloads],
        canResume: false,
      });
    });
  }

  private cleanupPc(pc: RTCPeerConnection | null, dc: RTCDataChannel | null): void {
    if (dc) {
      try {
        dc.onopen = null;
        dc.onclose = null;
        dc.onmessage = null;
        dc.onerror = null;
        dc.close();
      } catch {
        // ignore
      }
    }
    if (pc) {
      try {
        pc.onicecandidate = null;
        pc.ondatachannel = null;
        pc.oniceconnectionstatechange = null;
        pc.close();
      } catch {
        // ignore
      }
    }
  }
}
