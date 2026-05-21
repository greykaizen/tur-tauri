import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Store } from "@tauri-apps/plugin-store";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import {
  File,
  FileVideo,
  FileAudio,
  FileArchive,
  FileImage,
  FileText,
  Package,
  Globe,
} from "lucide-react";
import type { DownloadItem } from "./types";

function fileType(url: string) {
  const ext = url.split(".").pop()?.toLowerCase() ?? "";
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

import { Titlebar } from "./components/Titlebar";

export default function ConfirmationView() {
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("General");
  const [saveDir, setSaveDir] = useState("");
  const [filename, setFilename] = useState("");
  const [useAuth, setUseAuth] = useState(false);
  const [user, setUser] = useState("");
  const [engine, setEngine] = useState("tur");
  const [plugins, setPlugins] = useState<string[]>([]);

  const { Icon, color } = fileType(filename || url);

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

  // ── Load Last Directory ────────────────────────────────────────────────────
  useEffect(() => {
    Store.load("tur-settings.json").then((store) => {
      store.get<string>("lastDownloadDirectory").then((dir) => {
        if (dir) setSaveDir(dir);
      });
    });
  }, []);

  async function handleBrowse() {
    const selected = await openDialog({
      directory: true,
      title: "Choose save directory",
      defaultPath: saveDir || undefined,
    });
    if (typeof selected === "string" && selected.length > 0) {
      setSaveDir(selected);
      Store.load("tur-settings.json").then((s) =>
        s.set("lastDownloadDirectory", selected),
      );
    }
  }

  async function start(later: boolean) {
    if (!url.trim() || !saveDir.trim()) return;
    try {
      const headers = [];
      if (useAuth && user && password) {
        headers.push({
          name: "Authorization",
          value: "Basic " + btoa(`${user}:${password}`),
        });
      }

      const rows = await invoke<DownloadItem[]>("start_download", {
        input: {
          urls: [url.trim()],
          directory: saveDir.trim(),
          filename: filename.trim() || null,
          engineId: engine,
          plugins,
          referer: null,
          bearerToken: null,
          cookieFile: null,
          headers,
        },
      });
      if (rows.length > 0) {
        if (later) {
          await invoke("pause_download", { id: rows[0].id });
          try { await getCurrentWindow().close(); } catch {}
        } else {
          try {
            await invoke("open_instance_window", { taskId: rows[0].id });
            setTimeout(async () => {
              try { await getCurrentWindow().close(); } catch {}
            }, 500);
          } catch (err) {
            console.error("Failed to open instance window:", err);
          }
        }
      } else {
        try { await getCurrentWindow().close(); } catch {}
      }
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground font-sans text-[13px] select-none rounded-xl ring-1 ring-border overflow-hidden">
      <Titlebar />
      <div className="flex flex-col flex-1 p-4 overflow-y-auto">
        <div className="flex gap-4 mb-4">
          <div className="shrink-0 pt-1">
            <Icon size={48} color={color} />
          </div>
          <div className="flex-1 flex flex-col gap-3">
            <div className="grid grid-cols-[80px_1fr] items-center gap-2">
              <label className="text-right font-medium text-muted-foreground">
                URL
              </label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://..."
                className="h-7 text-[13px] rounded-sm"
                autoFocus
              />

              <label className="text-right font-medium text-muted-foreground">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-7 px-2 border border-input rounded-sm bg-transparent text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option>General</option>
                <option>Programs</option>
                <option>Music</option>
                <option>Video</option>
                <option>Documents</option>
              </select>

              <label className="text-right font-medium text-muted-foreground">
                Engine
              </label>
              <select
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
                className="h-7 px-2 border border-input rounded-sm bg-transparent text-[13px] focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="tur">tur-rs (Native)</option>
                <option value="aria2c">aria2c (External)</option>
              </select>

              <label className="text-right font-medium text-muted-foreground">
                Save As
              </label>
              <div className="flex gap-1">
                <Input
                  value={saveDir}
                  onChange={(e) => setSaveDir(e.target.value)}
                  className="h-7 text-[13px] rounded-sm flex-1"
                  placeholder="/path/to/folder"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 rounded-sm"
                  onClick={handleBrowse}
                >
                  ...
                </Button>
              </div>

              <label className="text-right font-medium text-muted-foreground">
                File Name
              </label>
              <Input
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                className="h-7 text-[13px] rounded-sm"
                placeholder="(optional)"
              />
            </div>
          </div>
        </div>

        <div className="border-t pt-3 flex flex-col gap-2">

          <label className="flex items-center gap-2 font-medium mt-1 text-muted-foreground">
            <input
              type="checkbox"
              checked={useAuth}
              onChange={(e) => setUseAuth(e.target.checked)}
            />
            Use authorization
          </label>

          {useAuth && (
            <div className="grid grid-cols-[60px_1fr] items-center gap-2 ml-5 mt-1">
              <label className="text-right text-muted-foreground">User</label>
              <Input
                value={user}
                onChange={(e) => setUser(e.target.value)}
                className="h-7 text-[13px] rounded-sm"
              />
              <label className="text-right text-muted-foreground">
                Password
              </label>
              <Input
                value={password}
                type="password"
                onChange={(e) => setPassword(e.target.value)}
                className="h-7 text-[13px] rounded-sm"
              />
            </div>
          )}
        </div>
      </div>
      <div className="mt-auto p-4 pt-4 flex justify-end gap-2">
        <Button
          variant="outline"
          className="w-32 rounded-sm"
          onClick={() => start(true)}
        >
          Download Later
        </Button>
        <Button
          className="w-32 bg-blue-600 hover:bg-blue-700 text-white rounded-sm"
          onClick={() => start(false)}
        >
          Start Download
        </Button>
        <Button
          variant="outline"
          className="w-20 rounded-sm"
          onClick={() => {
            try {
              getCurrentWindow().close();
            } catch {}
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
