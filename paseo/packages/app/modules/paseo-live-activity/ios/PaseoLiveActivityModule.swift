import ExpoModulesCore
import Foundation
import Security
import UIKit
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Live Activity of busy bots, app side.
///
/// - Watches ActivityKit from launch (also when iOS wakes the app in the background after a
///   push-to-start): the push-to-start token, every activity and its update token. The latest
///   values are cached in UserDefaults and handed to JS (`getState`, `onChange`), which syncs them
///   with the paseo-apns daemon plugin.
/// - `apply(state, staleDate)` shows the daemon's answer locally: update every activity, start one
///   if none is running (only possible in the foreground), or end them all when `state` is null.
/// - At most one activity: when a new one appears, older ones are ended.
public class PaseoLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoLiveActivity")

    Events("onChange")

    OnCreate {
      LiveActivityCenter.shared.onChange = { [weak self] in
        self?.sendEvent("onChange", [:])
      }
      LiveActivityCenter.shared.start()
      AppearanceSync.shared.start()
    }

    OnDestroy {
      LiveActivityCenter.shared.onChange = nil
    }

    Function("isSupported") { () -> Bool in
      return LiveActivityCenter.shared.isSupported()
    }

    AsyncFunction("getState") { () -> [String: Any] in
      return LiveActivityCenter.shared.snapshot()
    }

    /// Bot icon for the widget (BotIconStore): base64 PNG, downscaled here to 96 px; nil removes it.
    /// Stored twice: in the App Group (SharedStore, the widget's first choice) when this build has
    /// one, and in the shared keychain (BotIconStore). True when either took it.
    AsyncFunction("setBotIcon") { (botId: String, base64Png: String?) -> Bool in
      guard let base64 = base64Png else {
        let group = SharedStore.writeIcon(botId, nil)
        return BotIconStore.write(botId, nil) || (SharedStore.available && group)
      }
      guard let data = Data(base64Encoded: base64), let png = downscaledPng(data, px: 96) else {
        return false
      }
      let group = SharedStore.writeIcon(botId, png)
      return BotIconStore.write(botId, png) || group
    }

    /// Bot ids whose icon the widget can read now: with an App Group, those in both stores (so a
    /// copy missing from either is written again), else the keychain's (BotIconStore). Rejects when
    /// neither store answers.
    AsyncFunction("storedBotIcons") { () throws -> [String] in
      let keychain = BotIconStore.storedIds()
      let group = SharedStore.iconIds()
      if let k = keychain, let g = group {
        let inGroup = Set(g)
        return k.filter { inGroup.contains($0) }
      }
      if let k = keychain { return k }
      if let g = group { return g }
      throw Exception(name: "BotIconStore", description: "keychain status \(BotIconStore.lastError ?? 0)")
    }

    /// For the Network page: icons stored (ids, and how many read back as images here), the shared
    /// group, the last keychain error, and the widget's own report of what it found (JSON or null)
    /// with the keychain status of reading it (-25300: the widget never wrote one). The report is
    /// read from the App Group first (widgetSource "group", status 0), then the keychain. appGroup:
    /// whether this build has the App Group container, and how many icons are in it.
    AsyncFunction("iconStatus") { () -> [String: Any] in
      let ids = BotIconStore.storedIds()
      let readable = (ids ?? []).filter { id in
        BotIconStore.read(id).flatMap { UIImage(data: $0) } != nil
      }.count
      let groupReport: Data? = SharedStore.readReport()
      let keychainReport = BotIconStore.readReportWithStatus()
      let reportData: Data? = groupReport ?? keychainReport.data
      let reportStatus: OSStatus = groupReport != nil ? errSecSuccess : keychainReport.status
      var source: Any = NSNull()
      if groupReport != nil {
        source = "group"
      } else if keychainReport.data != nil {
        source = "keychain"
      }
      let groupIcons: Int? = SharedStore.iconIds()?.count
      return [
        "stored": ids?.count ?? 0,
        "ids": ids ?? [],
        "readable": readable,
        "group": BotIconStore.group.map { $0 as Any } ?? NSNull(),
        "lastError": BotIconStore.lastError.map { Int($0) as Any } ?? NSNull(),
        "widget": reportData.flatMap { String(data: $0, encoding: .utf8) }.map { $0 as Any }
          ?? NSNull(),
        "widgetStatus": Int(reportStatus),
        "widgetSource": source,
        "appGroup": [
          "available": SharedStore.available,
          "icons": groupIcons.map { $0 as Any } ?? NSNull(),
        ] as [String: Any],
        "dino": [
          "app": DinoSetting.current,
          "card": LiveActivityCenter.shared.cardDinoLayers().map { $0 as Any } ?? NSNull(),
          "group": SharedStore.readDinoLayers().map { $0 as Any } ?? NSNull(),
          "fix": DinoFixSetting.current,
          "cardFix": LiveActivityCenter.shared.cardDinoFix().map { $0 as Any } ?? NSNull(),
        ] as [String: Any],
        "appearance": [
          "app": AppearanceSync.current.map { $0 as Any } ?? NSNull(),
          "card": LiveActivityCenter.shared.cardAppearance().map { $0 as Any } ?? NSNull(),
          "keychain": BotIconStore.readAppearance().map { $0 as Any } ?? NSNull(),
          "keychainStatus": AppearanceSync.keychainStatus.map { Int($0) as Any } ?? NSNull(),
        ] as [String: Any],
      ]
    }

    /// Lock Screen dino animation layers (DinoSetting): 3 (3 fps) or 6 (6 fps).
    Function("getDinoLayers") { () -> Int in
      return DinoSetting.current
    }

    /// Stores 3 or 6 and redraws the running card with it in the content state, so it switches at
    /// once.
    AsyncFunction("setDinoLayers") { (layers: Int) -> Bool in
      guard DinoSetting.set(layers) else { return false }
      LiveActivityCenter.shared.redraw(dinoLayers: layers)
      // The next sync reports it to paseo-apns (getState), so its pushes can carry it.
      LiveActivityCenter.shared.dinoLayersChanged()
      return true
    }

    /// The 6 fps flicker fix (DinoFixSetting): 0 = build 28, 1-3 the widget's DinoFix options; 3 until
    /// the picker is used.
    Function("getDinoFix") { () -> Int in
      return DinoFixSetting.current
    }

    /// Stores the fix and redraws the running card with it in the content state.
    AsyncFunction("setDinoFix") { (fix: Int) -> Bool in
      guard DinoFixSetting.set(fix) else { return false }
      LiveActivityCenter.shared.redraw(dinoFix: fix)
      return true
    }

    AsyncFunction("apply") { (stateJson: String?, staleDate: Double?, promise: Promise) in
      LiveActivityCenter.shared.apply(stateJson: stateJson, staleDate: staleDate) { result in
        promise.resolve(result)
      }
    }
  }
}

