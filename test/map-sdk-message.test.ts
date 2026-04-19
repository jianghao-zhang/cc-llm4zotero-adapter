import { describe, expect, it } from "vitest";

import { mapSdkMessageToProviderEvents } from "../src/event-mapper/map-sdk-message.js";

describe("mapSdkMessageToProviderEvents", () => {
  it("does not duplicate tool_call when assistant content already includes tool_use", () => {
    const assistantMessage = {
      type: "assistant",
      session_id: "session-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call_123",
            name: "Read",
            input: { file_path: "/tmp/a.txt" },
          },
        ],
      },
    };

    const streamEvent = {
      type: "stream_event",
      session_id: "session-1",
      event: {
        type: "content_block_start",
        content_block: {
          type: "tool_use",
          id: "call_123",
          name: "Read",
          input: { file_path: "/tmp/a.txt" },
        },
      },
    };

    const assistantEvents = mapSdkMessageToProviderEvents(assistantMessage);
    const streamEvents = mapSdkMessageToProviderEvents(streamEvent);

    expect(assistantEvents.filter((event) => event.type === "tool_call")).toHaveLength(0);
    expect(streamEvents.filter((event) => event.type === "tool_call")).toHaveLength(1);
  });

  it("does not duplicate tool_result when user message contains both top-level and content-block results", () => {
    const userMessage = {
      type: "user",
      session_id: "session-1",
      tool_use_result: "top-level duplicate",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_123",
            content: [{ type: "text", text: "content-block result" }],
          },
        ],
      },
    };

    const events = mapSdkMessageToProviderEvents(userMessage);
    const toolResults = events.filter((event) => event.type === "tool_result");

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: "tool_result",
      payload: {
        toolUseId: "call_123",
        content: "content-block result",
      },
    });
  });
});
