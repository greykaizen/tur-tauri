import React, { useEffect, useRef, useState, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Store } from "@tauri-apps/plugin-store";
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
import { openUrl } from "@tauri-apps/plugin-opener";

import type { DownloadItem, DownloadStatus, FilterMode } from "./types";

import {
  SettingsDialog,
  type SettingsSection,
} from "./components/SettingsDialog";
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
  Heart,
  Info,
  LogOut,
  Play,
  Pause,
  Trash2,
  ChevronRight,
  Minus,
  Monitor,
  Moon,
  Square,
  Settings2,
  Sun,
  X,
} from "lucide-react";

// ─── File type icon ───────────────────────────────────────────────────────────

type FtInfo = { Icon: React.ElementType; color: string };

function fileType(name: string): FtInfo {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v"].includes(ext))
    return { Icon: FileVideo, color: "#a78bfa" };
  if (["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "opus"].includes(ext))
    return { Icon: FileAudio, color: "#f472b6" };
  if (
    [
      "zip",
      "rar",
      "7z",
      "tar",
      "gz",
      "bz2",
      "xz",
      "zst",
      "iso",
      "cab",
    ].includes(ext)
  )
    return { Icon: FileArchive, color: "#fbbf24" };
  if (
    [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "svg",
      "bmp",
      "tiff",
      "heic",
    ].includes(ext)
  )
    return { Icon: FileImage, color: "#38bdf8" };
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "txt", "epub"].includes(ext))
    return { Icon: FileText, color: "#fb7185" };
  if (
    ["exe", "msi", "deb", "rpm", "appimage", "dmg", "apk", "pkg"].includes(ext)
  )
    return { Icon: Package, color: "#4ade80" };
  if (["html", "htm", "php"].includes(ext))
    return { Icon: Globe, color: "#60a5fa" };
  return { Icon: File, color: "var(--muted-foreground)" };
}

// ─── Status display ───────────────────────────────────────────────────────────

const STATUS_META: Record<
  DownloadStatus,
  { label: string; dot: string; text: string }
> = {
  downloading: {
    label: "Downloading",
    dot: "bg-blue-400",
    text: "text-blue-400",
  },
  queued: { label: "Queued", dot: "bg-amber-400", text: "text-amber-400" },
  paused: { label: "Paused", dot: "bg-amber-500", text: "text-amber-500" },
  stopped: { label: "Stopped", dot: "bg-slate-500", text: "text-slate-400" },
  completed: {
    label: "Complete",
    dot: "bg-emerald-400",
    text: "text-emerald-400",
  },
  error: { label: "Failed", dot: "bg-red-400", text: "text-red-400" },
};

function StatusPill({ status }: { status: DownloadStatus }) {
  const m = STATUS_META[status];
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`size-[7px] rounded-full shrink-0 ${m.dot} ${status === "downloading" ? "animate-pulse" : ""}`}
      />
      <span className={`text-[12px] ${m.text}`}>{m.label}</span>
    </span>
  );
}

// ─── Sidebar nav item ─────────────────────────────────────────────────────────

