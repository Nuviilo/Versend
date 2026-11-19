import { Laptop, Smartphone } from 'lucide-react';
import type { PlatformType } from '../types/versend';

export function VersendLogo({ className = 'w-7 h-7' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect width="32" height="32" rx="8" className="fill-blue-600 dark:fill-blue-500" />
      <path
        d="M9.5 12.5H20.5M20.5 12.5L17 9M20.5 12.5L17 16"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22.5 19.5H11.5M11.5 19.5L15 16M11.5 19.5L15 23"
        stroke="white"
        strokeOpacity="0.82"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PlatformIcon({
  platform,
  className = 'w-5 h-5',
}: {
  platform: PlatformType;
  className?: string;
}) {
  if (platform === 'Windows') {
    return (
      <svg
        viewBox="0 0 20 20"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        aria-hidden="true"
      >
        <path d="M2.5 3.6L9.2 2.7V9.3H2.5V3.6ZM10.4 2.5L17.5 1.5V9.3H10.4V2.5ZM2.5 10.5H9.2V17.2L2.5 16.3V10.5ZM10.4 10.5H17.5V18.5L10.4 17.4V10.5Z" />
      </svg>
    );
  }
  if (platform === 'Android') {
    return <Smartphone className={className} strokeWidth={1.75} aria-hidden="true" />;
  }
  return <Laptop className={className} strokeWidth={1.75} aria-hidden="true" />;
}
