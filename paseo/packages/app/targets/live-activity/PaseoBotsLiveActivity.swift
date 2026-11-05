import ActivityKit
import SwiftUI
import CoreText
import UIKit
import WidgetKit

/// Busy bots on the Lock Screen and in the Dynamic Island (the owner's pick, 2026-10-11, mockups in
/// research/live-activity/reports/mockups):
/// - Lock Screen (also banner/StandBy), option F since build 38 (mockups-v3): up to 4 rows (icon,
///   name, worker segments or "working", running time) or 3 and "+N more" on a solid panel, black /
///   white following the phone (lockScheme), with a "N BOTS · N WKR" tab on its top edge and the
///   dino walking on that edge up to the tab (FPanel). Glass card around it (build 36).
/// - Dynamic Island, option C (builds 13-37, and again since build 39 with F's timer style;
///   build 38 used option F): expanded is a strip of large icons with the running time under each
///   (IslandTimer) and a Paseo green (spring #9CC963) worker-count badge, no names; compact is the
///   top bot's icon (with a small worker-count badge while it has workers, CompactLeadingIcon) and
///   the count in a green ring; minimal is the ring.
/// Bots are shown longest-running first. Data comes from the paseo-apns add-on (pushes) or the app
/// (local apply); see PaseoBotsAttributes.swift. Icons: BotIcon.
@main
struct PaseoLiveActivityBundle: WidgetBundle {
  var body: some Widget {
    PaseoBotsLiveActivity()
  }
}

private let green = Color(red: 0.19, green: 0.82, blue: 0.35)  // iOS system green, as in the mockups
/// Worker-count capsules and badges (13 Oct, option A: "a deemphasised workers bubble,
/// match the green with dinos light green body"): the dino's light green body #C7D08E
/// (dino-colour-filled-light.svg) behind dark olive #2B3318 text (the svg's darkest ink), the same
/// in light and dark. Builds 22-31 used Apple's system green #248A3D with white bold text.
/// Build 33 (13 Oct 20:03: "use the dark dino green everywhere instead"): the fill is
/// the dark dino green #84983F (DinoGreen.outline) with white numbers.
/// Build 35 (13 Oct: "the working in la should go back to dino light green"): back to option
/// A's body green #C7D08E with #2B3318 text, in the capsule (the island badges moved to
/// islandBadgeFill below).
let workerCapsuleFill = DinoGreen.body
let workerCapsuleText = DinoGreen.ink
/// Dynamic Island worker-count badges, expanded and compact (13 Oct 21:34: "dynamic
/// island badge isnt using the correct green"): Paseo's green, spring #9CC963 (DinoGreen.accent),
/// with dark olive #2B3318 numbers. The Lock Screen / banner WorkerCapsule stays #C7D08E.
let islandBadgeFill = DinoGreen.accent
let islandBadgeText = DinoGreen.ink

/// A worker count in a small dino light green capsule (option A): 11 pt semibold, 16 pt tall,
/// 6 pt side padding, fully rounded.
struct WorkerCapsule: View {
  let text: String

  var body: some View {
    Text(text)
      .font(.system(size: 11, weight: .semibold).monospacedDigit())
      .foregroundStyle(workerCapsuleText)
      .lineLimit(1)
      .padding(.horizontal, 6)
      .frame(height: 16)
      .background(Capsule().fill(workerCapsuleFill))
  }
}
/// LockInk.of(.dark)'s background, unused since the card is always light (after build 29):
/// translucent black, the wallpaper shows through (build 15: "make this transparent black
/// not blue"; builds 12-14 used a dark navy panel).
private let panel = Color.black.opacity(0.45)

/// Lock Screen colours. The card always uses `.light` (lockScheme; 13 Oct, after build 29:
/// "lets make the live activity always light, as the ios doesnt actually change notifications on
/// dark mode"): the system's Liquid Glass with no tint of our own, and white text and dino line art,
/// like Apple's own Lock Screen notifications and widgets (build 19: "on light mode the lock
/// screen live activity should still have white text"; build 18 drew black ink on the glass).
/// `.dark` (build 17: white on the translucent black `panel`) was the dark-appearance card in
/// builds 17-29; it is kept here but nothing selects it any more.
struct LockInk {
  let primary: Color
  let secondary: Color
  /// Option F's faint ink ("working", "N workers"; mockup --pink3, a little stronger to stay legible).
  let tertiary: Color
  /// Dino green (the action tint; DinoGreen.accent, spring #9CC963 since 13 Oct 21:02). The island worker badges use it too (islandBadgeFill); Lock Screen worker counts are WorkerCapsule.
  let accent: Color
  /// `.clear` lets iOS 26 draw its Liquid Glass; a nil tint gives the older default material.
  let background: Color
  /// The inner box's solid fill (build 36): black in dark, white in light; `primary`/`secondary`
  /// are the inverted ink drawn on it.
  let box: Color
  /// The dino line art and outline, which stand on the glass above the box: the box's colour, black
  /// in dark and white in light (13 Oct ~21:40: "also make dino match the box
  /// colour"). Builds 19-36 drew it white in both.
  let dino: Color
  // No drop shadow anywhere (13 Oct, build 28: "no drop shadow on any area"). Builds 19-28
  // had a soft black shadow under the text and line art in light mode.

