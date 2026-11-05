import SwiftUI

/// The Lock Screen dino in live mode (Flint's la-live, Oct 2026): dino-motion's live mode (seed 1,
/// bots/flint/tasks/la-live/live-config.json) walking, running, turning and sitting along the whole
/// header line, played by the system's timer renderer. The widget draws nothing per frame.
///
/// - Precomputed: a 10 h run (a 60 min run for 6 fps) of the exact engine (dino-motion c9fd24e),
///   sampled 6 times a second, the loop closed by a walk home (bots/flint/tasks/la-live/tools/timeline.ts).
/// - Each `Text(timerInterval:)` ticks once a second; its string is "HHHHH:MM:SS". The fonts
///   (tools/gen_live.py) turn the MM and SS digit pairs into pair glyphs and then, by context
///   (last hour digit, colon, minutes pair, colon), the seconds pair into one glyph: the dino's pose
///   at its place along the line (a TrueType composite: pose outline + x offset, mirrored when
///   facing left). Every other character is an empty zero-width glyph. The timer renderer forms no
///   ligature across a colon, but contextual rules do see across it.
/// - So the 3 fps sequence repeats every 10 h (the hour digit's cycle), with no ContentState field
///   and no update needed; the anchor is a fixed date, so updates do not move him.
/// - The 6 fps fonts (DinoLive6j<j>m) hold a separate 60 min run (rules on minutes and seconds only,
///   2.1 MB instead of 8.5 MB; 2026-10-12: "use the 60min loop and 6fps"). It is not the
///   10 h run's first hour, so the dino jumps to another place when the switch flips.
/// - N layers (3 or 6) start j/N s apart, for N fps. Layer j is one font with every second; it shows
///   while its own second and the next layer's differ in parity (gate fonts, la-font's scheme as an
///   intersection of two masks), i.e. only in its own 1/N s.
/// Fonts (this target, Info.plist UIAppFonts): DinoLive3j<j>m, DinoLive6j<j>m, DinoLiveGate<e|o>,
/// DinoLiveStill ("0" = standing at the start of the line, for Always-On).
/// Flicker fixes for 6 fps (Flint's la-flicker, 13 Oct 2026), picked on the app's Network page
/// ("Lock Screen dino flicker fix") and sent to the widget in the content state (`dinoFix`), like
/// the 3/6 fps switch. On the owner's iPhone 17 (build 28, 6 fps) the dino blanked for one refresh at
/// the hand-over from layer 1 to layer 2 (every second) and from layer 2 to layer 3 (every other
/// second), and doubled at some others; only the hand-over from layer 5 to layer 0 was always clean.
/// At a hand-over two separate timer Texts with the same start (the closing gate of the old layer,
/// the opening gate of the new one) must change in the same frame, and on the phone they do not
/// always. 3 fps is unchanged by every option.
enum DinoFix {
  /// 0: build 28 as it was.
  static let b28 = 0
  /// 1: whole-second closers. Every layer's closing gate is a timer started 1 s later than the
  /// next layer's (same ticks, opposite parity, so the gate fonts pair even/even and odd/odd),
  /// as the always-clean 5 -> 0 hand-over already was (anchor + 1 s closes layer 5, anchor + 0 opens
  /// layer 0). No new views.
  static let wholeSecond = 1
  /// 2: per-hand-over hold. Only where build 28 blanked, the old layer's closing gate ticks
  /// `holdShort` later: 1 -> 2 on every second, 2 -> 3 on even seconds. Elsewhere as build 28.
  static let holdFailing = 2
  /// 3: cover + hold. Every layer is drawn opaque (white dino on a black lane, turned into alpha by
  /// its luminance), later layers on top, and every closing gate ticks `holdLong` later. A late
  /// close shows the new pose on top of the old one (it covers it), an early close is held by the
  /// old pose: no blank and no double, at the cost of the 5 -> 0 change showing `holdLong` late.
  static let coverHold = 3
  static let count = 4
  /// The fix when neither the content state nor the widget's own copy has one (pushes from
  /// paseo-apns do not carry `dinoFix`): cover + hold. 13 Oct, build 29: every option was
  /// clean on his phone; 3 is the one that does not depend on the order iOS changes the timers in.
  /// Builds 28-29 used 0.
  static let standard = coverHold
  /// 1.5 refreshes at 120 Hz: a closer that was one refresh early lands with the opener or one
  /// refresh after it, never on the same frame boundary again.
  static let holdShort: Double = 0.0125
  /// 3 refreshes at 120 Hz; hidden under the next layer, so it can be longer.
  static let holdLong: Double = 0.025