/// Starts the ActivityKit watchers as early as possible, so a background launch after a
/// push-to-start still records the new activity's update token.
public class PaseoLiveActivityAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    LiveActivityCenter.shared.start()
    AppearanceSync.shared.start()
    return true
  }
}

/// Tells the Live Activity widget the phone's light/dark setting. iOS 26 gives a Live Activity the
/// dark colour scheme in both appearances (FB21353175) and the widget cannot ask UIKit either, so
/// the app reads the system appearance at launch, whenever it becomes active and whenever the
/// appearance changes while it is open, and:
/// - carries it in the activity's content state (`appearance`): every local update sets it
///   (LiveActivityCenter.apply), and a change redraws the running activity with it
///   (LiveActivityCenter.redraw), a changed state, so iOS renders the card again;
/// - reports it to paseo-apns with the next sync (getState, onChange), which puts it in its pushes;
/// - writes it to the shared keychain too (BotIconStore.writeAppearance), the widget's fallback for
///   pushes from a server that does not send it. A keychain failure does not stop the rest.
/// It reads the window scene's traits, which follow the phone setting (Settings > Display &
/// Brightness), not a window's own override.
/// Lag: a change made while the app is closed or suspended reaches the card the next time the app
/// is opened.
/// Not while in the background: iOS flips the app's appearance there to take its snapshots.
@MainActor
final class AppearanceSync {
  nonisolated static let shared = AppearanceSync()

  nonisolated private init() {}

  nonisolated private static let value = LockedAppearance()

  /// The phone's appearance as the app last saw it ("light" / "dark"), else what the keychain
  /// holds from an earlier run; nil before either. Safe from any thread.
  nonisolated static var current: String? { value.get() }

  nonisolated private static func setCurrent(_ appearance: String) { value.set(appearance) }

  /// OSStatus of the last keychain write this launch (nil before one). For the Network page.
  nonisolated static var keychainStatus: OSStatus? { value.status() }

  private var started = false
  private var last: String?
  private var observed = Set<ObjectIdentifier>()
  private var observers: [NSObjectProtocol] = []