  /// Build 34 (13 Oct ~20:15: "i want the whole box to be block colour black in dark
  /// mode white in light mode. text should invert colour to be high contrast"): a solid card, pure
  /// black in dark and pure white in light, no glass; text, timer, dino line art and outline in the
  /// opposite colour. Builds 30-33: always the light glass with white ink (`panel` was the dark one).
  ///
  /// Build 36 (13 Oct: "i actually only wanted the inner box of the la to be black/white.
  /// with no outline"): the card is the glass again (`background` `.clear`, as builds 30-33); only
  /// the box around the rows (option A's faded, outlined box, DinoListFrame) is solid black / white,
  /// with no outline and no fade; the ink on it stays inverted. The dino above the box takes the
  /// box's colour (after build 36).
  static func of(_ scheme: ColorScheme) -> LockInk {
    scheme == .dark
      ? LockInk(
        primary: .white, secondary: Color.white.opacity(0.66), tertiary: Color.white.opacity(0.4), accent: DinoGreen.accent, background: .clear,
        box: .black, dino: .black)
      : LockInk(
        primary: .black, secondary: Color.black.opacity(0.62), tertiary: Color.black.opacity(0.36), accent: DinoGreen.accent, background: .clear,
        box: .white, dino: .white)
  }
}

/// The Lock Screen card's colour scheme: always `.light` (13 Oct, after build 29: iOS does
/// not change its own Lock Screen notifications with the phone's appearance, so the card does not
/// either). Builds 17-29 followed the phone: the activity state's `appearance` (set by the app,
/// and by paseo-apns from what the app reported), else the app's shared keychain copy
/// (BotIconStore.readAppearance), else the view's scheme, which iOS 26 gives as dark in both
/// appearances (FB21353175). The app still sends `appearance`; the card ignores it.
///
/// Builds 34-36 (solid box) follow the phone again, the builds 25-29 way (84b8a49, 2d560dc): the
/// state's `appearance`, else the keychain copy, else the view's scheme.
func lockScheme(_ state: String?, _ environment: ColorScheme) -> ColorScheme {
  switch state ?? BotIconStore.readAppearance() {
  case "light": return .light
  case "dark": return .dark
  default: return environment
  }
}

/// The Lock Screen dino's timer layers (3 or 6), first match wins:
/// 1. the activity state's `dinoLayers` (set by the app on every local update and when the switch
///    changes);
/// 2. the App Group copy the app wrote (SharedStore), for pushes that do not carry it;
/// 3. the shared keychain copy (BotIconStore.readDinoLayers, which is 3 when it has none).
/// Builds 23-24 used the keychain alone, and the switch never reached the card on the phone.
func dinoLayers(_ state: PaseoBotsAttributes.ContentState) -> Int {
  if let layers = state.dinoLayers, layers == 3 || layers == 6 { return layers }
  return SharedStore.readDinoLayers() ?? BotIconStore.readDinoLayers()
}

/// The 6 fps flicker fix (DinoFix, the app's Network page picker): the activity state's `dinoFix`
/// (the app sets it on every local update and redraws the card when the picker changes), else the
/// last one this widget saw in a state. paseo-apns does not send it, the App Group is off and the
/// shared keychain never reached the widget on the phone, so the widget keeps its own copy
/// (its UserDefaults) for pushes; DinoFix.standard (3, cover + hold) before it ever saw one
/// (builds 28-29: 0, build 28's timing).
func dinoFix(_ state: PaseoBotsAttributes.ContentState) -> Int {
  let key = "paseo.dinoFix"
  if let fix = DinoFix.valid(state.dinoFix) {
    if UserDefaults.standard.object(forKey: key) as? Int != fix {
      UserDefaults.standard.set(fix, forKey: key)
    }
    return fix
  }
  return DinoFix.valid(UserDefaults.standard.object(forKey: key) as? Int) ?? DinoFix.standard
}

private func since(_ bot: PaseoBotsAttributes.Bot) -> Date {
  Date(timeIntervalSince1970: bot.since)
}

/// Build 44 (19 Oct: "do that live activity timer fix"): from 10 h the timer reads
/// hh:mm:ss (93 pt), which the 80 pt column cut. Rows that are near 10 h when the view renders get
/// the wider column. Checked from 9.5 h because the view only re-renders on a push (heartbeat every
/// 20 min), so a row that crosses 10 h between pushes already has the room. Same font and size.
private func longRun(_ bot: PaseoBotsAttributes.Bot) -> Bool {
  Date().timeIntervalSince(since(bot)) >= FLayout.longAfter
}

/// Stalled (19 Oct: "lets do the la update with it showing stalled unless we are at 100%
/// weekly in which case it drops off"): the bots plugin flags a bot that is not running a turn and
/// whose only outstanding workers are stalled (`stalled`), and counts any bot's stalled workers
/// (`stalledWorkers`); at 100% weekly it leaves stalled bots out itself. A stalled row says
/// "stalled" in grey (ink.tertiary), has no running timer, grey bars, and no dino walk for it; a
/// bot with running and stalled workers stays busy with its stalled workers as grey bars. Both
/// fields are optional: an older server sends neither, and every bot shows as busy, as before.
func isStalled(_ bot: PaseoBotsAttributes.Bot) -> Bool {
  bot.stalled == true && !bot.working
}

/// How many of the bot's workers to draw grey: all of them for a stalled bot.
func stalledCount(_ bot: PaseoBotsAttributes.Bot) -> Int {
  isStalled(bot) ? bot.workers : min(max(0, bot.stalledWorkers ?? 0), bot.workers)
}

/// Every bot is stalled (none hidden behind "+N", whose state the widget does not know): the dino
/// stands still and the island ring is grey.
func allStalled(_ state: PaseoBotsAttributes.ContentState) -> Bool {
  state.more == 0 && !state.bots.isEmpty && state.bots.allSatisfy(isStalled)
}

