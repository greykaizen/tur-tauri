import React, { useEffect, useRef, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Store } from "@tauri-apps/plugin-store";

import type { DownloadItem, DownloadStatus, FilterMode } from "./types";
import { AddDownloadDialog } from "./components/AddDownloadDialog";
import { formatBytes, formatSpeed, formatEta } from "./lib/format";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import { ScrollArea } from "./components/ui/scroll-area";

import {
  Plus,
  Search,
  Menu,
  PanelLeft,
  Download,
  LayoutGrid,
  CheckCircle2,
  AlertCircle,
  Loader2,
  PauseCircle,
  FileVideo,
  FileAudio,
  FileArchive,
  FileImage,
  FileText,
  Package,
  Globe,
  File,
  FolderOpen,
  Copy,
  ExternalLink,
  Play,
  Pause,
  Trash2,
} from "lucide-react";

// ─── Mock data (shown when Tauri backend is unavailable) ──────────────────────

const MOCK: DownloadItem[] = [
  {
    id: "m1",
    filename: "Interstellar.2014.BluRay.2160p.mkv",
    url: "https://cdn.movies.example.com/releases/2014/interstellar-4k-bluray.mkv",
    directory: "/home/user/Downloads/Movies",
    downloadedBytes: 8_589_934_592,
    totalSize: 19_327_352_832,
    speedBps: 8_453_120,
    progress: 44.4,
    status: "downloading",
    protocol: "http2",
    createdAtMs: Date.now() - 600_000,
    workerSnapshots: [],
    errorMessage: null,
  },
  {
    id: "m2",
    filename: "Firefox-Setup-120.0.exe",
    url: "https://releases.mozilla.org/pub/firefox/releases/120.0/Firefox%20Setup%20120.0.exe",
    directory: "/home/user/Downloads",
    downloadedBytes: 56_000_000,
    totalSize: 56_000_000,
    speedBps: 0,
    progress: 100,
    status: "completed",
    protocol: "http2",
    createdAtMs: Date.now() - 3_600_000,
    workerSnapshots: [],
    errorMessage: null,
  },
  {
    id: "m3",
    filename: "ubuntu-23.10-desktop-amd64.iso",
    url: "https://releases.ubuntu.com/23.10/ubuntu-23.10-desktop-amd64.iso",
    directory: "/home/user/Downloads",
    downloadedBytes: 1_258_291_200,
    totalSize: 2_097_152_000,
    speedBps: 3_145_728,
    progress: 60,
    status: "downloading",
    protocol: "http2",
    createdAtMs: Date.now() - 120_000,
    workerSnapshots: [],
    errorMessage: null,
  },
  {
    id: "m4",
    filename: "Adobe-Premiere-Pro-2024-Setup.zip",
    url: "https://download.example.com/software/adobe/premiere-pro-2024-win-x64.zip",
    directory: "/home/user/Downloads/Software",
    downloadedBytes: 0,
    totalSize: 2_100_000_000,
    speedBps: 0,
    progress: 0,
    status: "queued",
    protocol: "auto",
    createdAtMs: Date.now() - 30_000,
    workerSnapshots: [],
    errorMessage: null,
  },
  {
    id: "m5",
    filename: "Bach_Goldberg_Variations_Glenn_Gould_1981.flac",
    url: "https://music.example.net/classical/bach/goldberg-variations-gould-1981.flac",
    directory: "/home/user/Music",
    downloadedBytes: 48_234_000,
    totalSize: 48_234_000,
    speedBps: 0,
    progress: 100,
    status: "completed",
    protocol: "http1",
    createdAtMs: Date.now() - 86_400_000,
    workerSnapshots: [],
    errorMessage: null,
  },
  {
    id: "m6",
    filename: "node-v21.5.0-linux-x64.tar.xz",
    url: "https://nodejs.org/dist/v21.5.0/node-v21.5.0-linux-x64.tar.xz",
    directory: "/home/user/Downloads",
    downloadedBytes: 12_000_000,
    totalSize: 40_000_000,
    speedBps: 0,
    progress: 30,
    status: "paused",
    protocol: "http2",
    createdAtMs: Date.now() - 1_800_000,
    workerSnapshots: [],
    errorMessage: null,
  },
  {
    id: "m7",
    filename: "project-source-v2.4.1.tar.gz",
    url: "https://github.com/example/repo/archive/refs/tags/v2.4.1.tar.gz",
    directory: "/home/user/Projects",
    downloadedBytes: 0,
    totalSize: 0,
    speedBps: 0,
    progress: 0,
    status: "error",
    protocol: "http2",
    createdAtMs: Date.now() - 7_200_000,
    workerSnapshots: [],
    errorMessage: "Connection timeout after 30s",
  },
  {
    id: "m8",
    filename: "Blender-4.0.2-windows-x64.msi",
    url: "https://mirror.freedif.org/blender/release/Blender4.0/blender-4.0.2-windows-x64.msi",
    directory: "/home/user/Downloads/Software",
    downloadedBytes: 220_000_000,
    totalSize: 220_000_000,
    speedBps: 0,
    progress: 100,
    status: "completed",
    protocol: "http2",
    createdAtMs: Date.now() - 172_800_000,
    workerSnapshots: [],
    errorMessage: null,
  },
];

