export type DownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "stopped"
  | "completed"
  | "error";

export type WorkerState =
  | "connecting"
  | "waiting_for_work"
  | "downloading"
  | "retrying"
  | "paused"
  | "stopped"
  | "finished";

export type WorkerSnapshot = {
  connectionId: number;
  state: WorkerState;
  transferredBytes: number;
  speedBps: number;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  rangeCursor?: number | null;
  detail?: string | null;
};

export type DownloadItem = {
  id: string;
  url: string;
  filename: string;
  directory: string;
  engineId: string;
  plugins: string[];
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

export type ActionName = "pause" | "resume" | "cancel";

export type HeaderField = {
  name: string;
  value: string;
};

export type FilterMode = "all" | "active" | "paused" | "completed" | "errors";
