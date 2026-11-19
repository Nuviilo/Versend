import { useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  File as FileIcon,
  FolderPlus,
  Plus,
  RotateCcw,
  Send as SendIcon,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { formatBytes, formatSpeed } from '../lib/deviceIdentity';
import {
  extractFilesFromDataTransfer,
  extractFilesFromFileList,
  triggerBrowserDownload,
} from '../lib/fileHelpers';
import type { ActiveTransfer, PairedDevice, QueuedFileItem } from '../types/versend';
import { PlatformIcon } from './PlatformIcon';

interface SendViewProps {
  pairedDevices: PairedDevice[];
  selectedDeviceId: string | null;
  transfers: ActiveTransfer[];
  onSelectDevice: (deviceId: string) => void;
  onGoToDevices: () => void;
  onSendFiles: (device: PairedDevice, files: QueuedFileItem[]) => Promise<void>;
  onCancelTransfer: (transferId: string) => void;
  onResumeTransfer: (transferId: string) => void;
  onDismissTransfer: (transferId: string) => void;
}

export function SendView({
  pairedDevices,
  selectedDeviceId,
  transfers,
  onSelectDevice,
  onGoToDevices,
  onSendFiles,
  onCancelTransfer,
  onResumeTransfer,
  onDismissTransfer,
}: SendViewProps) {
  const [queuedFiles, setQueuedFiles] = useState<QueuedFileItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [sending, setSending] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const selectedDevice = pairedDevices.find((d) => d.deviceId === selectedDeviceId) || null;
  const totalQueueSize = queuedFiles.reduce((acc, f) => acc + f.size, 0);

  const appendItems = (incoming: QueuedFileItem[]) => {
    if (incoming.length === 0) return;
    setQueuedFiles((prev) => [...prev, ...incoming]);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const items = await extractFilesFromDataTransfer(e.dataTransfer);
    appendItems(items);
  };

  const handleSendClick = async () => {
    if (!selectedDevice || !selectedDevice.online || queuedFiles.length === 0 || sending) return;
    setSending(true);
    try {
      await onSendFiles(selectedDevice, queuedFiles);
      setQueuedFiles([]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* 1. Recipient Selection */}
      <section aria-labelledby="recipient-heading" className="space-y-3">
        <h2 id="recipient-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          Select recipient
        </h2>

        {pairedDevices.length === 0 ? (
          <div className="bg-white dark:bg-[#181A1E] border border-neutral-200 dark:border-[#27292E] rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Connect a device first before sending files.
            </p>
            <button
              type="button"
              onClick={onGoToDevices}
              className="min-h-[44px] px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0"
            >
              Go to Devices
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {pairedDevices.map((device) => {
              const isSelected = device.deviceId === selectedDeviceId;
              return (
                <button
                  key={device.deviceId}
                  type="button"
                  disabled={!device.online}
                  onClick={() => onSelectDevice(device.deviceId)}
                  className={`min-h-[68px] flex items-center gap-3.5 p-4 rounded-2xl border text-left transition-colors ${
                    !device.online
                      ? 'bg-neutral-50 dark:bg-[#15171A] border-neutral-200/70 dark:border-[#27292E] opacity-55 cursor-not-allowed'
                      : isSelected
                        ? 'bg-blue-50/60 dark:bg-blue-500/10 border-blue-600 dark:border-blue-500'
                        : 'bg-white dark:bg-[#181A1E] border-neutral-200 dark:border-[#27292E] hover:border-neutral-300 dark:hover:border-[#373A42]'
                  }`}
                >
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      isSelected && device.online
                        ? 'bg-blue-600 text-white'
                        : 'bg-neutral-100 dark:bg-[#23262C] text-neutral-700 dark:text-neutral-200'
                    }`}
                  >
                    <PlatformIcon platform={device.platform} className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                      {device.name}
                    </p>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
                      {device.platform}
                      <span aria-hidden="true"> · </span>
                      <span className={device.online ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                        {device.online ? 'Online' : 'Offline'}
                      </span>
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* 2. File & Folder Picker + Drag & Drop */}
      <section aria-labelledby="files-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="files-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Files to send
          </h2>
          {queuedFiles.length > 0 && (
            <button
              type="button"
              onClick={() => setQueuedFiles([])}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 py-1"
            >
              Clear all
            </button>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              appendItems(extractFilesFromFileList(e.target.files));
              e.target.value = '';
            }
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is standard across Chromium/WebKit/Gecko for folder selection
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              appendItems(extractFilesFromFileList(e.target.files));
              e.target.value = '';
            }
          }}
        />

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setIsDragging(false);
          }}
          onDrop={handleDrop}
          className={`rounded-2xl border transition-colors p-6 text-center ${
            isDragging
              ? 'border-blue-600 dark:border-blue-500 bg-blue-50/50 dark:bg-blue-500/10'
              : 'border-dashed border-neutral-300 dark:border-[#32353C] bg-white dark:bg-[#181A1E]'
          }`}
        >
          <div className="flex flex-col items-center space-y-3">
            <div className="w-11 h-11 rounded-xl bg-neutral-100 dark:bg-[#23262C] text-neutral-600 dark:text-neutral-300 flex items-center justify-center">
              <Upload className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                Drop files or folders here
              </p>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Any file type, no size limit, folder structure preserved
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-neutral-200 dark:border-[#27292E] bg-white dark:bg-[#181A1E] hover:bg-neutral-50 dark:hover:bg-[#23262C] text-sm font-medium text-neutral-800 dark:text-neutral-100 transition-colors whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>Add files</span>
              </button>
              <button
                type="button"
                onClick={() => folderInputRef.current?.click()}
                className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-neutral-200 dark:border-[#27292E] bg-white dark:bg-[#181A1E] hover:bg-neutral-50 dark:hover:bg-[#23262C] text-sm font-medium text-neutral-800 dark:text-neutral-100 transition-colors whitespace-nowrap"
              >
                <FolderPlus className="w-4 h-4" />
                <span>Add folder</span>
              </button>
            </div>
          </div>
        </div>

        {/* Queued Files Summary & Send CTA */}
        {queuedFiles.length > 0 && (
          <div className="bg-white dark:bg-[#181A1E] border border-neutral-200 dark:border-[#27292E] rounded-2xl overflow-hidden">
            <div className="max-h-64 overflow-y-auto divide-y divide-neutral-200 dark:divide-[#27292E]">
              {queuedFiles.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileIcon className="w-4 h-4 text-neutral-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">
                        {item.name}
                      </p>
                      {item.relativePath !== item.name && (
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                          {item.relativePath}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
                      {formatBytes(item.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQueuedFiles((prev) => prev.filter((f) => f.id !== item.id))}
                      aria-label={`Remove ${item.name}`}
                      className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-100 dark:hover:bg-[#23262C] transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3.5 bg-neutral-50 dark:bg-[#141619] border-t border-neutral-200 dark:border-[#27292E]">
              <div className="text-sm text-neutral-600 dark:text-neutral-400">
                <span className="font-medium text-neutral-900 dark:text-neutral-100 tabular-nums">
                  {queuedFiles.length} {queuedFiles.length === 1 ? 'file' : 'files'}
                </span>
                <span aria-hidden="true"> · </span>
                <span className="font-mono tabular-nums">{formatBytes(totalQueueSize)}</span>
              </div>

              <button
                type="button"
                disabled={!selectedDevice || !selectedDevice.online || sending}
                onClick={handleSendClick}
                className="min-h-[44px] inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-45 disabled:hover:bg-blue-600 text-white text-sm font-medium transition-colors whitespace-nowrap"
              >
                <SendIcon className="w-4 h-4" />
                <span>
                  {selectedDevice && selectedDevice.online
                    ? `Send to ${selectedDevice.name}`
                    : 'Select an online device'}
                </span>
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 3. Active & Recent Transfers */}
      {transfers.length > 0 && (
        <section aria-labelledby="transfers-heading" className="space-y-3">
          <h2 id="transfers-heading" className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            Transfers
          </h2>

          <div className="space-y-3">
            {transfers.map((tr) => {
              const pct =
                tr.totalBytes > 0
                  ? Math.min(100, Math.round((tr.transferredBytes / tr.totalBytes) * 100))
                  : tr.status === 'completed'
                    ? 100
                    : 0;
              const remaining = Math.max(0, tr.totalBytes - tr.transferredBytes);
              const isActive =
                tr.status === 'waiting-approval' ||
                tr.status === 'connecting' ||
                tr.status === 'transferring';

              return (
                <div
                  key={tr.transferId}
                  className="bg-white dark:bg-[#181A1E] border border-neutral-200 dark:border-[#27292E] rounded-2xl p-4 sm:p-5 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-100 truncate">
                        {tr.direction === 'send' ? `Sending to ${tr.peerName}` : `Receiving from ${tr.peerName}`}
                      </p>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
                        {tr.currentFileName || `${tr.files.length} files`}
                        <span aria-hidden="true"> · </span>
                        <span>
                          {tr.transport === 'webrtc'
                            ? 'Direct P2P'
                            : tr.transport === 'relay'
                              ? 'Secure Relay'
                              : 'Connecting'}
                        </span>
                      </p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {isActive && (
                        <button
                          type="button"
                          onClick={() => onCancelTransfer(tr.transferId)}
                          className="min-h-[36px] px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-[#27292E] text-xs font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-[#23262C] transition-colors"
                        >
                          Cancel
                        </button>
                      )}
                      {tr.status === 'interrupted' && tr.direction === 'send' && tr.canResume && (
                        <button
                          type="button"
                          onClick={() => onResumeTransfer(tr.transferId)}
                          className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>Resume</span>
                        </button>
                      )}
                      {!isActive && (
                        <button
                          type="button"
                          onClick={() => onDismissTransfer(tr.transferId)}
                          aria-label="Dismiss transfer"
                          className="min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-[#23262C] transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full h-2 rounded-full bg-neutral-100 dark:bg-[#23262C] overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-150 ${
                        tr.status === 'completed'
                          ? 'bg-emerald-600 dark:bg-emerald-500'
                          : tr.status === 'cancelled' || tr.status === 'declined' || tr.status === 'error'
                            ? 'bg-red-500'
                            : tr.status === 'interrupted'
                              ? 'bg-amber-500'
                              : 'bg-blue-600 dark:bg-blue-500'
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>

                  {/* Transfer Telemetry */}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono tabular-nums">
                      <span className="font-semibold text-neutral-900 dark:text-neutral-100">{pct}%</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(tr.transferredBytes)} sent</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatBytes(remaining)} remaining</span>
                      {tr.status === 'transferring' && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-blue-600 dark:text-blue-400 font-medium">
                            {formatSpeed(tr.speedBytesPerSec)}
                          </span>
                        </>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5">
                      {tr.status === 'waiting-approval' && (
                        <span>Waiting for {tr.peerName} to press Save…</span>
                      )}
                      {tr.status === 'connecting' && <span>Establishing connection…</span>}
                      {tr.status === 'completed' && (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium">
                          {tr.integrityVerified ? (
                            <>
                              <ShieldCheck className="w-3.5 h-3.5" />
                              <span>Completed · Verified</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Completed</span>
                            </>
                          )}
                        </span>
                      )}
                      {tr.status === 'declined' && (
                        <span className="text-red-600 dark:text-red-400">Declined</span>
                      )}
                      {tr.status === 'cancelled' && <span>Cancelled</span>}
                      {tr.status === 'interrupted' && (
                        <span className="text-amber-600 dark:text-amber-400">
                          {tr.errorMessage || 'Interrupted'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Download links when browser fallback was used */}
                  {tr.status === 'completed' &&
                    tr.direction === 'receive' &&
                    tr.downloads &&
                    tr.downloads.some((d) => !d.savedDirectly && d.blobUrl) && (
                      <div className="pt-2 border-t border-neutral-100 dark:border-[#27292E] space-y-1.5">
                        <p className="text-xs text-neutral-500 dark:text-neutral-400">
                          If your browser blocked an automatic save prompt, save individually:
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {tr.downloads
                            .filter((d) => !d.savedDirectly && d.blobUrl)
                            .map((d) => (
                              <button
                                key={d.fileIndex}
                                type="button"
                                onClick={() => triggerBrowserDownload(d.blobUrl!, d.name)}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-neutral-200 dark:border-[#27292E] text-xs font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-[#23262C]"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span className="truncate max-w-[180px]">{d.name}</span>
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