// ─── File type icon ───────────────────────────────────────────────────────────

type FtInfo = { Icon: React.ElementType; color: string };

function fileType(name: string): FtInfo {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4","mkv","avi","mov","wmv","flv","webm","m4v"].includes(ext)) return { Icon: FileVideo,   color: "#a78bfa" };
  if (["mp3","flac","wav","aac","ogg","m4a","wma","opus"].includes(ext)) return { Icon: FileAudio,   color: "#f472b6" };
  if (["zip","rar","7z","tar","gz","bz2","xz","zst","iso","cab"].includes(ext)) return { Icon: FileArchive, color: "#fbbf24" };
  if (["jpg","jpeg","png","gif","webp","svg","bmp","tiff","heic"].includes(ext)) return { Icon: FileImage,   color: "#38bdf8" };
  if (["pdf","doc","docx","xls","xlsx","ppt","txt","epub"].includes(ext))        return { Icon: FileText,    color: "#fb7185" };
  if (["exe","msi","deb","rpm","appimage","dmg","apk","pkg"].includes(ext))      return { Icon: Package,     color: "#4ade80" };
  if (["html","htm","php"].includes(ext))                                         return { Icon: Globe,       color: "#60a5fa" };
  return { Icon: File, color: "var(--muted-foreground)" };
}

// ─── Status display ───────────────────────────────────────────────────────────

const STATUS_META: Record<DownloadStatus, { label: string; dot: string; text: string }> = {
  downloading: { label: "Downloading", dot: "bg-blue-400",    text: "text-blue-400" },
  queued:      { label: "Queued",      dot: "bg-amber-400",   text: "text-amber-400" },
  paused:      { label: "Paused",      dot: "bg-amber-500",   text: "text-amber-500" },
  stopped:     { label: "Stopped",     dot: "bg-slate-500",   text: "text-slate-400" },
  completed:   { label: "Complete",    dot: "bg-emerald-400", text: "text-emerald-400" },
  error:       { label: "Failed",      dot: "bg-red-400",     text: "text-red-400" },
};

