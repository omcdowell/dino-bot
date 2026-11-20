import type { TFunction } from "i18next";

/** Translate function of the caller (`useTranslation().t`). */
export type ChatImageTranslate = TFunction;

/** The image a save or share acts on: what is on screen (display image or original). */
export interface ChatImageActionTarget {
  uri: string;
  mimeType?: string | null;
}
