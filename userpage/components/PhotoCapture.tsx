"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Notice from "@/components/Notice";

const SIZE = 400;
/** Longest edge for a whole-frame photo. Larger than SIZE because nothing is
 *  being thrown away here: a wide vehicle shot at 400px would leave the plate
 *  under 100px across, and the plate is the reason the photo exists. */
const MAX_EDGE = 800;
const QUALITY = 0.82;

type Tab = "upload" | "camera";

/** Where the operator's chosen camera is remembered. A registration desk uses
 *  the same USB webcam every shift, and re-picking it out of a list on every
 *  visit is pure friction. */
const DEVICE_KEY = "photoCapture.videoDeviceId";

function errName(err: unknown): string {
  return err instanceof DOMException || err instanceof Error ? err.name : "";
}

/** True for the failures that a second, unconstrained getUserMedia can fix:
 *  a remembered camera that has been unplugged, or a machine whose only
 *  camera is an external one the browser refuses to call "user"-facing. */
function isConstraintFailure(err: unknown): boolean {
  const name = errName(err);
  return (
    name === "OverconstrainedError" ||
    name === "ConstraintNotSatisfiedError" ||
    name === "NotFoundError" ||
    name === "DevicesNotFoundError"
  );
}

function describeCameraError(err: unknown): string {
  switch (errName(err)) {
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "No camera found. Plug in a USB camera and press Turn on camera again, or use the Upload tab.";
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "Camera access is blocked. Allow it from the padlock in the address bar, or use the Upload tab.";
    case "NotReadableError":
    case "TrackStartError":
      return "The camera is in use by another app (Zoom, Teams, Camera). Close it and try again.";
    default:
      return "Camera unavailable. Check permissions, or use the Upload tab.";
  }
}

/**
 * How the chosen image is fitted before upload.
 *
 * `square` cover-crops to a centred square: an ID portrait is rendered in
 * round and square avatar frames all over the app, and a face is reliably in
 * the middle of the shot, so cropping once here beats every consumer cropping
 * differently.
 *
 * `whole` keeps the entire frame, only scaling it down. A laptop or a car
 * photographed at arm's length does NOT put its subject in a centred square —
 * a plate sits low and wide, a laptop lid fills a landscape frame — so the
 * square crop was silently eating the part the guard is meant to compare
 * against the object in front of them. This is a pixel-level fact, not a
 * display one: the cropped pixels never reached the server, so no amount of
 * object-contain at the far end could bring them back.
 */
export type PhotoFit = "square" | "whole";

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

/**
 * Scales a source image to fit inside MAX_EDGE and returns a JPEG blob. The
 * canvas takes the image's own aspect ratio, so every pixel of the original
 * frame survives — the whole point of this path. An image already smaller than
 * MAX_EDGE is re-encoded at its own size rather than upscaled.
 */
