import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appUrl } from "./app-url";

const originalUrl = process.env.APP_URL;
const originalPort = process.env.PORT;

beforeEach(() => {
  delete process.env.APP_URL;
  delete process.env.PORT;
});

afterEach(() => {
  process.env.APP_URL = originalUrl;
  process.env.PORT = originalPort;
});

describe("appUrl", () => {
  test("uses APP_URL when set", () => {
    process.env.APP_URL = "https://paco.example.com";
    expect(appUrl().origin).toBe("https://paco.example.com");
  });

  test("falls back to localhost on the default port", () => {
    expect(appUrl().origin).toBe("http://localhost:3000");
  });

  test("honours PORT in the fallback", () => {
    process.env.PORT = "3066";
    expect(appUrl().origin).toBe("http://localhost:3066");
  });

  test("treats a blank APP_URL as unset", () => {
    process.env.APP_URL = "   ";
    process.env.PORT = "4001";
    expect(appUrl().origin).toBe("http://localhost:4001");
  });

  test("rejects a URL with no scheme", () => {
    process.env.APP_URL = "localhost:3066";
    expect(() => appUrl()).toThrow(/must be an http\(s\) URL with a host/);
  });

  test("rejects a URL that does not parse", () => {
    process.env.APP_URL = "not a url";
    expect(() => appUrl()).toThrow(/is not a valid URL/);
  });
});
