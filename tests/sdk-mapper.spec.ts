import { describe, expect, it } from "vitest";
import { mapSdkMessageToProviderEvents } from "../src/event-mapper/map-sdk-message.js";

describe("mapSdkMessageToProviderEvents", () => {
  it("maps assistant text and tool_use blocks", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "assistant",
      session_id: "sess-1",
      message: {
        content: [
          { type: "text", text: "hello" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file: "a.ts" } }
        ]
      }
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "message_delta",
      payload: { delta: "hello", sessionId: "sess-1" }
    });
    expect(events[1]).toMatchObject({
      type: "tool_call",
      payload: { id: "toolu_1", name: "Read", sessionId: "sess-1" }
    });
  });

  it("maps result to final event", () => {
    const events = mapSdkMessageToProviderEvents({
      type: "result",
      session_id: "sess-2",
      result: "done",
      is_error: false,
      num_turns: 3
    });

    expect(events).toEqual([
      {
        type: "final",
        payload: {
          output: "done",
          isError: false,
          subtype: undefined,
          durationMs: undefined,
          numTurns: 3,
          sessionId: "sess-2"
        }
      }
    ]);
  });
});
