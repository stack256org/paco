"use client";

import { X } from "lucide-react";
import { useState } from "react";
import { ImageLightbox } from "@/components/image-lightbox";
import type { ImageAttachment } from "@/lib/image-utils";
import { cn } from "@/lib/utils";

interface ImageAttachmentItemProps {
  image: ImageAttachment;
  onRemove: () => void;
  onOpen: () => void;
}

function ImageAttachmentItem({
  image,
  onRemove,
  onOpen,
}: ImageAttachmentItemProps) {
  const label = image.filename ?? "Attached image";

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onOpen}
        className="block overflow-hidden rounded-lg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={`View ${label}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Data URLs not supported by next/image */}
        <img
          src={image.dataUrl}
          alt={label}
          className="h-16 w-16 object-cover"
        />
      </button>
      {/*
        Inset rather than overhanging the corner. The row holding these scrolls
        horizontally, and `overflow-x: auto` makes the cross axis clip too — so
        a button at `-top-1.5` was sliced off by the composer edge.

        Always visible rather than revealed on hover: a hover-only control
        cannot be reached on a touch screen, which is exactly where removing a
        mis-picked photo matters.
      */}
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-base-300/80 text-base-content backdrop-blur-sm transition-colors hover:bg-base-300 hover:text-base-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={`Remove ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

interface ImageAttachmentsPreviewProps {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}

export function ImageAttachmentsPreview({
  images,
  onRemove,
  className,
}: ImageAttachmentsPreviewProps) {
  const [viewing, setViewing] = useState<ImageAttachment | null>(null);

  if (images.length === 0) return null;

  return (
    <>
      <div
        className={cn("flex gap-2 overflow-x-auto px-3 pb-2 pt-3", className)}
      >
        {images.map((image) => (
          <ImageAttachmentItem
            key={image.id}
            image={image}
            onRemove={() => onRemove(image.id)}
            onOpen={() => setViewing(image)}
          />
        ))}
      </div>
      <ImageLightbox image={viewing} onClose={() => setViewing(null)} />
    </>
  );
}
