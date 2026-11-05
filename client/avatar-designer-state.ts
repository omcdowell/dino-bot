/**
 * Avatar designer state on the phone (AV3): the choices, the selected accessory layer and undo history.
 * Ported from designer-b app.js r9 (layout B): switchChar parks a character's accessory layers and brings back
 * the new character's own, tap-off deselects, the fullscreen buttons nudge / turn / resize the selection, and
 * Shuffle / Undo never touch the network.
 *
 * Accessory layers are kept in avatar.json units (x, y = centre as 0-1 of the avatar square, scale = accessory
 * width / avatar width, rotation = degrees clockwise), so the picture is always `composeAvatarSvg(look, pack)` and
 * Save is `toAvatarJson(look)`. designer-b kept offsets from the automatic placement instead; the limits it put on
 * them (scale 0.2-5x the automatic size, centre inside the square) are applied here in the same terms.
 *
 * Pure: no React, no react-native, so it runs under `tsx --test`.
 */
import {
  AVATAR_JSON_VERSION,
  MAX_ACCESSORIES,
  autoPlaceAccessory,
  eyeOptionsFor,
  keepInFrame,
  packIndex,
  parseAvatar,
  type AvatarAccessory,
  type AvatarJson,
  type AvatarLook,
  type AvatarPack,
} from "../shared/avatar";

/** What the picture depends on (avatar.json without v / packVersion / revision). */
export type Look = { character: string; eyes: string; colour?: string; accessories: AvatarAccessory[] };

export interface DesignerState {
  look: Look;
  /** Accessory layers of other characters this session (designer-b r7: layers belong to one character). */
  parked: Record<string, AvatarAccessory[]>;
}

export interface Designer {
  state: DesignerState;
  /** Selected accessory layer, -1 for none. Not part of undo history. */
  sel: number;
  history: DesignerState[];
  /** When the last button nudge pushed history (held buttons coalesce into one undo step). */
  lastNudgeAt: number;
}

export const HISTORY_MAX = 80;
/** designer-b STEP: move 1.5% of the square, turn 5°, resize ×1.06. */
export const STEP = { move: 0.015, rot: 5, scale: 1.06 } as const;
/** Resize limits, as multiples of the accessory's automatic size (designer-b ds 0.2-5). */
export const SCALE_MIN = 0.2;
export const SCALE_MAX = 5;
/** A held button keeps adding to the same undo step until it has been idle this long. */
export const NUDGE_COALESCE_MS = 1500;

/** designer-b DEFAULT: Emmet wearing his own box cap. */
export const DEFAULT_CHARACTER = "emmet-boxfish";

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const cloneLook = (l: Look): Look => ({ ...l, accessories: l.accessories.map((a) => ({ ...a })) });
const cloneState = (s: DesignerState): DesignerState => ({
  look: cloneLook(s.look),
  parked: Object.fromEntries(Object.entries(s.parked).map(([k, v]) => [k, v.map((a) => ({ ...a }))])),
});
const sameState = (a: DesignerState, b: DesignerState) => JSON.stringify(a) === JSON.stringify(b);

/** Degrees in (-180, 180]. */
export function normaliseRotation(r: number): number {
  const m = ((((r + 180) % 360) + 360) % 360) - 180;
  return m === -180 ? 180 : m;
}

/** A fresh designer on `look` (accessory layers default to their automatic placement when missing). */
export function createDesigner(look: Look): Designer {
  return { state: { look: cloneLook(look), parked: {} }, sel: -1, history: [], lastNudgeAt: 0 };
}

/** The default look for a character: its own accessory where it was drawn. */
export function defaultLook(pack: AvatarPack, character = DEFAULT_CHARACTER): Look {
  const own = pack.accessories.find((a) => a.from === character);
  return { character, eyes: "original", accessories: own ? [autoPlaceAccessory(pack, character, own.id)] : [] };
}

/** Change the state with one undo step (no step when nothing changed). `sel` is kept unless given. */
function commit(d: Designer, next: DesignerState, sel = d.sel): Designer {
  if (sameState(next, d.state)) return sel === d.sel ? d : { ...d, sel };
  const history = [...d.history, d.state].slice(-HISTORY_MAX);
  return { ...d, state: next, sel: clampSel(sel, next.look), history };
}
const clampSel = (sel: number, look: Look) => (sel >= 0 && sel < look.accessories.length ? sel : -1);

