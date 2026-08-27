"use client";

import {useRef, useState} from "react";
import {Button} from "@/components/ui/controls";
import {useSnackbar} from "@/components/ui/Snackbar";

const CANVAS_SIZE = 480;

/** Pet photo upload with a square crop (wp4-vet.md), done entirely client-side on a canvas - the
 * server stores whatever square image it's handed rather than doing its own image processing
 * (see the upload route's doc comment), so every stored photo is already a consistent shape. */
export function PhotoCropUpload({petId, currentFileId}: {petId: string; currentFileId?: string}) {
  const snackbar = useSnackbar();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [croppedDataUrl, setCroppedDataUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = CANVAS_SIZE;
        canvas.height = CANVAS_SIZE;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        // Center-crop to a square, then scale to fill the canvas.
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, CANVAS_SIZE, CANVAS_SIZE);
        setCroppedDataUrl(canvas.toDataURL("image/jpeg", 0.9));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  }

  async function handleUpload() {
    if (!croppedDataUrl) return;
    setUploading(true);
    try {
      const res = await fetch(`/api/pets/${petId}/photo`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({dataUrl: croppedDataUrl}),
      });
      if (!res.ok) throw new Error("Upload failed");
      snackbar.show("Photo updated", "ok");
      setCroppedDataUrl(null);
    } catch {
      snackbar.show("Could not upload photo - try again", "danger");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex items-start gap-4">
      <div className="h-24 w-24 shrink-0 overflow-hidden rounded-card border border-border bg-surface-2">
        {croppedDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a locally-cropped data URL, not an optimizable remote asset
          <img src={croppedDataUrl} alt="Cropped preview" className="h-full w-full object-cover" />
        ) : currentFileId ? (
          // eslint-disable-next-line @next/next/no-img-element -- served from our own StoredFile route, not a remote asset Next can optimize
          <img src={`/api/files/${currentFileId}`} alt="Pet photo" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-caption text-ink-faint">No photo</div>
        )}
      </div>
      <div className="space-y-2">
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
          className="text-body text-ink"
        />
        {croppedDataUrl && (
          <Button onClick={handleUpload} disabled={uploading} variant="secondary">
            {uploading ? "Uploading..." : "Save photo"}
          </Button>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
}
