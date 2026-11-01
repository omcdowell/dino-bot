#!/usr/bin/env python3
"""Stamp the copyright (nameID 0) and licence (nameID 13) records into the Dino Live Activity fonts.

The fonts are generated (dino artwork as glyphs); the generator does not write these records, so run
this after every regeneration. Needs fontTools (`pip install fonttools`). Glyphs are not touched.

    python3 packages/app/scripts/stamp-dino-font-names.py packages/app/targets/live-activity/DinoLive*.ttf
"""
import sys
from fontTools.ttLib import TTFont

COPYRIGHT = "Copyright 2026 omcdowell"
LICENCE = (
    "All rights reserved. Part of DinoBot: the DinoBot name, icon and artwork, including this font, "
    "are not covered by the Apache-2.0 licence of the DinoBot source."
)


def stamp(path: str) -> None:
    font = TTFont(path)
    names = font["name"]
    for name_id, text in ((0, COPYRIGHT), (13, LICENCE)):
        names.setName(text, name_id, 3, 1, 0x409)  # Windows, Unicode BMP, en-US
        names.setName(text, name_id, 1, 0, 0)  # Mac, Roman, English
    font.save(path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for p in sys.argv[1:]:
        stamp(p)
        print("stamped", p)
