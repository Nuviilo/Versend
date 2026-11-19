import { File as FileIcon, FolderOpen } from 'lucide-react';
import { formatBytes } from '../lib/deviceIdentity';
import { supportsDirectoryPicker, supportsSaveFilePicker } from '../lib/fileHelpers';
import type { IncomingOffer } from '../types/versend';
import { PlatformIcon } from './PlatformIcon';

interface IncomingOfferModalProps {
  offer: IncomingOffer | null;
  onAccept: (transferId: string) => void;
  onDecline: (transferId: string) => void;
}

export function IncomingOfferModal({ offer, onAccept, onDecline }: IncomingOfferModalProps) {
  if (!offer) return null;

  const canPickFolder = supportsDirectoryPicker();
  const canPickFile = offer.files.length === 1 && supportsSaveFilePicker();
  const hasNestedPaths = offer.files.some((f) => f.relativePath.includes('/'));

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/45 backdrop-blur-[2px] p-0 sm:p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="incoming-offer-title"
        className="w-full sm:max-w-md bg-white dark:bg-[#181A1E] border border-neutral-200 dark:border-[#27292E] rounded-t-2xl sm:rounded-2xl shadow-xl overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4 border-b border-neutral-200 dark:border-[#27292E]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
              <PlatformIcon platform={offer.senderPlatform} className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="incoming-offer-title"
                className="text-base font-semibold text-neutral-900 dark:text-neutral-100 truncate"
              >
                {offer.isResume ? 'Resume incoming transfer' : 'Incoming files'}
              </h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                From {offer.senderName} · {offer.senderPlatform}
              </p>
            </div>
          </div>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="text-neutral-600 dark:text-neutral-400">
              {offer.files.length === 1 ? '1 file' : `${offer.files.length} files`}
              {hasNestedPaths ? ' · Folder structure preserved' : ''}
            </span>
            <span className="font-mono font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
              {formatBytes(offer.totalSize)}
            </span>
          </div>

          <div className="max-h-48 overflow-y-auto divide-y divide-neutral-100 dark:divide-[#27292E] border border-neutral-200 dark:border-[#27292E] rounded-xl bg-neutral-50/60 dark:bg-[#111214]">
            {offer.files.map((file) => (
              <div
                key={file.fileIndex}
                className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {file.relativePath.includes('/') ? (
                    <FolderOpen className="w-4 h-4 text-neutral-400 shrink-0" />
                  ) : (
                    <FileIcon className="w-4 h-4 text-neutral-400 shrink-0" />
                  )}
                  <span className="truncate text-neutral-800 dark:text-neutral-200" title={file.relativePath}>
                    {file.relativePath}
                  </span>
                </div>
                <span className="font-mono text-xs tabular-nums text-neutral-500 dark:text-neutral-400 shrink-0">
                  {formatBytes(file.size)}
                </span>
              </div>
            ))}
          </div>

          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {offer.isResume
              ? 'Press Save to resume receiving into your selected destination.'
              : canPickFolder
                ? 'Press Save to choose your destination folder before download begins.'
                : canPickFile
                  ? 'Press Save to choose where to save this file.'
                  : 'Press Save to accept and save to your device Downloads.'}
          </p>

          <div className="grid grid-cols-2 gap-3 pt-1">
            <button
              type="button"
              onClick={() => onDecline(offer.transferId)}
              className="min-h-[44px] px-4 py-2.5 rounded-xl border border-neutral-200 dark:border-[#27292E] text-sm font-medium text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-[#23262C] transition-colors"
            >
              Decline
            </button>
            <button
              type="button"
              onClick={() => onAccept(offer.transferId)}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
