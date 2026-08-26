import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

let syncCalls = 0;
let syncFails = false;
type StackStatus =
  | { kind: "ready" }
  | { kind: "not-installed"; reason: string }
  | { kind: "incomplete"; reason: string };
let stackStatus: StackStatus = { kind: "ready" };

mock.module("./nginx-reload", () => ({
  previewStackStatus: async () => stackStatus,
  syncPreviewRoutes: async () => {
    syncCalls++;
    if (syncFails) {
      throw new Error("nginx -t failed");
    }
  },
}));

const {
  reconcilePreviewState,
  startPreviewReconciliation,
  stopPreviewReconciliation,
} = await import("./reconcile-job");

beforeEach(() => {
  syncCalls = 0;
  syncFails = false;
  stackStatus = { kind: "ready" };
  stopPreviewReconciliation();
});

describe("reconcilePreviewState", () => {
  test("syncs preview routes every sweep", async () => {
    await reconcilePreviewState();
    expect(syncCalls).toBe(1);
  });

  test("a failing nginx sync is swallowed, so the next sweep still happens", async () => {
    // The sweep runs on a timer: an escaping rejection would take the whole
    // reconciliation down on the first transient `nginx -t` failure.
    syncFails = true;

    const captured = captureConsole();
    try {
      await reconcilePreviewState();
      syncFails = false;
      await reconcilePreviewState();
    } finally {
      captured.restore();
    }

    expect(syncCalls).toBe(2);
    expect(captured.errors).toHaveLength(1);
  });
});

describe("startPreviewReconciliation", () => {
  test("starting twice schedules one sweep, not two", () => {
    const realSetInterval = globalThis.setInterval;
    let intervals = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervals++;
      return realSetInterval(...args);
    }) as typeof setInterval;

    try {
      startPreviewReconciliation();
      startPreviewReconciliation();
      expect(intervals).toBe(1);
    } finally {
      globalThis.setInterval = realSetInterval;
      stopPreviewReconciliation();
    }
  });

  test("stopping leaves nothing scheduled, so a restart works", () => {
    startPreviewReconciliation();
    stopPreviewReconciliation();

    const realSetInterval = globalThis.setInterval;
    let intervals = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervals++;
      return realSetInterval(...args);
    }) as typeof setInterval;

    try {
      startPreviewReconciliation();
      expect(intervals).toBe(1);
    } finally {
      globalThis.setInterval = realSetInterval;
      stopPreviewReconciliation();
    }
  });
});

interface CapturedConsole {
  logs: string[];
  errors: string[];
  restore: () => void;
}

/** Collect what the sweep prints, so "goes quiet" can actually be asserted. */
function captureConsole(): CapturedConsole {
  const realLog = console.log;
  const realError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = realLog;
      console.error = realError;
    },
  };
}

describe("a host with no nginx preview stack", () => {
  test("says so once, then never calls the sync again", async () => {
    stackStatus = {
      kind: "not-installed",
      reason: "no nginx on this host (/usr/sbin/nginx is not there)",
    };

    const captured = captureConsole();
    try {
      await reconcilePreviewState();
      await reconcilePreviewState();
      await reconcilePreviewState();
    } finally {
      captured.restore();
    }

    // Not "the error was swallowed": the sync is never attempted at all.
    expect(syncCalls).toBe(0);
    const reported = [...captured.logs, ...captured.errors].filter((line) =>
      line.includes("/usr/sbin/nginx"),
    );
    expect(reported).toHaveLength(1);
    // An absent stack is an environment fact, not a fault.
    expect(captured.errors).toHaveLength(0);
  });

  test("stays disarmed on every later tick, without throwing", async () => {
    // The probe is per-process and final, so a development checkout must
    // keep ticking harmlessly rather than retrying a sync that cannot work.
    stackStatus = { kind: "not-installed", reason: "no nginx on this host" };

    const captured = captureConsole();
    try {
      await reconcilePreviewState();
      await reconcilePreviewState();
    } finally {
      captured.restore();
    }

    expect(syncCalls).toBe(0);
  });

  test("a half-installed host reports a fault once, at error level", async () => {
    // nginx is here but `/etc/paco/nginx` is not: the package's postinst never
    // ran, or someone removed it. Retrying cannot fix it, so it is reported
    // once — but as an error, because unlike a dev checkout it is wrong.
    stackStatus = {
      kind: "incomplete",
      reason: "nginx is installed but /etc/paco/nginx does not exist",
    };

    const captured = captureConsole();
    try {
      await reconcilePreviewState();
      await reconcilePreviewState();
    } finally {
      captured.restore();
    }

    expect(syncCalls).toBe(0);
    expect(
      captured.errors.filter((line) => line.includes("/etc/paco/nginx")),
    ).toHaveLength(1);
  });
});

describe("a host that has an nginx preview stack and it is broken", () => {
  test("keeps reporting, every sweep, forever", async () => {
    // The case the quiet path must never swallow: a real server whose
    // `nginx -t` fails, or whose `/etc/paco/nginx` went root-owned. The
    // operator has to keep hearing about it.
    stackStatus = { kind: "ready" };
    syncFails = true;

    const captured = captureConsole();
    try {
      await reconcilePreviewState();
      await reconcilePreviewState();
      await reconcilePreviewState();
    } finally {
      captured.restore();
    }

    expect(syncCalls).toBe(3);
    expect(
      captured.errors.filter((line) =>
        line.includes("preview route sync failed"),
      ),
    ).toHaveLength(3);
  });
});
