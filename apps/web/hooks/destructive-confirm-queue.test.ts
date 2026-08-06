import { describe, expect, test } from "bun:test";
import {
  createDestructiveConfirmQueue,
  type DestructiveConfirmRequest,
} from "./destructive-confirm-queue";

function request(title: string): DestructiveConfirmRequest {
  return {
    confirmLabel: "Do it",
    description: "What goes and what stays.",
    title,
  };
}

function trackChanges() {
  const seen: (DestructiveConfirmRequest | null)[] = [];
  const queue = createDestructiveConfirmQueue((next) => seen.push(next));
  return { queue, seen };
}

describe("destructive confirm queue", () => {
  test("nothing is on screen until something asks", () => {
    const { queue } = trackChanges();
    expect(queue.current()).toBeNull();
  });

  test("asking shows the question and waits for an answer", async () => {
    const { queue, seen } = trackChanges();

    const answer = queue.ask(request("Delete it?"));

    expect(queue.current()?.title).toBe("Delete it?");
    expect(seen).toEqual([queue.current()]);

    queue.settle(true);
    expect(await answer).toBe(true);
  });

  test("cancelling answers no and takes the question away", async () => {
    const { queue } = trackChanges();

    const answer = queue.ask(request("Delete it?"));
    queue.settle(false);

    expect(await answer).toBe(false);
    expect(queue.current()).toBeNull();
  });

  test("the question is gone before the caller resumes", async () => {
    // The caller usually starts the work it just asked about, which often
    // renders. Leaving the dialog on screen through that would show it over
    // the thing it is doing.
    const { queue } = trackChanges();

    const answer = queue.ask(request("Delete it?"));
    const observed = answer.then(() => queue.current());

    queue.settle(true);
    expect(await observed).toBeNull();
  });

  test("a second question answers the first one no", async () => {
    // The dangerous alternative is leaving the first `await` pending forever:
    // the caller would sit waiting for an answer that can never arrive, and
    // nothing on screen would explain why its action never happened.
    const { queue } = trackChanges();

    const first = queue.ask(request("Delete it?"));
    const second = queue.ask(request("Compact it?"));

    expect(await first).toBe(false);
    expect(queue.current()?.title).toBe("Compact it?");

    queue.settle(true);
    expect(await second).toBe(true);
  });

  test("superseding a question does not confirm it", async () => {
    const { queue } = trackChanges();

    const first = queue.ask(request("Delete everything?"));
    queue.ask(request("Compact it?"));
    queue.settle(true);

    // Confirming the *second* question must never be read as an answer to the
    // first — that would run a delete nobody agreed to.
    expect(await first).toBe(false);
  });

  test("answering when nothing is open is harmless", () => {
    const { queue, seen } = trackChanges();

    expect(() => queue.settle(true)).not.toThrow();
    expect(queue.current()).toBeNull();
    expect(seen).toEqual([null]);
  });

  test("an answered question cannot be answered twice", async () => {
    const { queue } = trackChanges();

    const answer = queue.ask(request("Delete it?"));
    queue.settle(true);
    queue.settle(false);

    expect(await answer).toBe(true);
  });
});
