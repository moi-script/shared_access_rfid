"use client";

import { useEffect, useRef, useState } from "react";
import Notice from "@/components/Notice";

const SIZE = 400;
const QUALITY = 0.82;

type Tab = "upload" | "camera";

/** Cover-crops a source image to a square canvas and returns a JPEG blob. */
async function toSquareJpeg(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser");

  // Cover: scale so the shorter edge fills, then centre the overflow.
  const scale = Math.max(SIZE / w, SIZE / h);
  const dw = w * scale;
  const dh = h * scale;
  ctx.drawImage(source, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the image"))),
      "image/jpeg",
      QUALITY
    );
  });
}

export default function PhotoCapture({
  onChange,
}: {
  onChange: (blob: Blob | null) => void;
}) {
  const [tab, setTab] = useState<Tab>("upload");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Mirrors `tab` for reading inside the async startCamera callback below —
  // the `tab` variable captured at call time goes stale the moment the user
  // switches tabs while getUserMedia is still pending, which is exactly the
  // race that leaves an orphaned stream running. Refs may not be written
  // during render, so the mirror is kept current via an effect instead.
  const tabRef = useRef<Tab>(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);
  // A tab switch is not the only way the pending getUserMedia promise can
  // outlive its relevance — the whole component can unmount while the
  // permission prompt is still open (closing the form, navigating away).
  // Unmounting does not touch `tab`, so tabRef alone can't see it; this
  // flag is the second, independent guard startCamera checks after the
  // await. Cleared in the unmount cleanup below, never written in render.
  const mountedRef = useRef(true);

  // getUserMedia needs a secure context; localhost qualifies, plain http does not.
  const cameraSupported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOn(false);
  }

  // A live camera indicator left on after the form closes looks alarming at a
  // registration desk, so the stream is released on unmount and on tab change.
  // This cleanup still handles the case where a stream was already adopted
  // before unmount (stopCamera stops it); mountedRef additionally guards the
  // case where getUserMedia is still pending at unmount time (see startCamera).
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopCamera();
    };
  }, []);
  useEffect(() => {
    // This effect synchronizes React state with an external system (the
    // MediaStream), not deriving state from props/state — the case React's
    // own guidance carves out from the cascading-render concern this rule
    // targets. Same precedent as components/AuthedImage.tsx.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab !== "camera") stopCamera();
  }, [tab]);

  function setResult(blob: Blob | null) {
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return blob ? URL.createObjectURL(blob) : null;
    });
    onChange(blob);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const bitmap = await createImageBitmap(file);
      setResult(await toSquareJpeg(bitmap, bitmap.width, bitmap.height));
      bitmap.close();
    } catch {
      setError("That file could not be read as an image.");
    }
  }

  async function startCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
      });
      // Two independent things can have made this stream irrelevant while
      // the permission prompt was pending: the user switched away from the
      // Camera tab (tabRef no longer "camera"), or the component unmounted
      // entirely (mountedRef false — unmounting doesn't touch `tab`, so
      // tabRef alone can't see it). Either one means adopting the stream
      // would leave an orphaned camera with nothing left to release it.
      if (!mountedRef.current || tabRef.current !== "camera") {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch {
      setError("Camera unavailable. Check permissions, or use the Upload tab.");
    }
  }

  async function capture() {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    try {
      setResult(await toSquareJpeg(video, video.videoWidth, video.videoHeight));
      stopCamera();
    } catch {
      setError("Could not capture a frame. Try again.");
    }
  }

  const tabCls = (active: boolean) =>
    active
      ? "rounded-lg bg-navy px-3 py-1.5 text-[13px] font-600 text-white"
      : "rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-navy";

  return (
    <div className="rounded-xl border border-line bg-paper p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[13px] font-600 text-ink-soft">Photo</p>
        <div className="flex gap-1.5">
          <button type="button" onClick={() => setTab("upload")} className={tabCls(tab === "upload")}>
            Upload
          </button>
          {cameraSupported && (
            <button
              type="button"
              onClick={() => setTab("camera")}
              className={tabCls(tab === "camera")}
            >
              Camera
            </button>
          )}
        </div>
      </div>

      {error && (
        <Notice compact className="mb-2 text-[12px] text-ink">
          {error}
        </Notice>
      )}

      <div className="flex items-start gap-3">
        <div className="grid h-28 w-28 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-white text-[11px] text-ink-soft">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Selected" className="h-full w-full object-cover" />
          ) : tab === "camera" && cameraOn ? (
            <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          ) : (
            "No photo"
          )}
        </div>

        <div className="space-y-2">
          {tab === "upload" ? (
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleFile}
              className="text-[13px] text-ink-soft file:mr-3 file:rounded-lg file:border file:border-line file:bg-white file:px-3 file:py-1.5 file:text-[13px] file:font-600 file:text-ink-soft"
            />
          ) : (
            <div className="flex gap-2">
              {!cameraOn ? (
                <button
                  type="button"
                  onClick={startCamera}
                  className="rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-navy"
                >
                  Turn on camera
                </button>
              ) : (
                <button
                  type="button"
                  onClick={capture}
                  className="rounded-lg bg-navy px-3 py-1.5 text-[13px] font-600 text-white"
                >
                  Capture
                </button>
              )}
            </div>
          )}

          {preview && (
            <button
              type="button"
              onClick={() => setResult(null)}
              className="block rounded px-1 text-[12px] font-600 text-ink-soft hover:bg-red/25 hover:text-ink"
            >
              Remove photo
            </button>
          )}
          <p className="text-[11px] text-ink-soft">Saved as a 400x400 JPEG.</p>
        </div>
      </div>
    </div>
  );
}
