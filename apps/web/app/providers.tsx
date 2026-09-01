"use client";

import { Toaster } from "@/components/ui/toaster";

/** Global providers for the app. */
export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}
