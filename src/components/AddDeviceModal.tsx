import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { Camera, Check, Copy, RefreshCw, X } from 'lucide-react';
import { getServerOrigin } from '../lib/serverUrl';

interface AddDeviceModalProps {
  open: boolean;
  wsConnected: boolean;
  serverUrl: string;
  code: string;
  expiresAt: number;
  error: string | null;
  onClose: () => void;
  onRequestNewCode: () => void;
  onRedeemCode: (code: string) => void;
  onClearError: () => void;
  onUpdateServerUrl: (url: string) => void;
}

function extractPairCode(rawText: string): string {
  const trimmed = rawText.trim();
  try {
    const url = new URL(trimmed);
    const param = url.searchParams.get('pair');
    if (param) return param.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  } catch {
    // Not a URL, fall back to alphanumeric check
  }
  return trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function AddDeviceModal({
  open,
  wsConnected,
  serverUrl,
  code,
  expiresAt,
  error,
  onClose,
  onRequestNewCode,
  onRedeemCode,
  onClearError,
  onUpdateServerUrl,
}: AddDeviceModalProps) {
  const [tab, setTab] = useState<'show' | 'connect'>('show');
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [secondsLeft, setSecondsLeft] = useState<number>(180);
  const [copied, setCopied] = useState(false);
  const [inputCode, setInputCode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [editingServer, setEditingServer] = useState(false);
  const [draftServer, setDraftServer] = useState(serverUrl);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stopScanner = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setScanning(false);
  }, []);

  useEffect(() => {
    if (!open) {
      stopScanner();
      setInputCode('');
      setCameraError(null);
      setEditingServer(false);
      onClearError();
      return;
    }
    setDraftServer(serverUrl);
    if (tab === 'show' && wsConnected && !code) {
      onRequestNewCode();
    }
  }, [open, tab, wsConnected, code, serverUrl, onRequestNewCode, stopScanner, onClearError]);

  useEffect(() => {
    if (!open || !code) {
      setQrDataUrl('');
      return;
    }
    const origin = getServerOrigin();
    const pairUrl = origin ? `${origin}/?pair=${encodeURIComponent(code)}` : code;
    QRCode.toDataURL(pairUrl, {
      width: 240,
      margin: 2,
      color: {
        dark: '#111827',
        light: '#FFFFFF',
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [open, code]);

  useEffect(() => {
    if (!open || !expiresAt) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setSecondsLeft(remaining);
      if (remaining === 0) {
        onRequestNewCode();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [open, expiresAt, onRequestNewCode]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const startScanner = async () => {
    setCameraError(null);
    onClearError();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('Camera access is not supported in this browser.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      streamRef.current = stream;
      setScanning(true);

      requestAnimationFrame(() => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        void videoRef.current.play();

        const scanLoop = () => {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (!video || !canvas || !streamRef.current) return;

          if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const decoded = jsQR(imgData.data, imgData.width, imgData.height, {
                inversionAttempts: 'dontInvert',
              });
              if (decoded && decoded.data) {
                const extracted = extractPairCode(decoded.data);
                if (extracted.length === 6) {
                  stopScanner();
                  setInputCode(extracted);
                  onRedeemCode(extracted);
                  return;
                }
              }
            }
          }
          rafRef.current = requestAnimationFrame(scanLoop);
        };
        rafRef.current = requestAnimationFrame(scanLoop);
      });
    } catch {
      setCameraError('Camera permission denied or unavailable. Enter the connection code manually instead.');
      stopScanner();
    }
  };

  const handleCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = extractPairCode(inputCode);
    if (cleaned.length < 6) return;
    onRedeemCode(cleaned);
  };

  if (!open) return null;

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const formattedTime = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  const formattedCode = code ? `${code.slice(0, 3)} ${code.slice(3)}` : '··· ···';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/45 backdrop-blur-[2px] p-0 sm:p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-device-title"
        className="w-full sm:max-w-md bg-white dark:bg-[#181A1E] border border-neutral-200 dark:border-[#27292E] rounded-t-2xl sm:rounded-2xl shadow-xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200 dark:border-[#27292E]">
          <h2 id="add-device-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            Add device
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="min-w-[40px] min-h-[40px] -mr-2 flex items-center justify-center rounded-lg text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-[#23262C] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 gap-1 p-1 bg-neutral-100 dark:bg-[#111214] rounded-xl border border-neutral-200/70 dark:border-[#27292E]">
            <button
              type="button"
              onClick={() => {
                stopScanner();
                onClearError();
                setTab('show');
              }}
              className={`min-h-[40px] px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                tab === 'show'
                  ? 'bg-white dark:bg-[#181A1E] text-neutral-900 dark:text-neutral-100 shadow-xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200'
              }`}
            >
              Show QR & code
            </button>
            <button
              type="button"
              onClick={() => {
                onClearError();
                setTab('connect');
              }}
              className={`min-h-[40px] px-3 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
                tab === 'connect'
                  ? 'bg-white dark:bg-[#181A1E] text-neutral-900 dark:text-neutral-100 shadow-xs'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200'
              }`}
            >
              Scan or enter code
            </button>
          </div>

          {tab === 'show' ? (
            <div className="flex flex-col items-center text-center space-y-4">
              <div className="p-3 bg-white rounded-xl border border-neutral-200">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Device pairing QR code"
                    className="w-44 h-44 block"
                  />
                ) : (
                  <div className="w-44 h-44 flex flex-col items-center justify-center px-3 text-center gap-2 text-xs text-neutral-500">
                    <span>{wsConnected ? 'Generating QR…' : 'Connecting to signaling server…'}</span>
                    {!wsConnected && (
                      <button
                        type="button"
                        onClick={() => setEditingServer((v) => !v)}
                        className="text-blue-600 font-medium hover:underline"
                      >
                        Change server URL
                      </button>
                    )}
                  </div>
                )}
              </div>

              {!wsConnected && editingServer && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    onUpdateServerUrl(draftServer);
                    setEditingServer(false);
                  }}
                  className="w-full flex items-center gap-2"
                >
                  <input
                    type="url"
                    value={draftServer}
                    onChange={(e) => setDraftServer(e.target.value)}
                    placeholder="https://your-versend-server.com"
                    className="flex-1 min-h-[38px] px-3 py-1.5 text-xs rounded-lg bg-neutral-50 dark:bg-[#111214] border border-neutral-200 dark:border-[#27292E] text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-600/30"
                  />
                  <button
                    type="submit"
                    className="min-h-[38px] px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium whitespace-nowrap"
                  >
                    Connect
                  </button>
                </form>
              )}

              <div className="space-y-1.5 w-full">
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  Scan with the other device or enter this code
                </p>
                <div className="flex items-center justify-center gap-2">
                  <span className="font-mono text-2xl font-semibold tracking-wider tabular-nums text-neutral-900 dark:text-neutral-100">
                    {formattedCode}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    aria-label="Copy connection code"
                    className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-lg text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-[#23262C] transition-colors"
                  >
                    {copied ? <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-center gap-3 pt-1 text-xs text-neutral-500 dark:text-neutral-400">
                <span className="tabular-nums">Expires in {formattedTime}</span>
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={onRequestNewCode}
                  className="inline-flex items-center gap-1 font-medium text-blue-600 dark:text-blue-400 hover:underline py-1"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>New code</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {scanning ? (
                <div className="space-y-3">
                  <div className="relative rounded-xl overflow-hidden bg-black aspect-square max-h-64 w-full border border-neutral-200 dark:border-[#27292E]">
                    <video
                      ref={videoRef}
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                    />
                    <canvas ref={canvasRef} className="hidden" />
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="w-44 h-44 border-2 border-white/80 rounded-2xl" />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={stopScanner}
                    className="w-full min-h-[44px] px-4 py-2 text-sm font-medium rounded-xl border border-neutral-200 dark:border-[#27292E] text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-[#23262C] transition-colors"
                  >
                    Stop camera
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={startScanner}
                  className="w-full min-h-[44px] flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium rounded-xl border border-neutral-200 dark:border-[#27292E] text-neutral-800 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-[#23262C] transition-colors"
                >
                  <Camera className="w-4 h-4" />
                  <span>Scan QR code with camera</span>
                </button>
              )}

              {cameraError && (
                <p className="text-xs text-amber-700 dark:text-amber-400">{cameraError}</p>
              )}

              <div className="relative flex items-center py-1">
                <div className="flex-grow border-t border-neutral-200 dark:border-[#27292E]" />
                <span className="px-3 text-xs text-neutral-400 dark:text-neutral-500">or</span>
                <div className="flex-grow border-t border-neutral-200 dark:border-[#27292E]" />
              </div>

              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <label
                    htmlFor="pair-code-input"
                    className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1.5"
                  >
                    Connection code
                  </label>
                  <input
                    id="pair-code-input"
                    type="text"
                    value={inputCode}
                    onChange={(e) => {
                      onClearError();
                      setInputCode(e.target.value.toUpperCase().replace(/[^A-Z0-9- ]/g, '').slice(0, 8));
                    }}
                    placeholder="7K4M9P"
                    autoComplete="off"
                    spellCheck={false}
                    className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-neutral-50 dark:bg-[#111214] border border-neutral-200 dark:border-[#27292E] text-center font-mono text-lg tracking-widest uppercase text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-600/30 focus:border-blue-600 dark:focus:border-blue-500"
                  />
                </div>

                {error && (
                  <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={extractPairCode(inputCode).length < 6}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-45 disabled:hover:bg-blue-600 text-white text-sm font-medium transition-colors"
                >
                  Connect
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