/** designer-b switchChar: park the current layers on the old character, bring back the new one's own. */
function switchCharacter(s: DesignerState, id: string, accessories?: AvatarAccessory[]): DesignerState {
  const parked = { ...s.parked };
  if (s.look.accessories.length) parked[s.look.character] = s.look.accessories.map((a) => ({ ...a }));
  else delete parked[s.look.character];
  const mine = accessories ?? parked[id] ?? [];
  delete parked[id];
  return { look: { ...s.look, character: id, accessories: mine.map((a) => ({ ...a })) }, parked };
}

export function pickCharacter(d: Designer, pack: AvatarPack, id: string): Designer {
  if (id === d.state.look.character || !packIndex(pack).character.has(id)) return d;
  return commit(d, switchCharacter(d.state, id), -1);
}

/** `undefined` = Original (the character's own colours). */
export function setColour(d: Designer, colour: string | undefined): Designer {
  const next = cloneState(d.state);
  if (colour) next.look.colour = colour;
  else delete next.look.colour;
  return commit(d, next, -1);
}

export function setEyes(d: Designer, eyes: string): Designer {
  const next = cloneState(d.state);
  next.look.eyes = eyes;
  return commit(d, next, -1);
}

/** Add an accessory at its automatic place and select it. Ignored at MAX_ACCESSORIES. */
export function addAccessory(d: Designer, pack: AvatarPack, id: string): Designer {
  if (d.state.look.accessories.length >= MAX_ACCESSORIES) return d;
  const next = cloneState(d.state);
  next.look.accessories.push(autoPlaceAccessory(pack, next.look.character, id));
  return commit(d, next, next.look.accessories.length - 1);
}

/** The None tile: every layer off. */
export function removeAllAccessories(d: Designer): Designer {
  if (!d.state.look.accessories.length) return d;
  const next = cloneState(d.state);
  next.look.accessories = [];
  return commit(d, next, -1);
}

export function deleteSelected(d: Designer): Designer {
  if (d.sel < 0 || !d.state.look.accessories[d.sel]) return d;
  const next = cloneState(d.state);
  next.look.accessories.splice(d.sel, 1);
  return commit(d, next, -1);
}

export function select(d: Designer, sel: number): Designer {
  const s = clampSel(sel, d.state.look);
  return s === d.sel ? d : { ...d, sel: s };
}
export const deselect = (d: Designer): Designer => select(d, -1);

/** The fullscreen "next accessory" button (designer-b `prev`): cycles backwards, wrapping. */
export function cycleSelection(d: Designer): Designer {
  const n = d.state.look.accessories.length;
  if (!n) return d;
  return { ...d, sel: d.sel <= 0 ? n - 1 : d.sel - 1 };
}

/** Clamp a layer: centre inside the square, size within 0.2-5x its automatic size, rotation in (-180, 180]. */
export function constrainAccessory(pack: AvatarPack, character: string, a: AvatarAccessory): AvatarAccessory {
  const auto = autoPlaceAccessory(pack, character, a.id).scale;
  const out = keepInFrame({ ...a, scale: clamp(a.scale, auto * SCALE_MIN, auto * SCALE_MAX) });
  const r = normaliseRotation(a.rotation ?? 0);
  if (r) out.rotation = r;
  else delete out.rotation;
  return out;
}

export type NudgeAction = "up" | "down" | "left" | "right" | "rotl" | "rotr" | "smaller" | "bigger";
export const NUDGE_ACTIONS: readonly NudgeAction[] = ["up", "down", "left", "right", "rotl", "rotr", "smaller", "bigger"];

/** One fullscreen button step on the selected layer. `isNew` = a fresh press (always its own undo step). */
export function nudge(d: Designer, pack: AvatarPack, act: NudgeAction, isNew: boolean, now: number): Designer {
  const a = d.state.look.accessories[d.sel];
  if (!a) return d;
  const b = { ...a };
  switch (act) {
    case "up": b.y -= STEP.move; break;
    case "down": b.y += STEP.move; break;
    case "left": b.x -= STEP.move; break;
    case "right": b.x += STEP.move; break;
    case "rotl": b.rotation = (b.rotation ?? 0) - STEP.rot; break;
    case "rotr": b.rotation = (b.rotation ?? 0) + STEP.rot; break;
    case "smaller": b.scale /= STEP.scale; break;
    case "bigger": b.scale *= STEP.scale; break;
  }
  const next = cloneState(d.state);
  next.look.accessories[d.sel] = constrainAccessory(pack, next.look.character, b);
  if (sameState(next, d.state)) return d;
  if (isNew || now - d.lastNudgeAt > NUDGE_COALESCE_MS) return { ...commit(d, next), lastNudgeAt: now };
  return { ...d, state: next, lastNudgeAt: now };
}

