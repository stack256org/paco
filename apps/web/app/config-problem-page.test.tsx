import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigProblemPage } from "./config-problem-page";

/**
 * The marker `packaging/build-deb.sh` greps for has to actually reach the HTML.
 *
 * That guard refuses to package a build in which this screen was prerendered
 * into a static `.html` file — which shipped once, and made the whole
 * Settings → Admin area unreachable on every install while telling operators a
 * correctly-configured host was unconfigured. A guard keyed on a marker that
 * React never emits would pass every build and catch nothing, so the marker is
 * asserted here rather than assumed.
 */
const MARKER = "data-paco-config-problem";

describe("ConfigProblemPage", () => {
  test("emits the marker build-deb.sh greps for", () => {
    const html = renderToStaticMarkup(
      <ConfigProblemPage
        problems={[
          {
            variable: "APP_SECRET",
            problem: "It is not set.",
            fix: "Set it in /etc/paco/paco.env, then run `sudo paco restart`.",
          },
        ]}
      />,
    );

    expect(html).toContain(MARKER);
  });

  test("still emits it for several problems at once", () => {
    // The guard must fire on any configuration-problem render, not just the
    // single-problem shape.
    const html = renderToStaticMarkup(
      <ConfigProblemPage
        problems={[
          { variable: "APP_SECRET", problem: "not set", fix: "set it" },
          {
            variable: "APP_URL",
            problem: "not a URL",
            fix: "include the scheme",
          },
        ]}
      />,
    );

    expect(html).toContain(MARKER);
  });

  test("names the offending variables, so the screen is actionable", () => {
    const html = renderToStaticMarkup(
      <ConfigProblemPage
        problems={[
          {
            variable: "APP_SECRET",
            problem: "It signs sign-in sessions and is not set.",
            fix: "Set it in /etc/paco/paco.env.",
          },
        ]}
      />,
    );

    expect(html).toContain("APP_SECRET");
    expect(html).toContain("It signs sign-in sessions and is not set.");
    expect(html).toContain("Set it in /etc/paco/paco.env.");
  });
});
