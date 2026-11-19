import { useCallback, useEffect, useRef, useState } from 'react';
import { MonitorSmartphone, Moon, Send as SendIcon, Sun } from 'lucide-react';
import { AddDeviceModal } from './components/AddDeviceModal';
import { DevicesView } from './components/DevicesView';
import { IncomingOfferModal } from './components/IncomingOfferModal';
import { VersendLogo } from './components/PlatformIcon';
import { SendView } from './components/SendView';
import {
  initTabLock,
  loadDeviceIdentity,
  loadPairedDevices,
  saveDeviceIdentity,
  savePairedDevices,
} from './lib/deviceIdentity';
import { VersendClient } from './lib/versendClient';
import type {
  ActiveTransfer,
  DeviceIdentity,
  IncomingOffer,
  PairedDevice,
  QueuedFileItem,
} from './types/versend';

type Section = 'devices' | 'send';

const THEME_KEY = 'versend_theme';

export default function App() {
  const [section, setSection] = useState<Section>('devices');
  const [isDark, setIsDark] = useState<boolean>(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : false
  );

  const [identity, setIdentity] = useState<DeviceIdentity>(() => loadDeviceIdentity());
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>(() => loadPairedDevices());
  const [wsConnected, setWsConnected] = useState(false);

  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<ActiveTransfer[]>([]);
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);

  const [addModalOpen, setAddModalOpen] = useState(false);
  const [pairCode, setPairCode] = useState('');
  const [pairExpiresAt, setPairExpiresAt] = useState(0);
  const [pairError, setPairError] = useState<string | null>(null);

  const clientRef = useRef<VersendClient | null>(null);
  const pendingUrlPairRef = useRef<string | null>(null);

  // Capture ?pair=CODE if opened via phone camera QR scan
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('pair');
      if (code) {
        const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        if (cleaned.length === 6) {
          pendingUrlPairRef.current = cleaned;
        }
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch {
      // ignore
    }
  }, []);

  // Initialize tab lock + WebSocket signaling client
  useEffect(() => {
    let active = true;
    let client: VersendClient | null = null;

    void initTabLock().then(() => {
      if (!active) return;
      const resolvedIdentity = loadDeviceIdentity();
      const resolvedPaired = loadPairedDevices();
      setIdentity(resolvedIdentity);
      setPairedDevices(resolvedPaired);

      client = new VersendClient(resolvedIdentity, resolvedPaired, {
        onWsConnectedChange: (connected) => {
          setWsConnected(connected);
          if (connected && pendingUrlPairRef.current) {
            const codeToRedeem = pendingUrlPairRef.current;
            pendingUrlPairRef.current = null;
            setTimeout(() => {
              client?.redeemPairingCode(codeToRedeem);
            }, 150);
          }
        },
        onPairedDevicesChange: (devices) => {
          setPairedDevices(devices);
          savePairedDevices(devices);
        },
        onPairingCode: (code, expiresAt) => {
          setPairCode(code);
          setPairExpiresAt(expiresAt);
        },
        onPairingExpired: () => {
          setPairCode('');
          setPairExpiresAt(0);
        },
        onPairingError: (message) => {
          setPairError(message);
        },
        onPairingSuccess: (peer) => {
          setAddModalOpen(false);
          setPairCode('');
          setPairExpiresAt(0);
          setPairError(null);
          setSelectedDeviceId(peer.deviceId);
        },
        onIncomingOffer: (offer) => {
          setIncomingOffer(offer);
        },
        onTransfersChange: (list) => {
          setTransfers(list);
        },
      });

      clientRef.current = client;
    });

    return () => {
      active = false;
      client?.destroy();
      clientRef.current = null;
    };
  }, []);

  // Keep selectedDeviceId valid & auto-select single online device when helpful
  useEffect(() => {
    if (selectedDeviceId) {
      const match = pairedDevices.find((d) => d.deviceId === selectedDeviceId);
      if (!match) {
        setSelectedDeviceId(null);
      }
    } else {
      const firstOnline = pairedDevices.find((d) => d.online);
      if (firstOnline) {
        setSelectedDeviceId(firstOnline.deviceId);
      }
    }
  }, [pairedDevices, selectedDeviceId]);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem(THEME_KEY, next ? 'dark' : 'light');
    } catch {
      // ignore
    }
  };

  const handleRenameDevice = (newName: string) => {
    const updated: DeviceIdentity = { ...identity, name: newName };
    setIdentity(updated);
    saveDeviceIdentity(updated);
    clientRef.current?.updateIdentity(updated);
  };

  const handleRequestNewCode = useCallback(() => {
    clientRef.current?.createPairingCode();
  }, []);

  const handleRedeemCode = useCallback((code: string) => {
    setPairError(null);
    clientRef.current?.redeemPairingCode(code);
  }, []);

  const handleClearPairError = useCallback(() => {
    setPairError(null);
  }, []);

  const handleRemoveDevice = (deviceId: string) => {
    clientRef.current?.removePairedDevice(deviceId);
    if (selectedDeviceId === deviceId) {
      setSelectedDeviceId(null);
    }
  };

  const handleSendToDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    setSection('send');
  };

  const handleSendFiles = async (device: PairedDevice, files: QueuedFileItem[]) => {
    await clientRef.current?.startTransfer(device, files);
  };

  const handleAcceptOffer = (transferId: string) => {
    void clientRef.current?.acceptIncomingOffer(transferId).then(() => {
      setSection('send');
    });
  };

  const handleDeclineOffer = (transferId: string) => {
    clientRef.current?.declineIncomingOffer(transferId);
  };

  const activeTransferCount = transfers.filter(
    (t) =>
      t.status === 'waiting-approval' ||
      t.status === 'connecting' ||
      t.status === 'transferring'
  ).length;

  return (
    <div className="min-h-screen flex flex-col md:flex-row bg-[#FAFAFA] text-[#111827] dark:bg-[#111214] dark:text-[#F3F4F6] transition-colors duration-150">
      {/* Desktop / Windows Sidebar */}
      <aside className="hidden md:flex md:flex-col md:w-60 md:shrink-0 border-r border-neutral-200 dark:border-[#27292E] bg-white dark:bg-[#15171A] px-4 py-6 justify-between sticky top-0 h-screen">
        <div className="space-y-8">
          <div className="flex items-center justify-between px-2">
            <div className="flex items-center gap-2.5">
              <VersendLogo className="w-7 h-7 shrink-0" />
              <span className="text-lg font-bold tracking-tight text-neutral-900 dark:text-neutral-100 whitespace-nowrap">
                Versend
              </span>
            </div>
          </div>

          <nav aria-label="Main navigation" className="space-y-1">
            <button
              type="button"
              onClick={() => setSection('devices')}
              className={`w-full min-h-[44px] flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap ${
                section === 'devices'
                  ? 'bg-neutral-100 dark:bg-[#23262C] text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-[#1C1E23]'
              }`}
            >
              <span className="flex items-center gap-3">
                <MonitorSmartphone className="w-4 h-4 shrink-0" />
                <span>Devices</span>
              </span>
              {pairedDevices.length > 0 && (
                <span className="font-mono text-xs tabular-nums text-neutral-400 dark:text-neutral-500">
                  {pairedDevices.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setSection('send')}
              className={`w-full min-h-[44px] flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-colors whitespace-nowrap ${
                section === 'send'
                  ? 'bg-neutral-100 dark:bg-[#23262C] text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-[#1C1E23]'
              }`}
            >
              <span className="flex items-center gap-3">
                <SendIcon className="w-4 h-4 shrink-0" />
                <span>Send</span>
              </span>
              {activeTransferCount > 0 && (
                <span className="font-mono text-xs tabular-nums text-blue-600 dark:text-blue-400 font-semibold">
                  {activeTransferCount}
                </span>
              )}
            </button>
          </nav>
        </div>

        <div className="pt-4 border-t border-neutral-200 dark:border-[#27292E] flex items-center justify-between px-2">
          <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate max-w-[140px]">
            {identity.name}
          </span>
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-[#23262C] transition-colors"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* Mobile / Android Top Bar */}
      <header className="md:hidden sticky top-0 z-30 h-13 px-4 flex items-center justify-between bg-white/90 dark:bg-[#15171A]/90 backdrop-blur-md border-b border-neutral-200 dark:border-[#27292E]">
        <div className="flex items-center gap-2.5">
          <VersendLogo className="w-6 h-6 shrink-0" />
          <span className="text-base font-bold tracking-tight text-neutral-900 dark:text-neutral-100 whitespace-nowrap">
            Versend
          </span>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          className="min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center rounded-xl text-neutral-600 dark:text-neutral-300"
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </header>

      {/* Main Content */}
      <main className="flex-1 min-w-0 pb-20 md:pb-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-8 py-6 md:py-10 space-y-6">
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100">
            {section === 'devices' ? 'Devices' : 'Send'}
          </h1>

          {section === 'devices' ? (
            <DevicesView
              identity={identity}
              pairedDevices={pairedDevices}
              wsConnected={wsConnected}
              onRenameDevice={handleRenameDevice}
              onOpenAddModal={() => setAddModalOpen(true)}
              onRemoveDevice={handleRemoveDevice}
              onSendToDevice={handleSendToDevice}
            />
          ) : (
            <SendView
              pairedDevices={pairedDevices}
              selectedDeviceId={selectedDeviceId}
              transfers={transfers}
              onSelectDevice={setSelectedDeviceId}
              onGoToDevices={() => setSection('devices')}
              onSendFiles={handleSendFiles}
              onCancelTransfer={(id) => clientRef.current?.cancelTransfer(id)}
              onResumeTransfer={(id) => clientRef.current?.resumeTransfer(id)}
              onDismissTransfer={(id) => clientRef.current?.dismissTransfer(id)}
            />
          )}
        </div>
      </main>

      {/* Mobile / Android Bottom Navigation (Exactly 2 Sections) */}
      <nav
        aria-label="Mobile navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 h-14 bg-white/95 dark:bg-[#15171A]/95 backdrop-blur-md border-t border-neutral-200 dark:border-[#27292E] grid grid-cols-2"
      >
        <button
          type="button"
          onClick={() => setSection('devices')}
          className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors ${
            section === 'devices'
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-neutral-500 dark:text-neutral-400'
          }`}
        >
          <MonitorSmartphone className="w-5 h-5" />
          <span>Devices</span>
        </button>

        <button
          type="button"
          onClick={() => setSection('send')}
          className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors relative ${
            section === 'send'
              ? 'text-blue-600 dark:text-blue-400'
              : 'text-neutral-500 dark:text-neutral-400'
          }`}
        >
          <SendIcon className="w-5 h-5" />
          <span>
            Send{activeTransferCount > 0 ? ` (${activeTransferCount})` : ''}
          </span>
        </button>
      </nav>

      {/* Add Device Modal (QR Code + Expiring Connection Code) */}
      <AddDeviceModal
        open={addModalOpen}
        code={pairCode}
        expiresAt={pairExpiresAt}
        error={pairError}
        onClose={() => setAddModalOpen(false)}
        onRequestNewCode={handleRequestNewCode}
        onRedeemCode={handleRedeemCode}
        onClearError={handleClearPairError}
      />

      {/* Incoming File Offer Modal (Explicit Save / Decline) */}
      <IncomingOfferModal
        offer={incomingOffer}
        onAccept={handleAcceptOffer}
        onDecline={handleDeclineOffer}
      />
    </div>
  );
}