  static func valid(_ value: Int?) -> Int? {
    guard let value = value, value >= 0, value < count else { return nil }
    return value
  }
}

struct DinoLiveLane: View {
  /// 3 or 6 (dinoLayers(state)); anything else shows the standing pose.
  var layers: Int
  /// DinoFix (6 fps only).
  var fix: Int = DinoFix.standard
  var height: CGFloat = 24
  /// Line art colour (build 34: the Lock Screen ink; before: always white).
  var color: Color = .white

  static let anchor = Date(timeIntervalSince1970: 1_700_000_000)
  /// Lane width / height (gen_live.py fonts.json "aspect"): the engine's world width.
  /// Build 38: 7.59 (world 7 590 units), so that on iPhone 17 his walk ends just before option F's
  /// tab ("dino should only walk until the tab sticks out and then turn back"). Same engine,
  /// config (seed 1), speed and poses; only the turn-around points moved. Builds 26-37: 13.54.
  static let aspect: CGFloat = 7.59
  /// His ink's x extent over both loops (font units; min / max over every frame glyph of the 3 fps
  /// and 6 fps fonts). Builds 26-37 (13.54): 64.3..13 474.1.
  static let inkLeft: CGFloat = 48
  static let inkRight: CGFloat = 7_541

  private var width: CGFloat { height * Self.aspect }
  private var activeFix: Int { layers == 6 ? (DinoFix.valid(fix) ?? DinoFix.standard) : DinoFix.b28 }

  private func timer(_ offset: Double, _ font: String) -> some View {
    Text(timerInterval: Self.anchor.addingTimeInterval(offset)...Date.distantFuture, countsDown: false)
      .font(.custom(font, fixedSize: height))
      .lineLimit(1)
      .frame(width: width, height: height, alignment: .leading)
      .clipped()
  }

  /// Delay of layer j's closing gate (s): `even` for the term that closes on even seconds of the
  /// next layer's timer (Gatee own ∩ Gateo next), else the one that closes on odd seconds.
  private func hold(_ j: Int, even: Bool) -> Double {
    switch activeFix {
    case DinoFix.holdFailing:
      // Build 28 on the phone: 1 -> 2 blanked on every second, 2 -> 3 on even seconds.
      if j == 1 { return DinoFix.holdShort }
      if j == 2 && even { return DinoFix.holdShort }
      return 0
    case DinoFix.coverHold:
      return DinoFix.holdLong
    default:
      return 0
    }
  }

  /// Layer j's window: open while its own timer's second and the next layer's differ in parity.
  @ViewBuilder private func gate(_ j: Int) -> some View {
    let off = Double(j) / Double(layers)
    let next = Double(j + 1) / Double(layers)
    if activeFix == DinoFix.wholeSecond {
      // The closer one second later: same ticks, opposite parity.
      ZStack {
        timer(off, "DinoLiveGatee").mask(timer(next + 1, "DinoLiveGatee"))
        timer(off, "DinoLiveGateo").mask(timer(next + 1, "DinoLiveGateo"))
      }
    } else {
      ZStack {
        timer(off, "DinoLiveGatee").mask(timer(next + hold(j, even: true), "DinoLiveGateo"))
        timer(off, "DinoLiveGateo").mask(timer(next + hold(j, even: false), "DinoLiveGatee"))
      }
    }
  }

  private func content(_ j: Int) -> some View {
    timer(Double(j) / Double(layers), "DinoLive\(layers)j\(j)m")
  }

  var body: some View {
    ZStack {
      if layers == 3 || layers == 6 {
        if activeFix == DinoFix.coverHold {
          // Opaque layers: a later (newer) layer hides the one under it; luminance -> alpha. drawingGroup
          // flattens them first: with compositingGroup the Lock Screen applied the luminance per layer
          // (no cover; simulator, la-flicker).
          Rectangle().fill(color)
            .frame(width: width, height: height)
            .mask {
              ZStack {
                ForEach(0..<layers, id: \.self) { j in
                  ZStack {
                    Color.black
                    content(j).foregroundStyle(.white)
                  }
                  .frame(width: width, height: height)
                  .mask(gate(j))
                }
              }
              .drawingGroup()
              .luminanceToAlpha()
            }
        } else {
          ForEach(0..<layers, id: \.self) { j in
            content(j).mask(gate(j))
          }
        }
      } else {
        Text("0")
          .font(.custom("DinoLiveStill", fixedSize: height))
          .lineLimit(1)
          .frame(width: width, height: height, alignment: .leading)
      }
    }
    .frame(width: width, height: height)
    .foregroundStyle(color)
    // VoiceOver would read the timers ("25 thousand hours"): one element, "dino".
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("dino")
  }
}
