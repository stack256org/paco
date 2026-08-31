import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const POSTINST = join(import.meta.dirname, "debian", "postinst");
const CONTROL = join(import.meta.dirname, "debian", "control");

describe("packaging protects the instance", () => {
  test("the nginx site requires basic auth", async () => {
    const postinst = await readFile(POSTINST, "utf8");

    expect(postinst).toContain('auth_basic "Paco"');
    expect(postinst).toContain(
      "auth_basic_user_file /etc/nginx/paco.htpasswd;",
    );
  });

  test("the password file is generated only when absent", async () => {
    const postinst = await readFile(POSTINST, "utf8");

    // Guarded on the file not existing, the same shape as the APP_SECRET
    // guard above it. An upgrade must never change the operator's password.
    expect(postinst).toContain('if [ ! -f "$NGINX_HTPASSWD" ]; then');
  });

  test("the generated password is hashed, never written in the clear", async () => {
    const postinst = await readFile(POSTINST, "utf8");

    expect(postinst).toContain("htpasswd -i -B -c");
    expect(postinst).not.toContain("htpasswd -b");
  });

  test("the generated password is validated before use", async () => {
    const postinst = await readFile(POSTINST, "utf8");

    const generatedAt = postinst.indexOf("generated_password=$(openssl");
    const emptyCheckAt = postinst.indexOf('-z "$generated_password"');
    const lengthCheckAt = postinst.indexOf("-ne 24");
    const usedAt = postinst.indexOf("htpasswd -i -B -c");

    expect(generatedAt).toBeGreaterThan(-1);
    expect(emptyCheckAt).toBeGreaterThan(-1);
    expect(lengthCheckAt).toBeGreaterThan(-1);
    expect(usedAt).toBeGreaterThan(-1);
    // The guard has to sit between generation and use, or an empty/short
    // password from a failed `openssl rand` still reaches htpasswd.
    expect(emptyCheckAt).toBeGreaterThan(generatedAt);
    expect(lengthCheckAt).toBeGreaterThan(generatedAt);
    expect(usedAt).toBeGreaterThan(emptyCheckAt);
    expect(usedAt).toBeGreaterThan(lengthCheckAt);
  });

  test("htpasswd is guaranteed present by a package dependency", async () => {
    const control = await readFile(CONTROL, "utf8");

    const depends = control
      .split("\n")
      .find((line) => line.startsWith("Depends:"));

    expect(depends).toBeDefined();
    expect(depends).toContain("apache2-utils");
  });
});