/// Grey for stalled bots in the island (always dark): LockInk.of(.dark).tertiary, and a grey badge.
let stalledInk = Color.white.opacity(0.4)
let stalledBadgeFill = Color(white: 0.32)
let stalledIconOpacity = 0.45

private func label(_ bot: PaseoBotsAttributes.Bot) -> String {
  if isStalled(bot) { return "stalled" }
  if bot.working && bot.workers == 0 { return "working" }
  return bot.workers == 1 ? "1 worker" : "\(bot.workers) workers"
}

private func total(_ state: PaseoBotsAttributes.ContentState) -> Int {
  state.bots.count + state.more
}

/// Longest-running first; stalled bots after the busy ones (so the compact icon is a busy bot).
private func ordered(_ state: PaseoBotsAttributes.ContentState) -> [PaseoBotsAttributes.Bot] {
  state.bots.enumerated()
    .sorted {
      let (a, b) = (isStalled($0.element), isStalled($1.element))
      if a != b { return !a }
      return $0.element.since != $1.element.since ? $0.element.since < $1.element.since : $0.offset < $1.offset
    }
    .map(\.element)
}

/// Running time: fixed width (fits h:mm:ss), right or centre aligned.
private struct Elapsed: View {
  let bot: PaseoBotsAttributes.Bot
  var font: Font = .subheadline
  var width: CGFloat = 64
  var alignment: Alignment = .trailing

  var body: some View {
    Text(timerInterval: since(bot)...Date.distantFuture, countsDown: false)
      .font(font.monospacedDigit())
      .multilineTextAlignment(alignment == .center ? .center : .trailing)
      .lineLimit(1)
      .frame(width: width, alignment: alignment)
  }
}

// MARK: - Icons

/// The bot's icon, same as the app's bots home: its avatar, else its Lucide icon on a rounded tile
/// (both written by the app into BotIconStore), else the avatar built into the widget
/// (BundledAvatars), else the Lucide tile drawn here from the icon name in the activity state
/// (LucideTile), else the letter circle. Reusable at any size.
struct BotIcon: View {
  let bot: PaseoBotsAttributes.Bot
  var size: CGFloat = 22

  var body: some View {
    if let image = WidgetBotImage.image(bot.id) {
      Image(uiImage: image)
        .resizable()
        .interpolation(.high)
        .scaledToFit()
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    } else if let name = bot.icon, let glyph = LucidePaths.glyph(name) {
      LucideTile(glyph: glyph, size: size).accessibilityHidden(true)
    } else {
      BotInitial(bot: bot, size: size)
    }
  }
}

struct BotInitial: View {
  let bot: PaseoBotsAttributes.Bot
  var size: CGFloat = 22

  var body: some View {
    Text(String(bot.name.prefix(1)).uppercased())
      .font(.system(size: size * 0.5, weight: .semibold))
      .foregroundStyle(.white)
      .frame(width: size, height: size)
      .background(Circle().fill(Color(white: 0.3)))
  }
}

/// Icon with the dino light green worker-count badge at its top-right corner (no badge without workers).
/// The badge sits inside the view's own frame: the icon is inset by the badge's overhang at the top
/// and on both sides (both, so the icon stays centred over its timer), so nothing is drawn outside
/// the frame and no region bound can clip it. Build 13 drew the badge as an offset overlay above
/// the frame; the island cut its top flat (under the camera in the expanded view, at the compact
/// region's top).
struct BadgedBotIcon: View {
  let bot: PaseoBotsAttributes.Bot
  var size: CGFloat = 44

  static func badgeDiameter(_ size: CGFloat) -> CGFloat { max(12, size * 0.4) }
  /// How far the badge reaches past the icon's top and right edges.
  static func overhang(_ size: CGFloat) -> CGFloat { (badgeDiameter(size) * 0.35).rounded(.up) }

  var body: some View {
    let d = Self.badgeDiameter(size)
    let o = Self.overhang(size)
    ZStack(alignment: .topTrailing) {
      BotIcon(bot: bot, size: size)
        .opacity(isStalled(bot) ? stalledIconOpacity : 1)
        .padding(.top, o)
        .padding(.horizontal, o)
      if bot.workers > 0 {
        Text("\(bot.workers)")
          .font(CountRing.font(d * 0.62))  // timer typeface (build 39)
          .foregroundStyle(isStalled(bot) ? Color.white.opacity(0.75) : islandBadgeText)
          .minimumScaleFactor(0.6)
          .offset(x: NumberCentring.offset("\(bot.workers)", size: d * 0.62))  // build 41
          .frame(width: CountRing.pillWidth(d, bot.workers), height: d)
          // Circle at 1-9, fully rounded pill at 10+ like CountRing (build 39; before: "9+").
          // Grey for a stalled bot (build 45).
          .background(Capsule(style: .continuous).fill(isStalled(bot) ? stalledBadgeFill : islandBadgeFill))
          // Same place as before: centre near the icon's corner, 35% of the badge past each edge.
          .padding(.top, o - d * 0.35)
          .padding(.trailing, o - d * 0.35)
      }
    }
    .frame(width: size + 2 * o, height: size + o)
  }
}

