export type PlatformType = 'Windows' | 'Android' | 'Other';

export interface DeviceIdentity {
  deviceId: string;
  name: string;
  platform: PlatformType;
}

export interface PairedDevice {
  deviceId: string;
  name: string;
  platform: PlatformType;
  online: boolean;
  addedAt: number;
}

export interface QueuedFileItem {
  id: string;
  file: File;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
}

export interface TransferFileMeta {
  fileIndex: number;
  name: string;
  relativePath: string;
  size: number;
  mimeType: string;
}

export type TransferTransport = 'connecting' | 'webrtc' | 'relay';

export type TransferStatus =
  | 'waiting-approval'
  | 'connecting'
  | 'transferring'
  | 'interrupted'
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'error';

export interface ReceivedFileDownload {
  fileIndex: number;
  name: string;
  relativePath: string;
  size: number;
  verified: boolean;
  blobUrl?: string;
  savedDirectly: boolean;
}

export interface ActiveTransfer {
  transferId: string;
  direction: 'send' | 'receive';
  peerDeviceId: string;
  peerName: string;
  peerPlatform: PlatformType;
  files: TransferFileMeta[];
  totalBytes: number;
  transferredBytes: number;
  currentFileIndex: number;
  currentFileName: string;
  speedBytesPerSec: number;
  status: TransferStatus;
  transport: TransferTransport;
  integrityVerified: boolean | null;
  errorMessage?: string;
  canResume?: boolean;
  downloads?: ReceivedFileDownload[];
}

export interface IncomingOffer {
  transferId: string;
  fromDeviceId: string;
  senderName: string;
  senderPlatform: PlatformType;
  files: TransferFileMeta[];
  totalSize: number;
  isResume?: boolean;
}
