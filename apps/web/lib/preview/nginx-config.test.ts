import { describe, expect, test } from "bun:test";
import { previewCertDir, previewServerBlock } from "./nginx-config";

const base = {
  hostname: "abc.previews.example.com",
  upstreamPort: 49_213,
  appPort: 3000,
};

describe("previewServerBlock", () => {
  test("always guards with auth_request", () => {
    // Every preview is authorised by Paco, public or private. The endpoint
    // decides; the config must never decide for it.
    expect(previewServerBlock({ ...base, certDir: null })).toContain(
      "auth_request /_paco_auth",
    );
  });

  test("passes the real host to the auth endpoint", () => {
    const block = previewServerBlock({ ...base, certDir: null });
    expect(block).toContain("X-Forwarded-Host $host");
  });

  test("names the hostname exactly once as server_name", () => {
    const block = previewServerBlock({ ...base, certDir: null });
    expect(block).toMatch(/server_name\s+abc\.previews\.example\.com;/);
  });

  test("refuses a hostname that could break out of the config", () => {
    expect(() =>
      previewServerBlock({
        ...base,
        hostname: "a.com; } server { listen 80;",
        certDir: null,
      }),
    ).toThrow();
  });

  test("no certificate emits no ssl_certificate", () => {
    expect(previewServerBlock({ ...base, certDir: null })).not.toContain(
      "ssl_certificate",
    );
  });

  test("a certificate emits ssl_certificate and an http redirect", () => {
    const block = previewServerBlock({
      ...base,
      certDir: "/etc/paco/preview-certs/abc.previews.example.com",
    });
    expect(block).toContain("ssl_certificate");
    expect(block).toContain("return 301 https://");
  });

  test("auth subrequest targets the loopback, not the public origin", () => {
    const block = previewServerBlock({ ...base, certDir: null });
    expect(block).toContain("http://127.0.0.1:3000/api/preview-auth");
  });

  test("preview traffic proxies to the sandbox's published port", () => {
    const block = previewServerBlock({ ...base, certDir: null });
    expect(block).toContain("http://127.0.0.1:49213");
  });

  test("refuses a certificate path that could break out of the config", () => {
    // Same reasoning as the hostname guard: this is interpolated into an
    // `ssl_certificate` directive, and a `;` would terminate it.
    expect(() =>
      previewServerBlock({
        ...base,
        certDir: "/etc/paco/x; } server { listen 80;",
      }),
    ).toThrow();
  });

  test("previewCertDir points at the hostname's own directory", () => {
    expect(previewCertDir("abc.previews.example.com")).toBe(
      "/etc/paco/preview-certs/abc.previews.example.com",
    );
    expect(() => previewCertDir("a.com; rm -rf /")).toThrow();
  });

  test("a preview without a certificate still serves, on port 80 only", () => {
    // The regression that made this an explicit path rather than a boolean:
    // `tlsEnabled` came straight from Settings and emitted an
    // `ssl_certificate` under a directory nothing has ever written to.
    // nginx validates those paths in `nginx -t`, so the whole sync failed and
    // *every* preview route on the instance stopped being applied — while the
    // Settings toggle claimed to be fetching certificates. Serving HTTP is
    // the correct degradation; refusing to serve at all is not.
    const block = previewServerBlock({ ...base, certDir: null });
    expect(block).toContain("listen 80;");
    expect(block).not.toContain("listen 443");
    expect(block).not.toContain("return 301 https://");
    expect(block).toContain("auth_request /_paco_auth");
  });

  test("refuses a non-integer or out-of-range port", () => {
    expect(() =>
      previewServerBlock({
        ...base,
        upstreamPort: Number.NaN,
        certDir: null,
      }),
    ).toThrow();
    expect(() =>
      previewServerBlock({ ...base, appPort: 70_000, certDir: null }),
    ).toThrow();
  });
});