/// Compact leading: the top bot's icon, centred on the island's centre line (level with the ring).
/// - No workers: the icon alone at the ring's size (22 pt), as in build 15.
/// - Workers: the icon shrinks to 18 pt towards the island's end and the green count badge appears
///   at its top-right, overlapping it, as in build 14 (build 16).
/// The frame is the same in both states (22 x 24 pt): 24 so the icon stays vertically centred while
/// the badge reaches 3 pt above the small icon (the region's content is ~26 pt tall, so nothing is
/// clipped), 22 wide so the island does not change width. Build 14 instead padded the frame above
/// the icon only, which put the icon 2.7 pt below the centre.
/// Animation (content-state update, iOS 17+): the icon's scale springs between 22 and 18 pt and the
/// badge scales and fades in or out; the count morphs as a numeric text. iOS 16 shows the end state.
struct CompactLeadingIcon: View {
  let bot: PaseoBotsAttributes.Bot
  static let width: CGFloat = CountRing.size
  static let height: CGFloat = CountRing.size + 2
  static let smallIcon: CGFloat = 18
  static let badge: CGFloat = 12

  var body: some View {
    let busy = bot.workers > 0
    ZStack(alignment: .topTrailing) {
      BotIcon(bot: bot, size: Self.width)
        .opacity(isStalled(bot) ? stalledIconOpacity : 1)
        // scaleEffect, not a smaller frame: the scale animates, and the layout (and so the
        // island's width) stays the same. Anchored at the leading edge: the icon keeps its inset from
        // the island's end and frees the space on its right for the badge.
        .scaleEffect(busy ? Self.smallIcon / Self.width : 1, anchor: .leading)
        .frame(width: Self.width, height: Self.height)
      if busy {
        // Top-right of the frame: 3 pt above and 4 pt right of the small icon's corner, like the
        // expanded badges.
        Text("\(bot.workers)")
          .font(CountRing.font(Self.badge * 0.62))  // timer typeface (build 39)
          .foregroundStyle(isStalled(bot) ? Color.white.opacity(0.75) : islandBadgeText)
          .minimumScaleFactor(0.6)
          .contentTransition(.numericText())
          .offset(x: NumberCentring.offset("\(bot.workers)", size: Self.badge * 0.62))  // build 41
          .frame(width: CountRing.pillWidth(Self.badge, bot.workers), height: Self.badge)
          // Circle at 1-9, fully rounded pill at 10+ like CountRing (build 39; before: "9+").
          .background(Capsule(style: .continuous).fill(isStalled(bot) ? stalledBadgeFill : islandBadgeFill))
          .transition(.scale(scale: 0.1, anchor: .center).combined(with: .opacity))
      }
    }
    .frame(width: Self.width, height: Self.height)
    .animation(.spring(response: 0.55, dampingFraction: 0.7), value: busy)
    .animation(.spring(response: 0.4, dampingFraction: 0.8), value: bot.workers)
  }
}

// MARK: - Lock Screen (option F, build 38)

/// Option F, "Bold HUD on solid panel" (13 Oct ~22:50: "lets implement F, switching
/// between white and black on light/dark mode"; research/live-activity/reports/mockups-v3, F-*.png):
/// option E's one-row-per-bot HUD on the solid panel (the inner box of build 36), heavier rounded
/// type (SF Rounded), worker segments, a "N BOTS · N WKR" tab sticking up from the panel's top edge
/// at the right, and the dino in the panel's colour walking on the panel's top edge, turning back
/// before the tab (~23:00: "dino should only walk until the tab sticks out and then turn
/// back"; FTab, DinoOnEdge). Up to 4 rows; with more bots 3 rows and "+N more".
enum FType {
  static let name = Font.system(size: 16, weight: .heavy, design: .rounded)
  static let timer = Font.system(size: 19, weight: .black, design: .rounded).monospacedDigit()
  static let idle = Font.system(size: 12, weight: .bold, design: .rounded)
  static let tab = Font.system(size: 11, weight: .black, design: .rounded)
  static let more = Font.system(size: 12.5, weight: .heavy, design: .rounded)
}

/// "4 BOTS · 2 WKR": every bot (with the ones not in the list) and the workers of the listed bots.
private func tabText(_ state: PaseoBotsAttributes.ContentState) -> String {
  let bots = total(state)
  let workers = state.bots.reduce(0) { $0 + $1.workers }
  return "\(bots) \(bots == 1 ? "BOT" : "BOTS") · \(workers) WKR"
}

/// Worker segments (option F): one spring green (#9CC963) upright bar per worker, `width` x 9 pt, 2 pt
/// apart, at most `maxShown`, then "+N" for the rest (14 Oct 08:29, build 39: "Use
/// fewer, narrower bars, for example 4 and then +N"; 6 workers = 4 bars + "+2"). Build 38: up to 5
/// bars, 15 pt wide, and no "+N" (6 workers cut "Emmet" to "Em…"). Builds 22-37 used a
/// WorkerCapsule ("2 workers") here.
/// Build 45: the last `stalled` workers are grey bars (ink.tertiary), after the green ones.
struct WorkerSegments: View {
  let count: Int
  var stalled: Int = 0
  var ink: LockInk? = nil
  static let maxShown = 4
  static let width: CGFloat = 6

  var body: some View {
    HStack(spacing: 2) {
      ForEach(0..<min(count, Self.maxShown), id: \.self) { i in
        RoundedRectangle(cornerRadius: Self.width / 2, style: .continuous)
          .fill(i >= count - stalled ? (ink?.tertiary ?? stalledInk) : DinoGreen.accent)
          .frame(width: Self.width, height: 9)
      }
      if count > Self.maxShown {
        Text("+\(count - Self.maxShown)")
          .font(FType.idle)
          .foregroundStyle(ink?.secondary ?? .secondary)
          .padding(.leading, 2)
      }
    }
    .fixedSize()
  }
}

