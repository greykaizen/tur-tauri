import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Separator } from "./ui/separator";

export type SettingsSection =
  | "general"
  | "notifications"
  | "shortcuts"
  | "about";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  theme: "light" | "dark" | "system";
  onThemeChange: (theme: "light" | "dark" | "system") => void;
  autostartEnabled: boolean;
  isTogglingAutostart: boolean;
  onToggleAutostart: () => void;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
  onToggleNotifyOnComplete: () => void;
  onToggleNotifyOnFailure: () => void;
  onOpenDonate: () => void;
  onOpenProject: () => void;
  onQuit: () => void;
}

const sections: Array<{ id: SettingsSection; label: string; blurb: string }> = [
  { id: "general", label: "General", blurb: "Startup, theme, and app behavior" },
  {
    id: "notifications",
    label: "Notifications",
    blurb: "Completion and failure alerts",
  },
  {
    id: "shortcuts",
    label: "Keyboard Shortcuts",
    blurb: "Core commands and future remapping",
  },
  { id: "about", label: "About", blurb: "Project links and support" },
];

function SectionButton({
  active,
  label,
  blurb,
  onClick,
}: {
  active: boolean;
  label: string;
  blurb: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full rounded-xl border px-3 py-3 text-left transition-colors",
        active
          ? "border-foreground/12 bg-muted text-foreground"
          : "border-transparent text-muted-foreground hover:border-border hover:bg-muted/50 hover:text-foreground",
      ].join(" ")}
    >
      <div className="text-[13px] font-semibold">{label}</div>
      <div className="mt-1 text-[12px] leading-5">{blurb}</div>
    </button>
  );
}

function ToggleRow({
  title,
  description,
  enabled,
  onToggle,
  disabled = false,
}: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card px-4 py-4">
      <div className="min-w-0">
        <div className="text-[14px] font-semibold">{title}</div>
        <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
          {description}
        </div>
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={onToggle}
        className={[
          "mt-0.5 inline-flex h-7 min-w-[58px] items-center justify-center rounded-full border px-3 text-[12px] font-semibold transition-colors",
          enabled
            ? "border-blue-500/30 bg-blue-500/12 text-blue-500"
            : "border-border bg-muted text-muted-foreground",
          disabled ? "cursor-not-allowed opacity-50" : "hover:border-foreground/15",
        ].join(" ")}
      >
        {enabled ? "On" : "Off"}
      </button>
    </div>
  );
}

