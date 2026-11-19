const SERVER_URL_STORAGE_KEY = 'versend_server_url';

export function isPackagedRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.protocol === 'file:' ||
    window.location.hostname === 'appassets.androidplatform.net'
  );
}

export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function getCustomServerUrl(): string {
  try {
    const saved = localStorage.getItem(SERVER_URL_STORAGE_KEY);
    return saved ? normalizeServerUrl(saved) : '';
  } catch {
    return '';
  }
}

export function setCustomServerUrl(url: string): string {
  const normalized = normalizeServerUrl(url);
  try {
    if (normalized) {
      localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
    } else {
      localStorage.removeItem(SERVER_URL_STORAGE_KEY);
    }
  } catch {
    // ignore
  }
  return normalized;
}

export function getServerOrigin(): string {
  const custom = getCustomServerUrl();
  if (custom) return custom;

  const configured = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_SERVER_URL;
  if (configured && configured.trim().length > 0) {
    return normalizeServerUrl(configured);
  }
  if (
    typeof window !== 'undefined' &&
    window.location.origin &&
    window.location.origin.startsWith('http') &&
    !isPackagedRuntime()
  ) {
    return window.location.origin;
  }
  return '';
}

export function getApiUrl(path: string): string {
  const base = getServerOrigin();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}

export function getWsUrl(): string {
  const base = getServerOrigin();
  if (base) {
    const wsBase = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
    return `${wsBase}/ws`;
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
