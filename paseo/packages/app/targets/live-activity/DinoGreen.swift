import SwiftUI

/// Dino green (13 Oct: "update the green everywhere in paseo to match the new dino green"):
/// the light green of the dino art's body (dino-colour-filled-light.svg) and the art's own darks.
/// The app's theme uses the same values (DINO_GREEN in packages/app/src/styles/theme.ts).
/// - body: fills and the island's count ring (10.6:1 on the island's black).
/// - outline: the art's outline green, for green drawn on a light surface (3.2:1 on white).
/// - ink: the art's eye/text colour, for anything drawn on a body-green fill (8.1:1).
enum DinoGreen {
  static let body = Color(red: 0xC7 / 255, green: 0xD0 / 255, blue: 0x8E / 255)
  static let outline = Color(red: 0x84 / 255, green: 0x98 / 255, blue: 0x3F / 255)
  static let ink = Color(red: 0x2B / 255, green: 0x33 / 255, blue: 0x18 / 255)
  /// Paseo's green: spring #9CC963 (13 Oct 21:02: "spring is my chosen green, but
  /// expect it change again"; build 35 was #64A633). Count ring, action tint, keyline, island worker
  /// badges. Lock Screen worker bubbles stay body/ink. The one place to change the Live Activity green; mirrors DINO_GREEN.accent in theme.ts.
  static let accent = Color(red: 0x9C / 255, green: 0xC9 / 255, blue: 0x63 / 255)
}
