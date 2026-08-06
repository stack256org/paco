import { describe, expect, test } from "bun:test";
import { ContainerIdleTimer } from "./idle-timer.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ContainerIdleTimer", () => {
  test("an abandoned instance cannot stop a container another instance holds", async () => {
    /*
     * The reported failure, in miniature. `connectSandbox()` builds a new
     * `DockerSandbox` every call and caches none of them, so an instance made
     * for a checkpoint step at 10:00 and then discarded still held a live
     * 30-minute countdown. A new turn started on a new instance at 10:29, and
     * at 10:30 the abandoned instance's timer stopped the shared container
     * mid-turn.
     */
    const stops: string[] = [];

    const abandoned = new ContainerIdleTimer("paco-sbx-session_1");
    abandoned.arm(Date.now() + 5, () => stops.push("abandoned"));

    // A later connection to the same container.
    const inUse = new ContainerIdleTimer("paco-sbx-session_1");
    inUse.arm(Date.now() + 60_000, () => stops.push("in-use"));

    await sleep(40);

    expect(stops).toEqual([]);
    expect(inUse.isHolder).toBe(true);
    expect(abandoned.isHolder).toBe(false);
  });

  test("the holder's own timer still fires", async () => {
    // The point is not to disable idle reaping, only to key it per container.
    const stops: string[] = [];
    const timer = new ContainerIdleTimer("paco-sbx-session_2");

    timer.arm(Date.now() + 5, () => stops.push("stopped"));
    await sleep(40);

    expect(stops).toEqual(["stopped"]);
  });

  test("re-arming pushes the deadline back instead of stacking timers", async () => {
    // This is what `#touch()` does after every command.
    const stops: string[] = [];
    const timer = new ContainerIdleTimer("paco-sbx-session_3");

    timer.arm(Date.now() + 5, () => stops.push("stopped"));
    timer.arm(Date.now() + 60_000, () => stops.push("stopped"));
    await sleep(40);

    expect(stops).toEqual([]);
  });

  test("containers do not share a claim", async () => {
    const stops: string[] = [];

    const one = new ContainerIdleTimer("paco-sbx-session_4");
    one.arm(Date.now() + 5, () => stops.push("one"));
    const other = new ContainerIdleTimer("paco-sbx-session_5");
    other.arm(Date.now() + 5, () => stops.push("other"));

    await sleep(40);

    expect(stops.sort()).toEqual(["one", "other"]);
  });

  test("releasing a deposed instance leaves the live claim alone", async () => {
    // An abandoned sandbox object being stopped explicitly must not disarm the
    // instance that has since taken the container over.
    const stops: string[] = [];

    const deposed = new ContainerIdleTimer("paco-sbx-session_6");
    deposed.arm(Date.now() + 60_000, () => stops.push("deposed"));
    const current = new ContainerIdleTimer("paco-sbx-session_6");
    current.arm(Date.now() + 5, () => stops.push("current"));

    deposed.release();
    await sleep(40);

    expect(stops).toEqual(["current"]);
  });
});