/// One bot: icon 24, name (heavy rounded), state (segments, or "working"), running time (black
/// rounded). Every row with workers writes "N workers" next to its segments (workers-text mock;
/// builds 38-41: only the only bot (`single`, F-lock-1bot) and above 5 workers).
struct FRow: View {
  let bot: PaseoBotsAttributes.Bot
  let ink: LockInk
  var single = false
  var timerWidth: CGFloat = FLayout.timerWidth

  var body: some View {
    HStack(spacing: 9) {
      BotIcon(bot: bot, size: 24)
      Text(bot.name)
        .font(FType.name)
        .foregroundStyle(ink.primary)
        .lineLimit(1)
        .layoutPriority(1)
      Spacer(minLength: 4)
      if bot.workers > 0 {
        // "N workers" on every row with workers (workers-text mock, 14 Oct: "i think you
        // have dropped the grey worker text again"). Builds 38-41 wrote it only for the only bot
        // and above FLayout.writtenAbove workers. The text, bars and timer keep their full size;
        // the name truncates first ("Emm…").
        // Build 45: a stalled bot says "stalled" here; stalled workers are grey bars.
        Text(label(bot)).font(FType.idle).foregroundStyle(ink.tertiary).lineLimit(1).fixedSize()
        WorkerSegments(count: bot.workers, stalled: stalledCount(bot), ink: ink)
      } else {
        Text(label(bot)).font(FType.idle).foregroundStyle(ink.tertiary).lineLimit(1).fixedSize()
      }
      if isStalled(bot) {
        // No running timer for a stalled bot (build 45); the column stays, so rows line up.
        Color.clear.frame(width: timerWidth, height: 1)
      } else {
        Text(timerInterval: since(bot)...Date.distantFuture, countsDown: false)
          .font(FType.timer)
          .foregroundStyle(ink.primary)
          .multilineTextAlignment(.trailing)
          .lineLimit(1)
          // No shrink-to-fit (build 41, "consistent text size on the timer"): the column fits h:mm:ss.
          .frame(width: longRun(bot) ? max(timerWidth, FLayout.longTimerWidth) : timerWidth, alignment: .trailing)
      }
    }
    .frame(height: FLayout.rowHeight)
  }
}

/// The rows and "+N more" (shared by the Lock Screen panel and the expanded island).
struct FList: View {
  let state: PaseoBotsAttributes.ContentState
  let ink: LockInk
  var maxRows = FLayout.maxRows

  var body: some View {
    let bots = ordered(state)
    let all = total(state)
    // Up to maxRows bots; with more, one row less and "+N more" (mockup's split(4)).
    let shown = all > maxRows ? Array(bots.prefix(maxRows - 1)) : Array(bots.prefix(maxRows))
    let hidden = all - shown.count
    VStack(alignment: .leading, spacing: 0) {
      ForEach(shown, id: \.id) { bot in
        FRow(bot: bot, ink: ink, single: all == 1)
      }
      if hidden > 0 {
        Text("+\(hidden) more")
          .font(FType.more)
          .foregroundStyle(ink.secondary)
          .frame(height: FLayout.moreHeight)
          .padding(.leading, 33)
      }
    }
  }
}

/// The tab on the panel's top edge: panel-coloured, top corners rounded, and concave 9 pt flares
/// at its foot that merge it into the panel's edge (mockup .F .tab::before/::after). `rect` is the
/// tab body; the shape is `flare` wider on each side.
struct FTabShape: Shape {
  var flare: CGFloat = FLayout.tabFlare
  var corner: CGFloat = 9

  func path(in rect: CGRect) -> Path {
    let f = flare, c = corner
    let l = rect.minX, r = rect.maxX, t = rect.minY, b = rect.maxY
    var p = Path()
    p.move(to: CGPoint(x: l, y: b))
    p.addQuadCurve(to: CGPoint(x: l + f, y: b - f), control: CGPoint(x: l + f, y: b))
    p.addLine(to: CGPoint(x: l + f, y: t + c))
    p.addQuadCurve(to: CGPoint(x: l + f + c, y: t), control: CGPoint(x: l + f, y: t))
    p.addLine(to: CGPoint(x: r - f - c, y: t))
    p.addQuadCurve(to: CGPoint(x: r - f, y: t + c), control: CGPoint(x: r - f, y: t))
    p.addLine(to: CGPoint(x: r - f, y: b - f))
    p.addQuadCurve(to: CGPoint(x: r, y: b), control: CGPoint(x: r - f, y: b))
    p.closeSubpath()
    return p
  }
}

/// The "N BOTS · N WKR" tab. Fixed width (FLayout.tabWidth) so the dino's turn-around point, baked
/// into the DinoLive fonts, is always just before it; long counts shrink the text.
struct FTab: View {
  let text: String
  let ink: LockInk

  var body: some View {
    Text(text)
      .font(FType.tab)
      .tracking(0.66)
      .foregroundStyle(ink.secondary)
      .lineLimit(1)
      .minimumScaleFactor(0.7)
      .padding(.horizontal, 8)
      .frame(width: FLayout.tabWidth, height: FLayout.tabHeight)
      // 1 pt down into the panel, so no hairline shows between them.
      .padding(.bottom, 1)
      .padding(.horizontal, FLayout.tabFlare)
      .background(FTabShape().fill(ink.box))
      .offset(y: 1)
  }
}

/// The dino strip, the tab and the panel. The dino (DinoLiveLane, live mode, 3 / 6 fps; Always-On:
/// standing at the left end) stands on the panel's top edge in the panel's colour (LockInk.dino,
/// after build 36), drawn above the tab (zIndex); the tab stands on the same edge at the right.
struct FPanel<Content: View>: View {
  let ink: LockInk
  let tab: String
  let layers: Int
  /// DinoFix (6 fps flicker fix).
  let fix: Int
  let content: Content
  @Environment(\.isLuminanceReduced) private var dimmed

