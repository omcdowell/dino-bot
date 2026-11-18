/**
 * SVG markup for the designer, all from the shared composer (shared/avatar/compose.ts), so the phone draws the
 * same picture the server renders from the saved avatar.json.
 *
 * Tiles are cached by what they show (designer-b r8: no tile is redrawn by a tap that does not change it, the
 * iOS "tile pop"): character tiles by colour, eye tiles by character + colour, accessory tiles once per pack.
 * The same inputs give the same array and strings, so memoised tiles skip their render entirely.
 *
 * Pure: runs under `tsx --test`.
 */
import { avatarViewBox, composeAccessorySvg, composeAvatarSvg, eyeOptionsFor, frameToView, packIndex, viewToFrame, type AvatarPack } from "../shared/avatar";
import { layerBox, toAvatarJson, type LayerBox, type Look } from "./avatar-designer-state";

export type Tile = { id: string; name: string; xml: string };

/** The shown square [x, y, size] in character units (shared/avatar/centre.ts avatarViewBox). */
export type StageView = readonly [number, number, number];

/** The stage, drawn from the look as Save writes it (4-decimal avatar.json), so what the phone shows is exactly what
 *  the server renders, centred the same way (AC1). `frozen`: keep this view instead (during a drag, so the picture
 *  does not slide under the finger; it settles on release, before any save). */
export function designerSvgs(pack: AvatarPack, look: Look, frozen?: StageView | null): { full: string; view: StageView } {
  const json = toAvatarJson(look, pack, 0);
  const view = frozen ?? avatarViewBox(pack, json);
  return { full: composeAvatarSvg(json, pack, { viewBox: view }), view };
}

/** A point on the stage (0-1 of the shown square) in avatar.json units (0-1 of the pack frame). */
export function stageToFrame(pack: AvatarPack, character: string, view: StageView, u: number, v: number): [number, number] {
  return viewToFrame(packIndex(pack).character.get(character)!, view, u, v);
}

/** Avatar.json lengths per stage length (the shown square is `view[2]`, the frame `geo.frame[2]`). */
export function stageScale(pack: AvatarPack, character: string, view: StageView): number {
  return view[2] / packIndex(pack).character.get(character)!.geo.frame[2];
}

/** layerBox in stage units (0-1 of the shown square). */
export function stageLayerBox(pack: AvatarPack, look: Look, view: StageView, i: number): LayerBox | null {
  const b = layerBox(pack, look, i);
  if (!b) return null;
  const [cx, cy] = frameToView(packIndex(pack).character.get(look.character)!, view, b.cx, b.cy);
  const k = stageScale(pack, look.character, view);
  return { cx, cy, w: b.w / k, h: b.h / k, rotation: b.rotation };
}

const caches = new WeakMap<AvatarPack, { chars: Map<string, Tile[]>; eyes: Map<string, Tile[]>; accs?: Tile[] }>();
const cacheOf = (pack: AvatarPack) => {
  let c = caches.get(pack);
  if (!c) caches.set(pack, (c = { chars: new Map(), eyes: new Map() }));
  return c;
};
/** Small LRU: a session touches a handful of colours / characters. */
function remember<T>(map: Map<string, T>, key: string, make: () => T, max = 16): T {
  const hit = map.get(key);
  if (hit) {
    map.delete(key);
    map.set(key, hit);
    return hit;
  }
  const v = make();
  map.set(key, v);
  if (map.size > max) map.delete(map.keys().next().value!);
  return v;
}

export function characterTiles(pack: AvatarPack, colour: string | undefined): Tile[] {
  return remember(cacheOf(pack).chars, colour ?? "", () =>
    pack.characters.map((c) => ({
      id: c.id,
      name: c.name,
      xml: composeAvatarSvg({ character: c.id, eyes: "original", accessories: [], ...(colour ? { colour } : {}) }, pack, { view: "naked" }),
    })),
  );
}

export function eyeTiles(pack: AvatarPack, character: string, colour: string | undefined): Tile[] {
  return remember(cacheOf(pack).eyes, `${character}|${colour ?? ""}`, () =>
    eyeOptionsFor(pack, character).map(([id, name]) => ({
      id,
      name,
      xml: composeAvatarSvg({ character, eyes: id, accessories: [], ...(colour ? { colour } : {}) }, pack, { view: "face" }),
    })),
  );
}

export function accessoryTiles(pack: AvatarPack): Tile[] {
  const c = cacheOf(pack);
  return (c.accs ??= pack.accessories.map((a) => ({ id: a.id, name: a.name, xml: composeAccessorySvg(pack, a.id) })));
}

export function tileSvgs(pack: AvatarPack, look: Pick<Look, "character" | "colour"> & Partial<Look>) {
  return {
    characters: characterTiles(pack, look.colour),
    eyes: eyeTiles(pack, look.character, look.colour),
    accessories: accessoryTiles(pack),
  };
}