/**
 * A drag / pinch on the stage, relative to the layer as it was when the gesture started (`start`):
 * `dx`, `dy` in avatar units (fractions of the square), `scale` a multiplier, `rotation` degrees added.
 * `first` = the first move of this gesture (pushes one undo step for the whole gesture).
 */
export function applyGesture(
  d: Designer,
  pack: AvatarPack,
  start: AvatarAccessory,
  g: { dx: number; dy: number; scale?: number; rotation?: number },
  first: boolean,
): Designer {
  if (!d.state.look.accessories[d.sel]) return d;
  const b: AvatarAccessory = {
    ...start,
    x: start.x + g.dx,
    y: start.y + g.dy,
    scale: start.scale * (g.scale ?? 1),
    rotation: (start.rotation ?? 0) + (g.rotation ?? 0),
  };
  const next = cloneState(d.state);
  next.look.accessories[d.sel] = constrainAccessory(pack, next.look.character, b);
  if (first) return commit(d, next);
  return { ...d, state: next };
}

export function undo(d: Designer): Designer {
  const prev = d.history[d.history.length - 1];
  if (!prev) return d;
  return { ...d, state: prev, history: d.history.slice(0, -1), sel: clampSel(d.sel, prev.look), lastNudgeAt: 0 };
}

/** designer-b shuffle: any character; its own accessory 35%, any accessory 40%, none 25%; colour Original 30%;
 *  eyes Original 45%. `rng` returns [0, 1). */
export function shuffle(d: Designer, pack: AvatarPack, rng: () => number = Math.random): Designer {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rng() * a.length)]!;
  const ch = pick(pack.characters);
  const own = pack.accessories.find((a) => a.from === ch.id);
  const r = rng();
  const acc = r < 0.35 && own ? own.id : r < 0.75 ? pick(pack.accessories).id : null;
  const next = switchCharacter(d.state, ch.id, acc ? [autoPlaceAccessory(pack, ch.id, acc)] : []);
  if (rng() < 0.3) delete next.look.colour;
  else next.look.colour = pick(pack.palette)[0];
  next.look.eyes = rng() < 0.45 ? "original" : pick(eyeOptionsFor(pack, ch.id))[0];
  return commit(d, next, -1);
}

/* ---------- rows ---------- */

/** The eye option the Eyes row marks: the character's own look is hidden there, so it marks Original. */
export function shownEyes(pack: AvatarPack, look: Pick<Look, "character" | "eyes">): string {
  const own = packIndex(pack).character.get(look.character)?.ownEyes;
  return look.eyes === own ? "original" : look.eyes;
}

/** Accessory row badges: how many layers of each accessory are on. */
export function accessoryCounts(look: Look): Record<string, number> {
  const n: Record<string, number> = {};
  for (const a of look.accessories) n[a.id] = (n[a.id] ?? 0) + 1;
  return n;
}

/** Counter texts beside the row labels (designer-b layout B). */
export function counters(pack: AvatarPack, d: Designer): { character: string; colour: string; eyes: string; accessories: string } {
  const look = d.state.look;
  const ix = packIndex(pack);
  const at = pack.characters.findIndex((c) => c.id === look.character);
  const eyes = shownEyes(pack, look);
  const sel = look.accessories[d.sel];
  const n = look.accessories.length;
  return {
    character: `${ix.character.get(look.character)?.name ?? look.character} · ${at + 1} / ${pack.characters.length}`,
    colour: look.colour ? (pack.palette.find(([hex]) => hex.toUpperCase() === look.colour!.toUpperCase())?.[1] ?? look.colour) : "Original",
    eyes: pack.eyes.find(([id]) => id === eyes)?.[1] ?? "",
    accessories: !n ? "None" : `${n} on` + (sel ? ` · ${ix.accessory.get(sel.id)?.name ?? sel.id} selected` : ""),
  };
}

