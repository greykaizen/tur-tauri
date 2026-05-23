import { DownloadItem } from "../types";

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatSpeed(speedBps: number): string {
  if (!speedBps) return "0 B/s";
  return `${formatBytes(speedBps)}/s`;
}

export function formatEta(download: DownloadItem): string {
  if (download.totalSize <= 0 || download.speedBps <= 0) {
    return "—";
  }
  const remaining = Math.max(download.totalSize - download.downloadedBytes, 0);
  const seconds = Math.max(Math.ceil(remaining / download.speedBps), 0);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export function formatRemaining(download: DownloadItem): string {
  if (download.totalSize <= 0) {
    return "—";
  }
  return formatBytes(Math.max(download.totalSize - download.downloadedBytes, 0));
}

export function formatProtocol(protocol: DownloadItem["protocol"]): string {
  switch (protocol) {
    case "http1":
      return "HTTP/1.1";
    case "http2":
      return "HTTP/2";
    case "http3":
      return "HTTP/3";
    default:
      return "Auto";
  }
}
