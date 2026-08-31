import { describe, expect, test } from "bun:test";
import { previewCertDir, previewServerBlock } from "./nginx-config";

const base = {
  hostname: "abc.previews.example.com",
  upstreamPort: 49_213,
  appPort: 3000,
};

describe("previewServerBlock", () => {
  test("requires the instance password", () => {
    const block = previewServerBlock({
      hostname: "abc123.previews.example.com",
      upstreamPort: 5173,
      appPort: 3000,
      certDir: null,
    });

    expect(block).toContain('auth_basic "Paco";');
    expect(block).toContain("auth_basic_user_file /etc/nginx/paco.htpasswd;");
  });

  test("no longer delegates authorization to the app", () => {
    const block = previewServerBlock({
      hostname: "abc123.previews.example.com",
      upstreamPort: 5173,
      appPort: 3000,
      certDir: null,
    });

    // The app no longer decides preview access: there is no public preview to
    // decide about, so nginx answers with the instance password alone.
    expect(block).not.toContain("auth_request");
    expect(block).not.toContain("_paco_auth");
    expect(block).not.toContain("preview-auth");
  });

  test("requires the password on the TLS listener too", () => {
    const block = previewServerBlock({
      hostname: "abc123.previews.example.com",
      upstreamPort: 5173,
      appPort: 3000,
      certDir: "/etc/paco/preview-certs/abc123.previews.example.com",
    });

    expect(block).toContain('auth_basic "Paco";');
    expect(block).toContain("auth_basic_user_file /etc/nginx/paco.htpasswd;");
    expect(block).not.toContain("auth_request");
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
