import Foundation

/// Files shared between the app and the Live Activity widget through the App Group
/// `group.com.example.paseo`. Keep identical to modules/paseo-live-activity/ios/SharedStore.swift.
///
/// Why (build 24, la-keychain): on the owner's iPhone the app's own keychain reads and writes work,
/// but nothing the widget does with the shared keychain group shows (no widget report, the 6 fps
/// switch and light mode never reach the card), while the same code works in the simulator. So the
/// widget's settings come in the activity's content state (PaseoBotsAttributes.ContentState), and
/// what still has to be shared (bot icons, the widget's report, a fallback copy of the dino
/// setting) also goes here, a plain file in the App Group container, the documented way for an app
/// and its widget to share data. The keychain stays as the second choice.
///
/// Only when this build is entitled to the group (app.config.js, PASEO_APP_GROUP; the App Group
/// has to be registered on the Apple account and in both profiles first): otherwise iOS gives no
/// container and every call here is a no-op returning nil / false. (The simulator does not check
/// the entitlement and gives a container anyway.)
///
/// Files are written atomically and get iOS's default protection for app containers (readable
/// once the phone was unlocked after boot, like the keychain items' AfterFirstUnlock).
enum SharedStore {
  /// `group.<app bundle id>`, from this binary's bundle id (the widget's ends in ".LiveActivity"),
  /// so the own build (com.example.paseo) and the public flavour (release-flavour.js) both match
  /// the group app.config.js adds.
  static let group: String = {
    let id = Bundle.main.bundleIdentifier ?? "com.example.paseo"
    let base = id.hasSuffix(".LiveActivity") ? String(id.dropLast(".LiveActivity".count)) : id
    return "group.\(base)"
  }()

  /// The group's container, or nil when this build is not entitled to it.
  static var container: URL? {
    return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
  }

  static var available: Bool { container != nil }

  private static func url(_ name: String) -> URL? {
    return container?.appendingPathComponent("Library/Paseo", isDirectory: true)
      .appendingPathComponent(name)
  }

  static func read(_ name: String) -> Data? {
    guard let url = url(name) else { return nil }
    return try? Data(contentsOf: url)
  }

  /// Stores (data) or removes (nil). False when there is no container or the write failed.
  @discardableResult
  static func write(_ name: String, _ data: Data?) -> Bool {
    guard let url = url(name) else { return false }
    let fm = FileManager.default
    guard let data = data else {
      if !fm.fileExists(atPath: url.path) { return true }
      return (try? fm.removeItem(at: url)) != nil
    }
    do {
      try fm.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: url, options: .atomic)
      return true
    } catch {
      return false
    }
  }

  // MARK: Bot icons (copies of BotIconStore's, same ids and PNG data)

  private static func iconName(_ id: String) -> String? {
    return BotIconStore.isValidId(id) ? "bot-icons/\(id).png" : nil
  }

  static func readIcon(_ id: String) -> Data? {
    guard let name = iconName(id), let data = read(name), data.count <= BotIconStore.maxBytes
    else { return nil }
    return data
  }

  @discardableResult
  static func writeIcon(_ id: String, _ data: Data?) -> Bool {
    guard let name = iconName(id) else { return false }
    return write(name, data)
  }

  /// Bot ids with an icon here; nil without a container.
  static func iconIds() -> [String]? {
    guard let dir = url("bot-icons") else { return nil }
    let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
    return names.filter { $0.hasSuffix(".png") }.map { String($0.dropLast(4)) }
  }

  // MARK: Widget report (WidgetIconReport's JSON)

  static func readReport() -> Data? { read("widget-report.json") }

  @discardableResult
  static func writeReport(_ data: Data) -> Bool { write("widget-report.json", data) }

  // MARK: Lock Screen dino layers (fallback when the activity state has none: pushes from a
  // paseo-apns that does not send it)

  static func readDinoLayers() -> Int? {
    guard let data = read("dino-layers"), let value = Int(String(decoding: data, as: UTF8.self)),
      value == 3 || value == 6
    else { return nil }
    return value
  }

  @discardableResult
  static func writeDinoLayers(_ value: Int) -> Bool {
    guard value == 3 || value == 6 else { return false }
    return write("dino-layers", Data(String(value).utf8))
  }
}
