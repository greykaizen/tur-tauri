import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { DownloadItem, WorkerSnapshot, WorkerState, DownloadStatus } from "./types";
import { formatBytes, formatSpeed, formatEta } from "./lib/format";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { Button } from "./components/ui/button";
import { Titlebar } from "./components/Titlebar";

function workerStateLabel(state: WorkerState): string {
  const labels: Record<WorkerState, string> = {
    connecting: "Connecting...",
    waiting_for_work: "Waiting",
    downloading: "Receiving data...",
    retrying: "Retrying...",
    paused: "Paused",
    stopped: "Stopped",
    finished: "Finished",
  };
  return labels[state] ?? state;
}

const DOWNLOAD_EVENT = "download-update";

export default function InstanceView() {
  const [download, setDownload] = useState<DownloadItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // ── Theme Sync ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const applyTheme = () => {
      const theme = localStorage.getItem("tur-theme") || "system";
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      if (
        theme === "dark" ||
        (theme === "system" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches)
      ) {
        root.classList.add("dark");
      } else {
        root.classList.add(theme);
      }
    };
    applyTheme();
    window.addEventListener("storage", applyTheme);
    return () => window.removeEventListener("storage", applyTheme);
  }, []);

  // Automatically resize the OS window to exactly fit content when details are toggled
  useEffect(() => {
    try {
      const win = getCurrentWindow();
      if (win.label.startsWith("download-instance:")) {
        // Slight delay to allow DOM to render the new state before measuring
        setTimeout(async () => {
          if (rootRef.current) {
            const rect = rootRef.current.getBoundingClientRect();
            try {
              // Guaranteed native resize bypassing capabilities
              await invoke("resize_instance_window", {
                width: 728.0,
                height: Math.ceil(rect.height),
              });
            } catch (err) {
              console.error("Failed to resize window:", err);
            }
          }
        }, 30);
      }
    } catch (e) {
      // Ignore if running in regular browser
    }
  }, [showDetails, download?.workerSnapshots.length]);

  useEffect(() => {
    let mounted = true;
    const bootstrap = async () => {
      try {
        const win = getCurrentWindow();
        const taskId = win.label.replace("download-instance:", "");

        // The instance window can open immediately after a task is created.
        // Poll briefly so we don't get stuck on an empty loading screen if the
        // snapshot has not propagated by the first paint.
        let found: DownloadItem | null = null;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try {
            found = await invoke<DownloadItem>("get_download", { id: taskId });
            if (found) break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
        }

        if (mounted && found) {
          setDownload(found);
          setError(null);
        } else if (mounted) {
          setError(`Download ${taskId} was not found.`);
        }

        const unlisten = await listen<DownloadItem>(DOWNLOAD_EVENT, (ev) => {
          if (ev.payload.id === taskId) {
            setDownload(ev.payload);
            setError(null);
          }
        });

        return () => {
          mounted = false;
          unlisten();
        };
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      }
    };

    let cleanup: (() => void) | undefined;
    bootstrap().then((c) => (cleanup = c));
    return () => {
      mounted = false;
      cleanup?.();
    };
  }, []);

  // Track previous status to detect transitions
  const prevStatusRef = useRef<DownloadStatus | null>(null);

  useEffect(() => {
    if (!download) return;
    
    // Only transition if it changed to completed (or was completed on first load)
    if (prevStatusRef.current !== "completed" && download.status === "completed") {
      const transition = async () => {
        try {
          await invoke("open_completion_window", { taskId: download.id });
          await getCurrentWindow().close();
        } catch (err) {
          console.error("Failed to transition to completion window:", err);
        }
      };
      transition();
    }
    
    prevStatusRef.current = download.status;
  }, [download?.status, download?.id]);

  if (!download) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-6 text-[14px] font-sans text-muted-foreground">
        <div className="max-w-[420px] rounded-xl border border-border bg-card px-5 py-4 text-center shadow-sm">
          {error ? (
            <>
              <div className="text-[14px] font-semibold text-red-500">
                Failed to open download window
              </div>
              <div className="mt-2 text-[12px] leading-5 text-muted-foreground">
                {error}
              </div>
            </>
          ) : (
            <div className="text-[13px]">Loading download details…</div>
          )}
        </div>
      </div>
    );
  }

  const act = async (action: "pause" | "resume" | "cancel") => {
    if (!download) return;
    try {
      await invoke(`${action}_download`, { id: download.id });
    } catch (err) {
      console.error(action, err);
    }
    if (action === "cancel") {
      try {
        await getCurrentWindow().close();
      } catch {}
    }
  };

  const isActive = ["downloading", "retrying", "queued"].includes(
    download.status,
  );
  const pct = Math.max(0, Math.min(100, download.progress * 100)).toFixed(2);

  // Chunk map segments
  const segments = download.workerSnapshots
    .filter(
      (w) =>
        w.rangeStart != null &&
        w.rangeCursor != null &&
        w.rangeEnd != null &&
        w.rangeEnd > 0,
    )
    .map((w) => {
      const total = w.rangeEnd! - w.rangeStart!;
      const downloaded = w.rangeCursor! - w.rangeStart!;
      return {
        id: w.connectionId,
        left: (w.rangeStart! / download.totalSize) * 100,
        width: (total / download.totalSize) * 100,
        progressWidth: total > 0 ? (downloaded / total) * 100 : 0,
      };
    });



  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground font-sans text-[14px] select-none rounded-xl ring-1 ring-border overflow-hidden">
      <div ref={rootRef} className="flex flex-col w-full h-auto">
        <Titlebar />
        <Tabs
          defaultValue="status"
          className="flex flex-col w-full"
        >
        {/* Top Tabs */}
        <div className="px-4 pt-2">
          <TabsList className="h-8 justify-start rounded-none bg-transparent p-0 flex gap-1">
            <TabsTrigger
              value="status"
              className="data-[state=active]:bg-card data-[state=active]:border data-[state=active]:border-b-transparent h-8 rounded-t-md px-4 border border-transparent"
            >
              Download status
            </TabsTrigger>
            <TabsTrigger
              value="speed"
              className="data-[state=active]:bg-card data-[state=active]:border data-[state=active]:border-b-transparent h-8 rounded-t-md px-4 border border-transparent"
            >
              Speed Limiter
            </TabsTrigger>
            <TabsTrigger
              value="options"
              className="data-[state=active]:bg-card data-[state=active]:border data-[state=active]:border-b-transparent h-8 rounded-t-md px-4 border border-transparent"
            >
              Options on completion
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="status"
          className="flex flex-col p-4 m-0 bg-card/30 border-t"
        >
          {/* Main Info Box with background progress */}
          <div className="border bg-card rounded-xl mb-4 shadow-sm relative overflow-hidden shrink-0">
            {/* Background progress fill */}
            <div
              className="absolute inset-y-0 left-0 bg-emerald-500/15 pointer-events-none transition-all duration-100 ease-linear"
              style={{ width: `${pct}%` }}
            />

            <div className="p-4 pb-5 relative">
              {/* URL */}
              <div
                className="mb-3 text-[12px] truncate text-muted-foreground tracking-[0.01em] font-medium"
                title={download.url}
              >
                {download.url}
              </div>

              {/* Grid */}
              <div className="grid grid-cols-[130px_1fr] gap-y-2 items-center">
                <div className="text-muted-foreground font-medium">Status</div>
                <div className={isActive ? "text-blue-500 font-medium" : ""}>
                  {download.status === "downloading"
                    ? "Receiving data..."
                    : download.status}
                </div>

                <div className="text-muted-foreground font-medium">
                  File size
                </div>
                <div>{formatBytes(download.totalSize)}</div>

                <div className="text-muted-foreground font-medium">
                  Downloaded
                </div>
                <div>
                  {formatBytes(download.downloadedBytes)}
                  <span className="ml-2 text-muted-foreground">({pct} %)</span>
                </div>

                <div className="text-muted-foreground font-medium">
                  Transfer rate
                </div>
                <div>{isActive ? formatSpeed(download.speedBps) : "—"}</div>

                <div className="text-muted-foreground font-medium">
                  Time left
                </div>
                <div>{isActive ? formatEta(download) : "—"}</div>

                <div className="text-muted-foreground font-medium">
                  Resume capability
                </div>
                <div>Yes</div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-between items-center mb-4 shrink-0">
            <Button
              variant="outline"
              className="w-[120px] bg-card"
              onClick={() => setShowDetails(!showDetails)}
            >
              {showDetails ? "<< Hide details" : "Show details >>"}
            </Button>
            <div className="flex gap-3">
              {isActive ? (
                <Button
                  variant="outline"
                  className="w-[100px] bg-card"
                  onClick={() => act("pause")}
                >
                  Pause
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="w-[100px] bg-card"
                  onClick={() => act("resume")}
                >
                  Resume
                </Button>
              )}
              <Button
                variant="outline"
                className="w-[100px] bg-card"
                onClick={() => act("cancel")}
              >
                Cancel
              </Button>
            </div>
          </div>

          {showDetails && (
            <div className="flex flex-col mt-2">
              {/* Chunk Map Label */}
              <div className="text-center text-[12px] text-muted-foreground mb-2 shrink-0">
                Start positions and download progress by connections
              </div>

              {/* Chunk Map Bar */}
              <div className="h-[22px] bg-white/5 border border-white/10 relative shadow-inner mb-3 rounded-md overflow-hidden shrink-0">
                {segments.map((seg) => (
                  <div
                    key={seg.id}
                    className="absolute top-0 bottom-0 border-r border-background"
                    style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
                  >
                    {/* Inner progress of this chunk */}
                    <div
                      className="h-full bg-blue-500 transition-all duration-100 ease-linear"
                      style={{ width: `${seg.progressWidth}%` }}
                    />
                  </div>
                ))}
              </div>

              {/* Connections Table */}
              <div className="border bg-card rounded-sm overflow-hidden flex flex-col">
                <div className="grid grid-cols-[40px_120px_100px_1fr] gap-4 bg-muted/40 border-b px-3 py-2 text-[12px] font-semibold text-muted-foreground">
                  <div>N.</div>
                  <div>Downloaded</div>
                  <div>Speed</div>
                  <div>Info</div>
                </div>
                <div className="flex flex-col">
                  {download.workerSnapshots.map((w, i) => (
                    <div
                      key={w.connectionId}
                      className={`grid grid-cols-[40px_120px_100px_1fr] gap-4 px-3 py-1.5 text-[12px] items-center ${i % 2 === 0 ? "bg-white/[0.02]" : ""}`}
                    >
                      <div className="text-muted-foreground">
                        {w.connectionId}
                      </div>
                      <div>
                        {(w.transferredBytes / 1024).toLocaleString(undefined, {
                          maximumFractionDigits: 0,
                        })}{" "}
                        KB
                      </div>
                      <div className="text-muted-foreground font-medium">
                        {w.speedBps > 0 ? formatSpeed(w.speedBps) : "—"}
                      </div>
                      <div className="text-muted-foreground">
                        {workerStateLabel(w.state)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="speed" className="p-4 m-0 text-muted-foreground">
          Speed Limiter options (Placeholder)
        </TabsContent>

        <TabsContent value="options" className="p-4 m-0 text-muted-foreground">
          Options on completion (Placeholder)
        </TabsContent>
      </Tabs>
      </div>
    </div>
  );
}
