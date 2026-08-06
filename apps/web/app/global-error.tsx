"use client";

import { useEffect } from "react";

/**
 * The last resort: a failure in the root layout itself.
 *
 * This boundary replaces the whole document, so it cannot use the app's
 * providers, fonts or components — anything it imported might be the thing
 * that just threw. That is why the markup is plain and the colours are the
 * only fixed ones in the app: the daisyUI theme lives on `<html>`, which this
 * component is responsible for rendering, so there is no theme to inherit.
 *
 * It stays deliberately dull. Nobody should ever see it, and if they do, the
 * only useful things are a way to reload and an identifier to report.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Root layout error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          alignItems: "center",
          background: "#0a0a0a",
          color: "#ededed",
          display: "flex",
          flexDirection: "column",
          fontFamily: "system-ui, sans-serif",
          gap: "1rem",
          justifyContent: "center",
          margin: 0,
          minHeight: "100dvh",
          padding: "1.5rem",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "1.125rem", margin: 0 }}>
          Paco couldn&rsquo;t start
        </h1>
        <p style={{ margin: 0, maxWidth: "28rem", opacity: 0.7 }}>
          Something went wrong before the page could load. Reloading usually
          fixes it. If it keeps happening, check that the server is running.
        </p>

        <button
          onClick={reset}
          style={{
            background: "#ededed",
            border: "none",
            borderRadius: "0.375rem",
            color: "#0a0a0a",
            cursor: "pointer",
            fontSize: "0.875rem",
            padding: "0.5rem 1rem",
          }}
          type="button"
        >
          Reload
        </button>

        {error.digest ? (
          <p style={{ fontSize: "0.75rem", margin: 0, opacity: 0.5 }}>
            Reference: {error.digest}
          </p>
        ) : null}
      </body>
    </html>
  );
}