async function toWholeJpeg(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  // Rounded, and floored at 1: a canvas dimension of 0 (a sub-pixel sliver of
  // an image) throws on toBlob rather than producing an empty picture.
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser");

  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

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
  fit = "square",
}: {
  onChange: (blob: Blob | null) => void;
  /** See PhotoFit. Defaults to the ID-portrait behaviour, so a caller that
   *  says nothing keeps the square crop it has always had. */
  fit?: PhotoFit;
}) {
  const [tab, setTab] = useState<Tab>("upload");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cameraOn, setCameraOn] = useState(false);
  // Which path produced the current preview. Drives whether the camera tab
  // offers "Retake" (one click, straight back to a live preview) instead of
  // "Turn on camera" (which would otherwise make a capture-then-remove-
  // then-turn-on-camera sequence the only way to reshoot).
  const [capturedFrom, setCapturedFrom] = useState<Tab | null>(null);
  // The video inputs the machine can see, and which one the operator picked.
  // A desk PC has no built-in camera, so the camera that matters is whatever
  // USB webcam is plugged in — and where several video inputs exist (a USB
  // webcam alongside a virtual camera installed by a meeting app) the
  // browser's default pick is regularly the wrong one. Holding an explicit
  // deviceId makes that the operator's choice rather than the browser's.
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(() => {
    // Read straight from storage rather than in an effect: the value is
    // needed by the very first startCamera call, which can happen before an
    // effect that only mirrors it would have run. Nothing is rendered from it
    // until `devices` is populated, so this cannot desync hydration.
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(DEVICE_KEY);
    } catch {
      return null;
    }
  });

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

  /**
   * Reloads the video-input list. Worth calling both after a stream is
   * granted — deviceIds and labels are empty strings until the user has
   * allowed the camera once, so before that a picker would offer nothing but
   * blanks — and whenever the OS reports a device change, which is what a USB
   * camera being plugged in or pulled out looks like from here.
   */
  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter(
        (d) => d.kind === "videoinput"
      );
      if (!mountedRef.current) return;
      setDevices(cams);
      // Only prune the remembered camera once the ids are actually exposed
      // (they are blank before permission). Forgetting an unplugged camera
      // matters: an exact deviceId matching nothing fails the request
      // outright, where letting the browser choose still yields a preview.
      if (cams.some((c) => c.deviceId)) {
        setDeviceId((cur) => (cur && cams.some((c) => c.deviceId === cur) ? cur : null));
      }
    } catch {
      // The list is a convenience; the camera still works without it.
    }
  }, []);

  // Remember the pick across visits, so a desk that always uses the same USB
  // webcam gets it selected on the next registration without being asked.
  useEffect(() => {
    try {
      if (deviceId) window.localStorage.setItem(DEVICE_KEY, deviceId);
      else window.localStorage.removeItem(DEVICE_KEY);
    } catch {
      // Storage can be denied (private mode, locked-down kiosk); the picker
      // still works for the current session.
    }
  }, [deviceId]);

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!cameraSupported || !media?.addEventListener) return;
    const onDeviceChange = () => void refreshDevices();
    media.addEventListener("devicechange", onDeviceChange);
    return () => media.removeEventListener("devicechange", onDeviceChange);
  }, [cameraSupported, refreshDevices]);

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
    // Set on every mount, not just declared at the ref: React's StrictMode
    // mounts, cleans up, and mounts again in development, so a flag that is
    // only ever cleared stays false for the rest of the component's life —
    // and startCamera would then silently throw every stream away.
    mountedRef.current = true;
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

  // One encoder for both the file and the camera paths, so an uploaded laptop
  // and a photographed one are stored the same way.
  const encode = fit === "whole" ? toWholeJpeg : toSquareJpeg;

  function setResult(blob: Blob | null, source: Tab | null = null) {
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return blob ? URL.createObjectURL(blob) : null;
    });
    setCapturedFrom(blob ? source : null);
    onChange(blob);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      const bitmap = await createImageBitmap(file);
      setResult(await encode(bitmap, bitmap.width, bitmap.height), "upload");
      bitmap.close();
    } catch {
      setError("That file could not be read as an image.");
    }
  }

  /**
   * Opens a preview stream. `preferred` names the camera to use; omitting it
   * falls back to the remembered pick, and passing null deliberately lets the
   * browser choose.
   */
  async function startCamera(preferred?: string | null) {
    setError(null);
    const wanted = preferred === undefined ? deviceId : preferred;
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // An exact deviceId is the only constraint that reliably pins a
          // specific USB camera. With no pick yet, facingMode is asked for as
          // an ideal, never a requirement — a plain external webcam has no
          // facing mode at all, and demanding one is what made this tab
          // unusable on a desktop with no built-in camera.
          video: wanted ? { deviceId: { exact: wanted } } : { facingMode: { ideal: "user" } },
        });
      } catch (err) {
        if (!isConstraintFailure(err)) throw err;
        // The pinned camera is gone, or nothing matched the ideal. Ask for
        // any camera at all before giving up.
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
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
      setCameraOn(true);
      // Record what the browser actually opened — after a fallback that is
      // not necessarily what was asked for — so the picker shows the true
      // camera and the next visit reuses it.
      const opened = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (opened) setDeviceId(opened);
      // Labels only become readable once permission has been granted, so this
      // is the first point at which a useful picker can be built.
      void refreshDevices();
    } catch (err) {
      setError(describeCameraError(err));
    }
  }

  /** Switches cameras, restarting the preview in place if one is running. */
  async function selectDevice(id: string) {
    setDeviceId(id);
    if (streamRef.current) {
      stopCamera();
      await startCamera(id);
    }
  }

  // The <video> is only rendered once cameraOn is true, so the element does
  // not exist yet at the moment startCamera receives the stream — attaching
  // there would silently write to a null ref and leave a blank preview.
  // Attach once the element has actually mounted instead.
  useEffect(() => {
    const video = videoRef.current;
    if (!cameraOn || !video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    void video.play().catch(() => setError("Could not start the preview. Try again."));
  }, [cameraOn]);

  async function capture() {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    try {
      setResult(await encode(video, video.videoWidth, video.videoHeight), "camera");
      stopCamera();
    } catch {
      setError("Could not capture a frame. Try again.");
    }
  }

  // One click back to a live preview after a camera shot. The old preview is
  // cleared first — not just left in place — because the preview element
  // takes priority over the <video> in the render below, so a stale preview
  // would otherwise keep showing the old still instead of the live feed once
  // the camera comes back on.
  async function retake() {
    setResult(null);
    await startCamera();
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
              onClick={() => {
                setTab("camera");
                // Opening the tab is the moment the operator needs to know
                // whether this machine has a camera at all, so count the
                // inputs here rather than waiting for a failed getUserMedia
                // to say so.
                void refreshDevices();
              }}
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
            <img
              src={preview}
              alt="Selected"
              // The preview must show what was actually stored. In `whole`
              // mode the blob keeps the full frame, so cover here would crop
              // it on screen only — reintroducing, as an illusion, the exact
              // confusion this fix removes.
              className={`h-full w-full ${fit === "whole" ? "object-contain" : "object-cover"}`}
            />
          ) : tab === "camera" && cameraOn ? (
            <video
              ref={videoRef}
              className={`h-full w-full ${fit === "whole" ? "object-contain" : "object-cover"}`}
              muted
              playsInline
            />
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
                  onClick={() => void (preview && capturedFrom === "camera" ? retake() : startCamera())}
                  className="rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-navy"
                >
                  {preview && capturedFrom === "camera" ? "Retake" : "Turn on camera"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={capture}
                    className="rounded-lg bg-navy px-3 py-1.5 text-[13px] font-600 text-white"
                  >
                    Capture
                  </button>
                  <button
                    type="button"
                    onClick={stopCamera}
                    className="rounded-lg border border-line bg-white px-3 py-1.5 text-[13px] font-600 text-ink-soft hover:text-navy"
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}

          {tab === "camera" && devices.length > 1 && (
            <select
              value={deviceId ?? ""}
              onChange={(e) => void selectDevice(e.target.value)}
              className="block max-w-56 rounded-lg border border-line bg-white px-2 py-1.5 text-[12px] font-600 text-ink-soft"
              aria-label="Camera"
            >
              {!deviceId && <option value="">Choose a camera</option>}
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {/* Unlabelled inputs are the norm until permission has been
                      granted once; a position is still enough to tell two
                      cameras apart. */}
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
          )}

          {tab === "camera" && !cameraOn && devices.length === 0 && (
            <p className="max-w-56 text-[11px] text-ink-soft">
              No camera detected. Plug in a USB camera, then press Turn on camera.
            </p>
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