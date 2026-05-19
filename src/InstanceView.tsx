import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

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
  protocol: string;
  errorMessage?: string | null;
  createdAtMs: number;
  workerSnapshots: WorkerSnapshot[];
};

type ActionName = "pause" | "resume" | "cancel";

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
    worker.rangeStart === null ||
    worker.rangeStart === undefined ||
    worker.rangeCursor === null ||
    worker.rangeCursor === undefined ||
    worker.rangeEnd === null ||
    worker.rangeEnd === undefined
  ) {
    return "—";
  }
  const mb = (value: number) => `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${mb(worker.rangeStart)} → ${mb(worker.rangeCursor)} / ${mb(worker.rangeEnd)}`;
}

function statusColor(status: DownloadStatus): string {
  switch (status) {
    case "downloading":
    case "queued":
      return "#3b82f6";
    case "paused":
    case "stopped":
      return "#eab308";
    case "completed":
      return "#22c55e";
    case "error":
      return "#ef4444";
  }
}

export default function InstanceView() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailExpanded, setDetailExpanded] = useState(true);

  useEffect(() => {
    const label = getCurrentWindow().label;
    const prefix = "download-instance:";
    const taskIdRef = { current: "" };

    if (label.startsWith(prefix)) {
      taskIdRef.current = label.slice(prefix.length);
      setTaskId(taskIdRef.current);
      loadDownload(taskIdRef.current);
    } else {
      setError("This window was opened incorrectly.");
      setLoading(false);
    }

    async function loadDownload(id: string) {
      try {
        const item = await invoke<DownloadItem>("get_download", { id });
        setDownload(item);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    const unlisten = listen<DownloadItem>(DOWNLOAD_EVENT, (event) => {
      const next = event.payload;
      if (next.id === taskIdRef.current) {
        setDownload(next);
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  async function handleAction(action: ActionName) {
    if (!taskId) return;
    try {
      await invoke(`${action}_download`, { id: taskId });
      if (download) {
        setDownload({
          ...download,
          status: action === "pause" ? "paused" : action === "resume" ? "queued" : "stopped",
          speedBps: action !== "resume" ? 0 : download.speedBps,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRetry() {
    if (!download) return;
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
      if (rows.length > 0) {
        setDownload(rows[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOpenFolder() {
    if (!download) return;
    try {
      await invoke("open_download_folder", { path: download.directory });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleOpenFile() {
    if (!download) return;
    try {
      await invoke("open_download_file", {
        directory: download.directory,
        filename: download.filename,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleClose() {
    await getCurrentWindow().close();
  }

  if (loading) {
    return (
      <main style={{
        background: "var(--bg-gradient, #0f1113)",
        color: "var(--text-primary, #f0ede8)",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
      }}>
        <p style={{ color: "var(--text-secondary, #a8a49e)" }}>Loading download details…</p>
      </main>
    );
  }

  if (error || !download) {
    return (
      <main style={{
        background: "var(--bg-gradient, #0f1113)",
        color: "var(--text-primary, #f0ede8)",
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        fontFamily: "system-ui, sans-serif",
      }}>
        <p style={{ color: "#ef4444" }}>{error || "Download not found."}</p>
        <button onClick={handleClose} style={{
          padding: "8px 16px",
          borderRadius: 8,
          border: "1px solid var(--border-color, rgba(255,255,255,0.07))",
          background: "var(--bg-card, #1a1c20)",
          color: "var(--text-primary, #f0ede8)",
          cursor: "pointer",
        }}>Close Window</button>
      </main>
    );
  }

  const isActive = download.status === "downloading" || download.status === "queued";
  const isTerminal = download.status === "completed" || download.status === "error";
  const color = statusColor(download.status);
  const activeConnections = download.workerSnapshots.filter((w) =>
    ["connecting", "waiting_for_work", "downloading", "retrying"].includes(w.state),
  ).length;

  return (
    <main style={{
      background: "var(--bg-gradient, #0f1113)",
      color: "var(--text-primary, #f0ede8)",
      minHeight: "100vh",
      padding: 20,
      fontFamily: '"Space Grotesk", "IBM Plex Sans", system-ui, sans-serif',
      display: "flex",
      flexDirection: "column",
      gap: 16,
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 700,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>{download.filename}</h1>
          <p style={{
            margin: "4px 0 0 0",
            fontSize: 11,
            color: "var(--text-tertiary, #6b6863)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}>{download.url}</p>
        </div>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "3px 10px",
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 600,
          background: `${color}18`,
          color: color,
          whiteSpace: "nowrap",
        }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
          {download.status.charAt(0).toUpperCase() + download.status.slice(1)}
        </span>
      </div>

      {/* Metrics row */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))",
        gap: 8,
      }}>
        {isActive ? (
          <Metric label="Speed" value={formatSpeed(download.speedBps)} />
        ) : (
          <Metric label="Size" value={formatBytes(download.totalSize || download.downloadedBytes)} />
        )}
        <Metric label="Remaining" value={download.totalSize > 0 ? formatBytes(Math.max(download.totalSize - download.downloadedBytes, 0)) : "—"} />
        <Metric label="ETA" value={formatEta(download)} />
        <Metric label="Received" value={formatBytes(download.downloadedBytes)} />
        <Metric label="Protocol" value={download.protocol === "auto" ? "Auto" : download.protocol.toUpperCase()} />
        <Metric label="Connections" value={`${activeConnections} active`} />
      </div>

      {/* Progress bar */}
      <div>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--text-secondary, #a8a49e)",
          marginBottom: 6,
        }}>
          <span>{(download.progress * 100).toFixed(download.totalSize > 0 ? 1 : 0)}%</span>
          <span>
            {formatBytes(download.downloadedBytes)}
            {download.totalSize > 0 ? <> / {formatBytes(download.totalSize)}</> : ""}
          </span>
        </div>
        <div style={{
          height: 6,
          borderRadius: 3,
          background: "var(--bg-surface, #22252a)",
          overflow: "hidden",
        }}>
          <div style={{
            height: "100%",
            borderRadius: 3,
            width: `${Math.max(2, download.progress * 100)}%`,
            background: isActive
              ? "linear-gradient(90deg, #f47836, #f59e0b)"
              : download.status === "completed"
                ? "#22c55e"
                : "var(--text-tertiary, #6b6863)",
            transition: "width 0.3s ease",
          }} />
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {isActive ? (
          <>
            <ActionBtn label="Pause" onClick={() => handleAction("pause")} />
            <ActionBtn label="Cancel" onClick={() => handleAction("cancel")} variant="danger" />
          </>
        ) : !isTerminal ? (
          <>
            <ActionBtn label="Resume" onClick={() => handleAction("resume")} />
            <ActionBtn label="Cancel" onClick={() => handleAction("cancel")} variant="danger" />
          </>
        ) : download.status === "error" ? (
          <>
            <ActionBtn label="Retry" onClick={handleRetry} />
            <ActionBtn label="Remove" onClick={async () => { await invoke("remove_download", { id: download.id }); await handleClose(); }} variant="danger" />
          </>
        ) : (
          <ActionBtn label="Remove" onClick={async () => { await invoke("remove_download", { id: download.id }); await handleClose(); }} variant="danger" />
        )}
        {download.directory && (
          <ActionBtn label="Open Folder" onClick={handleOpenFolder} />
        )}
        {download.status === "completed" && download.filename && (
          <ActionBtn label="Open File" onClick={handleOpenFile} />
        )}
        <ActionBtn label="Close Window" onClick={handleClose} />
      </div>

      {/* Error message */}
      {download.errorMessage ? (
        <div style={{
          padding: "10px 14px",
          borderRadius: 8,
          border: "1px solid rgba(239, 68, 68, 0.2)",
          background: "rgba(239, 68, 68, 0.08)",
          fontSize: 12,
          color: "#fca5a5",
        }}>
          {download.errorMessage}
        </div>
      ) : null}

      {/* Connection diagnostics */}
      {download.workerSnapshots.length > 0 ? (
        <div style={{
          borderRadius: 10,
          border: "1px solid var(--border-color, rgba(255,255,255,0.07))",
          background: "var(--bg-card, #1a1c20)",
          overflow: "hidden",
        }}>
          <button
            onClick={() => setDetailExpanded((v) => !v)}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              border: "none",
              background: "transparent",
              color: "var(--text-primary, #f0ede8)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            <span>Connections ({download.workerSnapshots.length})</span>
            <span style={{ fontSize: 10, color: "var(--text-tertiary, #6b6863)" }}>
              {detailExpanded ? "▲ Hide" : "▼ Show"}
            </span>
          </button>
          {detailExpanded && (
            <div style={{ borderTop: "1px solid var(--border-color, rgba(255,255,255,0.07))" }}>
              <table style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 11,
              }}>
                <thead>
                  <tr style={{ color: "var(--text-tertiary, #6b6863)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.07))" }}>ID</th>
                    <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.07))" }}>State</th>
                    <th style={{ padding: "6px 10px", textAlign: "right", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.07))" }}>Speed</th>
                    <th style={{ padding: "6px 10px", textAlign: "right", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.07))" }}>Transferred</th>
                    <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.07))" }}>Range</th>
                  </tr>
                </thead>
                <tbody>
                  {download.workerSnapshots.map((worker) => (
                    <tr key={worker.connectionId} style={{ borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.04))" }}>
                      <td style={{ padding: "6px 10px", fontFamily: "monospace", fontSize: 10, color: "var(--text-secondary, #a8a49e)" }}>
                        #{worker.connectionId}
                      </td>
                      <td style={{ padding: "6px 10px" }}>
                        <span style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          padding: "1px 6px",
                          borderRadius: 4,
                          fontSize: 10,
                          fontWeight: 500,
                          background: worker.state === "downloading" ? "rgba(59,130,246,0.12)" : worker.state === "connecting" ? "rgba(245,158,11,0.12)" : worker.state === "finished" ? "rgba(34,197,94,0.12)" : worker.state === "retrying" ? "rgba(239,68,68,0.12)" : "var(--bg-surface, #22252a)",
                          color: worker.state === "downloading" ? "#60a5fa" : worker.state === "connecting" ? "#fbbf24" : worker.state === "finished" ? "#4ade80" : worker.state === "retrying" ? "#f87171" : "var(--text-secondary, #a8a49e)",
                        }}>
                          {formatWorkerState(worker.state)}
                        </span>
                      </td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "monospace", fontSize: 10, color: "var(--text-secondary, #a8a49e)" }}>
                        {worker.speedBps > 0 ? formatSpeed(worker.speedBps) : "—"}
                      </td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontFamily: "monospace", fontSize: 10, color: "var(--text-secondary, #a8a49e)" }}>
                        {formatBytes(worker.transferredBytes)}
                      </td>
                      <td style={{ padding: "6px 10px", fontFamily: "monospace", fontSize: 9, color: "var(--text-tertiary, #6b6863)" }}>
                        {formatWorkerRange(worker)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* Error alert */}
      {error ? (
        <div style={{
          padding: "8px 12px",
          borderRadius: 8,
          background: "rgba(239, 68, 68, 0.08)",
          border: "1px solid rgba(239, 68, 68, 0.2)",
          fontSize: 11,
          color: "#fca5a5",
        }}>
          {error}
        </div>
      ) : null}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      padding: "8px 10px",
      borderRadius: 8,
      border: "1px solid var(--border-color, rgba(255,255,255,0.07))",
      background: "var(--bg-card, #1a1c20)",
    }}>
      <p style={{ margin: 0, fontSize: 9, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.15em", color: "var(--text-tertiary, #6b6863)" }}>
        {label}
      </p>
      <p style={{ margin: "2px 0 0 0", fontSize: 13, fontWeight: 600, color: "var(--text-primary, #f0ede8)" }}>
        {value}
      </p>
    </div>
  );
}

function ActionBtn({ label, onClick, variant = "default" }: { label: string; onClick: () => void; variant?: "default" | "danger" }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "6px 14px",
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 500,
        border: variant === "danger"
          ? "1px solid rgba(239, 68, 68, 0.25)"
          : "1px solid var(--border-color, rgba(255,255,255,0.07))",
        background: variant === "danger"
          ? "rgba(239, 68, 68, 0.1)"
          : "var(--bg-card, #1a1c20)",
        color: variant === "danger" ? "#fca5a5" : "var(--text-primary, #f0ede8)",
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
    >
      {label}
    </button>
  );
}
