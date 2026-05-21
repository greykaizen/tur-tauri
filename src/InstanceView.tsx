import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";

import type { DownloadItem, WorkerSnapshot, WorkerState } from "./types";
import { formatBytes, formatSpeed, formatEta } from "./lib/format";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs";
import { Button } from "./components/ui/button";

const DOWNLOAD_EVENT = "download-update";

// Mock data for browser testing
const MOCK_DOWNLOAD: DownloadItem = {
  id: "test",
  filename: "idm.ogv",
  url: "https://www.internetdownloadmanager.com/video2/idm.ogv",
  directory: "/Downloads",
  downloadedBytes: 4_360_000_000,
  totalSize: 17_745_000_000,
  speedBps: 1_916_000_000,
  progress: 24.57,
  status: "downloading",
  protocol: "http2",
  createdAtMs: Date.now(),
  workerSnapshots: [
    { connectionId: 1, state: "connecting", transferredBytes: 656000000, speedBps: 0, rangeStart: 0, rangeCursor: 656000000, rangeEnd: 2000000000 },
    { connectionId: 2, state: "downloading", transferredBytes: 789937000, speedBps: 1916000000, rangeStart: 2000000000, rangeCursor: 2789937000, rangeEnd: 4000000000 },
    { connectionId: 3, state: "downloading", transferredBytes: 640625000, speedBps: 0, rangeStart: 4000000000, rangeCursor: 4640625000, rangeEnd: 6000000000 },
    { connectionId: 4, state: "downloading", transferredBytes: 578125000, speedBps: 0, rangeStart: 6000000000, rangeCursor: 6578125000, rangeEnd: 8000000000 },
    { connectionId: 5, state: "downloading", transferredBytes: 453125000, speedBps: 0, rangeStart: 8000000000, rangeCursor: 8453125000, rangeEnd: 10000000000 },
    { connectionId: 6, state: "downloading", transferredBytes: 429687000, speedBps: 0, rangeStart: 10000000000, rangeCursor: 10429687000, rangeEnd: 12000000000 },
  ],
  errorMessage: null,
};

function workerStateLabel(state: WorkerState): string {
  const labels: Record<WorkerState, string> = {
    connecting:       "Send GET...",
    waiting_for_work: "Waiting",
    downloading:      "Receiving data...",
    retrying:         "Retrying...",
    paused:           "Paused",
    stopped:          "Stopped",
    finished:         "Finished",
  };
  return labels[state] ?? state;
}

