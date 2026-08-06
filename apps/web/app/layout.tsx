import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { appUrl } from "@/lib/app-url";
import { cn } from "@/lib/utils";
import { findConfigProblems } from "@/lib/config/required-env";
import { PRODUCT_DESCRIPTION } from "@/lib/brand";
import {
  parseThemePreference,
  THEME_COOKIE_NAME,
  themeAttribute,
} from "@/lib/theme";
import { ConfigProblemPage } from "./config-problem-page";
import { Providers } from "./providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const faviconPath = "/favicon.ico";

/*
 * Force every route through per-request rendering.
 *
 * Without this, a page with no dynamic API anywhere in its own tree — no
 * `cookies()`, no `headers()`, nothing — gets statically optimized by Next:
 * fully rendered once, during `next build`, and served as fixed HTML from
 * then on. `configProblems` below is checked *before* this layout's own
 * `cookies()` call (see the early return a few lines down), so on a build
 * machine that has no `paco.env` — every native package build, by design;
 * see packaging/build-deb.sh's own header comment on why migrations and
 * secrets never touch the build — that early return is the branch taken
 * during the build, `cookies()` is never reached, and Next never sees a
 * dynamic API used at all. The result: pages with no config problem of
 * their own (most of Settings) get the *build machine's* "APP_SECRET is
 * missing" screen baked in as static HTML, forever, regardless of what the
 * installed host's real environment says. Found by loading
 * `/settings/admin` on a real, correctly-configured install and getting
 * exactly that screen while `/sessions` (a dynamic route) worked. This
 * directive is a declarative build-time signal, not runtime branching, so
 * it applies regardless of which branch below actually executes.
 */
export const dynamic = "force-dynamic";

/*
 * Used only for the static `metadata` export below (the tab title and
 * `metadataBase`), never for the actual render-gating decision — that one is
 * computed fresh inside `RootLayout`, per request, a few lines down. This
 * copy stays at module scope because `metadata` is a plain object, not a
 * function, and Next evaluates it once per module load regardless; a stale
 * tab title if `APP_SECRET` somehow changed mid-process would be cosmetic,
 * where a stale *render* was the actual bug (see `force-dynamic` above and
 * `RootLayout`'s own copy below).
 */
const metadataConfigProblems = findConfigProblems(process.env);

/*
 * Absent rather than wrong when the origin is unusable.
 *
 * `metadataBase` only affects absolute URLs in Open Graph tags. Omitting it
 * costs a warning in the log; deriving it from a broken value would crash the
 * page that exists to explain the broken value.
 */
const metadataBase = metadataConfigProblems.some(
  (problem) => problem.variable === "APP_URL",
)
  ? undefined
  : appUrl();

export const metadata: Metadata = {
  metadataBase,
  /*
   * The tab says what the page says. A misconfigured instance titled "Paco"
   * looks like the app failed to render; titled this, the tab alone is the
   * diagnosis — which matters when it is one of a dozen open while someone
   * works out why the thing will not start.
   */
  title:
    metadataConfigProblems.length > 0
      ? "Paco needs configuring"
      : {
          default: "Paco",
          template: "%s | Paco",
        },
  description: PRODUCT_DESCRIPTION,
  icons: {
    icon: faviconPath,
    shortcut: faviconPath,
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  /*
   * Called first, unconditionally — belt-and-suspenders alongside
   * `force-dynamic` above, not a replacement for it. `force-dynamic` is a
   * declarative signal Next reads independently of which branch below
   * actually runs; calling a real dynamic API before the early return below
   * is a second, structural guarantee that this route can never again be
   * prerendered no matter how this function gets reordered later — the
   * trap fixed here was exactly "whether this route is static depends on
   * which branch executes first," so removing that dependency at the
   * source is worth it. `ConfigProblemPage` below doesn't need the cookie
   * itself, only that reading it happened before any early return; the
   * theme logic further down is what actually uses the value.
   */
  const cookieStore = await cookies();

  /*
   * Computed here, per request, rather than reused from module scope —
   * a module-scope read is only evaluated once per running process rather
   * than once per request, which is a hazard waiting for the next time
   * someone reorders this file. Recomputing it where it is actually used
   * removes the hazard instead of just no longer triggering it today.
   *
   * A misconfigured instance has to be able to say so, and `ConfigProblemPage`
   * renders its own `<html>` precisely so it does not depend on the
   * providers below.
   */
  const configProblems = findConfigProblems(process.env);
  if (configProblems.length > 0) {
    return <ConfigProblemPage problems={configProblems} />;
  }

  // Applied here, in the first byte of HTML, so the page never paints one
  // theme and then swaps to another. `null` means "system": no attribute, and
  // daisyUI's `prefersdark` resolves it in CSS.
  const theme = themeAttribute(
    parseThemePreference(cookieStore.get(THEME_COOKIE_NAME)?.value),
  );

  return (
    <html
      lang="en"
      suppressHydrationWarning
      {...(theme ? { "data-theme": theme } : {})}
    >
      <body
        className={cn(
          geistSans.variable,
          geistMono.variable,
          "overflow-x-hidden font-sans antialiased",
        )}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
