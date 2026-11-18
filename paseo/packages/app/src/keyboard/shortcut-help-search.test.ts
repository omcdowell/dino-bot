import { describe, expect, it } from "vitest";
import {
  buildEffectiveBindings,
  buildKeyboardShortcutHelpSections,
  UNASSIGNED_COMBO,
  type ShortcutOverrides,
} from "./keyboard-shortcuts";
import { filterShortcutHelpSections, shortcutSearchText } from "./shortcut-help-search";

const MAC_DESKTOP = { isMac: true, isDesktop: true };
const COMMAND_CENTER_BINDING = "command-center-toggle-cmd-k-mac";

/**
 * The i18n port, filled with the real English strings the rows use. Translation
 * is the only dependency the filter cannot compute, so it is injected rather
 * than mocked.
 */
const EN: Record<string, string> = {
  "settings.shortcuts.sections.general": "General",
  "settings.shortcuts.help.toggleCommandCenter": "Toggle command center",
};

function translate(key: string): string {
  return EN[key] ?? key;
}

function filter(query: string, overrides: ShortcutOverrides = {}) {
  return filterShortcutHelpSections({
    sections: buildKeyboardShortcutHelpSections(MAC_DESKTOP, buildEffectiveBindings(overrides)),
    query,
    translate,
    shortcutOs: "mac",
  });
}

function matchedRowIds(query: string, overrides: ShortcutOverrides = {}): string[] {
  return filter(query, overrides).flatMap((section) => section.rows.map((row) => row.id));
}

describe("shortcutSearchText", () => {
  it("covers the tokens, the rendered badge, and the modifier aliases", () => {
    const text = shortcutSearchText([["mod", "N"]], "mac");

    expect(text).toContain("mod N");
    expect(text).toContain("⌘N");
    expect(text).toContain("cmd+N");
    expect(text).toContain("command+N");
  });

  // The alias expansion is combinatorial, so a flattened chord would multiply
  // the two combos together and invent spellings for keys never pressed at once.
  it("keeps a multi-step chord's combos apart", () => {
    const text = shortcutSearchText(
      [
        ["mod", "K"],
        ["mod", "N"],
      ],
      "mac",
    );

    expect(text).toContain("cmd+K");
    expect(text).toContain("cmd+N");
    expect(text).not.toContain("cmd+K+cmd+N");
  });
});

describe("filterShortcutHelpSections", () => {
  it("returns every section for a blank query", () => {
    expect(filter("  ")).toHaveLength(buildKeyboardShortcutHelpSections(MAC_DESKTOP).length);
  });

  it("matches a row by its label", () => {
    expect(matchedRowIds("command center")).toContain("toggle-command-center");
  });

  it("matches a row by the rendered badge", () => {
    expect(matchedRowIds("⌘k")).toContain("toggle-command-center");
  });

  it("matches a row by a spelled-out modifier", () => {
    expect(matchedRowIds("command+k")).toContain("toggle-command-center");
  });

  // The reported bug, from the search side: the cheat sheet has to stop finding
  // a row by keys the user has rebound away from.
  it("finds a rebound row by its new keys and not by the superseded default", () => {
    const overrides = { [COMMAND_CENTER_BINDING]: "Cmd+Shift+J" };

    expect(matchedRowIds("cmd+shift+j", overrides)).toContain("toggle-command-center");
    expect(matchedRowIds("cmd+k", overrides)).not.toContain("toggle-command-center");
  });

  it("still finds an unassigned row by its label", () => {
    const overrides = { [COMMAND_CENTER_BINDING]: UNASSIGNED_COMBO };

    expect(matchedRowIds("command center", overrides)).toContain("toggle-command-center");
    expect(matchedRowIds("cmd+k", overrides)).not.toContain("toggle-command-center");
  });

  it("keeps every row of a section whose own title matches", () => {
    const matched = filter("layout").find((section) => section.id === "layout");
    const all = buildKeyboardShortcutHelpSections(MAC_DESKTOP).find(
      (section) => section.id === "layout",
    );

    expect(matched?.rows).toHaveLength(all?.rows.length ?? 0);
  });

  it("drops a section whose rows all miss", () => {
    expect(filter("no shortcut spells this")).toEqual([]);
  });
});
