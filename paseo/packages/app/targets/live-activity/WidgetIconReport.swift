import Foundation
import Security
import UIKit
import os

/// The bot's icon image for the widget: the one the app stored in the App Group (SharedStore),
/// else the one in the keychain (BotIconStore), else the avatar built into the widget
/// (BundledAvatars). Every lookup is noted in WidgetIconReport, so the app's Network page can show
/// what the widget really found on the phone (build 14 drew the Lucide tile for Emmet on the
/// device, not his avatar).
enum WidgetBotImage {
  static func image(_ id: String) -> UIImage? {
    if let data = SharedStore.readIcon(id), let image = UIImage(data: data) {
      WidgetIconReport.note(id, status: errSecSuccess, bundled: false, fromGroup: true)
      return image
    }
    let read = BotIconStore.readWithStatus(id)
    var status = read.status
    var image: UIImage?
    if let data = read.data {
      image = UIImage(data: data)
      if image == nil { status = BotIconStore.statusNotImage }
    }
    let bundled = image == nil ? BundledAvatars.image(id) : nil
    WidgetIconReport.note(id, status: status, bundled: bundled != nil, fromGroup: false)
    return image ?? bundled
  }
}

/// The extension's own memory, as iOS counts it against the extension's limit: phys_footprint now
/// and its peak in this process, and what iOS still allows (os_proc_available_memory; 0 where there
/// is no limit, as in the simulator), all in whole MB. The simulator's figures are not the phone's
/// (the simulator counts system framework pages the phone shares), so this is how to read the real
/// number: the app's Network page shows it from the report below.
enum WidgetMemory {
  static func now() -> (mem: Int, peak: Int, avail: Int)? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return nil }
    func mb<T: BinaryInteger>(_ bytes: T) -> Int { Int((Double(bytes) / 1_048_576).rounded()) }
    let avail: Int
    if #available(iOS 13.0, *) { avail = mb(os_proc_available_memory()) } else { avail = 0 }
    let peak = max(info.ledger_phys_footprint_peak, Int64(info.phys_footprint))
    return (mb(info.phys_footprint), mb(peak), avail)
  }
}

/// What the widget found when it drew bot icons: per bot, the keychain status (0 = drawn from the
/// keychain or App Group; `group` counts those read from the App Group) and whether the built-in
/// avatar was used, plus the widget's memory (WidgetMemory).
/// Written as small JSON to the App Group (SharedStore.writeReport, `via: "group"`) when this build
/// has one, else to the shared keychain group (BotIconStore.writeReport, `via: "keychain"`; on
/// the owner's iPhone those writes never arrived, build 24), when it changes
/// (memory: when the peak moves by a whole MB), or at most every 5 minutes otherwise. Also written
/// on every render (rendered(), from the Lock Screen view and the Dynamic Island), so the memory
/// arrives even when no bot icon is drawn. A write the keychain refuses is not counted as written:
/// it is retried on a render 30 s later, and the next report that gets through carries the refused
/// status and how many writes were refused (wfail, wfails). If the widget cannot reach the keychain
/// at all, no report ever appears, which says so too. Changes are also logged (subsystem
/// com.example.paseo.LiveActivity, categories icons and memory) for Console.app.
enum WidgetIconReport {
  private static let log = Logger(subsystem: "com.example.paseo.LiveActivity", category: "icons")
  private static let memoryLog = Logger(
    subsystem: "com.example.paseo.LiveActivity", category: "memory")
  private static let lock = NSLock()
  private static var statuses: [String: OSStatus] = [:]
  private static var bundled = Set<String>()
  private static var fromGroup = Set<String>()
  private static var written: String?
  private static var writtenAt = Date.distantPast
  private static var loggedPeak: Int?
  private static var failedStatus: OSStatus?
  private static var failures = 0
  private static var retryAt = Date.distantPast
  static let retryAfter: TimeInterval = 30

  /// A render of the Live Activity (Lock Screen or island): reports even if no bot icon is drawn.
  static func rendered() {
    lock.lock()
    report(changedIcon: nil)
  }

  static func note(_ id: String, status: OSStatus, bundled usedBundled: Bool, fromGroup group: Bool) {
    lock.lock()
    let changed = statuses[id] != status || bundled.contains(id) != usedBundled
      || fromGroup.contains(id) != group
    statuses[id] = status
    if usedBundled { bundled.insert(id) } else { bundled.remove(id) }
    if group { fromGroup.insert(id) } else { fromGroup.remove(id) }
    report(changedIcon: changed ? (id, status, usedBundled) : nil)
  }

  /// Called with `lock` held; unlocks it.
  private static func report(changedIcon: (id: String, status: OSStatus, bundled: Bool)?) {
    let read = statuses.values.filter { $0 == errSecSuccess }.count
    let missing = statuses.values.filter { $0 == errSecItemNotFound }.count
    let errors = statuses.values.filter { $0 != errSecSuccess && $0 != errSecItemNotFound }
    let summary: [String: Any] = [
      "read": read,
      "missing": missing,
      "errors": errors.count,
      "status": Int(errors.first ?? 0),
      "bundled": bundled.count,
      "group": fromGroup.count,
      "via": SharedStore.available ? "group" : "keychain",
    ]
    var key = summary.keys.sorted().map { "\($0)=\(summary[$0]!)" }.joined(separator: ",")
    // The peak only (not the current figure, which moves up and down): a new report per MB of peak.
    let memory = WidgetMemory.now()
    if let memory = memory { key += ",peak=\(memory.peak)" }
    let memoryChanged = memory != nil && memory?.peak != loggedPeak
    if memoryChanged { loggedPeak = memory?.peak }
    let now = Date()
    let due = now >= retryAt && (key != written || now.timeIntervalSince(writtenAt) > 300)
    if due {
      written = key
      writtenAt = now
    }
    let refused = (failedStatus, failures)
    lock.unlock()
    if memoryChanged, let memory = memory {
      memoryLog.notice(
        "memory \(memory.mem) MB, peak \(memory.peak) MB, available \(memory.avail) MB")
    }
    if let icon = changedIcon {
      log.notice(
        "icon \(icon.id, privacy: .public): keychain status \(icon.status), built-in \(icon.bundled)")
    }
    guard due else { return }
    var payload = summary
    if let status = refused.0 {
      payload["wfail"] = Int(status)
      payload["wfails"] = refused.1
    }
    payload["at"] = Int(now.timeIntervalSince1970)
    if let memory = memory {
      payload["mem"] = memory.mem
      payload["peak"] = memory.peak
      payload["avail"] = memory.avail
    }
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
      // App Group when this build has one (a failed file write counts as refused, errSecIO), else the
      // keychain.
      let result: OSStatus =
        SharedStore.available
        ? (SharedStore.writeReport(data) ? errSecSuccess : errSecIO)
        : BotIconStore.writeReport(data)
      log.notice("report \(key, privacy: .public): write status \(result)")
      lock.lock()
      if result == errSecSuccess {
        failedStatus = nil
        failures = 0
        retryAt = .distantPast
      } else {
        // Not written: try again on a render retryAfter seconds from now (not in 5 minutes, and
        // not on every icon of every presentation either).
        failedStatus = result
        failures += 1
        written = nil
        retryAt = now.addingTimeInterval(retryAfter)
      }
      lock.unlock()
    }
  }
}