  /// Opacity of the dino as a whole (13 Oct: 90%).
  static var dinoOpacity: Double { 0.90 }

  init(
    ink: LockInk, tab: String, layers: Int, fix: Int = DinoFix.standard,
    @ViewBuilder content: () -> Content
  ) {
    self.ink = ink
    self.tab = tab
    self.layers = layers
    self.fix = fix
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ZStack(alignment: .bottomTrailing) {
        FTab(text: tab, ink: ink)
          .padding(.trailing, FLayout.tabRight - FLayout.tabFlare)
        GeometryReader { g in
          DinoOnEdge(
            layers: dimmed ? 0 : layers, fix: fix, width: g.size.width,
            end: g.size.width - DinoOnEdge.tabStop, color: ink.dino)
        }
        .compositingGroup()
        .opacity(Self.dinoOpacity)
        .zIndex(1)
      }
      .frame(height: DinoOnEdge.headroom)
      .zIndex(1)
      content
        .padding(.leading, FLayout.panelLeading)
        .padding(.trailing, FLayout.panelTrailing)
        .padding(.vertical, FLayout.panelVertical)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          // Solid panel (build 36's inner box): LockInk.box, black / white with the phone, no outline.
          RoundedRectangle(cornerRadius: LockLayout.frameRadius, style: .continuous)
            .fill(ink.box))
    }
  }
}

/// The dino (DinoLiveLane) standing on the panel's top edge, in a `headroom` tall strip as wide as
/// the panel. The fonts are not scaled up; the lane is placed so that
/// - his feet (ground, font y 13.9 = the lowest ink of any pose in either loop) sit on the strip's
///   bottom, which is the panel's top edge;
/// - build 38 ("dino should only walk until the tab sticks out and then turn back"): his
///   walk range is the fonts' world, now 7 590 units (was 13 540), so that on iPhone 17 (panel 350
///   pt) it runs from `cornerClearance` inside the left corner (14 pt) to `tabStop` before the
///   panel's right end (`end`, 3 pt short of the tab's left flare). The range is right-aligned to
///   `end`: on wider phones the extra space is at the left corner; on narrower ones he is scaled
///   down to fit. Without `end` (nil) the range is centred between the corners, as before.
/// The world width is the engine's own turn point: the fonts (gen_live.py, timeline.mjs with world
/// 7590, seed 1, same speed and poses as builds 26-37) turn him at the new ends.
struct DinoOnEdge: View {
  let layers: Int
  var fix: Int = DinoFix.standard
  let width: CGFloat
  /// Where his ink must end on the right (strip x); nil: centred between the corners.
  var end: CGFloat? = nil
  /// Line art colour (build 34: the Lock Screen ink; before: always white).
  var color: Color = .white

  static let headroom: CGFloat = 24
  /// pt per font unit at build 26's size (lane 24 pt tall).
  static let fullScale: CGFloat = 24.0 / 1000
  /// Ink x extent over both loops (font units; build 38 fonts, world 7590). Builds 26-37 (world
  /// 13 540): 64.3..13 474.1.
  static let inkLeft: CGFloat = DinoLiveLane.inkLeft
  static let inkRight: CGFloat = DinoLiveLane.inkRight
  static let inkBottom: CGFloat = 13.9
  static let cornerClearance: CGFloat = 2
  /// From the panel's right end to his rightmost ink: the tab's right inset, its width, its left
  /// flare and 3 pt of air (FLayout).
  static var tabStop: CGFloat { FLayout.tabRight + FLayout.tabWidth + FLayout.tabFlare + 3 }
  /// Measured (la-flicker): his lowest ink edge was 0.9 pt above the line from the Text's line
  /// placement; the lane moves down by this much (at build 26's size; it scales with him).
  static let feetDrop: CGFloat = 0.9

  /// pt per font unit for a walk from the left corner to `end` (or between the corners).
  static func scale(_ width: CGFloat, end: CGFloat? = nil) -> CGFloat {
    let left = LockLayout.frameRadius + cornerClearance
    let right = end ?? (width - LockLayout.frameRadius - cornerClearance)
    return max(0, min(fullScale, (right - left) / (inkRight - inkLeft)))
  }

  var body: some View {
    let k = Self.scale(width, end: end)
    let laneHeight = 1000 * k
    let laneX =
      end.map { $0 - Self.inkRight * k }
      ?? ((width - (Self.inkRight - Self.inkLeft) * k) / 2 - Self.inkLeft * k)
    let laneBottom = Self.headroom + Self.inkBottom * k + Self.feetDrop * k / Self.fullScale
    ZStack(alignment: .topLeading) {
      Color.clear
      DinoLiveLane(layers: layers, fix: fix, height: laneHeight, color: color)
        .offset(x: laneX, y: laneBottom - laneHeight)
    }
    .frame(width: width, height: Self.headroom, alignment: .topLeading)
  }
}

