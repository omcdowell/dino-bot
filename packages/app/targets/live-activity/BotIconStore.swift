import Foundation
import Security

/// Bot icons shared between the app and the Live Activity widget. Keep identical to
/// modules/paseo-live-activity/ios/BotIconStore.swift.
///
/// One keychain item per bot (generic password, service `com.example.paseo.bot-icons`, account = bot
/// id, data = 96 px PNG) in the shared access group `<team>.com.example.paseo.shared`. Both targets
/// list that group in `keychain-access-groups` and name it in Info.plist `PaseoSharedKeychainGroup`.
/// The keychain is used rather than an App Group container because App Groups cannot be registered
/// with the App Store Connect API key; the team keychain wildcard is already in both profiles.
enum BotIconStore {
  static let service = "com.example.paseo.bot-icons"
  static let maxBytes = 256 * 1024

  /// The shared group, or nil when this build has none (then nothing is stored: letters).
  static var group: String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "PaseoSharedKeychainGroup") as? String,
      !value.isEmpty, !value.contains("$(")
    else { return nil }
    return value
  }

  static func isValidId(_ id: String) -> Bool {
    return !id.isEmpty && id.count <= 64
      && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-") }
  }

  private static func query(_ id: String, group: String) -> [String: Any] {
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: id,
      kSecAttrAccessGroup as String: group,
    ]
  }

  /// Status codes of our own (not OSStatus) for readWithStatus / the widget report.
  static let statusNoGroup: OSStatus = -1
  static let statusNotImage: OSStatus = -2
  static let statusTooBig: OSStatus = -3

  static func read(_ id: String) -> Data? {
    return readWithStatus(id).data
  }

  /// The icon and how the read went: errSecSuccess, errSecItemNotFound (nothing stored), another
  /// keychain OSStatus, or statusNoGroup / statusTooBig.
  static func readWithStatus(_ id: String) -> (data: Data?, status: OSStatus) {
    guard let group = group else { return (nil, statusNoGroup) }
    guard isValidId(id) else { return (nil, errSecParam) }
    var q = query(id, group: group)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: AnyObject?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    guard status == errSecSuccess else { return (nil, status) }
    guard let data = out as? Data else { return (nil, errSecDecode) }
    guard data.count <= maxBytes else { return (nil, statusTooBig) }
    return (data, errSecSuccess)
  }

  // MARK: Widget report (diagnostics)

  /// What the widget found when it last drew bot icons (WidgetIconReport in the widget), small
  /// JSON in its own keychain item; the app shows it on the Network page.
  static let reportService = "com.example.paseo.bot-icons.report"
  static let reportAccount = "widget"

  @discardableResult
  static func writeReport(_ data: Data) -> OSStatus {
    guard let group = group else { return statusNoGroup }
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: reportService,
      kSecAttrAccount as String: reportAccount,
      kSecAttrAccessGroup as String: group,
    ]
    let update = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update != errSecItemNotFound { return update }
    var add = q
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil)
  }

  static func readReport() -> Data? {
    return readReportWithStatus().data
  }

  /// The report and how the read went: errSecSuccess, errSecItemNotFound (the widget never wrote
  /// one), another keychain OSStatus, or statusNoGroup.
  static func readReportWithStatus() -> (data: Data?, status: OSStatus) {
    guard let group = group else { return (nil, statusNoGroup) }
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: reportService,
      kSecAttrAccount as String: reportAccount,
      kSecAttrAccessGroup as String: group,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: AnyObject?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    guard status == errSecSuccess else { return (nil, status) }
    guard let data = out as? Data else { return (nil, errSecDecode) }
    return (data, errSecSuccess)
  }

  // MARK: System appearance (Lock Screen light/dark)

  /// The phone's light/dark setting as the app last saw it: "light" or "dark", in its own keychain
  /// item. iOS 26 gives a Live Activity the dark colour scheme in both appearances (FB21353175), so
  /// the app (AppearanceSync) writes the system setting here and the widget's Lock Screen card reads
  /// it. It only changes while the app runs: a change made with the app closed reaches the card the
  /// next time the app is opened.
  static let appearanceService = "com.example.paseo.appearance"
  static let appearanceAccount = "system"

  static func readAppearance() -> String? {
    guard let group = group else { return nil }
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: appearanceService,
      kSecAttrAccount as String: appearanceAccount,
      kSecAttrAccessGroup as String: group,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
      let value = String(data: data, encoding: .utf8), value == "light" || value == "dark"
    else { return nil }
    return value
  }

  @discardableResult
  static func writeAppearance(_ value: String) -> OSStatus {
    guard let group = group else { return statusNoGroup }
    guard value == "light" || value == "dark" else { return errSecParam }
    let data = Data(value.utf8)
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: appearanceService,
      kSecAttrAccount as String: appearanceAccount,
      kSecAttrAccessGroup as String: group,
    ]
    let update = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update != errSecItemNotFound { return update }
    var add = q
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil)
  }

  // MARK: Lock Screen dino animation (Network page switch)

  /// How many timer layers the Lock Screen dino walks with: 3 (3 fps, the default) or 6 (6 fps),
  /// in its own keychain item ("3" or "6"). The app's Network page switch writes it
  /// (setDinoLayers) and redraws the card; the widget reads it on every render.
  static let dinoService = "com.example.paseo.dino"
  static let dinoAccount = "layers"
  static let dinoDefaultLayers = 3

  static func readDinoLayers() -> Int {
    guard let group = group else { return dinoDefaultLayers }
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: dinoService,
      kSecAttrAccount as String: dinoAccount,
      kSecAttrAccessGroup as String: group,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var out: AnyObject?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
      let value = Int(String(data: data, encoding: .utf8) ?? ""), value == 3 || value == 6
    else { return dinoDefaultLayers }
    return value
  }

  @discardableResult
  static func writeDinoLayers(_ value: Int) -> OSStatus {
    guard let group = group else { return statusNoGroup }
    guard value == 3 || value == 6 else { return errSecParam }
    let data = Data(String(value).utf8)
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: dinoService,
      kSecAttrAccount as String: dinoAccount,
      kSecAttrAccessGroup as String: group,
    ]
    let update = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if update != errSecItemNotFound { return update }
    var add = q
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil)
  }

  /// Stores (data) or removes (nil). False when the keychain refused (status in lastError).
  @discardableResult
  static func write(_ id: String, _ data: Data?) -> Bool {
    guard let group = group, isValidId(id) else { return false }
    let q = query(id, group: group)
    let deleted = SecItemDelete(q as CFDictionary)
    guard let data = data else {
      return note(deleted == errSecItemNotFound ? errSecSuccess : deleted)
    }
    guard data.count <= maxBytes else { return false }
    var add = q
    add[kSecValueData as String] = data
    // Readable on the Lock Screen once the phone was unlocked after boot.
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    return note(SecItemAdd(add as CFDictionary, nil))
  }

  /// Bot ids with an icon in the shared group; nil when this build has no group or the keychain
  /// refused (status in lastError).
  static func storedIds() -> [String]? {
    guard let group = group else { return nil }
    let q: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccessGroup as String: group,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    var out: AnyObject?
    let status = SecItemCopyMatching(q as CFDictionary, &out)
    if status == errSecItemNotFound { return [] }
    guard note(status), let items = out as? [[String: Any]] else { return nil }
    return items.compactMap { $0[kSecAttrAccount as String] as? String }
  }

  private static let lock = NSLock()
  private static var lastStatus: OSStatus?

  /// The last keychain error (OSStatus) of a write or list; nil after a success. For diagnostics.
  static var lastError: OSStatus? {
    lock.lock()
    defer { lock.unlock() }
    return lastStatus
  }

  private static func note(_ status: OSStatus) -> Bool {
    lock.lock()
    lastStatus = status == errSecSuccess ? nil : status
    lock.unlock()
    return status == errSecSuccess
  }
}
