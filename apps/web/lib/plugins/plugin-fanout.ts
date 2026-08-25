import "server-only";

import { SessionEventFanout } from "@/lib/plugins/event-fanout";

/**
 * The process-wide session-event fan-out every running plugin host is
 * registered with.
 *
 * Cached on `globalThis`, same reasoning as `registry.ts`'s own
 * `__pacoPluginRegistry`: a dev-server reload builds a fresh module graph,
 * and a module-level `SessionEventFanout` would otherwise leave a stale
 * timer running from the previous reload while a new one started ticking
 * alongside it.
 *
 * This is its own module, separate from `registry.ts`, so that owning the
 * fan-out singleton and owning the map of running `PluginHost`s stay two
 * independently mockable concerns — `registry.test.ts` can assert that
 * starting/stopping a host registers/unregisters it here without also
 * having to fake `SessionEventFanout`'s own polling behaviour, which
 * `event-fanout.test.ts` already covers.
 */
const globalForPluginFanout = globalThis as typeof globalThis & {
  __pacoPluginEventFanout?: SessionEventFanout;
};

/**
 * The singleton fan-out instance. `registry.ts` registers every plugin host
 * that starts (and calls `start()` on this, idempotently) and unregisters
 * one that stops; nothing else needs to touch this directly outside tests.
 */
export function getPluginEventFanout(): SessionEventFanout {
  globalForPluginFanout.__pacoPluginEventFanout ??= new SessionEventFanout();
  return globalForPluginFanout.__pacoPluginEventFanout;
}
