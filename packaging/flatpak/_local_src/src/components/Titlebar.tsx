import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { X, Minus, Square } from "lucide-react";

export function Titlebar({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) {
  // We want to show left window controls except on Windows
  const showControls = !window.navigator.userAgent.toLowerCase().includes("windows");

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 items-center gap-3 bg-background px-3 border-b border-border/40"
    >
      <div className="flex items-center gap-3 flex-1" data-tauri-drag-region>
        {showControls && (
          <div className="flex items-center gap-2 pr-1" data-no-drag="true">
            <button
              type="button"
              onClick={async () => {
                try {
                  await getCurrentWindow()?.close();
                } catch {}
              }}
              className="group flex size-3.5 items-center justify-center rounded-full bg-[#ff5f57]"
              aria-label="Close window"
            >
              <X className="size-2.5 text-black/55 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2.4} />
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await getCurrentWindow()?.minimize();
                } catch {}
              }}
              className="group flex size-3.5 items-center justify-center rounded-full bg-[#febc2e]"
              aria-label="Minimize window"
            >
              <Minus className="size-2.5 text-black/55 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2.4} />
            </button>
            <button
              type="button"
              onClick={async () => {
                try {
                  await getCurrentWindow()?.toggleMaximize();
                } catch {}
              }}
              className="group flex size-3.5 items-center justify-center rounded-full bg-[#28c840]"
              aria-label="Maximize window"
            >
              <Square className="size-2 text-black/55 opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2.4} />
            </button>
          </div>
        )}
        {title && (
          <div className="text-[13px] font-semibold text-foreground select-none pointer-events-none tracking-tight">
            {title}
          </div>
        )}
      </div>
      {children && (
        <div className="flex items-center" data-no-drag="true">
          {children}
        </div>
      )}
    </header>
  );
}
