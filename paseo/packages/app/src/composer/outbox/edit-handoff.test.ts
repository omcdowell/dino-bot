import { expect, test } from "vitest";
import { mergeEditedIntoDraft } from "./edit-handoff";

const image = (id: string) => ({
  kind: "image" as const,
  metadata: {
    id,
    mimeType: "image/png",
    storageType: "native-file" as const,
    storageKey: `${id}.png`,
    createdAt: 1,
  },
});

test("an empty composer gets the edited message as it was", () => {
  expect(
    mergeEditedIntoDraft(undefined, {
      text: "hello",
      attachments: [image("a")],
    }),
  ).toEqual({
    text: "hello",
    attachments: [image("a")],
  });
  expect(
    mergeEditedIntoDraft({ text: "  ", attachments: [] }, { text: "hello", attachments: [] }).text,
  ).toBe("hello");
});

test("text already in the composer is kept, the edited message after it", () => {
  expect(
    mergeEditedIntoDraft(
      { text: "new thought \n", attachments: [image("a")] },
      { text: "old message", attachments: [image("a"), image("b")] },
    ),
  ).toEqual({
    text: "new thought\n\nold message",
    attachments: [image("a"), image("b")],
  });
});

test("an image-only message keeps the typed text", () => {
  expect(
    mergeEditedIntoDraft(
      { text: "typed", attachments: [] },
      { text: "", attachments: [image("a")] },
    ),
  ).toEqual({ text: "typed", attachments: [image("a")] });
});

test("workspace context attachments are not put back (the composer re-derives them)", () => {
  const merged = mergeEditedIntoDraft(undefined, {
    text: "x",
    attachments: [
      {
        kind: "review",
        reviewDraftKey: "k",
        attachment: {
          type: "text",
          mimeType: "text/plain",
          title: "r",
          text: "r",
        },
      } as never,
    ],
  });
  expect(merged.attachments).toEqual([]);
});