function NavItem({
  icon,
  label,
  count,
  active,
  collapsed,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "flex items-center rounded-md transition-colors select-none",
        collapsed
          ? "justify-center w-10 h-10 mx-auto"
          : "w-full gap-2.5 px-3 py-[6px] text-[13px] text-left",
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
            <span
              className={`text-[11px] px-1.5 py-px rounded tabular-nums ${active ? "bg-blue-500/20 text-blue-400" : "bg-white/8 text-muted-foreground"}`}
            >
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
const STORE_KEY_NOTIFY_ON_COMPLETE = "notifyOnComplete";
const STORE_KEY_NOTIFY_ON_FAILURE = "notifyOnFailure";
const DOWNLOAD_EVENT = "download-update";
const PROJECT_URL = "https://github.com/greykaizen/tur-rs";
const DONATE_URL = PROJECT_URL;

// ─── Notifications ────────────────────────────────────────────────────────────

async function notificationPermissionGranted(): Promise<boolean> {
  let granted = await isPermissionGranted();
  if (!granted) granted = (await requestPermission()) === "granted";
  return granted;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [directory, setDirectory] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isThemeSubmenuOpen, setIsThemeSubmenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [isTogglingAutostart, setIsTogglingAutostart] = useState(false);
  const [notifyOnComplete, setNotifyOnComplete] = useState(true);
  const [notifyOnFailure, setNotifyOnFailure] = useState(true);

  const [theme, setTheme] = useState<"light" | "dark" | "system">(() => {
    return (
      (localStorage.getItem("tur-theme") as "light" | "dark" | "system") ||
      "system"
    );
  });

  const storeRef = useRef<Store | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const titlebarRef = useRef<HTMLElement | null>(null);
  const notifyPrefsRef = useRef({
    notifyOnComplete: true,
    notifyOnFailure: true,
  });
  const appWindowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null);
  const platformRef = useRef<"mac" | "linux" | "windows">("windows");

  if (!appWindowRef.current) {
    try {
      appWindowRef.current = getCurrentWindow();
    } catch {
      appWindowRef.current = null;
    }
  }

  if (typeof navigator !== "undefined") {
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } })
        .userAgentData?.platform ??
      navigator.platform ??
      "";
    platformRef.current = /mac/i.test(platform)
      ? "mac"
      : /linux/i.test(platform)
        ? "linux"
        : "windows";
  }

  // ── Theme Sync ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    if (theme === "system") {
      const systemDark = window.matchMedia(
        "(prefers-color-scheme: dark)",
      ).matches;
      if (systemDark) root.classList.add("dark");
    } else {
      root.classList.add(theme);
    }
    localStorage.setItem("tur-theme", theme);
  }, [theme]);

  useEffect(() => {
    notifyPrefsRef.current = { notifyOnComplete, notifyOnFailure };
  }, [notifyOnComplete, notifyOnFailure]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
        setIsThemeSubmenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isMenuOpen]);

  useEffect(() => {
    const titlebar = titlebarRef.current;
    const appWindow = appWindowRef.current;
    if (!titlebar || !appWindow) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'button, a, input, textarea, select, summary, [role="button"], [data-no-drag="true"]',
        )
      ) {
        return;
      }

      if (event.detail === 2) {
        void appWindow.toggleMaximize();
        return;
      }

      void appWindow.startDragging();
    };

    titlebar.addEventListener("mousedown", handleMouseDown);
    return () => titlebar.removeEventListener("mousedown", handleMouseDown);
  }, []);

  async function notifyStatusChange(item: DownloadItem) {
    const shouldNotify =
      (item.status === "completed" &&
        notifyPrefsRef.current.notifyOnComplete) ||
      (item.status === "error" && notifyPrefsRef.current.notifyOnFailure);
    if (!shouldNotify) return;
    if (!(await notificationPermissionGranted())) return;
    sendNotification({
      title:
        item.status === "completed" ? "Download Complete" : "Download Failed",
      body: item.filename,
    });
  }

  // ── Bootstrap (gracefully falls back to MOCK if no Tauri) ─────────────────
  useEffect(() => {
    let mounted = true;
    let disposed = false;
    let unlistenDownload: (() => void) | undefined;
    let unlistenFocusAdd: (() => void) | undefined;
    const bootstrap = async () => {
      try {
        const store = await Store.load(STORE_PATH, {
          autoSave: 150,
          defaults: {
            [STORE_KEY_DIR]: "",
            [STORE_KEY_NOTIFY_ON_COMPLETE]: true,
            [STORE_KEY_NOTIFY_ON_FAILURE]: true,
          },
        });
        if (disposed) return;
        storeRef.current = store;
        const saved = await store.get<string>(STORE_KEY_DIR);
        if (mounted && saved) setDirectory(saved);
        const savedNotifyOnComplete =
          (await store.get<boolean>(STORE_KEY_NOTIFY_ON_COMPLETE)) ?? true;
        const savedNotifyOnFailure =
          (await store.get<boolean>(STORE_KEY_NOTIFY_ON_FAILURE)) ?? true;
        if (mounted) {
          setNotifyOnComplete(savedNotifyOnComplete);
          setNotifyOnFailure(savedNotifyOnFailure);
        }

        const autostart = await isAutostartEnabled();
        if (mounted) setAutostartEnabled(autostart);

        const rows = await invoke<DownloadItem[]>("list_downloads");
        if (mounted)
          setDownloads([...rows].sort((a, b) => b.createdAtMs - a.createdAtMs));

        unlistenDownload = await listen<DownloadItem>(DOWNLOAD_EVENT, (ev) => {
          const next = ev.payload;
          setDownloads((cur) => {
            const previous = cur.find((item) => item.id === next.id);
            if (
              !previous &&
              (next.status === "completed" || next.status === "error")
            ) {
              void notifyStatusChange(next);
              if (next.status === "completed") {
                try { invoke("open_completion_window", { taskId: next.id }); } catch {}
              }
            }
            if (
              previous &&
              previous.status !== next.status &&
              (next.status === "completed" || next.status === "error")
            ) {
              void notifyStatusChange(next);
              if (next.status === "completed") {
                try { invoke("open_completion_window", { taskId: next.id }); } catch {}
              }
            }
            const merged = [next, ...cur.filter((d) => d.id !== next.id)];
            return merged.sort((a, b) => b.createdAtMs - a.createdAtMs);
          });
        });

        unlistenFocusAdd = await listen("focus-add-download", () => {
          if (mounted) {
            try { invoke("open_confirmation_window"); } catch {}
            setIsMenuOpen(false);
          }
        });

        if (disposed) {
          unlistenDownload?.();
          unlistenFocusAdd?.();
        }
      } catch {
        // No Tauri context — keep MOCK data, that's fine
      }
    };

    void bootstrap();
    return () => {
      mounted = false;
      disposed = true;
      unlistenDownload?.();
      unlistenFocusAdd?.();
    };
  }, []);

  async function persistDir(dir: string) {
    setDirectory(dir);
    await storeRef.current?.set(STORE_KEY_DIR, dir);
  }

  async function persistBoolean(key: string, value: boolean) {
    await storeRef.current?.set(key, value);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function doAction(action: "pause" | "resume" | "cancel", id: string) {
    try {
      await invoke(`${action}_download`, { id });
    } catch {
      /* no Tauri */
    }
  }

  async function doRemove(id: string) {
    try {
      await invoke("remove_download", { id });
    } catch {
      /* no Tauri */
    }
    setDownloads((cur) => cur.filter((d) => d.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  async function openFolder(path: string) {
    try {
      await invoke("open_download_folder", { path });
    } catch {
      /* no Tauri */
    }
  }

  async function openInstance(id: string) {
    const d = downloads.find((x) => x.id === id);
    if (d?.status === "completed") {
      try {
        await invoke("open_download_file", {
          path: `${d.directory}/${d.filename}`,
        });
      } catch {
        /* ignore */
      }
      return;
    }

    try {
      await invoke("open_instance_window", { taskId: id });
    } catch {
      /* no Tauri */
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url).catch(() => {});
  }

  async function handleAutostartToggle() {
    setIsTogglingAutostart(true);
    try {
      if (autostartEnabled) {
        await disableAutostart();
        setAutostartEnabled(false);
      } else {
        await enableAutostart();
        setAutostartEnabled(true);
      }
    } finally {
      setIsTogglingAutostart(false);
    }
  }

  async function handleToggleNotifyOnComplete() {
    const next = !notifyOnComplete;
    setNotifyOnComplete(next);
    await persistBoolean(STORE_KEY_NOTIFY_ON_COMPLETE, next);
  }

  async function handleToggleNotifyOnFailure() {
    const next = !notifyOnFailure;
    setNotifyOnFailure(next);
    await persistBoolean(STORE_KEY_NOTIFY_ON_FAILURE, next);
  }

  function openSettingsSection(section: SettingsSection) {
    setSettingsSection(section);
    setIsSettingsOpen(true);
    setIsMenuOpen(false);
    setIsThemeSubmenuOpen(false);
  }

  async function openProjectUrl() {
    try {
      await openUrl(PROJECT_URL);
    } catch {
      /* no opener */
    }
  }

  async function openDonateUrl() {
    try {
      await openUrl(DONATE_URL);
    } catch {
      /* no opener */
    }
  }

  async function quitApp() {
    try {
      await invoke("quit_app");
    } catch {
      /* no Tauri */
    }
  }

  async function minimizeWindow() {
    await appWindowRef.current?.minimize();
  }

  async function toggleMaximizeWindow() {
    await appWindowRef.current?.toggleMaximize();
  }

  async function closeWindow() {
    await appWindowRef.current?.close();
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    let active = 0,
      paused = 0,
      completed = 0,
      errors = 0;
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
      case "active":
        list = list.filter(
          (d) => d.status === "downloading" || d.status === "queued",
        );
        break;
      case "paused":
        list = list.filter(
          (d) => d.status === "paused" || d.status === "stopped",
        );
        break;
      case "completed":
        list = list.filter((d) => d.status === "completed");
        break;
      case "errors":
        list = list.filter((d) => d.status === "error");
        break;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (d) =>
          d.filename.toLowerCase().includes(q) ||
          d.url.toLowerCase().includes(q),
      );
    }
    return list;
  }, [downloads, filter, search]);

  const totalSpeed = useMemo(
    () =>
      downloads
        .filter((d) => d.status === "downloading")
        .reduce((s, d) => s + d.speedBps, 0),
    [downloads],
  );

  const platform = platformRef.current;
  const showLeftWindowControls = platform !== "windows";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-screen w-full flex-col overflow-hidden rounded-xl ring-1 ring-border bg-background text-foreground">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header
        ref={titlebarRef}
        data-tauri-drag-region
        className="flex h-14 shrink-0 items-center gap-3 bg-background px-3"
      >
        <div className="flex items-center gap-3">
          {showLeftWindowControls && (
            <div className="flex items-center gap-2 pr-1" data-no-drag="true">
              <button
                type="button"
                onClick={() => void closeWindow()}
                className="group flex size-3.5 items-center justify-center rounded-full bg-[#ff5f57]"
                aria-label="Close window"
              >
                <X className="size-2.5 text-black/55 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2.4} />
              </button>
              <button
                type="button"
                onClick={() => void minimizeWindow()}
                className="group flex size-3.5 items-center justify-center rounded-full bg-[#febc2e]"
                aria-label="Minimize window"
              >
                <Minus className="size-2.5 text-black/55 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2.4} />
              </button>
              <button
                type="button"
                onClick={() => void toggleMaximizeWindow()}
                className="group flex size-3.5 items-center justify-center rounded-full bg-[#28c840]"
                aria-label="Maximize window"
              >
                <Square className="size-2 text-black/55 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2.4} />
              </button>
            </div>
          )}

          <button
            onClick={() => setSidebarOpen((o) => !o)}
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="Toggle sidebar"
          >
            <PanelLeft size={18} strokeWidth={2.1} />
          </button>
          <div className="flex items-center gap-3 select-none">
            <img src="/tur.png" alt="tur" className="h-8 w-8 object-contain" />
            <div className="flex flex-col">
              <span className="text-[22px] font-black leading-none tracking-[-0.04em] lowercase">
                tur
              </span>
              <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                download manager
              </span>
            </div>
          </div>
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5">
          <button className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            <Search size={17} strokeWidth={2.1} />
          </button>
          <button
            onClick={() => {
              try {
                invoke("open_confirmation_window");
              } catch {}
            }}
            className="flex h-9 items-center gap-1.5 rounded-full bg-blue-500 px-4 text-[13px] font-semibold text-white transition-colors select-none hover:bg-blue-600 active:bg-blue-700"
          >
            <Plus size={16} strokeWidth={2.1} /> New
          </button>
          <div ref={menuRef} className="relative">
            <button
              onClick={() => {
                setIsMenuOpen((open) => !open);
                setIsThemeSubmenuOpen(false);
              }}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="Settings and app menu"
            >
              <Menu size={17} strokeWidth={2.1} />
            </button>

            {isMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+10px)] z-[100] w-[220px] rounded-2xl border border-border bg-popover p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
                <div className="space-y-0.5">
                  <button
                    type="button"
                    onClick={() => setIsThemeSubmenuOpen((open) => !open)}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Monitor size={15} />
                    <span className="flex-1">Theme</span>
                    <span className="text-[11px] capitalize text-muted-foreground">
                      {theme}
                    </span>
                    <ChevronRight
                      size={14}
                      className={`text-muted-foreground transition-transform ${isThemeSubmenuOpen ? "rotate-90" : ""}`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => openSettingsSection("general")}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Settings2 size={15} />
                    <span className="flex-1">Settings</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => openSettingsSection("about")}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Info size={15} />
                    <span className="flex-1">About</span>
                  </button>
                  <button
                    type="button"
                    onClick={openDonateUrl}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <Heart size={15} />
                    <span className="flex-1">Donate</span>
                  </button>
                  <div className="my-1 h-px bg-border" />
                  <button
                    type="button"
                    onClick={quitApp}
                    className="flex w-full items-center gap-2 rounded-xl bg-destructive/6 px-3 py-2.5 text-left text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10"
                  >
                    <LogOut size={15} />
                    <span className="flex-1">Quit</span>
                  </button>
                </div>

                {isThemeSubmenuOpen && (
                  <div className="absolute right-[calc(100%+8px)] top-1.5 z-[110] w-[176px] rounded-2xl border border-border bg-popover p-1.5 shadow-[0_24px_80px_rgba(0,0,0,0.16)]">
                    {(
                      [
                        { value: "system", label: "System", icon: Monitor },
                        { value: "dark", label: "Dark", icon: Moon },
                        { value: "light", label: "Light", icon: Sun },
                      ] as const
                    ).map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => {
                          setTheme(value);
                          setIsThemeSubmenuOpen(false);
                          setIsMenuOpen(false);
                        }}
                        className={[
                          "flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors",
                          theme === value
                            ? "bg-muted text-foreground"
                            : "text-foreground hover:bg-muted",
                        ].join(" ")}
                      >
                        <Icon size={15} />
                        <span className="flex-1">{label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {!showLeftWindowControls && (
            <div className="ml-2 flex items-center gap-1 rounded-lg border border-border/80 bg-muted/45 p-1">
              <button
                type="button"
                onClick={() => void minimizeWindow()}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                aria-label="Minimize window"
              >
                <Minus size={14} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                onClick={() => void toggleMaximizeWindow()}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                aria-label="Maximize window"
              >
                <Square size={12} strokeWidth={2.2} />
              </button>
              <button
                type="button"
                onClick={() => void closeWindow()}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                aria-label="Close window"
              >
                <X size={14} strokeWidth={2.2} />
              </button>
            </div>
          )}
        </div>
      </header>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">
        {/* ── Collapsible sidebar ───────────────────────────────────────── */}
        <div
          className="sidebar-panel"
          style={{ width: sidebarOpen ? 200 : 56 }}
        >
          <div
            className="sidebar-panel-inner"
            style={{ width: sidebarOpen ? 200 : 56, overflow: "hidden" }}
          >
            <div className="pt-3 px-2 pb-2">
              <div className="space-y-1">
                <NavItem
                  icon={<LayoutGrid size={16} />}
                  label="All"
                  count={stats.all}
                  active={filter === "all"}
                  collapsed={!sidebarOpen}
                  onClick={() => setFilter("all")}
                />
                <NavItem
                  icon={<Loader2 size={16} />}
                  label="Active"
                  count={stats.active}
                  active={filter === "active"}
                  collapsed={!sidebarOpen}
                  onClick={() => setFilter("active")}
                />
                <NavItem
                  icon={<PauseCircle size={16} />}
                  label="Paused"
                  count={stats.paused}
                  active={filter === "paused"}
                  collapsed={!sidebarOpen}
                  onClick={() => setFilter("paused")}
                />
                <NavItem
                  icon={<CheckCircle2 size={16} />}
                  label="Completed"
                  count={stats.completed}
                  active={filter === "completed"}
                  collapsed={!sidebarOpen}
                  onClick={() => setFilter("completed")}
                />
                <NavItem
                  icon={<AlertCircle size={16} />}
                  label="Failed"
                  count={stats.errors}
                  active={filter === "errors"}
                  collapsed={!sidebarOpen}
                  onClick={() => setFilter("errors")}
                />
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
              className="flex items-center shrink-0 border-b bg-muted/50 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground select-none"
              style={{ paddingLeft: 12, paddingRight: 12, height: 32 }}
            >
              <div style={{ width: 26, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>File</div>
              <div style={{ width: 90, textAlign: "right", flexShrink: 0 }}>
                Size
              </div>
              <div style={{ width: 130, paddingLeft: 16, flexShrink: 0 }}>
                Status
              </div>
              <div style={{ width: 82, textAlign: "right", flexShrink: 0 }}>
                Speed
              </div>
              <div style={{ width: 58, textAlign: "right", flexShrink: 0 }}>
                ETA
              </div>
              <div style={{ width: 80, textAlign: "right", flexShrink: 0 }}>
                Date
              </div>
              <div style={{ width: 130, paddingLeft: 16, flexShrink: 0 }}>
                Save To
              </div>
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
                          "hover:bg-muted/70",
                          isSel
                            ? "bg-blue-500/12 hover:bg-blue-500/16"
                            : isEven
                              ? "bg-transparent"
                              : "bg-[var(--row-alt)]",
                        ].join(" ")}
                        style={{
                          paddingLeft: 12,
                          paddingRight: 12,
                          paddingTop: 9,
                          paddingBottom: 9,
                        }}
                        onClick={() => setSelectedId(isSel ? null : d.id)}
                        onDoubleClick={() => openInstance(d.id)}
                      >
                        {/* Full-row background progress fill */}
                        {isActive && (
                          <div
                            className="absolute inset-y-0 left-0 bg-emerald-500/15 pointer-events-none transition-all duration-100 ease-linear"
                            style={{ width: `${d.progress * 100}%` }}
                          />
                        )}

                        {/* File type icon */}
                        <div
                          style={{
                            width: 26,
                            flexShrink: 0,
                            position: "relative",
                          }}
                        >
                          <Icon size={15} color={color} />
                        </div>

                        {/* Filename + URL */}
                        <div
                          style={{ flex: 1, minWidth: 0, position: "relative" }}
                        >
                          <p
                            className="text-[14px] font-semibold truncate leading-snug tracking-[-0.01em] flex items-center gap-2"
                            title={d.filename}
                          >
                            <span>{d.filename}</span>
                            {d.engineId && d.engineId !== "tur" && (
                              <span className="px-1.5 py-0.5 rounded-sm bg-muted text-[10px] text-muted-foreground font-mono uppercase leading-none">
                                {d.engineId}
                              </span>
                            )}
                            {d.plugins && d.plugins.length > 0 && (
                              <span className="px-1.5 py-0.5 rounded-sm bg-blue-500/10 text-blue-500 text-[10px] font-mono uppercase leading-none">
                                +{d.plugins[0]}
                              </span>
                            )}
                          </p>
                          <p
                            className="text-[12px] text-muted-foreground truncate leading-snug mt-0.5"
                            title={d.url}
                          >
                            {d.url}
                          </p>
                        </div>

                        {/* Size */}
                        <div
                          className="text-[12px] tabular-nums text-muted-foreground shrink-0 text-right relative font-medium"
                          style={{ width: 90 }}
                        >
                          {d.totalSize > 0 ? (
                            isActive ? (
                              <>
                                <span>{formatBytes(d.totalSize)}</span>
                              </>
                            ) : (
                              formatBytes(d.totalSize)
                            )
                          ) : (
                            "—"
                          )}
                        </div>

                        {/* Status */}
                        <div
                          style={{
                            width: 130,
                            paddingLeft: 16,
                            flexShrink: 0,
                            position: "relative",
                          }}
                        >
                          <StatusPill status={d.status} />
                          {isActive && (
                            <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5 leading-none">
                              {formatBytes(d.downloadedBytes)} ·{" "}
                              {Math.round(d.progress * 100)}%
                            </p>
                          )}
                        </div>

                        {/* Speed */}
                        <div
                          className="text-[12px] tabular-nums shrink-0 text-right relative"
                          style={{
                            width: 82,
                            color: isActive
                              ? "var(--c-blue)"
                              : "var(--muted-foreground)",
                          }}
                        >
                          {isActive ? formatSpeed(d.speedBps) : "—"}
                        </div>

                        {/* ETA */}
                        <div
                          className="text-[12px] tabular-nums text-muted-foreground shrink-0 text-right relative"
                          style={{ width: 58 }}
                        >
                          {isActive ? formatEta(d) : "—"}
                        </div>

                        {/* Date */}
                        <div
                          className="text-[12px] tabular-nums text-muted-foreground shrink-0 text-right relative"
                          style={{ width: 80 }}
                        >
                          {new Date(d.createdAtMs).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )}
                        </div>

                        {/* Save To */}
                        <div
                          className="text-[12px] text-muted-foreground shrink-0 truncate relative"
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
                      {(d.status === "paused" ||
                        d.status === "stopped" ||
                        d.status === "error") && (
                        <ContextMenuItem
                          onClick={() => doAction("resume", d.id)}
                        >
                          <Play size={13} className="mr-2" /> Resume
                        </ContextMenuItem>
                      )}
                      {d.status === "downloading" && (
                        <ContextMenuItem
                          onClick={() => doAction("pause", d.id)}
                        >
                          <Pause size={13} className="mr-2" /> Pause
                        </ContextMenuItem>
                      )}
                      {!["completed", "error"].includes(d.status) && (
                        <ContextMenuItem
                          onClick={() => doAction("cancel", d.id)}
                        >
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
      <div className="flex items-center gap-3 px-4 h-7 border-t bg-card shrink-0 text-[12px] text-muted-foreground select-none">
        {stats.active > 0 ? (
          <>
            <span
              style={{ color: "var(--c-blue)" }}
              className="tabular-nums flex items-center gap-1"
            >
              <Loader2 size={10} className="spin-slow" />
              {formatSpeed(totalSpeed)}
            </span>
            <span className="opacity-30">·</span>
          </>
        ) : null}
        <span>
          {stats.all} item{stats.all !== 1 ? "s" : ""}
        </span>
        {stats.active > 0 && (
          <>
            <span className="opacity-30">·</span>
            <span>{stats.active} downloading</span>
          </>
        )}
        {stats.completed > 0 && (
          <>
            <span className="opacity-30">·</span>
            <span>{stats.completed} complete</span>
          </>
        )}
        {stats.errors > 0 && (
          <>
            <span className="opacity-30">·</span>
            <span style={{ color: "var(--c-red)" }}>{stats.errors} failed</span>
          </>
        )}
      </div>


      <SettingsDialog
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        section={settingsSection}
        onSectionChange={setSettingsSection}
        theme={theme}
        onThemeChange={setTheme}
        autostartEnabled={autostartEnabled}
        isTogglingAutostart={isTogglingAutostart}
        onToggleAutostart={handleAutostartToggle}
        notifyOnComplete={notifyOnComplete}
        notifyOnFailure={notifyOnFailure}
        onToggleNotifyOnComplete={handleToggleNotifyOnComplete}
        onToggleNotifyOnFailure={handleToggleNotifyOnFailure}
        onOpenDonate={openDonateUrl}
        onOpenProject={openProjectUrl}
        onQuit={quitApp}
      />
    </div>
  );
}
