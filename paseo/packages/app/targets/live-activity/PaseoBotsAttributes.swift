import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// The Live Activity's data. Keep identical to targets/live-activity/PaseoBotsAttributes.swift:
/// ActivityKit matches the app's and the widget's copies by type name, and the server sends
/// `attributes-type: PaseoBotsAttributes` and this ContentState as JSON (paseo-apns,
/// server/live-activity.ts). `since` is unix seconds (not Date: ActivityKit decodes Date as
/// seconds since 2001).
@available(iOS 16.1, *)
public struct PaseoBotsAttributes: ActivityAttributes {
  public struct Bot: Codable, Hashable {
    public var id: String
    public var name: String
    public var working: Bool
    public var workers: Int
    public var since: Double
    /// The bot's Lucide icon name (`.bot.json` "icon"), for the widget's drawn tile when the app
    /// has not stored the bot's icon (BotIconStore). Optional: older servers do not send it.
    public var icon: String?
    /// Not running a turn and every outstanding worker is stalled (bots plugin, 19 Oct): the
    /// widget greys the row ("stalled", no running timer, no dino walk for it). Optional: older
    /// servers do not send it (the bot then shows as busy, as before).
    public var stalled: Bool?
    /// How many of `workers` are stalled, drawn as grey bars. Optional, as `stalled`.
    public var stalledWorkers: Int?
  }

  public struct ContentState: Codable, Hashable {
    public var bots: [Bot]
    public var more: Int
    /// The phone's light/dark setting, "light" or "dark", for the Lock Screen card (iOS 26 gives a
    /// Live Activity the dark colour scheme in both appearances, FB21353175). The app sets it on
    /// every local update and reports it to paseo-apns, which puts it in its pushes. Optional:
    /// older servers do not send it. After build 29 the widget ignores it: the Lock Screen card is
    /// always light (lockScheme). Kept so the app and paseo-apns need no change.
    public var appearance: String?
    /// Timer layers of the Lock Screen dino walk: 3 (3 fps) or 6 (6 fps), the app's Network page
    /// switch. The app sets it on every local update and redraws the running activity with it when
    /// the switch changes (a changed state, so iOS renders the card again; builds 23-24 re-sent the
    /// same content and relied on the widget reading the keychain, which it could not on the
    /// phone). Optional: pushes from a paseo-apns that does not send it leave it out; the widget
    /// then falls back to the App Group copy, then the keychain, then 3.
    public var dinoLayers: Int?
    /// The 6 fps flicker fix (0 = build 28; 1-3, the widget's DinoFix), the app's Network page
    /// picker (la-flicker, a test build). The app sets it on every local update and redraws the
    /// running activity when it changes. paseo-apns does not send it; the widget then uses the last
    /// one it saw, else 3 (cover + hold).
    public var dinoFix: Int?
  }

  public init() {}
}
#endif
