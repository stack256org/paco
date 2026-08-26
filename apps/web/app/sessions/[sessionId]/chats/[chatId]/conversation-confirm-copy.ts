import type { DestructiveConfirmRequest } from "@/hooks/use-destructive-confirm";

/**
 * The wording of the conversation's "are you sure?" questions.
 *
 * It lives away from the handlers because the wording is the whole point of
 * the dialog and it is longer than the code it guards. Each one says what is
 * lost *and* what survives: "this cannot be undone" tells someone that they
 * should be worried without telling them what about, so they either click
 * through it or stop using the feature.
 */

/**
 * Compaction is the CLI's `/compact`. It hands the conversation to Claude, gets
 * a summary back, and from then on that summary is the history the CLI resumes
 * from — so context is freed and the detail is gone. Paco keeps its own copy of
 * the messages in the database, which is why the transcript on screen is
 * unaffected and worth saying so: the visible chat not changing is otherwise
 * indistinguishable from the button having done nothing.
 */
export const COMPACT_CHAT_CONFIRM: DestructiveConfirmRequest = {
  busyLabel: "Compacting…",
  confirmLabel: "Compact it",
  description:
    "Claude reads everything said in this chat so far and boils it down to a short summary, which frees up room so the chat can keep going. From then on it works from that summary: the detail in the earlier messages is no longer something it can look back at, and the summary cannot be unpacked into them again. Nothing in your workspace changes — no file is edited or deleted — and the messages already on screen stay there for you to scroll back through. Writing the summary is a piece of work for Claude, so it takes a moment and costs about as much as asking it a question.",
  destructive: false,
  title: "Compact this chat?",
};

/**
 * Forking is additive — nothing here is touched — but it opens the new chat
 * immediately, and the button that does it is an unlabelled icon sitting next
 * to Copy. Being moved somewhere else is the part worth warning about.
 */
export const FORK_CONVERSATION_CONFIRM: DestructiveConfirmRequest = {
  confirmLabel: "Fork it",
  description:
    "Paco starts a second chat that begins as a copy of this one up to this reply, with its own branch and its own copy of the files, and opens it — so you will be taken out of this chat. Nothing here is lost: this chat, everything said in it and its files stay exactly as they are, and you can come back to it from the tabs along the top. From here on the two chats work separately, and what one does to its files does not affect the other.",
  destructive: false,
  title: "Fork this conversation?",
};

/**
 * Reverting a turn restores the whole worktree to the snapshot taken just
 * before it ran (`refs/paco/turns/<chatId>/<turnId>`), so it is a state, not a
 * patch: everything after that instant goes with it.
 *
 * Two things this has to say that the old wording did not, both consequences
 * of turns no longer auto-committing. It discards **staged** work, because the
 * restore replaces the index as well as the tree — and staging is now
 * deliberate, so silently throwing it away would be the worst surprise here.
 * And it cannot touch **commits**: the branch never moves, so anything already
 * committed survives. That second half is the reassuring one and belongs in
 * the dialog for the same reason the file's header gives — a warning that only
 * says "this cannot be undone" makes someone anxious without telling them what
 * they are actually risking.
 */
export const REVERT_TURN_CONFIRM: DestructiveConfirmRequest = {
  confirmLabel: "Revert this turn",
  description:
    "Your files go back to exactly how they were just before this turn ran. Every change made since is discarded — by the agent and by you — including anything you have staged in Changes but not yet committed. Commits are safe: anything you already committed stays, and this cannot reach it. The turn itself stays in the transcript. This cannot be undone.",
  title: "Revert this turn?",
};