function ShortcutRow({
  label,
  keys,
  note,
}: {
  label: string;
  keys: string;
  note: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
      <div>
        <div className="text-[14px] font-semibold">{label}</div>
        <div className="mt-1 text-[12px] text-muted-foreground">{note}</div>
      </div>
      <div className="rounded-lg border border-border bg-muted px-2.5 py-1 text-[12px] font-medium text-muted-foreground">
        {keys}
      </div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  section,
  onSectionChange,
  theme,
  onThemeChange,
  autostartEnabled,
  isTogglingAutostart,
  onToggleAutostart,
  notifyOnComplete,
  notifyOnFailure,
  onToggleNotifyOnComplete,
  onToggleNotifyOnFailure,
  onOpenDonate,
  onOpenProject,
  onQuit,
}: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(960px,calc(100vw-2rem))] overflow-hidden p-0 sm:max-w-[960px]"
        showCloseButton
      >
        <div className="grid min-h-[620px] grid-cols-[220px_minmax(0,1fr)]">
          <aside className="border-r bg-muted/35 px-4 py-4">
            <DialogHeader className="px-2 pb-4">
              <DialogTitle>Settings</DialogTitle>
              <DialogDescription>
                Production controls for how Tur behaves.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              {sections.map((entry) => (
                <SectionButton
                  key={entry.id}
                  active={section === entry.id}
                  label={entry.label}
                  blurb={entry.blurb}
                  onClick={() => onSectionChange(entry.id)}
                />
              ))}
            </div>
          </aside>

          <section className="min-w-0 overflow-y-auto px-6 py-6">
            {section === "general" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-[18px] font-semibold tracking-[-0.02em]">
                    General
                  </h3>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Keep startup and appearance controls in one predictable place.
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-card px-4 py-4">
                  <div className="text-[14px] font-semibold">Theme</div>
                  <div className="mt-1 text-[12px] text-muted-foreground">
                    Minimal system-aware palette with explicit overrides.
                  </div>
                  <div className="mt-4 inline-flex rounded-xl border border-border bg-muted p-1">
                    {(["system", "dark", "light"] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => onThemeChange(value)}
                        className={[
                          "rounded-lg px-3 py-1.5 text-[12px] font-semibold capitalize transition-colors",
                          theme === value
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        ].join(" ")}
                      >
                        {value}
                      </button>
                    ))}
                  </div>
                </div>

                <ToggleRow
                  title="Launch at login"
                  description="Open Tur automatically when the system session starts."
                  enabled={autostartEnabled}
                  disabled={isTogglingAutostart}
                  onToggle={onToggleAutostart}
                />

                <div className="rounded-xl border border-border bg-card px-4 py-4">
                  <div className="text-[14px] font-semibold">
                    Window close behavior
                  </div>
                  <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
                    Closing the main window hides Tur to the system tray. Use the
                    top-bar Quit action when you want to fully exit the app.
                  </div>
                </div>
              </div>
            )}

            {section === "notifications" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-[18px] font-semibold tracking-[-0.02em]">
                    Notifications
                  </h3>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Control which transfer events trigger desktop alerts.
                  </p>
                </div>

                <ToggleRow
                  title="Completed downloads"
                  description="Show a desktop notification when a transfer finishes successfully."
                  enabled={notifyOnComplete}
                  onToggle={onToggleNotifyOnComplete}
                />
                <ToggleRow
                  title="Failed downloads"
                  description="Show a desktop notification when a transfer ends with an error."
                  enabled={notifyOnFailure}
                  onToggle={onToggleNotifyOnFailure}
                />
              </div>
            )}

            {section === "shortcuts" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-[18px] font-semibold tracking-[-0.02em]">
                    Keyboard Shortcuts
                  </h3>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    Start with stable defaults now; custom remapping can layer on later.
                  </p>
                </div>

                <ShortcutRow
                  label="New download"
                  keys="Ctrl/Cmd + N"
                  note="Open the add-download dialog quickly."
                />
                <ShortcutRow
                  label="Search downloads"
                  keys="Ctrl/Cmd + K"
                  note="Reserved for list filtering once the search field is exposed."
                />
                <ShortcutRow
                  label="Open settings"
                  keys="Ctrl/Cmd + ,"
                  note="Common desktop convention; recommended for a future command palette pass."
                />

                <div className="rounded-xl border border-dashed border-border px-4 py-4 text-[12px] leading-5 text-muted-foreground">
                  Shortcut remapping is not wired yet. This layout already keeps the
                  feature localized and ready for a later editable keymap.
                </div>
              </div>
            )}

            {section === "about" && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-[18px] font-semibold tracking-[-0.02em]">
                    About Tur
                  </h3>
                  <p className="mt-1 text-[13px] text-muted-foreground">
                    High-concurrency desktop downloads built on the Tur engine.
                  </p>
                </div>

                <div className="rounded-xl border border-border bg-card px-4 py-4">
                  <div className="text-[14px] font-semibold">Project</div>
                  <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
                    Open the repository and project home in the system browser.
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Button variant="outline" onClick={onOpenProject}>
                      Open Project
                    </Button>
                    <Button variant="outline" onClick={onOpenDonate}>
                      Donate
                    </Button>
                  </div>
                </div>

                <Separator />

                <div className="rounded-xl border border-border bg-card px-4 py-4">
                  <div className="text-[14px] font-semibold">Application</div>
                  <div className="mt-1 text-[12px] leading-5 text-muted-foreground">
                    Tur stays resident in the tray when the main window closes. Use
                    the quit action below only when you want to stop all desktop UI.
                  </div>
                  <div className="mt-4">
                    <Button variant="destructive" onClick={onQuit}>
                      Quit Tur
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
