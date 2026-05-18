import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
  errorMessage?: string | null;
  createdAtMs: number;
};

type HeaderField = {
  name: string;
  value: string;
};

const STORE_PATH = "tur-settings.json";
const STORE_KEY_DOWNLOAD_DIR = "lastDownloadDirectory";
const DOWNLOAD_EVENT = "download-update";

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

function statusTone(status: DownloadStatus): string {
  switch (status) {
    case "completed":
      return "bg-emerald-500/15 text-emerald-200 ring-emerald-400/25";
    case "error":
      return "bg-rose-500/15 text-rose-200 ring-rose-400/25";
    case "paused":
    case "stopped":
      return "bg-amber-500/15 text-amber-200 ring-amber-400/25";
    case "downloading":
      return "bg-sky-500/15 text-sky-200 ring-sky-400/25";
    case "queued":
    default:
      return "bg-stone-500/15 text-stone-200 ring-stone-400/25";
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

function App() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [url, setUrl] = useState("");
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
  const storeRef = useRef<Store | null>(null);
  const lastStatusRef = useRef<Record<string, DownloadStatus>>({});

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

  const activeDownloads = downloads.filter(
    (item) => item.status === "downloading" || item.status === "queued",
  ).length;

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

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!url.trim()) {
      setPageError("Enter a direct download URL first.");
      return;
    }
    if (!directory.trim()) {
      setPageError("Pick a destination folder before starting the download.");
      return;
    }

    setIsSubmitting(true);
    setPageError(null);

    try {
      const row = await invoke<DownloadItem>("start_download", {
        input: {
          url: url.trim(),
          directory: directory.trim(),
          filename: filename.trim() || null,
          referer: referer.trim() || null,
          bearerToken: bearerToken.trim() || null,
          cookieFile: cookieFile.trim() || null,
          headers: parseHeaders(headerLines),
        },
      });

      setDownloads((current) => [row, ...current.filter((item) => item.id !== row.id)]);
      await persistDirectory(directory.trim());
      setUrl("");
      setFilename("");
      setReferer("");
      setBearerToken("");
      setCookieFile("");
      setHeaderLines("");
      setShowAdvanced(false);
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleAction(action: "pause" | "resume" | "cancel", id: string) {
    setPageError(null);
    try {
      await invoke(`${action}_download`, { id });
    } catch (error) {
      setPageError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="min-h-screen px-6 py-8 text-stone-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <header className="flex flex-col gap-5 rounded-[2rem] border border-white/10 bg-white/5 p-8 shadow-[0_25px_90px_rgba(0,0,0,0.35)] backdrop-blur">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="space-y-3">
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-orange-300/15 bg-orange-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-orange-100">
                Tur desktop
              </div>
              <div className="space-y-2">
                <h1 className="text-4xl font-bold tracking-tight text-white md:text-5xl">
                  Fast downloads.
                  <span className="block text-orange-300">Session-aware when you need it.</span>
                </h1>
                <p className="max-w-3xl text-sm leading-6 text-stone-300 md:text-base">
                  This MVP binds directly to <code className="rounded bg-black/25 px-1.5 py-0.5 text-orange-200">tur-rs</code>.
                  The GUI stays thin; the downloader core stays authoritative.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:min-w-[19rem]">
              <StatCard label="Active" value={String(activeDownloads)} />
              <StatCard label="Tracked" value={String(downloads.length)} />
            </div>
          </div>
        </header>

        <section className="grid gap-8 xl:grid-cols-[minmax(0,430px)_minmax(0,1fr)]">
          <form
            onSubmit={handleSubmit}
            className="rounded-[2rem] border border-white/10 bg-stone-950/65 p-6 shadow-[0_25px_60px_rgba(0,0,0,0.28)]"
          >
            <div className="space-y-1">
              <p className="text-sm font-semibold uppercase tracking-[0.22em] text-orange-200/85">
                New transfer
              </p>
              <h2 className="text-2xl font-semibold text-white">Add a download</h2>
            </div>

            <div className="mt-6 space-y-5">
              <Field label="Download URL">
                <input
                  value={url}
                  onChange={(event) => setUrl(event.currentTarget.value)}
                  placeholder="https://example.com/file.zip"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                />
              </Field>

              <Field label="Destination folder">
                <div className="flex gap-3">
                  <input
                    value={directory}
                    onChange={(event) => setDirectory(event.currentTarget.value)}
                    placeholder="/home/kaizen/Downloads"
                    className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                  />
                  <button
                    type="button"
                    onClick={handlePickDirectory}
                    className="rounded-2xl border border-white/12 bg-white/8 px-4 py-3 text-sm font-medium text-white transition hover:border-orange-300/40 hover:bg-orange-400/12"
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
                  className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                />
              </Field>

              <div className="rounded-2xl border border-white/10 bg-black/15">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((value) => !value)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                >
                  <span>
                    <span className="block text-sm font-semibold text-white">Advanced session fields</span>
                    <span className="block text-xs text-stone-400">
                      Referer, bearer token, cookies, and custom headers.
                    </span>
                  </span>
                  <span className="text-sm text-orange-200">{showAdvanced ? "Hide" : "Show"}</span>
                </button>

                {showAdvanced ? (
                  <div className="space-y-4 border-t border-white/8 px-4 py-4">
                    <Field label="Referer">
                      <input
                        value={referer}
                        onChange={(event) => setReferer(event.currentTarget.value)}
                        placeholder="https://origin.example.com/page"
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                      />
                    </Field>
                    <Field label="Bearer token">
                      <input
                        value={bearerToken}
                        onChange={(event) => setBearerToken(event.currentTarget.value)}
                        placeholder="eyJhbGciOi..."
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                      />
                    </Field>
                    <Field label="Cookie file">
                      <div className="flex gap-3">
                        <input
                          value={cookieFile}
                          onChange={(event) => setCookieFile(event.currentTarget.value)}
                          placeholder="/path/to/cookies.txt"
                          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                        />
                        <button
                          type="button"
                          onClick={handlePickCookieFile}
                          className="rounded-2xl border border-white/12 bg-white/8 px-4 py-3 text-sm font-medium text-white transition hover:border-orange-300/40 hover:bg-orange-400/12"
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
                        rows={4}
                        className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition focus:border-orange-300/60 focus:bg-white/8"
                      />
                    </Field>
                  </div>
                ) : null}
              </div>

              {pageError ? (
                <div className="rounded-2xl border border-rose-300/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {pageError}
                </div>
              ) : null}

              <button
                type="submit"
                disabled={isSubmitting}
                className="inline-flex w-full items-center justify-center rounded-2xl bg-orange-400 px-5 py-3 text-sm font-semibold text-stone-950 transition hover:bg-orange-300 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSubmitting ? "Starting…" : "Start download"}
              </button>
            </div>
          </form>

          <section className="rounded-[2rem] border border-white/10 bg-white/4 p-6 shadow-[0_25px_60px_rgba(0,0,0,0.22)] backdrop-blur">
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-orange-200/85">
                  Transfer board
                </p>
                <h2 className="mt-1 text-2xl font-semibold text-white">Downloads in progress</h2>
              </div>
              <p className="text-sm text-stone-400">
                {downloads.length === 0 ? "No downloads yet" : `${downloads.length} tracked`}
              </p>
            </div>

            <div className="mt-6 space-y-4">
              {downloads.length === 0 ? (
                <div className="rounded-[1.75rem] border border-dashed border-white/12 bg-black/10 px-6 py-14 text-center">
                  <p className="text-lg font-semibold text-white">No transfers yet.</p>
                  <p className="mt-2 text-sm text-stone-400">
                    Add a URL on the left, choose a destination, and Tur will start the engine through <code className="rounded bg-black/20 px-1.5 py-0.5 text-orange-200">tur-rs</code>.
                  </p>
                </div>
              ) : (
                downloads.map((download) => (
                  <article
                    key={download.id}
                    className="rounded-[1.75rem] border border-white/8 bg-stone-950/55 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1 space-y-3">
                        <div className="flex flex-wrap items-center gap-3">
                          <h3 className="truncate text-lg font-semibold text-white">
                            {download.filename}
                          </h3>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] ring-1 ${statusTone(download.status)}`}
                          >
                            {download.status}
                          </span>
                        </div>
                        <p className="truncate text-sm text-stone-400">{download.url}</p>
                        <p className="truncate text-xs uppercase tracking-[0.18em] text-stone-500">
                          {download.directory}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <ActionButton
                          label="Pause"
                          disabled={
                            download.status !== "downloading" && download.status !== "queued"
                          }
                          onClick={() => handleAction("pause", download.id)}
                        />
                        <ActionButton
                          label="Resume"
                          disabled={
                            download.status !== "paused" && download.status !== "stopped"
                          }
                          onClick={() => handleAction("resume", download.id)}
                        />
                        <ActionButton
                          label="Cancel"
                          danger
                          disabled={
                            download.status === "completed" || download.status === "error"
                          }
                          onClick={() => handleAction("cancel", download.id)}
                        />
                      </div>
                    </div>

                    <div className="mt-5">
                      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-[0.16em] text-stone-400">
                        <span>{(download.progress * 100).toFixed(download.totalSize > 0 ? 1 : 0)}%</span>
                        <span>{formatBytes(download.downloadedBytes)} / {download.totalSize > 0 ? formatBytes(download.totalSize) : "?"}</span>
                      </div>
                      <div className="h-3 overflow-hidden rounded-full bg-white/8">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-orange-400 via-amber-300 to-orange-100 transition-all"
                          style={{ width: `${Math.max(4, download.progress * 100)}%` }}
                        />
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 text-sm text-stone-300 md:grid-cols-3">
                      <Metric label="Speed" value={formatSpeed(download.speedBps)} />
                      <Metric label="Downloaded" value={formatBytes(download.downloadedBytes)} />
                      <Metric label="Task ID" value={download.id.slice(0, 8)} mono />
                    </div>

                    {download.errorMessage ? (
                      <div className="mt-4 rounded-2xl border border-rose-300/15 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                        {download.errorMessage}
                      </div>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>
        </section>
      </div>
    </main>
  );

  async function notifyStatusChange(download: DownloadItem) {
    const prior = lastStatusRef.current[download.id];
    if (prior === download.status) {
      return;
    }
    lastStatusRef.current[download.id] = download.status;

    if (!(await notificationPermissionGranted())) {
      return;
    }

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
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-4">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-stone-400">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-white">{value}</p>
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
    <div className="rounded-2xl border border-white/8 bg-white/4 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-stone-400">
        {label}
      </p>
      <p className={`mt-1 text-sm text-white ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl px-3.5 py-2 text-sm font-medium transition ${
        danger
          ? "border border-rose-300/18 bg-rose-500/10 text-rose-100 hover:bg-rose-500/18"
          : "border border-white/10 bg-white/7 text-white hover:border-orange-300/30 hover:bg-orange-500/10"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

export default App;