  /// Safe from any thread; the work runs on the main thread.
  nonisolated func start() {
    DispatchQueue.main.async { MainActor.assumeIsolated { self.startOnMain() } }
  }

  private func startOnMain() {
    if started { return }
    started = true
    // Only a starting value for `current`: `last` stays nil, so the first check always redraws
    // and reports the scene's appearance (the keychain may be stale, or unreadable on a device).
    if let stored = BotIconStore.readAppearance(), Self.current == nil { Self.setCurrent(stored) }
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) {
        [weak self] _ in MainActor.assumeIsolated { self?.check() }
      })
    observers.append(
      center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) {
        [weak self] _ in MainActor.assumeIsolated { self?.check() }
      })
    check()
  }

  private func scenes() -> [UIWindowScene] {
    return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
  }

  /// Watches each window scene for appearance changes (iOS 17+; older: on becoming active only).
  private func observe(_ scene: UIWindowScene) {
    let id = ObjectIdentifier(scene)
    if observed.contains(id) { return }
    observed.insert(id)
    if #available(iOS 17.0, *) {
      scene.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [weak self] (_: UIWindowScene, _: UITraitCollection) in
        self?.check()
      }
    }
  }

  private func systemAppearance() -> String? {
    let active = scenes().first { $0.activationState == .foregroundActive } ?? scenes().first
    switch active?.traitCollection.userInterfaceStyle {
    case .dark: return "dark"
    case .light: return "light"
    default: return nil
    }
  }

  private func check() {
    scenes().forEach(observe)
    guard UIApplication.shared.applicationState != .background else { return }
    guard let now = systemAppearance(), now != last else { return }
    last = now
    Self.setCurrent(now)
    // Best effort (the widget's fallback). Builds 19-24 stopped here if the write failed.
    Self.value.setStatus(
      BotIconStore.readAppearance() == now ? errSecSuccess : BotIconStore.writeAppearance(now))
    LiveActivityCenter.shared.redraw(appearance: now)
    // The next sync reports it to paseo-apns (getState), so its pushes carry it.
    LiveActivityCenter.shared.appearanceChanged()
  }
}

/// AppearanceSync.current's storage, readable from any thread (apply and getState run off main).
private final class LockedAppearance: @unchecked Sendable {
  private let lock = NSLock()
  private var value: String?
  private var writeStatus: OSStatus?

  func get() -> String? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }

  func status() -> OSStatus? {
    lock.lock()
    defer { lock.unlock() }
    return writeStatus
  }

  func setStatus(_ status: OSStatus) {
    lock.lock()
    writeStatus = status
    lock.unlock()
  }

  func set(_ appearance: String) {
    lock.lock()
    value = appearance
    lock.unlock()
  }
}

/// The Lock Screen dino's timer layers (Network page switch): 3 (3 fps, the default) or 6 (6 fps).
/// The app's own copy (UserDefaults) is the truth; it goes to the widget in the activity's content
/// state (`dinoLayers`: every local update, LiveActivityCenter.apply, and a redraw when it changes)
/// and, for pushes that do not carry it, as copies in the App Group (SharedStore) and the shared
/// keychain (BotIconStore). Builds 23-24 kept it only in the keychain, and the widget never saw it
/// on the phone.
enum DinoSetting {
  private static let key = "paseo.liveActivity.dinoLayers"

  /// The app's value, else the keychain's from builds 23-24 (BotIconStore.readDinoLayers: 3 when
  /// it has none).
  static var current: Int {
    let stored = UserDefaults.standard.integer(forKey: key)
    return stored == 3 || stored == 6 ? stored : BotIconStore.readDinoLayers()
  }

  /// False only for a value other than 3 or 6; the widget copies are best effort.
  static func set(_ layers: Int) -> Bool {
    guard layers == 3 || layers == 6 else { return false }
    UserDefaults.standard.set(layers, forKey: key)
    SharedStore.writeDinoLayers(layers)
    BotIconStore.writeDinoLayers(layers)
    return true
  }
}

/// The Lock Screen dino's 6 fps flicker fix (Network page picker, la-flicker): 0 (build 28) to
/// DinoFixSetting.count - 1; `standard` (3, cover + hold, the widget's DinoFix.standard) until the
/// picker is used (builds 28-29: 0). Kept in the app's UserDefaults and sent to the widget in the content
/// state (`dinoFix`: every local update and a redraw when it changes); the widget keeps the last one
/// it saw for pushes, which do not carry it.
enum DinoFixSetting {
  private static let key = "paseo.liveActivity.dinoFix"
  static let count = 4
  static let standard = 3

