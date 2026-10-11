import { isDeepStrictEqual } from "node:util";
import type { TurnEvidence } from "./types.ts";

/** Do not forward provider replay signatures or binary attachments to a text judge. */
export function textEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(textEvidence);
  if (value === null || typeof value !== "object") return value;
  const object = value as Record<string, unknown>;
  if (object.type === "image" || object.type === "audio" || object.type === "video") {
    return { type: "unavailable_attachment", reason: "Text-only reviewer cannot inspect this attachment." };
  }
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(object)) {
    if (/signature|encrypted|replay|usage|timestamp/i.test(key) || ["providerPayload", "responseId", "credentialId"].includes(key)) continue;
    result[key] = textEvidence(field);
  }
  return result;
}

export function buildEvidence(instructions: string[], history: unknown[], assistant: unknown, toolResults: unknown[]): TurnEvidence {
  const relevant = history.filter((message): message is Record<string, unknown> => {
    if (!message || typeof message !== "object") return false;
    const item = message as Record<string, unknown>;
    return ["user", "assistant", "toolResult", "compactionSummary", "branchSummary"].includes(String(item.role));
  });
  const userIndex = relevant.findLastIndex(message => message.role === "user");
  const currentAssistant = textEvidence(assistant);
  const currentToolResults = toolResults.map(textEvidence);
  const projectedHistory = relevant.map(textEvidence);
  const excluded = new Set([userIndex]);
  // Equal earlier replies are real context, not copies of this turn. Remove only
  // the newest occurrence of each current message after the latest user request.
  for (const current of [currentAssistant, ...currentToolResults]) {
    for (let index = projectedHistory.length - 1; index > userIndex; index--) {
      if (excluded.has(index) || !isDeepStrictEqual(projectedHistory[index], current)) continue;
      excluded.add(index);
      break;
    }
  }
  return {
    instructions,
    userRequest: userIndex >= 0 ? JSON.stringify(textEvidence(relevant[userIndex].content)) : "No user request available; abstain where necessary.",
    recentHistory: projectedHistory.filter((_message, index) => !excluded.has(index)),
    assistant: currentAssistant,
    toolResults: currentToolResults,
  };
}
