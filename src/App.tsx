import { useEffect, useRef, useState, useMemo, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { Store } from "@tauri-apps/plugin-store";

type DownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "stopped"
  | "completed"
  | "error";

type WorkerState =
  | "connecting"
  | "waiting_for_work"
  | "downloading"
  | "retrying"
  | "paused"
  | "stopped"
  | "finished";

type WorkerSnapshot = {
  connectionId: number;
  state: WorkerState;
  transferredBytes: number;
  speedBps: number;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  rangeCursor?: number | null;
  detail?: string | null;
};

type DownloadItem = {
  id: string;
  url: string;
  filename: string;
  directory: string;
  downloadedBytes: number;
  totalSize: number;
  speedBps: number;
  progress: number;
  status: DownloadStatus;
  protocol: "auto" | "http1" | "http2" | "http3";
  errorMessage?: string | null;
  createdAtMs: number;
  workerSnapshots: WorkerSnapshot[];
};

type ActionName = "pause" | "resume" | "cancel";

type HeaderField = {
  name: string;
  value: string;
};

type FilterMode = "all" | "active" | "completed" | "errors";

const STORE_PATH = "tur-settings.json";
const STORE_KEY_DOWNLOAD_DIR = "lastDownloadDirectory";
const DOWNLOAD_EVENT = "download-update";

// Status icons

const STATUS_ICON: Record<DownloadStatus, string> = {
  queued: "○",
  downloading: "▶",
  paused: "⏸",
  stopped: "⏹",
  completed: "✓",
  error: "✗",
};

const STATUS_LABEL: Record<DownloadStatus, string> = {
  queued: "Queued",
  downloading: "Downloading",
  paused: "Paused",
  stopped: "Stopped",
  completed: "Completed",
  error: "Failed",
};

// Helpers

function formatBytes(bytes: number): string {
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

function formatSpeed(speedBps: number): string {
  if (!speedBps) return "0 B/s";
  return `${formatBytes(speedBps)}/s`;
}

function formatEta(download: DownloadItem): string {
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

function formatRemaining(download: DownloadItem): string {
  if (download.totalSize <= 0) {
    return "—";
  }
  return formatBytes(Math.max(download.totalSize - download.downloadedBytes, 0));
}

function formatWorkerState(state: WorkerState): string {
  switch (state) {
    case "waiting_for_work":
      return "Waiting";
    default:
      return state.charAt(0).toUpperCase() + state.slice(1);
  }
}

function formatWorkerRange(worker: WorkerSnapshot): string {
  if (
    worker.rangeStart === undefined ||
    worker.rangeStart === null ||
    worker.rangeCursor === undefined ||
    worker.rangeCursor === null ||
    worker.rangeEnd === undefined ||
    worker.rangeEnd === null
  ) {
    return "—";
  }
  const mb = (value: number) => `${(value / (1024 * 1024)).toFixed(1)}MB`;
  return `${mb(worker.rangeStart)} → ${mb(worker.rangeCursor)} / ${mb(worker.rangeEnd)}`;
}

function formatProtocol(protocol: DownloadItem["protocol"]): string {
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

function parseHeaders(input: string): HeaderField[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) return [];
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (!name || !value) return [];
      return [{ name, value }];
    });
}

async function notificationPermissionGranted(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
  return granted;
}

// Status colour map

const STATUS_COLORS: Record<DownloadStatus, {
  badge: string;
  bar: string;
  accent: string;
  icon: string;
}> = {
  queued: {
    badge: "bg-stone-500/15 text-stone-300 ring-stone-500/25",
    bar: "bg-stone-500/30",
    accent: "text-stone-400",
    icon: "text-stone-400",
  },
  downloading: {
    badge: "bg-sky-500/15 text-sky-200 ring-sky-400/25",
    bar: "bg-gradient-to-r from-sky-400 via-cyan-300 to-sky-300",
    accent: "text-sky-300",
    icon: "text-sky-400",
  },
  paused: {
    badge: "bg-amber-500/15 text-amber-200 ring-amber-400/25",
    bar: "bg-amber-500/40",
    accent: "text-amber-300",
    icon: "text-amber-400",
  },
  stopped: {
    badge: "bg-amber-500/15 text-amber-200 ring-amber-400/25",
    bar: "bg-amber-500/30",
    accent: "text-amber-300",
    icon: "text-amber-400",
  },
  completed: {
    badge: "bg-emerald-500/15 text-emerald-200 ring-emerald-400/25",
    bar: "bg-emerald-500",
    accent: "text-emerald-300",
    icon: "text-emerald-400",
  },
  error: {
    badge: "bg-rose-500/15 text-rose-200 ring-rose-400/25",
    bar: "bg-rose-500/40",
    accent: "text-rose-300",
    icon: "text-rose-400",
  },
};

// App component

function App() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [urlText, setUrlText] = useState("");
  const [directory, setDirectory] = useState("");
  const [filename, setFilename] = useState("");
  const [referer, setReferer] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [cookieFile, setCookieFile] = useState("");
  const [headerLines, setHeaderLines] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [storeReady, setStoreReady] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [isTogglingAutostart, setIsTogglingAutostart] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [pendingActions, setPendingActions] = useState<Record<string, ActionName | undefined>>({});
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});
  const storeRef = useRef<Store | null>(null);
  const lastStatusRef = useRef<Record<string, DownloadStatus>>({});

  // Bootstrap

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        const store = await Store.load(STORE_PATH, {
          autoSave: 150,
          defaults: { [STORE_KEY_DOWNLOAD_DIR]: "" },
        });
        storeRef.current = store;
        const savedDir = await store.get<string>(STORE_KEY_DOWNLOAD_DIR);
        if (mounted && savedDir) {
          setDirectory(savedDir);
        }

        if (mounted) {
          setAutostartEnabled(await isAutostartEnabled());
        }

        const rows = await invoke<DownloadItem[]>("list_downloads");
        if (mounted) {
          const sorted = [...rows].sort((a, b) => b.createdAtMs - a.createdAtMs);
          setDownloads(sorted);
        }

        const unlisten = await listen<DownloadItem>(DOWNLOAD_EVENT, (event) => {
          const next = event.payload;
          setDownloads((current) => {
            const previous = current.find((item) => item.id === next.id);
            if (
              previous &&
              previous.status !== next.status &&
              (next.status === "completed" || next.status === "error")
            ) {
              void notifyStatusChange(next);
            }
            if (!previous && (next.status === "completed" || next.status === "error")) {
              void notifyStatusChange(next);
            }
            const merged = [next, ...current.filter((item) => item.id !== next.id)];
            return merged.sort((a, b) => b.createdAtMs - a.createdAtMs);
          });
          lastStatusRef.current[next.id] = next.status;
        });

        if (mounted) {
          setStoreReady(true);
        }

        return () => {
          mounted = false;
          void unlisten();
        };
      } catch (error) {
        if (mounted) {
          setPageError(error instanceof Error ? error.message : String(error));
        }
      }
    };

    let cleanup: (() => void) | undefined;
    void bootstrap().then((dispose) => {
      cleanup = dispose;
    });

    return () => {
      mounted = false;
      cleanup?.();
    };
  }, []);

  // Derived data

  const stats = useMemo(() => {
    let active = 0;
    let paused = 0;
    let completed = 0;
    let failed = 0;
    for (const d of downloads) {
      if (d.status === "downloading" || d.status === "queued") active++;
      else if (d.status === "paused" || d.status === "stopped") paused++;
      else if (d.status === "completed") completed++;
      else if (d.status === "error") failed++;
    }
    return { active, paused, completed, failed, total: downloads.length };
  }, [downloads]);


  const filteredDownloads = useMemo(() => {
    switch (filterMode) {
      case "active":
        return downloads.filter((d) => d.status === "downloading" || d.status === "queued");
      case "completed":
        return downloads.filter((d) => d.status === "completed");
      case "errors":
        return downloads.filter((d) => d.status === "error");
      default:
        return downloads;
    }
  }, [downloads, filterMode]);

  const filterCounts = useMemo(() => {
    return {
      all: downloads.length,
      active: stats.active,
      completed: stats.completed,
      errors: stats.failed,
    };
  }, [downloads.length, stats]);

  // Handlers

  async function persistDirectory(nextDirectory: string) {
    if (!storeRef.current) return;
    await storeRef.current.set(STORE_KEY_DOWNLOAD_DIR, nextDirectory);
  }

  async function handlePickDirectory() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose a download folder",
      defaultPath: directory || undefined,
    });
    if (typeof selected === "string" && selected.length > 0) {
      setDirectory(selected);
      if (storeReady) {
        await persistDirectory(selected);
      }
    }
  }

  async function handlePickCookieFile() {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Select a cookie file",
      defaultPath: cookieFile || undefined,
    });
    if (typeof selected === "string" && selected.length > 0) {
      setCookieFile(selected);
    }
  }

  async function handleImportLinksFile() {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Choose a file containing download links",
      defaultPath: directory || undefined,
    });
    if (typeof selected !== "string" || !selected.length) {
      return;
    }
    try {
      const links = await invoke<string[]>("import_download_links", { path: selected });
      if (links.length === 0) {
        setPageError("The selected file did not contain any usable links.");
        return;
      }
      setUrlText((current) => {
        const existing = current
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean);
        return [...new Set([...existing, ...links])].join("\n");
      });
      setPageError(null);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleAutostartToggle() {
    setIsTogglingAutostart(true);
    setPageError(null);
    try {
      if (autostartEnabled) {
        await disableAutostart();
        setAutostartEnabled(false);
      } else {
        await enableAutostart();
        setAutostartEnabled(true);
      }
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsTogglingAutostart(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const urls = urlText
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      setPageError("Enter at least one direct download URL first.");
      return;
    }
    if (!directory.trim()) {
      setPageError("Pick a destination folder before starting the download.");
      return;
    }

    setIsSubmitting(true);
    setPageError(null);

    try {
      const rows = await invoke<DownloadItem[]>("start_download", {
        input: {
          urls,
          directory: directory.trim(),
          filename: filename.trim() || null,
          referer: referer.trim() || null,
          bearerToken: bearerToken.trim() || null,
          cookieFile: cookieFile.trim() || null,
          headers: parseHeaders(headerLines),
        },
      });

      setDownloads((current) => {
        const nextMap = new Map(current.map((item) => [item.id, item]));
        for (const row of rows) {
          nextMap.set(row.id, row);
        }
        return [...nextMap.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
      });
      await persistDirectory(directory.trim());
      setUrlText("");
      setFilename("");
      setReferer("");
      setBearerToken("");
      setCookieFile("");
      setHeaderLines("");
      setShowAdvanced(false);
      setFilterMode("all");
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleAction(action: ActionName, id: string) {
    setPageError(null);
    setPendingActions((current) => ({ ...current, [id]: action }));
    try {
      await invoke(`${action}_download`, { id });
      setDownloads((current) =>
        current.map((item) => {
          if (item.id !== id) return item;
          if (action === "pause") {
            return { ...item, status: "paused", speedBps: 0 };
          }
          if (action === "resume") {
            return { ...item, status: "queued" };
          }
          return { ...item, status: "stopped", speedBps: 0 };
        }),
      );
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingActions((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  }

  async function handleRetry(download: DownloadItem) {
    setPageError(null);
    try {
      const rows = await invoke<DownloadItem[]>("start_download", {
        input: {
          urls: [download.url],
          directory: download.directory,
          filename: download.filename || null,
          referer: null,
          bearerToken: null,
          cookieFile: null,
          headers: [],
        },
      });
      setDownloads((current) => {
        const nextMap = new Map(current.map((item) => [item.id, item]));
        for (const row of rows) {
          nextMap.set(row.id, row);
        }
        return [...nextMap.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
      });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  }

  function toggleRowExpansion(id: string) {
    setExpandedRows((current) => ({ ...current, [id]: !current[id] }));
  }

  // Notify helper

  async function notifyStatusChange(download: DownloadItem) {
    const prior = lastStatusRef.current[download.id];
    if (prior === download.status) return;
    lastStatusRef.current[download.id] = download.status;

    if (!(await notificationPermissionGranted())) return;

    if (download.status === "completed") {
      await sendNotification({
        title: "Download complete",
        body: `${download.filename} finished successfully.`,
      });
    } else if (download.status === "error") {
      await sendNotification({
        title: "Download failed",
        body: download.errorMessage ?? `${download.filename} failed.`,
      });
    }
  }

  // Render

  return (
    <main className="min-h-screen px-5 py-6 text-stone-100 lg:px-8 lg:py-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        {/* Header */}
        <header className="flex flex-col gap-5 rounded-[1.75rem] border border-white/10 bg-white/5 p-6 shadow-[0_25px_90px_rgba(0,0,0,0.35)] backdrop-blur lg:p-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="space-y-2">
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-orange-300/15 bg-orange-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-orange-100">
                Tur Desktop
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-white md:text-4xl">
                Downloads
                <span className="ml-2 text-stone-500">/&thinsp;tur-rs</span>
              </h1>
            </div>

            {/* Stats dashboard */}
            <div className="grid grid-cols-4 gap-2 md:gap-3">
              <StatCard label="Active" value={String(stats.active)} accent={stats.active > 0 ? "text-sky-300" : "text-stone-400"} />
              <StatCard label="Paused" value={String(stats.paused)} accent={stats.paused > 0 ? "text-amber-300" : "text-stone-400"} />
              <StatCard label="Done" value={String(stats.completed)} accent={stats.completed > 0 ? "text-emerald-300" : "text-stone-400"} />
              <StatCard label="Failed" value={String(stats.failed)} accent={stats.failed > 0 ? "text-rose-300" : "text-stone-400"} />
            </div>
          </div>

          {/* Utility bar */}
          <div className="flex flex-wrap items-center gap-3 border-t border-white/8 pt-4">
            <button
              type="button"
              onClick={handleAutostartToggle}
              disabled={isTogglingAutostart}
              className="rounded-full border border-white/12 bg-black/20 px-3.5 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-white transition hover:border-orange-300/35 hover:bg-orange-500/10 disabled:opacity-50"
            >
              {autostartEnabled ? "⏻ Autostart on" : "Autostart off"}
            </button>
            <span className="text-[11px] uppercase tracking-[0.16em] text-stone-500">
              Single-instance &middot; {downloads.length} task{downloads.length !== 1 ? "s" : ""}
            </span>
          </div>
        </header>

        {/* Two-column layout */}
        <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          {/* Left: Add form */}
          <form
            onSubmit={handleSubmit}
            className="flex h-fit flex-col rounded-[1.75rem] border border-white/10 bg-stone-950/65 p-6 shadow-[0_25px_60px_rgba(0,0,0,0.28)]"
          >
            <div className="space-y-1">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-orange-200/85">
                New transfer
              </p>
              <h2 className="text-2xl font-semibold text-white">Add a download</h2>
            </div>

            <div className="mt-6 space-y-5">
              <Field label="Download URLs">
                <textarea
                  value={urlText}
                  onChange={(event) => setUrlText(event.currentTarget.value)}
                  placeholder={"https://example.com/file.zip\nhttps://example.com/file-2.iso"}
                  rows={4}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleImportLinksFile}
                    className="rounded-xl border border-white/12 bg-white/8 px-3.5 py-2 text-xs font-medium text-white transition hover:border-orange-300/40 hover:bg-orange-400/12"
                  >
                    📂 Import link list
                  </button>
                  <span className="text-[11px] uppercase tracking-[0.15em] text-stone-500">
                    One per line
                  </span>
                </div>
              </Field>

              <Field label="Destination folder">
                <div className="flex gap-2">
                  <input
                    value={directory}
                    onChange={(event) => setDirectory(event.currentTarget.value)}
                    placeholder="/home/kaizen/Downloads"
                    className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                  />
                  <button
                    type="button"
                    onClick={handlePickDirectory}
                    className="rounded-xl border border-white/12 bg-white/8 px-4 py-3 text-sm font-medium text-white transition hover:border-orange-300/40 hover:bg-orange-400/12"
                  >
                    Browse
                  </button>
                </div>
              </Field>

              <Field label="Filename override">
                <input
                  value={filename}
                  onChange={(event) => setFilename(event.currentTarget.value)}
                  placeholder="Optional custom filename"
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                />
              </Field>

              {/* Advanced collapsible */}
              <div className="rounded-xl border border-white/10 bg-black/15">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((value) => !value)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                >
                  <span>
                    <span className="block text-sm font-semibold text-white">⚙ Session fields</span>
                    <span className="block text-xs text-stone-400">
                      Referer, bearer token, cookies, custom headers
                    </span>
                  </span>
                  <span className="rounded-lg bg-white/8 px-2.5 py-1 text-xs font-medium text-orange-200 transition group-hover:bg-white/12">
                    {showAdvanced ? "Hide" : "Show"}
                  </span>
                </button>

                {showAdvanced ? (
                  <div className="space-y-4 border-t border-white/8 px-4 py-4">
                    <Field label="Referer">
                      <input
                        value={referer}
                        onChange={(event) => setReferer(event.currentTarget.value)}
                        placeholder="https://origin.example.com/page"
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                      />
                    </Field>
                    <Field label="Bearer token">
                      <input
                        value={bearerToken}
                        onChange={(event) => setBearerToken(event.currentTarget.value)}
                        placeholder="eyJhbGciOi..."
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                      />
                    </Field>
                    <Field label="Cookie file">
                      <div className="flex gap-2">
                        <input
                          value={cookieFile}
                          onChange={(event) => setCookieFile(event.currentTarget.value)}
                          placeholder="/path/to/cookies.txt"
                          className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                        />
                        <button
                          type="button"
                          onClick={handlePickCookieFile}
                          className="rounded-xl border border-white/12 bg-white/8 px-4 py-3 text-sm font-medium text-white transition hover:border-orange-300/40 hover:bg-orange-400/12"
                        >
                          Pick
                        </button>
                      </div>
                    </Field>
                    <Field label="Custom headers">
                      <textarea
                        value={headerLines}
                        onChange={(event) => setHeaderLines(event.currentTarget.value)}
                        placeholder={`X-Token: abc123\nX-Trace: true`}
                        rows={3}
                        className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                      />
                    </Field>
                  </div>
                ) : null}
              </div>

              {pageError ? (
                <div className="rounded-xl border border-rose-300/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {pageError}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-orange-400 px-5 py-3 text-sm font-semibold text-stone-950 transition hover:bg-orange-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "⏳ Starting\u2026" : "⬇ Start download"}
              </button>
            </div>
          </form>

          {/* Right: Transfer board */}
          <section className="flex flex-col rounded-[1.75rem] border border-white/10 bg-white/4 p-6 shadow-[0_25px_60px_rgba(0,0,0,0.22)] backdrop-blur lg:p-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-orange-200/85">
                  Transfer board
                </p>
                <h2 className="mt-1 text-2xl font-semibold text-white">Downloads</h2>
              </div>
            </div>

            {/* Filter tabs */}
            <div className="mt-5 flex flex-wrap gap-1.5">
              {(Object.entries({
                all: "All",
                active: "Downloading",
                completed: "Completed",
                errors: "Failed",
              }) as [FilterMode, string][]).map(([mode, label]) => {
                const count = filterCounts[mode];
                const isActive = filterMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setFilterMode(mode)}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.13em] transition ${
                      isActive
                        ? "bg-orange-400/15 text-orange-100 ring-1 ring-orange-400/30"
                        : "text-stone-400 hover:bg-white/8 hover:text-stone-200"
                    }`}
                  >
                    {label}
                    {count > 0 ? (
                      <span
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${
                          isActive ? "bg-orange-500/20 text-orange-100" : "bg-white/8 text-stone-400"
                        }`}
                      >
                        {count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {/* Download list / empty state */}
            <div className="mt-5 space-y-3">
              {filteredDownloads.length === 0 ? (
                filterMode === "all" && downloads.length === 0 ? (
                  <EmptyState />
                ) : (
                  <div className="rounded-xl border border-dashed border-white/12 bg-black/10 px-6 py-12 text-center">
                    <p className="text-base font-semibold text-white">Nothing here.</p>
                    <p className="mt-1 text-sm text-stone-400">
                      {filterMode === "active"
                        ? "No active downloads right now. Start one above."
                        : filterMode === "completed"
                          ? "No completed downloads yet."
                          : `No failed downloads. Good. $😎`}
                    </p>
                  </div>
                )
              ) : (
                filteredDownloads.map((download) => (
                  <DownloadCard
                    key={download.id}
                    download={download}
                    expanded={Boolean(expandedRows[download.id])}
                    pendingAction={pendingActions[download.id]}
                    onAction={handleAction}
                    onRetry={handleRetry}
                    onToggleExpanded={toggleRowExpansion}
                  />
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

// Sub-components

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatCard({
  label,
  value,
  accent = "text-stone-400",
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3 md:px-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-400">
        {label}
      </p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${accent}`}>{value}</p>
    </div>
  );
}

function Metric({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/4 px-3.5 py-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-stone-400">
        {label}
      </p>
      <p className={`mt-0.5 text-sm text-white ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  variant = "default",
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "danger" | "ghost";
}) {
  const variants = {
    default:
      "border border-white/10 bg-white/7 text-white hover:border-orange-300/30 hover:bg-orange-500/10",
    danger:
      "border border-rose-300/18 bg-rose-500/10 text-rose-100 hover:bg-rose-500/18",
    ghost:
      "border border-transparent text-stone-300 hover:bg-white/8 hover:text-white",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${variants[variant]} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-white/12 bg-black/10 px-6 py-16 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
        <span className="text-2xl">⬇</span>
      </div>
      <p className="text-lg font-semibold text-white">Ready to download</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-stone-400">
        Paste one or more URLs to the left, choose where to save, and Tur will handle the rest
        through the <code className="rounded bg-black/20 px-1 py-0.5 text-orange-200">tur-rs</code> engine.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-xs text-stone-500">
        <span className="inline-flex items-center gap-1.5">📋 Supports batch URLs</span>
        <span className="inline-flex items-center gap-1.5">⏳ Pause / resume / cancel</span>
        <span className="inline-flex items-center gap-1.5">🔒 Session-aware auth</span>
      </div>
    </div>
  );
}

// DownloadCard

function DownloadCard({
  download,
  expanded,
  pendingAction,
  onAction,
  onRetry,
  onToggleExpanded,
}: {
  download: DownloadItem;
  expanded: boolean;
  pendingAction?: ActionName;
  onAction: (action: ActionName, id: string) => void;
  onRetry: (download: DownloadItem) => void;
  onToggleExpanded: (id: string) => void;
}) {
  const colors = STATUS_COLORS[download.status];
  const isTerminal = download.status === "completed" || download.status === "error";
  const isActive = download.status === "downloading";
  const activeConnections = download.workerSnapshots.filter((worker) =>
    ["connecting", "waiting_for_work", "downloading", "retrying"].includes(worker.state),
  ).length;

  return (
    <article
      className={`rounded-xl border border-white/8 bg-stone-950/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] transition-all ${
        isActive ? "ring-1 ring-sky-500/15" : ""
      }`}
    >
      {/* Main row */}
      <div className="flex items-start gap-4 p-4">
        {/* Status icon */}
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/25 text-sm font-bold ${colors.icon}`}
          title={STATUS_LABEL[download.status]}
        >
          {STATUS_ICON[download.status]}
        </span>

        {/* Info */}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-base font-semibold text-white">
              {download.filename}
            </h3>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.16em] ring-1 ${colors.badge}`}
            >
              {STATUS_LABEL[download.status]}
            </span>
          </div>
          <p className="truncate text-xs text-stone-500">{download.url}</p>
          <div className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-stone-500">
            <span>{formatProtocol(download.protocol)}</span>
            <span>·</span>
            <span>{activeConnections} active conn</span>
            <span>·</span>
            <span>{download.workerSnapshots.length} tracked</span>
          </div>
        </div>

        {/* Actions (non-terminal) */}
        {!isTerminal ? (
          <div className="flex shrink-0 gap-1.5">
            <ActionButton
              label={pendingAction === "pause" ? "Pausing…" : "Pause"}
              disabled={
                pendingAction !== undefined ||
                (download.status !== "downloading" && download.status !== "queued")
              }
              onClick={() => onAction("pause", download.id)}
            />
            <ActionButton
              label={pendingAction === "resume" ? "Resuming…" : "Resume"}
              disabled={
                pendingAction !== undefined ||
                (download.status !== "paused" && download.status !== "stopped")
              }
              onClick={() => onAction("resume", download.id)}
            />
            <ActionButton
              label={pendingAction === "cancel" ? "Stopping…" : "Cancel"}
              variant="danger"
              disabled={
                pendingAction !== undefined ||
                download.status === "completed" ||
                download.status === "error"
              }
              onClick={() => onAction("cancel", download.id)}
            />
          </div>
        ) : (
          <div className="flex shrink-0 gap-1.5">
            {download.status === "error" ? (
              <ActionButton label="Retry" onClick={() => onRetry(download)} />
            ) : null}
            <ActionButton
              label="Clear"
              variant="ghost"
              onClick={() => {
                // no-op for now
              }}
            />
          </div>
        )}
      </div>

      {/* Progress bar (non-terminal) */}
      {!isTerminal && (
        <div className="px-4 pb-4">
          <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-stone-400">
            <span>
              {(download.progress * 100).toFixed(download.totalSize > 0 ? 1 : 0)}%
            </span>
            <span>
              {formatBytes(download.downloadedBytes)}
              {download.totalSize > 0 ? <> / {formatBytes(download.totalSize)}</> : ""}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/8">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                isActive ? "animate-shimmer bg-[length:200%_100%]" : ""
              } ${colors.bar}`}
              style={{
                width: `${Math.max(3, download.progress * 100)}%`,
                backgroundImage: isActive
                  ? "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.25) 50%, transparent 100%)"
                  : undefined,
              }}
            />
          </div>
        </div>
      )}

      {/* Completed: full bar */}
      {download.status === "completed" && (
        <div className="px-4 pb-4">
          <div className="mb-1.5 flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-emerald-300/70">
            <span>100%</span>
            <span>
              {formatBytes(download.downloadedBytes)}
              {download.totalSize > 0 ? <> / {formatBytes(download.totalSize)}</> : ""}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-white/8">
            <div className="h-full w-full rounded-full bg-emerald-500" />
          </div>
        </div>
      )}

      {/* Metrics row */}
      <div className="border-t border-white/6 px-4 py-3">
        <div className="grid grid-cols-3 gap-2">
          {download.status === "downloading" ? (
            <Metric label="Speed" value={formatSpeed(download.speedBps)} />
          ) : (
            <Metric
              label="Size"
              value={
                download.totalSize > 0
                  ? formatBytes(download.totalSize)
                  : formatBytes(download.downloadedBytes)
              }
            />
          )}
          <Metric label="Remaining" value={formatRemaining(download)} />
          <Metric label="ETA" value={formatEta(download)} />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Metric label="Received" value={formatBytes(download.downloadedBytes)} />
          <Metric label="Protocol" value={formatProtocol(download.protocol)} />
          <Metric label="ID" value={download.id.slice(0, 8)} mono />
        </div>
        {download.workerSnapshots.length > 0 ? (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => onToggleExpanded(download.id)}
              className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/6 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-300 transition hover:border-orange-300/30 hover:bg-orange-400/10 hover:text-white"
            >
              {expanded ? "Hide connections" : "Show connections"}
            </button>
          </div>
        ) : null}
      </div>

      {expanded && download.workerSnapshots.length > 0 ? (
        <div className="border-t border-white/6 px-4 py-4">
          <div className="space-y-2">
            {download.workerSnapshots.map((worker) => (
              <div
                key={`${download.id}-${worker.connectionId}`}
                className="rounded-xl border border-white/8 bg-black/20 px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-white/8 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-stone-200">
                      Conn {worker.connectionId}
                    </span>
                    <span className="rounded-md bg-sky-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-sky-200">
                      {formatWorkerState(worker.state)}
                    </span>
                  </div>
                  <span className="text-xs text-stone-400">{formatSpeed(worker.speedBps)}</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-3">
                  <Metric label="Transferred" value={formatBytes(worker.transferredBytes)} />
                  <Metric label="Range" value={formatWorkerRange(worker)} mono />
                  <Metric label="Detail" value={worker.detail || "—"} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Error message */}
      {download.errorMessage ? (
        <div className="border-t border-rose-300/12 px-4 py-3">
          <div className="rounded-lg border border-rose-300/12 bg-rose-500/8 px-3.5 py-2.5 text-xs text-rose-100">
            {download.errorMessage}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export default App;
