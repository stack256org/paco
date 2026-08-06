/**
 * The idle timer that stops a container after a period of no activity.
 *
 * Owned per *container*, not per object, and that is the whole point.
 *
 * `connectSandbox()` builds a fresh `DockerSandbox` on every call and nothing
 * caches them, so one container is represented by a stream of short-lived
 * objects — 25-odd call sites, several per turn. Each object armed its own
 * 30-minute timer, each timer called `stop()`, and `#touch()` only ever pushed
 * back the timer of the instance that ran the command. So an instance created
 * for one step and then discarded kept a live countdown against a container
 * everyone else was still using: a checkpoint step connected at 10:00, a new
 * turn started on a new instance at 10:29, and at 10:30 the abandoned
 * instance's timer stopped the container mid-turn.
 *
 * Keying on the container name makes the newest arm the only live one. Arming
 * deposes the previous holder and cancels its timer, and a deposed timer that
 * had already been scheduled checks before firing, so it can never stop a
 * container another instance has since claimed.
 */

const holders = new Map<string, ContainerIdleTimer>();

export class ContainerIdleTimer {
  readonly #containerName: string;
  #handle?: ReturnType<typeof setTimeout>;

  constructor(containerName: string) {
    this.#containerName = containerName;
  }

  /** Whether this instance is the container's current timer holder. */
  get isHolder(): boolean {
    return holders.get(this.#containerName) === this;
  }

  /**
   * Take over the container's idle timer and schedule it for `expiresAt`.
   *
   * Idempotent for the holder: re-arming is how activity pushes the deadline
   * back.
   */
  arm(expiresAt: number, onExpire: () => void): void {
    const previous = holders.get(this.#containerName);
    if (previous && previous !== this) {
      previous.#disarm();
    }
    holders.set(this.#containerName, this);

    this.#disarm();
    this.#handle = setTimeout(
      () => {
        // Belt and braces: a timer can already be in the event queue when it is
        // deposed, and stopping a container someone else now owns is exactly
        // the failure this class exists to prevent.
        if (!this.isHolder) {
          return;
        }
        holders.delete(this.#containerName);
        onExpire();
      },
      Math.max(0, expiresAt - Date.now()),
    );

    // Never hold the Node process open just to reap an idle sandbox.
    this.#handle.unref?.();
  }

  /**
   * Cancel the timer and give up the claim.
   *
   * Only clears the registry when this instance actually holds it, so a
   * discarded instance stopping itself cannot disarm the live one.
   */
  release(): void {
    this.#disarm();
    if (this.isHolder) {
      holders.delete(this.#containerName);
    }
  }

  #disarm(): void {
    if (this.#handle) {
      clearTimeout(this.#handle);
      this.#handle = undefined;
    }
  }
}