function StatusPill({ status }: { status: DownloadStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-[7px] rounded-full shrink-0 ${m.dot} ${status === "downloading" ? "animate-pulse" : ""}`} />
      <span className={`text-[12px] ${m.text}`}>{m.label}</span>
    </span>
  );
}

// ─── Sidebar nav item ─────────────────────────────────────────────────────────

function NavItem({
  icon, label, count, active, collapsed, onClick,
}: {
  icon: React.ReactNode; label: string; count: number; active: boolean; collapsed: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex items-center rounded-md transition-colors select-none",
        collapsed ? "justify-center w-10 h-10 mx-auto" : "w-full gap-2.5 px-3 py-[6px] text-[13px] text-left",
        active
          ? "bg-blue-500/15 text-blue-400"
          : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
      ].join(" ")}
      title={collapsed ? label : undefined}
    >
      {icon}
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{label}</span>
          {count > 0 && (
            <span className={`text-[11px] px-1.5 py-px rounded tabular-nums ${active ? "bg-blue-500/20 text-blue-400" : "bg-white/8 text-muted-foreground"}`}>
              {count}
            </span>
          )}
        </>
      )}
    </button>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STORE_PATH = "tur-settings.json";
const STORE_KEY_DIR = "lastDownloadDirectory";
const DOWNLOAD_EVENT = "download-update";

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [downloads, setDownloads] = useState<DownloadItem[]>(MOCK);
  const [directory, setDirectory] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const storeRef = useRef<Store | null>(null);

  // ── Bootstrap (gracefully falls back to MOCK if no Tauri) ─────────────────
  useEffect(() => {
    let mounted = true;
    const bootstrap = async () => {
      try {
        const store = await Store.load(STORE_PATH, {
          autoSave: 150,
          defaults: { [STORE_KEY_DIR]: "" },
        });
        storeRef.current = store;
        const saved = await store.get<string>(STORE_KEY_DIR);
        if (mounted && saved) setDirectory(saved);

        const rows = await invoke<DownloadItem[]>("list_downloads");
        // Only set downloads if we actually got rows from the backend
        // This ensures the dummy entries stay visible if the backend returns nothing yet
        if (mounted && rows.length > 0) setDownloads([...rows].sort((a, b) => b.createdAtMs - a.createdAtMs));

        const unlisten = await listen<DownloadItem>(DOWNLOAD_EVENT, (ev) => {
          const next = ev.payload;
          setDownloads((cur) => {
            const merged = [next, ...cur.filter((d) => d.id !== next.id)];
            return merged.sort((a, b) => b.createdAtMs - a.createdAtMs);
          });
        });

        return () => { mounted = false; unlisten(); };
      } catch {
        // No Tauri context — keep MOCK data, that's fine
      }
    };

    let cleanup: (() => void) | undefined;
    bootstrap().then((c) => (cleanup = c));
    return () => cleanup?.();
  }, []);

  async function persistDir(dir: string) {
    setDirectory(dir);
    await storeRef.current?.set(STORE_KEY_DIR, dir);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function doAction(action: "pause" | "resume" | "cancel", id: string) {
    try { await invoke(`${action}_download`, { id }); }
    catch { /* no Tauri */ }
  }

  async function doRemove(id: string) {
    try { await invoke("remove_download", { id }); } catch { /* no Tauri */ }
    setDownloads((cur) => cur.filter((d) => d.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  async function openFolder(path: string) {
    try { await invoke("open_download_folder", { path }); } catch { /* no Tauri */ }
  }

  async function openInstance(id: string) {
    try { await invoke("open_instance_window", { taskId: id }); } catch { /* no Tauri */ }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    let active = 0, paused = 0, completed = 0, errors = 0;
    for (const d of downloads) {
      if (d.status === "downloading" || d.status === "queued") active++;
      else if (d.status === "paused" || d.status === "stopped") paused++;
      else if (d.status === "completed") completed++;
      else if (d.status === "error") errors++;
    }
    return { all: downloads.length, active, paused, completed, errors };
  }, [downloads]);

  const filtered = useMemo(() => {
    let list = downloads;
    switch (filter) {
      case "active":    list = list.filter((d) => d.status === "downloading" || d.status === "queued"); break;
      case "paused":    list = list.filter((d) => d.status === "paused" || d.status === "stopped"); break;
      case "completed": list = list.filter((d) => d.status === "completed"); break;
      case "errors":    list = list.filter((d) => d.status === "error"); break;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((d) => d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q));
    }
    return list;
  }, [downloads, filter, search]);

  const totalSpeed = useMemo(
    () => downloads.filter((d) => d.status === "downloading").reduce((s, d) => s + d.speedBps, 0),
    [downloads],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground overflow-hidden">

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 px-4 h-14 shrink-0 bg-transparent">
        {/* Logo + sidebar toggle */}
        <div className="flex items-center gap-3 mr-1">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="size-8 flex items-center justify-center rounded hover:bg-white/8 transition-colors text-muted-foreground hover:text-foreground"
            title="Toggle sidebar"
          >
            <PanelLeft size={18} />
          </button>
          <div className="flex items-center gap-2 select-none">
            <img src="/tur.png" alt="Tur" className="w-5 h-5 object-contain" />
            <span className="font-semibold text-[17px] tracking-tight">Tur</span>
          </div>
        </div>

        {/* Center spacing */}
        <div className="flex-1" />

        {/* Right actions */}
        <div className="flex items-center gap-3">
          <button className="size-9 flex items-center justify-center rounded-full hover:bg-white/8 transition-colors text-muted-foreground hover:text-foreground">
            <Search size={18} />
          </button>
          <button
            onClick={() => setIsAddOpen(true)}
            className="flex items-center gap-1.5 px-5 h-9 rounded-full bg-blue-500 hover:bg-blue-600 active:bg-blue-700 text-white text-[14px] font-medium transition-colors select-none"
          >
            <Plus size={16} /> New
          </button>
          <button className="size-9 flex items-center justify-center rounded-md hover:bg-white/8 transition-colors text-muted-foreground hover:text-foreground ml-1">
            <Menu size={18} />
          </button>
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── Collapsible sidebar ───────────────────────────────────────── */}
        <div className="sidebar-panel" style={{ width: sidebarOpen ? 200 : 56 }}>
          <div className="sidebar-panel-inner" style={{ width: sidebarOpen ? 200 : 56, overflow: "hidden" }}>
            <div className="pt-3 px-2 pb-2">
              <div className="space-y-1">
                <NavItem icon={<LayoutGrid size={16} />}   label="All"        count={stats.all}       active={filter === "all"}       collapsed={!sidebarOpen} onClick={() => setFilter("all")} />
                <NavItem icon={<Loader2 size={16} />}      label="Active"     count={stats.active}    active={filter === "active"}    collapsed={!sidebarOpen} onClick={() => setFilter("active")} />
                <NavItem icon={<PauseCircle size={16} />}  label="Paused"     count={stats.paused}    active={filter === "paused"}    collapsed={!sidebarOpen} onClick={() => setFilter("paused")} />
                <NavItem icon={<CheckCircle2 size={16} />} label="Completed"  count={stats.completed} active={filter === "completed"} collapsed={!sidebarOpen} onClick={() => setFilter("completed")} />
                <NavItem icon={<AlertCircle size={16} />}  label="Failed"     count={stats.errors}    active={filter === "errors"}    collapsed={!sidebarOpen} onClick={() => setFilter("errors")} />
              </div>
            </div>
          </div>
        </div>

        {/* ── Main content ──────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 flex flex-col p-3 gap-0">

          {/* Download list container — rounded card */}
          <div className="flex-1 min-h-0 rounded-xl border bg-card flex flex-col overflow-hidden">

            {/* Column header */}
            <div
              className="flex items-center shrink-0 border-b bg-muted/30 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 select-none"
              style={{ paddingLeft: 12, paddingRight: 12, height: 32 }}
            >
              <div style={{ width: 26, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>File</div>
              <div style={{ width: 90, textAlign: "right", flexShrink: 0 }}>Size</div>
              <div style={{ width: 130, paddingLeft: 16, flexShrink: 0 }}>Status</div>
              <div style={{ width: 82, textAlign: "right", flexShrink: 0 }}>Speed</div>
              <div style={{ width: 58, textAlign: "right", flexShrink: 0 }}>ETA</div>
              <div style={{ width: 80, textAlign: "right", flexShrink: 0 }}>Date</div>
              <div style={{ width: 130, paddingLeft: 16, flexShrink: 0 }}>Save To</div>
            </div>

            {/* Rows */}
            <ScrollArea className="flex-1">
              {filtered.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground/40 select-none">
                  <Download size={32} className="mb-3 opacity-30" />
                  <p className="text-[13px]">No downloads</p>
                </div>
              )}

              {filtered.map((d, idx) => {
                const { Icon, color } = fileType(d.filename);
                const isActive = d.status === "downloading";
                const isSel = d.id === selectedId;
                const isEven = idx % 2 === 0;

                return (
                  <ContextMenu key={d.id}>
                    {/* @ts-expect-error — base-ui asChild */}
                    <ContextMenuTrigger asChild>
                      <div
                        className={[
                          "flex items-center relative cursor-default select-none transition-colors overflow-hidden",
                          "hover:bg-white/4",
                          isSel
                            ? "bg-blue-500/12 hover:bg-blue-500/16"
                            : isEven
                              ? "bg-transparent"
                              : "bg-white/[0.022]",
                        ].join(" ")}
                        style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 9, paddingBottom: 9 }}
                        onClick={() => setSelectedId(isSel ? null : d.id)}
                        onDoubleClick={() => openInstance(d.id)}
                      >
                        {/* Full-row background progress fill */}
                        {isActive && (
                          <div
                            className="absolute inset-y-0 left-0 bg-blue-500/10 pointer-events-none transition-all duration-500 ease-out"
                            style={{ width: `${d.progress}%` }}
                          />
                        )}

                        {/* File type icon */}
                        <div style={{ width: 26, flexShrink: 0, position: "relative" }}>
                          <Icon size={15} color={color} />
                        </div>

                        {/* Filename + URL */}
                        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
                          <p className="text-[13px] font-medium truncate leading-snug" title={d.filename}>
                            {d.filename}
                          </p>
                          <p className="text-[11px] text-muted-foreground/50 truncate leading-snug mt-px" title={d.url}>
                            {d.url}
                          </p>
                        </div>

                        {/* Size */}
                        <div
                          className="text-[12px] tabular-nums text-muted-foreground shrink-0 text-right relative"
                          style={{ width: 90 }}
                        >
                          {d.totalSize > 0 ? (
                            isActive
                              ? <><span>{formatBytes(d.totalSize)}</span></>
                              : formatBytes(d.totalSize)
                          ) : "—"}
                        </div>

                        {/* Status */}
                        <div style={{ width: 130, paddingLeft: 16, flexShrink: 0, position: "relative" }}>
                          <StatusPill status={d.status} />
                          {isActive && (
                            <p className="text-[11px] text-muted-foreground/60 tabular-nums mt-0.5 leading-none">
                              {formatBytes(d.downloadedBytes)} · {Math.round(d.progress)}%
                            </p>
                          )}
                        </div>

                        {/* Speed */}
                        <div
                          className="text-[12px] tabular-nums shrink-0 text-right relative"
                          style={{ width: 82, color: isActive ? "var(--c-blue)" : "var(--muted-foreground)" }}
                        >
                          {isActive ? formatSpeed(d.speedBps) : "—"}
                        </div>

                        {/* ETA */}
                        <div
                          className="text-[11px] tabular-nums text-muted-foreground shrink-0 text-right relative"
                          style={{ width: 58 }}
                        >
                          {isActive ? formatEta(d) : "—"}
                        </div>

                        {/* Date */}
                        <div
                          className="text-[11px] tabular-nums text-muted-foreground shrink-0 text-right relative"
                          style={{ width: 80 }}
                        >
                          {new Date(d.createdAtMs).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                        </div>

                        {/* Save To */}
                        <div
                          className="text-[11px] text-muted-foreground shrink-0 truncate relative"
                          style={{ width: 130, paddingLeft: 16 }}
                          title={d.directory}
                        >
                          {d.directory.split(/[\/\\]/).pop() || d.directory}
                        </div>
                      </div>
                    </ContextMenuTrigger>

                    <ContextMenuContent className="w-48">
                      <ContextMenuItem onClick={() => openInstance(d.id)}>
                        <ExternalLink size={13} className="mr-2" /> Open Details
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => openFolder(d.directory)}>
                        <FolderOpen size={13} className="mr-2" /> Open Folder
                      </ContextMenuItem>
                      <ContextMenuItem onClick={() => copyUrl(d.url)}>
                        <Copy size={13} className="mr-2" /> Copy URL
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      {(d.status === "paused" || d.status === "stopped" || d.status === "error") && (
                        <ContextMenuItem onClick={() => doAction("resume", d.id)}>
                          <Play size={13} className="mr-2" /> Resume
                        </ContextMenuItem>
                      )}
                      {d.status === "downloading" && (
                        <ContextMenuItem onClick={() => doAction("pause", d.id)}>
                          <Pause size={13} className="mr-2" /> Pause
                        </ContextMenuItem>
                      )}
                      {!["completed", "error"].includes(d.status) && (
                        <ContextMenuItem onClick={() => doAction("cancel", d.id)}>
                          Cancel
                        </ContextMenuItem>
                      )}
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        className="text-red-400 focus:text-red-400 focus:bg-red-400/8"
                        onClick={() => doRemove(d.id)}
                      >
                        <Trash2 size={13} className="mr-2" /> Remove
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </ScrollArea>
          </div>
        </div>
      </div>

      {/* ── Status bar ───────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-4 h-6 border-t bg-card shrink-0 text-[11px] text-muted-foreground/60 select-none">
        {stats.active > 0 ? (
          <>
            <span style={{ color: "var(--c-blue)" }} className="tabular-nums flex items-center gap-1">
              <Loader2 size={10} className="spin-slow" />
              {formatSpeed(totalSpeed)}
            </span>
            <span className="opacity-30">·</span>
          </>
        ) : null}
        <span>{stats.all} item{stats.all !== 1 ? "s" : ""}</span>
        {stats.active > 0 && <><span className="opacity-30">·</span><span>{stats.active} downloading</span></>}
        {stats.completed > 0 && <><span className="opacity-30">·</span><span>{stats.completed} complete</span></>}
        {stats.errors > 0 && <><span className="opacity-30">·</span><span style={{ color: "var(--c-red)" }}>{stats.errors} failed</span></>}
      </div>

      {/* ── Add URL dialog ────────────────────────────────────────────────── */}
      <AddDownloadDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        defaultDirectory={directory}
        onDirectoryChange={persistDir}
        onSuccess={(rows) => {
          setDownloads((cur) => {
            const m = new Map(cur.map((d) => [d.id, d]));
            for (const r of rows) m.set(r.id, r);
            return [...m.values()].sort((a, b) => b.createdAtMs - a.createdAtMs);
          });
        }}
      />
    </div>
  );
}
