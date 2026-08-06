"use client";

/**
 * A notification that the instance's domain was just saved.
 *
 * `DomainSection` and `CertificateSection` are siblings rendered by the admin
 * page, and the second one's entire state depends on the first one's; without
 * this, saving a domain left Certificate still showing "Save a domain above
 * first" with its button disabled, until the operator reloaded the page. That
 * reads as a broken screen, because the instruction it gives has already been
 * followed.
 *
 * Deliberately not solved by lifting the settings into the page and threading
 * them down: both sections load independently on purpose (the admin page is a
 * list of unrelated panels, and one slow read should not hold up the others),
 * and `CertificateSection` is not rendered at all during onboarding, where
 * `DomainSection` is reused on its own. A subscription keeps that
 * independence — a section that nobody is listening to just publishes into
 * nothing.
 *
 * Not `EventTarget`/`CustomEvent` on `window`: this never needs to cross a
 * frame or leave the module, and a module-scoped `Set` cannot collide with an
 * unrelated event name.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscribe function a `useEffect` cleanup wants. */
export function onDomainSaved(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitDomainSaved(): void {
  // Iterate a copy: a listener that unsubscribes itself while being notified
  // would otherwise mutate the set mid-iteration.
  for (const listener of Array.from(listeners)) {
    listener();
  }
}
