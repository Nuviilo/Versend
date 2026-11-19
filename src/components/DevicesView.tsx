import { useState } from 'react';
import { ArrowRight, Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { DeviceIdentity, PairedDevice } from '../types/versend';
import { PlatformIcon } from './PlatformIcon';

interface DevicesViewProps {
  identity: DeviceIdentity;
  pairedDevices: PairedDevice[];
  wsConnected: boolean;
  serverUrl: string;
  onRenameDevice: (newName: string) => void;
  onUpdateServerUrl: (url: string) => void;
  onOpenAddModal: () => void;
  onRemoveDevice: (deviceId: string) => void;
  onSendToDevice: (deviceId: string) => void;
}

export function DevicesView({
  identity,
  pairedDevices,
  wsConnected,
  serverUrl,
  onRenameDevice,
  onUpdateServerUrl,
  onOpenAddModal,
  onRemoveDevice,
  onSendToDevice,
}: DevicesViewProps) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(identity.name);
  const [editingServer, setEditingServer] = useState(false);
  const [draftServer, setDraftServer] = useState(serverUrl);

  const commitName = () => {
    const trimmed = draftName.trim();
    if (trimmed) {
      onRenameDevice(trimmed);
    } else {
      setDraftName(identity.name);
    }
    setEditingName(false);
  };

  return (
    <div className="space-y-8">
      {/* Current device identity */}
      <section aria-labelledby="this-device-heading">
        <div className="bg-white dark:bg-[#181A1E] border border-neutral-200 dark:border-[#27292E] rounded-2xl p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3.5 min-w-0">
              <div className="w-11 h-11 rounded-xl bg-neutral-100 dark:bg-[#23262C] text-neutral-800 dark:text-neutral-200 flex items-center justify-center shrink-0">
                <PlatformIcon platform={identity.platform} className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p id="this-device-heading" className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  This device
                </p>
                {editingName ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      commitName();
                    }}
                    className="flex items-center gap-1.5 mt-1"
                  >
                    <input
                      type="text"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      autoFocus
                      maxLength={40}
                      className="min-h-[36px] px-2.5 py-1 text-sm font-semibold rounded-lg bg-neutral-50 dark:bg-[#111214] border border-neutral-300 dark:border-[#34373E] text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-600/30"
                    />
                    <button
                      type="submit"
                      aria-label="Save device name"
                      className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                    >
                      <Check className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDraftName(identity.name);
                        setEditingName(false);
                      }}
                      aria-label="Cancel rename"
                      className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-[#23262C] transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2 mt-0.5">
                    <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                      {identity.name}
                    </h2>
                    <button
                      type="button"
                      onClick={() => {
                        setDraftName(identity.name);
                        setEditingName(true);
                      }}
                      aria-label="Rename this device"
                      className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-[#23262C] transition-colors"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 flex flex-wrap items-center gap-x-1.5">
                  <span>{identity.platform}</span>
                  <span aria-hidden="true">·</span>
                  <span className={wsConnected ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                    {wsConnected ? 'Ready for connections' : 'Connecting…'}
                  </span>
                  {!wsConnected && (
                    <>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        onClick={() => {
                          setDraftServer(serverUrl);
                          setEditingServer((v) => !v);
                        }}
                        className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                      >
                        Change server
                      </button>
                    </>
                  )}
                </p>
                {!wsConnected && editingServer && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      onUpdateServerUrl(draftServer);
                      setEditingServer(false);
                    }}
                    className="flex flex-wrap items-center gap-2 mt-2"
                  >
                    <input
                      type="url"
                      value={draftServer}
                      onChange={(e) => setDraftServer(e.target.value)}
                      placeholder="https://your-versend-server.com"
                      className="flex-1 min-w-[200px] min-h-[36px] px-2.5 py-1 text-xs rounded-lg bg-neutral-50 dark:bg-[#111214] border border-neutral-300 dark:border-[#34373E] text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-600/30"
                    />
                    <button
                      type="submit"
                      className="min-h-[36px] px-3 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium whitespace-nowrap"
                    >
                      Save & connect
                    </button>
                  </form>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={onOpenAddModal}
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" />
              <span>Add device</span>
            </button>
          </div>
        </div>
      </section>

      {/* Connected devices list */}
      <section aria-labelledby="connected-devices-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 id="connected-devices-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Connected devices
          </h3>
          {pairedDevices.length > 0 && (
            <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums">
              {pairedDevices.filter((d) => d.online).length} of {pairedDevices.length} online
            </span>
          )}
        </div>

        {pairedDevices.length === 0 ? (
          <div className="bg-white dark:bg-[#181A1E] border border-neutral-200 dark:border-[#27292E] rounded-2xl p-8 sm:p-10 text-center space-y-3">
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              No devices connected yet
            </p>
            <p className="text-sm text-neutral-500 dark:text-neutral-400 max-w-md mx-auto">
              Pair your Windows PC or Android phone using a QR code or connection code. Devices connect directly across any network.
            </p>
            <div className="pt-2">
              <button
                type="button"
                onClick={onOpenAddModal}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-neutral-200 dark:border-[#27292E] text-sm font-medium text-neutral-800 dark:text-neutral-100 hover:bg-neutral-50 dark:hover:bg-[#23262C] transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Add a device</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white dark:bg-[#181A1E] border border-neutral-200 dark:border-[#27292E] rounded-2xl divide-y divide-neutral-200 dark:divide-[#27292E] overflow-hidden">
            {pairedDevices.map((device) => (
              <div
                key={device.deviceId}
                className="flex items-center justify-between gap-4 px-5 py-4"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="w-10 h-10 rounded-xl bg-neutral-100 dark:bg-[#23262C] text-neutral-700 dark:text-neutral-200 flex items-center justify-center shrink-0">
                    <PlatformIcon platform={device.platform} className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                      {device.name}
                    </p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 flex items-center gap-1.5">
                      <span>{device.platform}</span>
                      <span aria-hidden="true">·</span>
                      <span className="inline-flex items-center gap-1.5">
                        {device.online && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                        )}
                        <span className={device.online ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>
                          {device.online ? 'Online' : 'Offline'}
                        </span>
                      </span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {device.online && (
                    <button
                      type="button"
                      onClick={() => onSendToDevice(device.deviceId)}
                      className="min-h-[40px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors whitespace-nowrap"
                    >
                      <span>Send</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemoveDevice(device.deviceId)}
                    aria-label={`Remove ${device.name}`}
                    className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-100 dark:hover:bg-[#23262C] transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