/// Option F's sizes (mockup .F, PAD F). iOS trims a Lock Screen Live Activity to 160 pt.
/// Height: top 8.5 + dino strip 24 + panel 7 + rows + 7 + bottom 12:
/// - 4 rows: 8.5 + 24 + 7 + 96 + 7 + 12 = 154.5 pt;
/// - 3 rows + "+N more": 8.5 + 24 + 7 + 72 + 18 + 7 + 12 = 148.5 pt.
/// `top` keeps the space above his head (median 20.7 pt above the edge) level with the space under
/// the panel, as in builds 30-37.
enum FLayout {
  static let maxRows = 4
  /// Rows write "N workers" beside the bars above this many (build 38's 5-bar limit).
  static let writtenAbove = 5
  static let rowHeight: CGFloat = 24
  static let moreHeight: CGFloat = 18
  /// h:mm:ss at full size (79.5 pt; build 41, no shrink-to-fit). Builds 38-40: 62 pt, mm:ss only.
  static let timerWidth: CGFloat = 80
  /// hh:mm:ss (10 h and over) at full size: 92.96 pt measured (build 44).
  static let longTimerWidth: CGFloat = 94
  /// Rows this old (s) get longTimerWidth: 9.5 h (see longRun).
  static let longAfter: TimeInterval = 9.5 * 3600
  static let panelLeading: CGFloat = 10
  static let panelTrailing: CGFloat = 12
  static let panelVertical: CGFloat = 7
  static let top: CGFloat = 8.5
  static let bottom: CGFloat = 12
  /// Tab body (without flares): fixed width, so the dino's turn point is fixed.
  static let tabWidth: CGFloat = 124
  static let tabHeight: CGFloat = 20
  static let tabFlare: CGFloat = 9
  /// From the panel's right end to the tab body's right edge: the right flare ends where the
  /// panel's 12 pt corner begins.
  static let tabRight: CGFloat = LockLayout.frameRadius + tabFlare
}

/// Shared with builds 27-37: the panel is `frameMargin` from the card's sides, its continuous
/// corners concentric with the card's 24 pt ones (24 - 12 = 12).
enum LockLayout {
  static let frameMargin: CGFloat = 12
  static let frameRadius: CGFloat = 12
}

struct LockScreenView: View {
  let state: PaseoBotsAttributes.ContentState
  let isStale: Bool
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    // The widget report (memory included) also when no bot icon is drawn (WidgetIconReport).
    let _ = WidgetIconReport.rendered()
    let ink = LockInk.of(lockScheme(state.appearance, scheme))
    // Build 45: the dino stands still (as Always-On) when every bot is stalled.
    FPanel(ink: ink, tab: tabText(state), layers: allStalled(state) ? 0 : dinoLayers(state), fix: dinoFix(state)) {
      FList(state: state, ink: ink)
    }
    .padding(.horizontal, LockLayout.frameMargin)
    .padding(.top, FLayout.top)
    .padding(.bottom, FLayout.bottom)
    .opacity(isStale ? 0.55 : 1)
    // Glass card (build 36); only the panel is solid.
    .activityBackgroundTint(ink.background)
  }
}

// MARK: - Dynamic Island (option C; F's timer style since build 39)

/// The island's running times use option F's timer style (FType.timer: SF Rounded, black, 19 pt,
/// monospaced digits; 14 Oct, build 39: "go back to the old design, but with the new timer
/// style"). Build 41 (14 Oct ~09:00: "should be consistent text size on the timer"): no
/// shrink-to-fit, every timer is 19 pt. The column is 80 pt so h:mm:ss (79.5 pt) fits at full size
/// (builds 39-40: 52 pt, mm:ss and h:mm:ss shrank to 0.7); IslandStrip shows fewer icons to make
/// room. Builds 13-37: .footnote regular; build 38 replaced the whole island with option F.
struct IslandTimer: View {
  let bot: PaseoBotsAttributes.Bot
  static let width: CGFloat = 80

  var body: some View {
    Text(timerInterval: since(bot)...Date.distantFuture, countsDown: false)
      .font(FType.timer)
      .foregroundStyle(.white)
      .multilineTextAlignment(.center)
      .lineLimit(1)
      .frame(width: longRun(bot) ? FLayout.longTimerWidth : Self.width, alignment: .center)
  }
}

/// Up to `maxIcons` bots, or `maxIcons - 1` and a "+N" circle. Build 41: 4 (builds 13-40: 6, so
/// 5 icons and "+N"), because the full-size 80 pt timers (IslandTimer) need 4 x 80 = 320 pt and the
/// strip has 320 pt (expanded width ~374 pt, less the 24 pt content margins and 3 pt padding a side).
struct IslandStrip: View {
  let state: PaseoBotsAttributes.ContentState
  var body: some View {
    let bots = ordered(state)
    // Build 44: a 10 h+ timer needs 94 pt, so 4 x 80 no longer fits the 320 pt strip; show 3.
    let maxIcons = bots.prefix(4).contains(where: { longRun($0) && !isStalled($0) }) ? 3 : 4
    let overflow = total(state) > maxIcons
    let shown = Array(bots.prefix(overflow ? maxIcons - 1 : maxIcons))
    HStack(alignment: .top, spacing: 0) {
      ForEach(shown, id: \.id) { bot in
        VStack(spacing: 6) {
          BadgedBotIcon(bot: bot, size: 40)
          if isStalled(bot) {
            // Build 45: "stalled" in grey instead of the running timer, on the timer's line height.
            ZStack {
              Text(" ").font(FType.timer)
              Text("stalled").font(FType.idle).foregroundStyle(stalledInk).lineLimit(1)
            }
            .frame(width: IslandTimer.width)
          } else {
            IslandTimer(bot: bot)
          }
        }
        .frame(maxWidth: .infinity)
      }
      if overflow {
        VStack(spacing: 6) {
          Text("+\(total(state) - shown.count)")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 40, height: 40)
            .background(Circle().fill(Color(white: 0.2)))
            .padding(.top, BadgedBotIcon.overhang(40))  // lines up with the badged icons
            .padding(.horizontal, BadgedBotIcon.overhang(40))
          Text(" ").font(FType.timer)
        }
        .frame(maxWidth: .infinity)
      }
    }
  }
}

