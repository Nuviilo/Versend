import type { DeviceIdentity, PairedDevice, PlatformType } from '../types/versend';

const IDENTITY_KEY = 'versend_device_identity';
const PAIRED_KEY = 'versend_paired_devices';
const TAB_IDENTITY_KEY = 'versend_tab_identity';
const TAB_PAIRED_KEY = 'versend_tab_paired';

export function detectPlatform(): PlatformType {
  if (typeof navigator === 'undefined') return 'Other';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android')) return 'Android';
  if (ua.includes('windows') || ua.includes('win32') || ua.includes('win64')) return 'Windows';
  return 'Other';
}

function defaultNameForPlatform(platform: PlatformType): string {
  if (platform === 'Windows') return 'Windows PC';
  if (platform === 'Android') return 'Android Phone';
  return 'My Device';
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'dev-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
}

let isSecondaryTab = false;

export function initTabLock(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof BroadcastChannel === 'undefined') {
      resolve(false);
      return;
    }

    const tabMarker = sessionStorage.getItem(TAB_IDENTITY_KEY);
    if (tabMarker) {
      isSecondaryTab = true;
      resolve(true);
      return;
    }

    const channel = new BroadcastChannel('versend_tab_presence');
    let conflict = false;
    const probeId = Math.random().toString(36).slice(2);

    const onMessage = (ev: MessageEvent) => {
      if (ev.data?.type === 'probe' && ev.data?.probeId !== probeId && !isSecondaryTab) {
        channel.postMessage({ type: 'occupied', probeId: ev.data.probeId });
      } else if (ev.data?.type === 'occupied' && ev.data?.probeId === probeId) {
        conflict = true;
      }
    };

    channel.addEventListener('message', onMessage);
    channel.postMessage({ type: 'probe', probeId });

    setTimeout(() => {
      isSecondaryTab = conflict;
      if (conflict) {
        // Keep listener closed; secondary tab uses sessionStorage identity
        channel.close();
      }
      resolve(conflict);
    }, 80);
  });
}

export function loadDeviceIdentity(): DeviceIdentity {
  const platform = detectPlatform();

  if (isSecondaryTab) {
    const rawTab = sessionStorage.getItem(TAB_IDENTITY_KEY);
    if (rawTab) {
      try {
        const parsed = JSON.parse(rawTab) as DeviceIdentity;
        if (parsed.deviceId && parsed.name) return parsed;
      } catch {
        // ignore
      }
    }
    const secondary: DeviceIdentity = {
      deviceId: createUuid(),
      name: `${defaultNameForPlatform(platform)} (2)`,
      platform,
    };
    sessionStorage.setItem(TAB_IDENTITY_KEY, JSON.stringify(secondary));
    return secondary;
  }

  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DeviceIdentity;
      if (parsed.deviceId && parsed.name) {
        return {
          deviceId: parsed.deviceId,
          name: parsed.name,
          platform: parsed.platform || platform,
        };
      }
    }
  } catch {
    // ignore
  }

  const created: DeviceIdentity = {
    deviceId: createUuid(),
    name: defaultNameForPlatform(platform),
    platform,
  };
  saveDeviceIdentity(created);
  return created;
}

export function saveDeviceIdentity(identity: DeviceIdentity): void {
  const target = isSecondaryTab ? sessionStorage : localStorage;
  const key = isSecondaryTab ? TAB_IDENTITY_KEY : IDENTITY_KEY;
  try {
    target.setItem(key, JSON.stringify(identity));
  } catch {
    // ignore
  }
}

export function loadPairedDevices(): PairedDevice[] {
  const target = isSecondaryTab ? sessionStorage : localStorage;
  const key = isSecondaryTab ? TAB_PAIRED_KEY : PAIRED_KEY;
  try {
    const raw = target.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PairedDevice[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((d) => ({ ...d, online: false }));
  } catch {
    return [];
  }
}

export function savePairedDevices(devices: PairedDevice[]): void {
  const target = isSecondaryTab ? sessionStorage : localStorage;
  const key = isSecondaryTab ? TAB_PAIRED_KEY : PAIRED_KEY;
  try {
    const sanitized = devices.map(({ deviceId, name, platform, addedAt }) => ({
      deviceId,
      name,
      platform,
      online: false,
      addedAt,
    }));
    target.setItem(key, JSON.stringify(sanitized));
  } catch {
    // ignore
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  const decimals = exp === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[exp]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}
