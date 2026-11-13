import type { ComposerAttachment, UserComposerAttachment } from "@/attachments/types";
import { userAttachmentsOnly } from "@/attachments/workspace-attachment-utils";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import type { DraftInput } from "@/stores/draft-store/state";
import { requestOutboxEdit, type OutboxRecord } from "@/stores/outbox-store";

/**
 * Edit on a pending message: its text (and images) go back into the agent's composer draft.
 *
 * The draft store is the composer's source of truth and is shared by every composer mounted
 * for the agent (and by the next one to mount), so writing there cannot miss the composer the
 * user is looking at. The write is checked before the caller may delete the message: if the
 * text did not land, the message must stay.
 */

/** What is already in the composer stays; the edited message follows it. */
export function mergeEditedIntoDraft(
  current: DraftInput | undefined,
  edited: { text: string; attachments: readonly ComposerAttachment[] },
): DraftInput {
  const text = mergeEditedText(current?.text ?? "", edited.text);
  const attachments: UserComposerAttachment[] = [...(current?.attachments ?? [])];
  const seen = new Set(attachments.map(attachmentIdentity));
  for (const attachment of userAttachmentsOnly(edited.attachments)) {
    const identity = attachmentIdentity(attachment);
    if (seen.has(identity)) continue;
    seen.add(identity);
    attachments.push(attachment);
  }
  return { text, attachments };
}

function mergeEditedText(existing: string, edited: string): string {
  if (existing.trim().length === 0) return edited;
  if (edited.length === 0) return existing;
  return `${existing.replace(/\s+$/, "")}\n\n${edited}`;
}

function attachmentIdentity(attachment: UserComposerAttachment): string {
  if (attachment.kind === "image") return `image:${attachment.metadata.id}`;
  return JSON.stringify(attachment);
}

export async function restoreOutboxRecordToComposer(record: OutboxRecord): Promise<void> {
  const draftKey = buildDraftStoreKey({
    serverId: record.serverId,
    agentId: record.agentId,
  });
  const store = useDraftStore.getState();
  const current = await store.hydrateDraftInput({ draftKey });
  const next = mergeEditedIntoDraft(current, {
    text: record.text,
    attachments: record.composerAttachments ?? [],
  });
  store.saveDraftInput({ draftKey, draft: next });
  const saved = useDraftStore.getState().getDraftInput(draftKey);
  if (!saved || saved.text !== next.text) {
    throw new Error("the text could not be put back in the composer");
  }
  // Mounted composers for this agent show the draft now.
  requestOutboxEdit({ serverId: record.serverId, agentId: record.agentId });
}
