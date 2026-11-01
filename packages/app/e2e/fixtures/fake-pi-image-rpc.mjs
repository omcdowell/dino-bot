// Fake `pi --mode rpc` for chat image tests: a prompt "read <path>" runs one `read` tool call
// whose result carries the image, the way pi's read tool returns PNG/JPEG files. History is
// kept so a reload replays it through get_messages.
import { readFileSync } from "node:fs";
import readline from "node:readline";

const messages = [];
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (command, data = {}) =>
  write({ id: command.id, type: "response", command: command.type, success: true, data });

function runPrompt(command) {
  const content = [{ type: "text", text: command.message }];
  for (const image of command.images ?? []) content.push(image);
  messages.push({ role: "user", content });
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  const target = /read (\S+)/.exec(command.message)?.[1];
  if (target) {
    const toolCallId = `read-${messages.length}`;
    const args = { path: target };
    const result = {
      content: [
        { type: "text", text: `Read image file [image/png]` },
        { type: "image", data: readFileSync(target).toString("base64"), mimeType: "image/png" },
      ],
    };
    write({ type: "tool_execution_start", toolCallId, toolName: "read", args });
    write({ type: "tool_execution_end", toolCallId, toolName: "read", result, isError: false });
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: args }],
    });
    messages.push({ role: "toolResult", toolCallId, toolName: "read", content: result.content });
  }
  write({ type: "agent_end", messages: [] });
}

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const command = JSON.parse(line);
  switch (command.type) {
    case "get_available_models":
      respond(command, { models: [{ provider: "e2e", id: "pi-image-model", name: "Pi image" }] });
      break;
    case "get_state":
      respond(command, {
        sessionId: "e2e-pi-image-session",
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        messageCount: messages.length,
        pendingMessageCount: 0,
      });
      break;
    case "get_messages":
      respond(command, { messages });
      break;
    case "prompt":
      respond(command, { agentInvoked: true });
      setTimeout(() => runPrompt(command), 50);
      break;
    default:
      respond(command);
  }
}
