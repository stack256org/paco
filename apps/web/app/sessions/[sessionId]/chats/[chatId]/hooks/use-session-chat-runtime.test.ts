import { describe, expect, mock, test } from "bun:test";
import type { WebAgentUIMessage } from "@/app/types";

mock.module("server-only", () => ({}));

const { shouldAutoSubmit } = await import("./use-session-chat-runtime");

function assistant(parts: unknown[]): WebAgentUIMessage {
  return { id: "m1", role: "assistant", parts } as WebAgentUIMessage;
}

const BASH_DONE = {
  type: "tool-bash",
  toolCallId: "t1",
  state: "output-available",
  input: {},
  output: {},
};

const QUESTION_PENDING = {
  type: "tool-ask_user_question",
  toolCallId: "q1",
  state: "input-available",
  input: {},
};

const QUESTION_ANSWERED = {
  type: "tool-ask_user_question",
  toolCallId: "q1",
  state: "output-available",
  input: {},
  output: { answers: {} },
};

const TEXT = { type: "text", text: "Done." };

describe("shouldAutoSubmit", () => {
  test("submits once the user has answered a question", () => {
    // The one case where the browser owes the agent something: it is blocked
    // waiting for this answer.
    expect(
      shouldAutoSubmit({ messages: [assistant([QUESTION_ANSWERED])] }),
    ).toBe(true);
  });

  test("does not submit while the question is still unanswered", () => {
    expect(
      shouldAutoSubmit({ messages: [assistant([QUESTION_PENDING])] }),
    ).toBe(false);
  });

  test("does not submit after ordinary tool calls", () => {
    // This is the regression. Bash and every other tool run inside the Claude
    // Code process, which continues on its own — resubmitting re-asks the same
    // question. One conversation accumulated 45 identical answers this way.
    expect(shouldAutoSubmit({ messages: [assistant([BASH_DONE, TEXT])] })).toBe(
      false,
    );
    expect(shouldAutoSubmit({ messages: [assistant([BASH_DONE])] })).toBe(
      false,
    );
  });

  test("does not submit again once the agent has replied to the answer", () => {
    // Without this the loop simply restarts: the answered question is still in
    // the message forever.
    expect(
      shouldAutoSubmit({ messages: [assistant([QUESTION_ANSWERED, TEXT])] }),
    ).toBe(false);
  });

  test("ignores a message with no parts, and non-assistant messages", () => {
    expect(shouldAutoSubmit({ messages: [assistant([])] })).toBe(false);
    expect(shouldAutoSubmit({ messages: [] })).toBe(false);
    expect(
      shouldAutoSubmit({
        messages: [
          { id: "u1", role: "user", parts: [TEXT] } as WebAgentUIMessage,
        ],
      }),
    ).toBe(false);
  });

  test("submits when the question errored, so the agent is not left waiting", () => {
    expect(
      shouldAutoSubmit({
        messages: [
          assistant([
            { ...QUESTION_ANSWERED, state: "output-error", errorText: "no" },
          ]),
        ],
      }),
    ).toBe(true);
  });
});
