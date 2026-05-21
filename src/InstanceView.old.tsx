import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { DownloadItem, WorkerSnapshot, WorkerState } from "./types";
import { formatBytes, formatSpeed, formatEta } from "./lib/format";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { Button } from "./components/ui/button";
import { ScrollArea } from "./components/ui/scroll-area";
import { Play, Pause, X } from "lucide-react";

const DOWNLOAD_EVENT = "download-update";

function workerStateLabel(state: WorkerState): string {
  const labels: Record<WorkerState, string> = {
    connecting:       "Connecting...",
    waiting_for_work: "Waiting",
    downloading:      "Receiving data...",
    retrying:         "Retrying...",
    paused:           "Paused",
    stopped:          "Stopped",
    finished:         "Finished",
  };
  return labels[state] ?? state;
}

function workerProgress(w: WorkerSnapshot): number {
  if (w.rangeStart == null || w.rangeCursor == null || w.rangeEnd == null || w.rangeEnd === 0) return 0;
  const total = w.rangeEnd - w.rangeStart;
  if (total <= 0) return 0;
  return Math.min(100, ((w.rangeCursor - w.rangeStart) / total) * 100);
}

export default function InstanceView() {
  const [download, setDownload] = useState<DownloadItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const appWindow = getCurrentWindow();
  const taskId = appWindow.label.replace("download-instance:", "");

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      try {
        const rows = await invoke<DownloadItem[]>("list_downloads");
        const found = rows.find((r) => r.id === taskId);
        if (mounted && found) setDownload(found);

        const unlisten = await listen<DownloadItem>(DOWNLOAD_EVENT, (ev) => {
          if (ev.payload.id === taskId) setDownload(ev.payload);
        });

        return () => { mounted = false; unlisten(); };
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      }
    };

    let cleanup: (() => void) | undefined;
    bootstrap().then((c) => (cleanup = c));
    return () => { mounted = false; cleanup?.(); };
  }, [taskId]);

  const act = async (action: "pause" | "resume" | "cancel") => {
    try {
      await invoke(`${action}_download`, { id: taskId });
      if (action === "cancel") appWindow.close();
    } catch (err) {
      console.error(action, err);
    }
  };

  if (!download) {
    return (
      <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", background: "var(--background)", color: "var(--muted-foreground)", fontSize: 13 }}>
        {error ? <span style={{ color: "var(--clr-red)" }}>{error}</span> : "Loading…"}
      </div>
    );
  }

  const isActive   = download.status === "downloading" || download.status === "queued";
  const isComplete = download.status === "completed";
  const pct = Math.round(download.progress);

  // Chunk map: compute segment positions as percentages of total file
  const segments = download.workerSnapshots
    .filter((w) => w.rangeStart != null && w.rangeCursor != null && w.rangeEnd != null && w.rangeEnd > 0)
    .map((w) => ({
      id: w.connectionId,
      left: (w.rangeStart! / w.rangeEnd!) * 100,
      width: ((w.rangeCursor! - w.rangeStart!) / w.rangeEnd!) * 100,
    }));

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--background)", color: "var(--foreground)", overflow: "hidden", fontFamily: "var(--font-sans)", fontSize: 13 }}>

      {/* ── File info header ──────────────────────────────────────────── */}
      <div style={{ padding: "8px 12px 6px", borderBottom: "1px solid var(--border)", background: "var(--card)" }}>
        <div style={{ fontSize: 12, color: "var(--muted-foreground)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }} title={download.url}>
          {download.url}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={download.filename}>
            {download.filename}
          </span>
          <span style={{ fontSize: 12, color: "var(--muted-foreground)", fontVariantNumeric: "tabular-nums" }}>
            {pct}%
          </span>
        </div>
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────── */}
      <Tabs defaultValue="status" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <TabsList
          style={{
            display: "flex",
            gap: 0,
            background: "var(--card)",
            borderBottom: "1px solid var(--border)",
            borderRadius: 0,
            padding: "0 8px",
            height: 32,
            justifyContent: "flex-start",
            flexShrink: 0,
          }}
        >
          <TabsTrigger
            value="status"
            style={{ borderRadius: "4px 4px 0 0", height: "100%", fontSize: 12, padding: "0 12px" }}
            className="data-[state=active]:bg-background data-[state=active]:border data-[state=active]:border-b-0 data-[state=active]:shadow-none"
          >
            Download status
          </TabsTrigger>
          <TabsTrigger
            value="connections"
            style={{ borderRadius: "4px 4px 0 0", height: "100%", fontSize: 12, padding: "0 12px" }}
            className="data-[state=active]:bg-background data-[state=active]:border data-[state=active]:border-b-0 data-[state=active]:shadow-none"
          >
            Connections
          </TabsTrigger>
          <TabsTrigger
            value="details"
            style={{ borderRadius: "4px 4px 0 0", height: "100%", fontSize: 12, padding: "0 12px" }}
            className="data-[state=active]:bg-background data-[state=active]:border data-[state=active]:border-b-0 data-[state=active]:shadow-none"
          >
            Details
          </TabsTrigger>
        </TabsList>

        {/* ── Status tab ───────────────────────────────────────────────── */}
        <TabsContent value="status" style={{ flex: 1, overflowY: "auto", margin: 0, padding: "12px 14px" }}>
          {/* Stat grid */}
          <div className="iv-stat-grid">
            <div className="iv-stat-label">Status</div>
            <div className="iv-stat-value" style={{ color: isActive ? "var(--clr-blue)" : isComplete ? "var(--clr-green)" : "var(--foreground)" }}>
              {download.status === "downloading" ? "Receiving data…" : download.status}
            </div>

            <div className="iv-stat-label">File size</div>
            <div className="iv-stat-value">{download.totalSize > 0 ? formatBytes(download.totalSize) : "Unknown"}</div>

            <div className="iv-stat-label">Downloaded</div>
            <div className="iv-stat-value">
              {formatBytes(download.downloadedBytes)}
              {download.totalSize > 0 && (
                <span style={{ color: "var(--muted-foreground)", marginLeft: 6 }}>({pct}%)</span>
              )}
            </div>

            <div className="iv-stat-label">Transfer rate</div>
            <div className="iv-stat-value">{isActive ? formatSpeed(download.speedBps) : "—"}</div>

            <div className="iv-stat-label">Time left</div>
            <div className="iv-stat-value">{isActive ? formatEta(download) : "—"}</div>

            <div className="iv-stat-label">Resume capability</div>
            <div className="iv-stat-value">Yes</div>
          </div>

          {/* Progress bar */}
          <div style={{ marginTop: 16 }}>
            <div className="iv-progress-track">
              <div
                className="iv-progress-fill"
                style={{
                  width: `${pct}%`,
                  background: isComplete ? "var(--clr-green)" : download.status === "error" ? "var(--clr-red)" : "var(--clr-green)",
                }}
              />
            </div>
          </div>

          {/* Chunk map */}
          {segments.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, color: "var(--muted-foreground)", marginBottom: 3 }}>
                Start positions and download progress by connections
              </div>
              <div className="chunk-map">
                {segments.map((seg) => (
                  <div
                    key={seg.id}
                    className="chunk-segment"
                    style={{ left: `${seg.left}%`, width: `${Math.max(0.5, seg.width)}%` }}
                  />
                ))}
              </div>
            </div>
          )}

          {download.errorMessage && (
            <div style={{ marginTop: 12, padding: "8px 10px", background: "rgba(196,50,50,0.12)", border: "1px solid rgba(196,50,50,0.25)", borderRadius: 4, color: "var(--clr-red)", fontSize: 12 }}>
              {download.errorMessage}
            </div>
          )}
        </TabsContent>

        {/* ── Connections tab ───────────────────────────────────────────── */}
        <TabsContent value="connections" style={{ flex: 1, margin: 0, display: "flex", flexDirection: "column" }}>
          <ScrollArea style={{ flex: 1 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "4px 8px", textAlign: "left", color: "var(--muted-foreground)", fontWeight: 500, fontSize: 11 }}>N.</th>
                  <th style={{ padding: "4px 8px", textAlign: "right", color: "var(--muted-foreground)", fontWeight: 500, fontSize: 11 }}>Downloaded</th>
                  <th style={{ padding: "4px 8px", textAlign: "left", color: "var(--muted-foreground)", fontWeight: 500, fontSize: 11 }}>Info</th>
                  <th style={{ padding: "4px 8px", textAlign: "right", color: "var(--muted-foreground)", fontWeight: 500, fontSize: 11 }}>Speed</th>
                </tr>
              </thead>
              <tbody>
                {download.workerSnapshots.length === 0 && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", padding: "32px 0", color: "var(--muted-foreground)" }}>
                      No active connections
                    </td>
                  </tr>
                )}
                {download.workerSnapshots.map((w) => {
                  const wpct = workerProgress(w);
                  return (
                    <tr key={w.connectionId} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "4px 8px", color: "var(--muted-foreground)" }}>{w.connectionId}</td>
                      <td style={{ padding: "4px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {formatBytes(w.transferredBytes)}
                        {wpct > 0 && (
                          <span style={{ color: "var(--muted-foreground)", marginLeft: 4 }}>({Math.round(wpct)}%)</span>
                        )}
                      </td>
                      <td style={{ padding: "4px 8px", color: "var(--muted-foreground)" }}>
                        {workerStateLabel(w.state)}
                      </td>
                      <td style={{ padding: "4px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: w.state === "downloading" ? "var(--clr-blue)" : "var(--muted-foreground)" }}>
                        {w.state === "downloading" ? formatSpeed(w.speedBps) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea>
        </TabsContent>

        {/* ── Details tab ───────────────────────────────────────────────── */}
        <TabsContent value="details" style={{ flex: 1, overflowY: "auto", margin: 0, padding: "12px 14px" }}>
          <div className="iv-stat-grid">
            <div className="iv-stat-label">Protocol</div>
            <div className="iv-stat-value">{download.protocol.toUpperCase()}</div>

            <div className="iv-stat-label">Date added</div>
            <div className="iv-stat-value">{new Date(download.createdAtMs).toLocaleString()}</div>

            <div className="iv-stat-label">Save to</div>
            <div className="iv-stat-value" style={{ wordBreak: "break-all" }}>{download.directory}</div>

            <div className="iv-stat-label">URL</div>
            <div className="iv-stat-value" style={{ wordBreak: "break-all", userSelect: "text" }}>{download.url}</div>
          </div>
        </TabsContent>
      </Tabs>

      {/* ── Action bar ────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, padding: "6px 10px", borderTop: "1px solid var(--border)", background: "var(--card)", flexShrink: 0 }}>
        {isActive && (
          <Button size="sm" variant="outline" onClick={() => act("pause")}>
            <Pause size={13} style={{ marginRight: 4 }} /> Pause
          </Button>
        )}
        {!isActive && !isComplete && (
          <Button size="sm" variant="outline" onClick={() => act("resume")}>
            <Play size={13} style={{ marginRight: 4 }} /> Resume
          </Button>
        )}
        {!isComplete && (
          <Button size="sm" variant="outline" style={{ color: "var(--clr-red)", borderColor: "rgba(196,50,50,0.3)" }} onClick={() => act("cancel")}>
            <X size={13} style={{ marginRight: 4 }} /> Cancel
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => appWindow.close()}>
          Close
        </Button>
      </div>
    </div>
  );
}