/// The bot count in a spring green ring (compact trailing and minimal). Build 39 (14 Oct
/// 08:03: "use the same timer font for the number of bots running circle too"): the number
/// is in the timer's typeface (FType.timer: SF Rounded black, monospaced digits) at `fontSize`,
/// sized for the 22 pt ring; from 10 bots (08:05) the ring becomes a pill of the same height,
/// `digitWidth` wider per extra digit, so two digits fit at the same size. Builds 13-38:
/// .caption bold in a circle.
/// Build 41 (14 Oct: "is this badge number not centred properly?", then "i dont want the
/// font changing though"): the badge and ring numbers are moved sideways only, so their ink sits in
/// the middle of the circle / pill. The font is unchanged. At these small sizes the system font's
/// optical size gives every fixed-width digit more space on its right than on its left, so all of
/// them sat left of centre (sim, 3x: "1" 0.6-0.9 pt, the others 0.05-0.6 pt; Core Text: "1" 0.53-0.70 pt,
/// the others 0.13-0.31 pt). The offset is half the difference between the glyphs' left and right side
/// bearings, read from Core Text for the exact string and size, so it is per digit (and per pair
/// for the 10+ pills; "12" is already within 0.13 pt) and needs no table.
enum NumberCentring {
  /// x offset (pt) that centres the ink of `text` in its own layout box, in the badge typeface
  /// (CountRing.font: SF Rounded black, monospaced digits) at `size`.
  static func offset(_ text: String, size: CGFloat) -> CGFloat {
    guard let rounded = UIFont.systemFont(ofSize: size, weight: .black).fontDescriptor.withDesign(.rounded) else {
      return 0
    }
    let desc = rounded.addingAttributes([
      .featureSettings: [[
        UIFontDescriptor.FeatureKey.type: kNumberSpacingType,
        UIFontDescriptor.FeatureKey.selector: kMonospacedNumbersSelector,
      ]],
    ])
    let font = UIFont(descriptor: desc, size: size)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: font]))
    let advance = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    let ink = CTLineGetImageBounds(line, nil)
    guard ink.width > 0, ink.width < advance + size else { return 0 }
    return advance / 2 - ink.midX
  }
}

struct CountRing: View {
  let count: Int
  /// Every bot stalled (build 45): the ring is grey, not green.
  var stalled = false
  static let size: CGFloat = 22
  static let fontSize: CGFloat = 13
  static let digitWidth: CGFloat = 8

  static func width(_ count: Int) -> CGFloat { pillWidth(size, count) }

  /// A circle `height` wide for 1 digit, `digitWidth` (scaled to `height`) wider per extra digit.
  /// Shared with the island's worker badges (BadgedBotIcon, CompactLeadingIcon).
  static func pillWidth(_ height: CGFloat, _ count: Int) -> CGFloat {
    height + CGFloat(max(0, String(count).count - 1)) * digitWidth * height / size
  }

  static func font(_ size: CGFloat) -> Font {
    Font.system(size: size, weight: .black, design: .rounded).monospacedDigit()
  }

  var body: some View {
    Text("\(count)")
      .font(Self.font(Self.fontSize))
      .foregroundStyle(Color.white)
      .lineLimit(1)
      .minimumScaleFactor(0.6)
      .offset(x: NumberCentring.offset("\(count)", size: Self.fontSize))  // build 41
      .frame(width: Self.width(count), height: Self.size)
      // strokeBorder: the ring is drawn inside the frame. A centred stroke reached 1 pt outside it
      // and the compact trailing region clipped its left edge flat (build 13). A capsule is a
      // circle at 1 digit and a fully rounded pill at 2+.
      .overlay(Capsule(style: .continuous).strokeBorder(stalled ? stalledBadgeFill : DinoGreen.accent, lineWidth: 2))
  }
}

struct PaseoBotsLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: PaseoBotsAttributes.self) { context in
      // Option F: glass card, solid black / white panel following the phone's appearance (LockScreenView, LockInk, lockScheme).
      LockScreenView(state: context.state, isStale: context.isStale)
        .activitySystemActionForegroundColor(DinoGreen.accent)
    } dynamicIsland: { context in
      WidgetIconReport.rendered()
      let state = context.state
      let top = ordered(state).first
      return DynamicIsland {
        DynamicIslandExpandedRegion(.bottom) {
          // No dino here (build 27: the dino and its pill are on the Lock Screen only).
          IslandStrip(state: state)
            .padding(.horizontal, 3)  // build 41: 8 -> 3, room for 4 x 80 pt timers
            .opacity(context.isStale ? 0.55 : 1)
        }
      } compactLeading: {
        // The top bot's icon, centred by the system on the island's centre line at the same inset
        // as the ring; it shrinks and gets a worker badge while the bot has workers.
        if let top = top {
          CompactLeadingIcon(bot: top)
        }
      } compactTrailing: {
        CountRing(count: total(state), stalled: allStalled(state))
      } minimal: {
        CountRing(count: total(state), stalled: allStalled(state))
      }
      .keylineTint(DinoGreen.accent)
      .withContentMargins()
    }
  }
}

extension DynamicIsland {
  /// Keeps expanded content clear of the island's curved corners (iOS 17+; older: default margins).
  func withContentMargins() -> DynamicIsland {
    if #available(iOS 17.0, *) {
      return self.contentMargins(.horizontal, 24, for: .expanded)
        .contentMargins(.bottom, 20, for: .expanded)
    }
    return self
  }
}