/** The tip under the preview and the fullscreen hint. */
export function hints(pack: AvatarPack, d: Designer): { tip: string; fs: string } {
  const look = d.state.look;
  const sel = look.accessories[d.sel];
  const name = sel ? (packIndex(pack).accessory.get(sel.id)?.name ?? sel.id) : "";
  return {
    tip: !look.accessories.length ? "" : sel ? "Drag to move · pinch to resize and turn · × removes it" : "Tap an accessory on the character to move or remove it",
    fs: !look.accessories.length
      ? "No accessories yet. Add some from the row above."
      : sel
        ? `${name} selected: drag, pinch, or use the buttons.`
        : "Tap an accessory to select it.",
  };
}

/* ---------- stage geometry (avatar units: the square is 0-1 on both axes) ---------- */

export interface LayerBox {
  cx: number;
  cy: number;
  /** Width and height of the selection box (the accessory plus designer-b's hit padding). */
  w: number;
  h: number;
  /** Degrees clockwise. */
  rotation: number;
}

/** The selection / hit box of layer `i` (designer-b's `.hit` rect: the accessory bbox padded by max(6, 8%)). */
export function layerBox(pack: AvatarPack, look: Look, i: number): LayerBox | null {
  const a = look.accessories[i];
  if (!a) return null;
  const ix = packIndex(pack);
  const acc = ix.accessory.get(a.id);
  const sa = acc && ix.character.get(acc.from)?.geo.acc;
  if (!sa) return null;
  const [, , w, h] = sa;
  const pad = Math.max(6, 0.08 * Math.max(w, h));
  const k = a.scale / w; // source units -> avatar units
  return { cx: a.x, cy: a.y, w: (w + 2 * pad) * k, h: (h + 2 * pad) * k, rotation: a.rotation ?? 0 };
}

/** Which layer is under the point (u, v) in avatar units: the top-most whose box holds it, else -1. */
export function hitTest(pack: AvatarPack, look: Look, u: number, v: number): number {
  for (let i = look.accessories.length - 1; i >= 0; i--) {
    const b = layerBox(pack, look, i);
    if (!b) continue;
    const t = (-b.rotation * Math.PI) / 180;
    const dx = u - b.cx, dy = v - b.cy;
    const lx = dx * Math.cos(t) - dy * Math.sin(t), ly = dx * Math.sin(t) + dy * Math.cos(t);
    if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return i;
  }
  return -1;
}

/** The top-right corner of a layer box after rotation (where the × button sits), in avatar units. */
export function boxCorner(b: LayerBox): { x: number; y: number } {
  const t = (b.rotation * Math.PI) / 180;
  const dx = b.w / 2, dy = -b.h / 2;
  return { x: b.cx + dx * Math.cos(t) - dy * Math.sin(t), y: b.cy + dx * Math.sin(t) + dy * Math.cos(t) };
}

/* ---------- avatar.json ---------- */

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** avatar.json for this look. x, y and scale are written with 4 decimals (AV2: 3 shifts accessories ~0.25 px at 512). */
export function toAvatarJson(look: Look, pack: AvatarPack, revision: number): AvatarJson {
  return {
    v: AVATAR_JSON_VERSION,
    packVersion: pack.packVersion,
    character: look.character,
    eyes: look.eyes,
    ...(look.colour ? { colour: look.colour } : {}),
    accessories: look.accessories.map((a) => {
      const r = Math.round(normaliseRotation(a.rotation ?? 0) * 10) / 10;
      return { id: a.id, x: clamp(r4(a.x), 0, 1), y: clamp(r4(a.y), 0, 1), scale: r4(a.scale), ...(r ? { rotation: r } : {}) };
    }),
    revision,
  };
}

/** A saved avatar.json as a look, or null when this pack cannot draw it (unknown ids, newer pack). */
export function lookFromAvatar(input: unknown, pack: AvatarPack): Look | null {
  const r = parseAvatar(input, pack);
  if (!r.ok) return null;
  const a = r.avatar;
  return { character: a.character, eyes: a.eyes, ...(a.colour ? { colour: a.colour } : {}), accessories: a.accessories.map((x) => ({ ...x })) };
}

/** The look as composeAvatarSvg takes it. */
export const composeInput = (look: Look): AvatarLook => look;
