/**
 * How one chat's timeline is laid out on disk.
 *
 * - The **head row** (`timeline`, one per agent) holds the newest items with a range trimmed to
 *   exactly those items, so a cold start paints them at once and resumes with `after endSeq`.
 * - Older items are **sealed** into immutable `timeline_page` rows of up to PAGE_MAX items, each
 *   with its own contiguous range. Scrolling up reads the page that ends right before the loaded
 *   range instead of asking the daemon (`before startSeq`).
 *
 * A cut between two items is only valid when every item before it has a lower sequence than every
 * item after it. Tool calls keep their display position while their completion advances their
 * sequence, so a cut inside interleaved items would certify rows it does not hold. Cuts prefer turn
 * boundaries, where nothing is interleaved.
 */

export const HEAD_KEEP = 50;
export const SEAL_AT = 100;
export const PAGE_MAX = 100;
/** Past this, an unsealable head (no valid cut) is stored display-only. */
export const HEAD_MAX = 400;

export interface PositionedItem {
  kind: string;
  turnId?: string;
  timelineCursor?: { epoch: string; seq: number };
}

export interface TimelineCoverage {
  epoch: string;
  startSeq: number;
  endSeq: number;
}

export interface SealedSegment<Item> {
  items: Item[];
  range: TimelineCoverage;
  hasOlder: boolean;
}

export interface TimelineSealPlan<Item> {
  head: SealedSegment<Item>;
  /** Oldest first. */
  pages: SealedSegment<Item>[];
}

export interface ArchivedPageRef {
  agentId: string;
  epoch: string;
  startSeq: number;
  endSeq: number;
}

const SEQ_WIDTH = 12;

export function timelinePageId(agentId: string, epoch: string, startSeq: number, endSeq: number) {
  return [
    agentId,
    epoch,
    String(startSeq).padStart(SEQ_WIDTH, "0"),
    String(endSeq).padStart(SEQ_WIDTH, "0"),
  ].join("|");
}

export function parseTimelinePageId(id: string): ArchivedPageRef | null {
  const parts = id.split("|");
  if (parts.length < 4) return null;
  const endSeq = Number(parts.at(-1));
  const startSeq = Number(parts.at(-2));
  const agentId = parts[0];
  const epoch = parts.slice(1, -2).join("|");
  if (!agentId || !Number.isInteger(startSeq) || !Number.isInteger(endSeq)) return null;
  return { agentId, epoch, startSeq, endSeq };
}

/**
 * The highest sequence covered by pages contiguous with `fromSeq` (exclusive start: pages must
 * reach back to `fromSeq` or earlier). Returns `fromSeq - 1` when no page connects.
 */
export function archivedChainEnd(
  pages: readonly ArchivedPageRef[],
  epoch: string,
  fromSeq: number,
): number {
  const sameEpoch = pages
    .filter((page) => page.epoch === epoch)
    .sort((left, right) => left.startSeq - right.startSeq);
  let end = fromSeq - 1;
  for (const page of sameEpoch) {
    if (page.startSeq <= end + 1 && page.endSeq > end) end = page.endSeq;
  }
  return end;
}

function seqOf(item: PositionedItem): number {
  return item.timelineCursor?.seq ?? Number.NaN;
}

function isTurnBoundary(items: readonly PositionedItem[], index: number): boolean {
  const item = items[index];
  const previous = items[index - 1];
  if (!item || !previous) return false;
  return item.kind === "user_message" || item.turnId !== previous.turnId;
}

/** Largest valid cut k in [1, maxK]: items[0..k) all sequence below items[k..]. */
export function chooseTimelineCut(items: readonly PositionedItem[], maxK: number): number | null {
  if (maxK < 1 || items.length < 2) return null;
  const limit = Math.min(maxK, items.length - 1);
  const suffixMin: number[] = Array.from({ length: items.length + 1 }, () => 0);
  suffixMin[items.length] = Number.POSITIVE_INFINITY;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    suffixMin[index] = Math.min(seqOf(items[index]), suffixMin[index + 1]);
  }
  let prefixMax = Number.NEGATIVE_INFINITY;
  let largest: number | null = null;
  let largestBoundary: number | null = null;
  for (let k = 1; k <= limit; k += 1) {
    prefixMax = Math.max(prefixMax, seqOf(items[k - 1]));
    if (prefixMax < suffixMin[k]) {
      largest = k;
      if (isTurnBoundary(items, k)) largestBoundary = k;
    }
  }
  if (largestBoundary !== null && largest !== null && largestBoundary * 2 >= largest) {
    return largestBoundary;
  }
  return largest;
}

function splitsCleanly(items: readonly PositionedItem[], base: number): boolean {
  let seenAbove = false;
  for (const item of items) {
    const above = seqOf(item) > base;
    if (above) seenAbove = true;
    else if (seenAbove) return false;
  }
  return true;
}

/**
 * Splits a contiguous, fully positioned timeline into a head and newly sealed pages. Items at or
 * below `archivedEnd` are already on disk and are left out. Returns null when no head can be
 * certified (the caller then stores a display-only head).
 */
export function planTimelineSeal<Item extends PositionedItem>(input: {
  items: readonly Item[];
  range: TimelineCoverage;
  hasOlder: boolean;
  archivedEnd: number | null;
  headKeep?: number;
  sealAt?: number;
  pageMax?: number;
  headMax?: number;
}): TimelineSealPlan<Item> | null {
  const headKeep = input.headKeep ?? HEAD_KEEP;
  const sealAt = input.sealAt ?? SEAL_AT;
  const pageMax = input.pageMax ?? PAGE_MAX;
  const headMax = input.headMax ?? HEAD_MAX;
  const { range, items } = input;
  const oldestInMemory = range.startSeq;

  let base = range.startSeq - 1;
  const archivedEnd = input.archivedEnd;
  if (archivedEnd !== null && archivedEnd > base && archivedEnd < range.endSeq) {
    const remaining = items.filter((item) => seqOf(item) > archivedEnd).length;
    if (remaining >= headKeep && splitsCleanly(items, archivedEnd)) base = archivedEnd;
  }
  let head = items.filter((item) => seqOf(item) > base);
  const hasOlderBefore = (start: number) => (start > oldestInMemory ? true : input.hasOlder);

  const pages: SealedSegment<Item>[] = [];
  while (head.length > sealAt) {
    const cut = chooseTimelineCut(head, Math.min(pageMax, head.length - headKeep));
    if (cut === null) break;
    const pageItems = head.slice(0, cut);
    const pageEnd = Math.max(...pageItems.map(seqOf));
    pages.push({
      items: pageItems,
      range: { epoch: range.epoch, startSeq: base + 1, endSeq: pageEnd },
      hasOlder: hasOlderBefore(base + 1),
    });
    base = pageEnd;
    head = head.slice(cut);
  }
  if (head.length > headMax || head.length === 0) return null;
  return {
    head: {
      items: head,
      range: { epoch: range.epoch, startSeq: base + 1, endSeq: range.endSeq },
      hasOlder: hasOlderBefore(base + 1),
    },
    pages,
  };
}
