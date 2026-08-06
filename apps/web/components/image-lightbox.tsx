"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import type { ImageAttachment } from "@/lib/image-utils";

interface ImageLightboxProps {
  image: ImageAttachment | null;
  onClose: () => void;
}

/**
 * Full-size view of an attached image.
 *
 * A 64px thumbnail is enough to tell two screenshots apart and not enough to
 * check you attached the right one, which is the moment it matters — right
 * before sending.
 *
 * Deliberately not the shared Dialog: this renders a `data:` URL that can be
 * several megabytes, and it wants the whole viewport with no panel chrome
 * around it. Escape, the backdrop, and the close button all dismiss it.
 */
export function ImageLightbox({ image, onClose }: ImageLightboxProps) {
  useEffect(() => {
    if (!image) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [image, onClose]);

  if (!image) {
    return null;
  }

  const label = image.filename ?? "Attached image";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/*
        A real button rather than a div with a click handler, so dismissing by
        clicking away is reachable from the keyboard and needs no
        stopPropagation on the image sitting above it.

        Fixed black-and-white rather than theme tokens, and deliberately so: a
        media viewer dims the whole page to judge an image against a neutral
        backdrop. Tinting it with the theme would change how the image reads,
        which is the one thing this view exists to show accurately.
      */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close image"
        className="absolute inset-0 cursor-default bg-black/80 backdrop-blur-sm"
      />

      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label="Close image"
      >
        <X className="h-5 w-5" />
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element -- Data URLs not supported by next/image */}
      <img
        src={image.dataUrl}
        alt={label}
        className="pointer-events-none relative max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />

      {image.filename && (
        <p className="pointer-events-none absolute bottom-5 left-1/2 max-w-[80vw] -translate-x-1/2 truncate rounded-md bg-black/60 px-3 py-1 text-xs text-white/80">
          {image.filename}
        </p>
      )}
    </div>
  );
}
