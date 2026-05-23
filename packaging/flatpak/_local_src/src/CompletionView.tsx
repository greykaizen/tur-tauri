import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button } from "./components/ui/button";
import { formatBytes } from "./lib/format";
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

export default function CompletionView() {
  const [download, setDownload] = useState<DownloadItem | null>(null);

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

  // ── Load Download ────────────────────────────────────────────────────────────
  useEffect(() => {
    const win = getCurrentWindow();
    const taskId = win.label.replace("download-completion:", "");

    invoke<DownloadItem>("get_download", { id: taskId })
      .then(setDownload)
      .catch(console.error);
  }, []);

  if (!download) {
    return <div className="p-4 text-muted-foreground text-sm">Loading...</div>;
  }

  const { Icon, color } = fileType(download.filename || download.url);

  async function handleOpen() {
    try {
      await invoke("open_download_file", {
        path: `${download!.directory}/${download!.filename}`,
      });
      await getCurrentWindow().close();
    } catch (e) {
      console.error(e);
    }
  }

  async function handleOpenFolder() {
    try {
      await invoke("open_download_folder", { path: download!.directory });
      await getCurrentWindow().close();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="flex flex-col h-screen w-full bg-background text-foreground font-sans text-[13px] select-none rounded-xl ring-1 ring-border overflow-hidden">
      <Titlebar />
      <div className="flex gap-4 p-4">
        <div className="shrink-0 pt-2 pl-2">
          <Icon size={48} color={color} />
        </div>
        <div className="flex-1 flex flex-col pt-1">
          <h2 className="text-[15px] font-semibold mb-3">Download complete</h2>

          <div className="grid grid-cols-[80px_1fr] items-center gap-y-2 text-[13px]">
            <div className="text-muted-foreground text-right font-medium pr-3">
              File:
            </div>
            <div
              className="truncate font-medium text-foreground"
              title={download.filename}
            >
              {download.filename}
            </div>

            <div className="text-muted-foreground text-right font-medium pr-3">
              Size:
            </div>
            <div className="text-foreground">
              {formatBytes(download.totalSize)}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-auto p-4 pt-4 flex justify-end gap-2">
        <Button
          className="w-28 bg-blue-600 hover:bg-blue-700 text-white rounded-sm"
          onClick={handleOpen}
        >
          Open
        </Button>
        <Button
          variant="outline"
          className="w-28 rounded-sm"
          onClick={handleOpenFolder}
        >
          Open Folder
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
          Close
        </Button>
      </div>
    </div>
  );
}