export default function InstanceView() {
  const [download, setDownload] = useState<DownloadItem>(MOCK_DOWNLOAD);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

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
                height: Math.ceil(rect.height)
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
  }, [showDetails, download.workerSnapshots.length]);

  useEffect(() => {
    let mounted = true;
    const bootstrap = async () => {
      try {
        const appWindow = getCurrentWindow();
        const taskId = appWindow.label.replace("download-instance:", "");
        
        const rows = await invoke<DownloadItem[]>("list_downloads");
        const found = rows.find((r) => r.id === taskId);
        if (mounted && found) setDownload(found);

        const unlisten = await listen<DownloadItem>(DOWNLOAD_EVENT, (ev) => {
          if (ev.payload.id === taskId) setDownload(ev.payload);
        });

        return () => { mounted = false; unlisten(); };
      } catch (err) {
        // Fallback to MOCK data if not in Tauri
      }
    };

    let cleanup: (() => void) | undefined;
    bootstrap().then((c) => (cleanup = c));
    return () => { mounted = false; cleanup?.(); };
  }, []);

  const act = async (action: "pause" | "resume" | "cancel") => {
    try {
      await invoke(`${action}_download`, { id: download.id });
      if (action === "cancel") getCurrentWindow().close();
    } catch (err) {
      console.error(action, err);
    }
  };

  const isActive = download.status === "downloading" || download.status === "queued";
  const pct = download.progress.toFixed(2);

  // Chunk map segments
  const segments = download.workerSnapshots
    .filter((w) => w.rangeStart != null && w.rangeCursor != null && w.rangeEnd != null && w.rangeEnd > 0)
    .map((w) => {
      const total = w.rangeEnd! - w.rangeStart!;
      const downloaded = w.rangeCursor! - w.rangeStart!;
      return {
        id: w.connectionId,
        left: (w.rangeStart! / download.totalSize) * 100,
        width: (total / download.totalSize) * 100,
        progressWidth: (downloaded / total) * 100,
      };
    });

  return (
    <div ref={rootRef} className="flex flex-col bg-background text-foreground font-sans text-[13px] select-none">
      <Tabs defaultValue="status" className="flex flex-col w-full">
        {/* Top Tabs */}
        <div className="px-4 pt-4">
          <TabsList className="h-8 justify-start rounded-none bg-transparent p-0 flex gap-1">
            <TabsTrigger value="status" className="data-[state=active]:bg-card data-[state=active]:border data-[state=active]:border-b-transparent h-8 rounded-t-md px-4 border border-transparent">
              Download status
            </TabsTrigger>
            <TabsTrigger value="speed" className="data-[state=active]:bg-card data-[state=active]:border data-[state=active]:border-b-transparent h-8 rounded-t-md px-4 border border-transparent">
              Speed Limiter
            </TabsTrigger>
            <TabsTrigger value="options" className="data-[state=active]:bg-card data-[state=active]:border data-[state=active]:border-b-transparent h-8 rounded-t-md px-4 border border-transparent">
              Options on completion
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="status" className="flex flex-col p-4 m-0 bg-card/30 border-t">
          {/* Main Info Box with background progress */}
          <div className="border bg-card rounded-xl mb-4 shadow-sm relative overflow-hidden shrink-0">
            {/* Background progress fill */}
            <div 
              className="absolute inset-y-0 left-0 bg-emerald-500/15 transition-all duration-300 ease-out pointer-events-none" 
              style={{ width: `${download.progress}%` }} 
            />
            
            <div className="p-4 pb-5 relative">
              {/* URL */}
              <div className="mb-2 text-[12px] truncate opacity-90 tracking-wide font-medium" title={download.url}>
                {download.url}
              </div>

              {/* Grid */}
              <div className="grid grid-cols-[130px_1fr] gap-y-1.5 items-center">
                <div className="text-muted-foreground">Status</div>
                <div className={isActive ? "text-blue-500 font-medium" : ""}>
                  {download.status === "downloading" ? "Receiving data..." : download.status}
                </div>

                <div className="text-muted-foreground">File size</div>
                <div>{formatBytes(download.totalSize)}</div>

                <div className="text-muted-foreground">Downloaded</div>
                <div>
                  {formatBytes(download.downloadedBytes)}
                  <span className="ml-2 text-muted-foreground">({pct} %)</span>
                </div>

                <div className="text-muted-foreground">Transfer rate</div>
                <div>{isActive ? formatSpeed(download.speedBps) : "—"}</div>

                <div className="text-muted-foreground">Time left</div>
                <div>{isActive ? formatEta(download) : "—"}</div>

                <div className="text-muted-foreground">Resume capability</div>
                <div>Yes</div>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex justify-between items-center mb-4 shrink-0">
            <Button variant="outline" className="w-[120px] bg-card" onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? "<< Hide details" : "Show details >>"}
            </Button>
            <div className="flex gap-3">
              {isActive ? (
                <Button variant="outline" className="w-[100px] bg-card" onClick={() => act("pause")}>Pause</Button>
              ) : (
                <Button variant="outline" className="w-[100px] bg-card" onClick={() => act("resume")}>Resume</Button>
              )}
              <Button variant="outline" className="w-[100px] bg-card" onClick={() => act("cancel")}>Cancel</Button>
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
                      className="h-full bg-blue-500 transition-all duration-300"
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
                      <div className="text-muted-foreground">{w.connectionId}</div>
                      <div>{(w.transferredBytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 0 })} KB</div>
                      <div className="text-muted-foreground font-medium">{w.speedBps > 0 ? formatSpeed(w.speedBps) : "—"}</div>
                      <div className="text-muted-foreground">{workerStateLabel(w.state)}</div>
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
  );
}