  static var current: Int {
    guard let stored = UserDefaults.standard.object(forKey: key) as? Int, stored >= 0, stored < count
    else { return standard }
    return stored
  }

  static func set(_ fix: Int) -> Bool {
    guard fix >= 0 && fix < count else { return false }
    UserDefaults.standard.set(fix, forKey: key)
    return true
  }
}

final class LiveActivityCenter {
  static let shared = LiveActivityCenter()

  var onChange: (() -> Void)?
  private var started = false
  private let lock = NSLock()
  private var startToken: String?
  /// activity id -> update token (nil until iOS hands it out)
  private var tokens: [String: String] = [:]
  private var watched = Set<String>()
  private let defaults = UserDefaults.standard
  private static let startTokenKey = "paseo.liveActivity.startToken"

  private init() {
    startToken = defaults.string(forKey: Self.startTokenKey)
  }

  func isSupported() -> Bool {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      return true
    }
    #endif
    return false
  }

  func start() {
    lock.lock()
    if started {
      lock.unlock()
      return
    }
    started = true
    lock.unlock()
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      if #available(iOS 17.2, *) {
        Task {
          for await data in Activity<PaseoBotsAttributes>.pushToStartTokenUpdates {
            self.setStartToken(hex(data))
          }
        }
      }
      for activity in Activity<PaseoBotsAttributes>.activities {
        watch(activity)
      }
      Task {
        for await activity in Activity<PaseoBotsAttributes>.activityUpdates {
          self.watch(activity)
          await self.endOthers(keeping: activity.id)
        }
      }
    }
    #endif
  }

  private func setStartToken(_ token: String) {
    lock.lock()
    let changed = startToken != token
    startToken = token
    lock.unlock()
    if changed {
      defaults.set(token, forKey: Self.startTokenKey)
      onChange?()
    }
  }

  private func notify() {
    onChange?()
  }

  /// The phone's appearance changed (AppearanceSync): JS syncs again and reports it.
  func appearanceChanged() {
    notify()
  }

  /// The dino switch changed (setDinoLayers): JS syncs again and reports it.
  func dinoLayersChanged() {
    notify()
  }

  #if canImport(ActivityKit)
  @available(iOS 16.2, *)
  private func watch(_ activity: Activity<PaseoBotsAttributes>) {
    lock.lock()
    if watched.contains(activity.id) {
      lock.unlock()
      return
    }
    watched.insert(activity.id)
    lock.unlock()
    Task {
      for await data in activity.pushTokenUpdates {
        self.lock.lock()
        self.tokens[activity.id] = hex(data)
        self.lock.unlock()
        self.notify()
      }
    }
    Task {
      for await state in activity.activityStateUpdates {
        if state == .ended || state == .dismissed {
          self.lock.lock()
          self.tokens.removeValue(forKey: activity.id)
          self.lock.unlock()
          self.notify()
        }
      }
    }
    notify()
  }

  @available(iOS 16.2, *)
  private func endOthers(keeping id: String) async {
    for other in Activity<PaseoBotsAttributes>.activities where other.id != id && other.activityState == .active {
      await other.end(nil, dismissalPolicy: .immediate)
    }
  }

  @available(iOS 16.2, *)
  private func live() -> [Activity<PaseoBotsAttributes>] {
    return Activity<PaseoBotsAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }
  }
  #endif

  func snapshot() -> [String: Any] {
    var activities: [[String: Any]] = []
    var enabled = false
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      enabled = ActivityAuthorizationInfo().areActivitiesEnabled
      lock.lock()
      let known = tokens
      lock.unlock()
      for activity in live() {
        var item: [String: Any] = ["id": activity.id, "token": NSNull()]
        if let token = known[activity.id] ?? activity.pushToken.map(hex) {
          item["token"] = token
        }
        activities.append(item)
      }
    }
    #endif
    lock.lock()
    let token = startToken
    lock.unlock()
    return [
      "enabled": enabled, "startToken": token.map { $0 as Any } ?? NSNull(), "activities": activities,
      "appearance": AppearanceSync.current.map { $0 as Any } ?? NSNull(),
      "dinoLayers": DinoSetting.current,
    ]
  }

  /// The dino layer count in the running activity's content state (what the widget draws from), or
  /// nil.
  func cardDinoLayers() -> Int? {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      return live().first?.content.state.dinoLayers
    }
    #endif
    return nil
  }

  /// Redraws the running activities with the new dino layer count in their content state (a
  /// changed state, so iOS renders the card again).
  func redraw(dinoLayers: Int) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      Task {
        for activity in self.live() {
          let content = activity.content
          guard content.state.dinoLayers != dinoLayers else { continue }
          var state = content.state
          state.dinoLayers = dinoLayers
          await activity.update(ActivityContent(state: state, staleDate: content.staleDate))
        }
      }
    }
    #endif
  }

  /// The flicker fix in the running activity's content state, or nil (after a push).
  func cardDinoFix() -> Int? {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      return live().first?.content.state.dinoFix
    }
    #endif
    return nil
  }

  /// Redraws the running activities with the new flicker fix in their content state.
  func redraw(dinoFix: Int) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      Task {
        for activity in self.live() {
          let content = activity.content
          guard content.state.dinoFix != dinoFix else { continue }
          var state = content.state
          state.dinoFix = dinoFix
          await activity.update(ActivityContent(state: state, staleDate: content.staleDate))
        }
      }
    }
    #endif
  }

  /// The appearance in the running activity's content state (what the widget draws from), or nil.
  func cardAppearance() -> String? {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      return live().first?.content.state.appearance
    }
    #endif
    return nil
  }

  /// Redraws the running activities with the new appearance in their content state. The state
  /// changes, so iOS renders the card again (builds 19-24 re-sent the same content and relied on
  /// the widget reading the keychain).
  func redraw(appearance: String) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      Task {
        for activity in self.live() {
          let content = activity.content
          guard content.state.appearance != appearance else { continue }
          var state = content.state
          state.appearance = appearance
          await activity.update(ActivityContent(state: state, staleDate: content.staleDate))
        }
      }
    }
    #endif
  }

  /// Shows the daemon's state locally. Result: "updated", "started", "ended", "none" or an error code.
  func apply(stateJson: String?, staleDate: Double?, done: @escaping (String) -> Void) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      let stale = staleDate.map { Date(timeIntervalSince1970: $0) }
      guard let json = stateJson else {
        Task {
          let running = Activity<PaseoBotsAttributes>.activities
          for activity in running {
            await activity.end(nil, dismissalPolicy: .immediate)
          }
          done(running.isEmpty ? "none" : "ended")
        }
        return
      }
      guard let data = json.data(using: .utf8),
        var state = try? JSONDecoder().decode(PaseoBotsAttributes.ContentState.self, from: data)
      else {
        done("bad_state")
        return
      }
      // The app's own reading is the freshest (AppearanceSync).
      if let appearance = AppearanceSync.current { state.appearance = appearance }
      state.dinoLayers = DinoSetting.current
      state.dinoFix = DinoFixSetting.current
      let content = ActivityContent(state: state, staleDate: stale)
      Task {
        let running = self.live()
        if !running.isEmpty {
          for activity in running {
            await activity.update(content)
          }
          done("updated")
          return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
          done("disabled")
          return
        }
        do {
          let activity = try Activity.request(
            attributes: PaseoBotsAttributes(), content: content, pushType: .token)
          self.watch(activity)
          done("started")
        } catch {
          // No push environment (e.g. an unsigned simulator build): show it anyway, kept fresh by
          // the sync on connect/foreground. Background launches cannot start activities at all;
          // push-to-start covers those.
          do {
            let activity = try Activity.request(
              attributes: PaseoBotsAttributes(), content: content, pushType: nil)
            self.watch(activity)
            done("started_local")
          } catch {
            done("start_failed")
          }
        }
      }
      return
    }
    #endif
    done("unsupported")
  }
}

/// Fits the image into px x px (aspect kept, transparent margin), 1x scale, as PNG.
func downscaledPng(_ data: Data, px: CGFloat) -> Data? {
  guard let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 else { return nil }
  let format = UIGraphicsImageRendererFormat()
  format.scale = 1
  format.opaque = false
  // Plain 8-bit sRGB. The default (.automatic) can pick the extended (wide colour, 16 bits per
  // channel) range on a real iPhone, unlike the simulator.
  format.preferredRange = .standard
  let fit = min(px / image.size.width, px / image.size.height)
  let size = CGSize(width: image.size.width * fit, height: image.size.height * fit)
  let rect = CGRect(x: (px - size.width) / 2, y: (px - size.height) / 2, width: size.width, height: size.height)
  return UIGraphicsImageRenderer(size: CGSize(width: px, height: px), format: format).pngData { _ in
    image.draw(in: rect)
  }
}

private func hex(_ data: Data) -> String {
  return data.map { String(format: "%02x", $0) }.joined()
}
