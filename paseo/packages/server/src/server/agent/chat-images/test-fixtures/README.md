HEIC fixtures for the chat image store tests. Made on the host with pillow-heif 1.8.0 (libheif 1.23.4,
x265) from a 160x120 downscale of a CC0 photo (Wikimedia Commons, "Crater Lake National Park -
HCP - October 13, 2022 - 014.jpg", by Vulturesong, CC0 1.0):

- landscape-160x120.heic: 160x120, no rotation.
- portrait-irot-120x160.heic: the same pixels stored 160x120 with an `irot` box (saved with EXIF
  orientation 6), so it displays 120x160.
