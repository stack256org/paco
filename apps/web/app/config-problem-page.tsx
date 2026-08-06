import type { ConfigProblem } from "@/lib/config/required-env";

/**
 * What Paco shows instead of itself when it is not configured to run.
 *
 * Rendered from the root layout in place of the app, so it is deliberately
 * self-contained: no providers, no theme cookie, no database, no fonts, and no
 * imported components. Anything it depended on might be the thing that cannot
 * start, and a configuration screen that needs configuration is no use.
 *
 * The colours are the only fixed ones in the app, for the same reason
 * `global-error.tsx` fixes its own: this component owns the `<html>` element,
 * so there is no daisyUI theme in scope to inherit from.
 *
 * It is a page rather than a thrown error because the previous behaviour was
 * to throw at module scope, before any error boundary existed. The user got
 * "Paco couldn't start… check that the server is running" — which named the
 * one part of the system that was working fine.
 */
export function ConfigProblemPage({ problems }: { problems: ConfigProblem[] }) {
  return (
    <html lang="en">
      {/*
        No `<title>` here: the root layout's `metadata` export already sets one
        for this state, and rendering a second would put two title elements in
        one document.
      */}
      <head>
        <meta content="width=device-width, initial-scale=1" name="viewport" />
      </head>
      <body
        style={{
          background: "#0a0a0a",
          color: "#ededed",
          fontFamily: "system-ui, sans-serif",
          lineHeight: 1.5,
          margin: 0,
          minHeight: "100dvh",
          padding: "3rem 1.5rem",
        }}
      >
        {/*
         * A stable marker for `packaging/build-deb.sh` to grep for.
         *
         * This page appearing in a *prerendered* `.html` file means the build
         * machine had no configuration, the root layout returned early before
         * reaching a dynamic API, and Next therefore froze this screen into a
         * file that the package will serve forever — telling every operator
         * their correctly-configured host is unconfigured. That shipped once.
         *
         * The guard cannot key off the visible copy above without breaking the
         * next time someone rewords it, so it keys off this attribute. Keep it
         * if you change the wording.
         */}
        <main
          data-paco-config-problem=""
          style={{ margin: "0 auto", maxWidth: "42rem" }}
        >
          <h1 style={{ fontSize: "1.375rem", margin: "0 0 0.5rem" }}>
            Paco needs a bit of setup before it can start
          </h1>
          <p style={{ margin: "0 0 2rem", opacity: 0.7 }}>
            The server is running.{" "}
            {problems.length === 1
              ? "One setting is"
              : `${problems.length} settings are`}{" "}
            missing or wrong, so it cannot serve the app yet. Set{" "}
            {problems.length === 1 ? "it" : "them"} in{" "}
            <code style={{ fontFamily: "ui-monospace, monospace" }}>
              apps/web/.env
            </code>{" "}
            and restart.
          </p>

          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {problems.map((problem) => (
              <li
                key={problem.variable}
                style={{
                  border: "1px solid #2a2a2a",
                  borderRadius: "0.5rem",
                  marginBottom: "1rem",
                  padding: "1rem 1.25rem",
                }}
              >
                <h2
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "0.9375rem",
                    margin: "0 0 0.5rem",
                  }}
                >
                  {problem.variable}
                </h2>
                <p style={{ margin: "0 0 0.5rem" }}>{problem.problem}</p>
                <p style={{ margin: 0, opacity: 0.7 }}>{problem.fix}</p>
              </li>
            ))}
          </ul>

          <p style={{ fontSize: "0.875rem", marginTop: "2rem", opacity: 0.5 }}>
            This page is only shown when one of these is missing. It is not a
            crash, and nothing has been lost.
          </p>
        </main>
      </body>
    </html>
  );
}
