import { useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { DownloadItem, HeaderField } from "../types";
import { Folder, FileText, ChevronDown, ChevronUp } from "lucide-react";
import { ScrollArea } from "./ui/scroll-area";

function parseHeaders(input: string): HeaderField[] {
  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator <= 0) return [];
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (!name || !value) return [];
      return [{ name, value }];
    });
}

interface AddDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultDirectory: string;
  onDirectoryChange: (dir: string) => void;
  onSuccess: (downloads: DownloadItem[]) => void;
}

export function AddDownloadDialog({ open, onOpenChange, defaultDirectory, onDirectoryChange, onSuccess }: AddDownloadDialogProps) {
  const [urlText, setUrlText] = useState("");
  const [filename, setFilename] = useState("");
  const [referer, setReferer] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [cookieFile, setCookieFile] = useState("");
  const [headerLines, setHeaderLines] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePickDirectory() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose a download folder",
      defaultPath: defaultDirectory || undefined,
    });
    if (typeof selected === "string" && selected.length > 0) {
      onDirectoryChange(selected);
    }
  }

  async function handlePickCookieFile() {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      title: "Select a cookie file",
      defaultPath: cookieFile || undefined,
    });
    if (typeof selected === "string" && selected.length > 0) {
      setCookieFile(selected);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const urls = urlText
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
      
    if (urls.length === 0) {
      setError("Enter at least one URL.");
      return;
    }
    if (!defaultDirectory.trim()) {
      setError("Pick a destination folder.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const rows = await invoke<DownloadItem[]>("start_download", {
        input: {
          urls,
          directory: defaultDirectory.trim(),
          filename: filename.trim() || null,
          referer: referer.trim() || null,
          bearerToken: bearerToken.trim() || null,
          cookieFile: cookieFile.trim() || null,
          headers: parseHeaders(headerLines),
        },
      });
      onSuccess(rows);
      setUrlText("");
      setFilename("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>Add New Download</DialogTitle>
          <DialogDescription className="sr-only">Add a new download URL</DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex-1 overflow-y-auto px-6 py-4">
          <form id="add-download-form" onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">URLs (one per line)</label>
              <Textarea
                value={urlText}
                onChange={(e) => setUrlText(e.target.value)}
                placeholder="https://example.com/file.zip"
                className="min-h-[100px] resize-y"
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Save to</label>
              <div className="flex gap-2">
                <Input
                  value={defaultDirectory}
                  readOnly
                  placeholder="Select a folder..."
                />
                <Button type="button" variant="secondary" onClick={handlePickDirectory}>
                  <Folder className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Rename as (optional, for single URL)</label>
              <Input
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="custom-name.zip"
              />
            </div>

            <div className="border-t pt-2">
              <button
                type="button"
                className="flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                {showAdvanced ? <ChevronUp className="w-4 h-4 mr-1" /> : <ChevronDown className="w-4 h-4 mr-1" />}
                Advanced Options
              </button>
              
              {showAdvanced && (
                <div className="mt-4 space-y-4 animate-in slide-in-from-top-2 duration-200">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Referer</label>
                    <Input value={referer} onChange={(e) => setReferer(e.target.value)} placeholder="https://origin-site.com" />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Bearer Token</label>
                    <Input value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} type="password" placeholder="ey..." />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Cookie File (Netscape format)</label>
                    <div className="flex gap-2">
                      <Input value={cookieFile} readOnly placeholder="cookies.txt" />
                      <Button type="button" variant="secondary" onClick={handlePickCookieFile}>
                        <FileText className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Custom Headers (Name: Value)</label>
                    <Textarea
                      value={headerLines}
                      onChange={(e) => setHeaderLines(e.target.value)}
                      placeholder="User-Agent: CustomApp/1.0"
                      className="min-h-[80px] font-mono text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            {error && <div className="text-sm text-destructive bg-destructive/10 p-2 rounded-md">{error}</div>}
          </form>
        </ScrollArea>
        <DialogFooter className="px-6 py-4 border-t bg-muted/20">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="add-download-form" disabled={isSubmitting}>
            {isSubmitting ? "Starting..." : "Start Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
