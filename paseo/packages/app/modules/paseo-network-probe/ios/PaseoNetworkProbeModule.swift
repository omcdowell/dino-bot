import Darwin
import ExpoModulesCore
import Foundation
import Network

/// Network probes for the Network page: interfaces (to spot the Tailscale tunnel), name lookup
/// (MagicDNS), a timed TCP connect (is box answering), and the current path flags.
public class PaseoNetworkProbeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoNetworkProbe")

    AsyncFunction("listInterfaces") { () -> [[String: Any]] in
      return listInterfaces()
    }

    AsyncFunction("resolve") { (host: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        let startedAt = DispatchTime.now()
        let result = resolveHost(host)
        let ms = elapsedMs(since: startedAt)
        switch result {
        case .success(let addresses):
          promise.resolve(["addresses": addresses, "ms": ms])
        case .failure(let message):
          promise.reject("ERR_RESOLVE", message)
        }
      }
    }

    AsyncFunction("tcpConnect") { (host: String, port: Int, timeoutMs: Int, promise: Promise) in
      tcpConnect(host: host, port: port, timeoutMs: timeoutMs) { result in
        promise.resolve(result)
      }
    }

    AsyncFunction("pathInfo") { (promise: Promise) in
      let monitor = NWPathMonitor()
      let queue = DispatchQueue(label: "sh.paseo.networkprobe.path")
      monitor.pathUpdateHandler = { path in
        monitor.cancel()
        promise.resolve([
          "status": String(describing: path.status),
          "isExpensive": path.isExpensive,
          "isConstrained": path.isConstrained,
          "usesOther": path.usesInterfaceType(.other),
          "usesWifi": path.usesInterfaceType(.wifi),
          "usesCellular": path.usesInterfaceType(.cellular),
        ])
      }
      monitor.start(queue: queue)
    }
  }
}

private enum ResolveResult {
  case success([String])
  case failure(String)
}

private func elapsedMs(since start: DispatchTime) -> Double {
  return Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
}

private func addressString(_ address: UnsafePointer<sockaddr>) -> String? {
  var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
  let length = socklen_t(address.pointee.sa_family == AF_INET6
    ? MemoryLayout<sockaddr_in6>.size
    : MemoryLayout<sockaddr_in>.size)
  let status = getnameinfo(address, length, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST)
  return status == 0 ? String(cString: buffer) : nil
}

private func listInterfaces() -> [[String: Any]] {
  var result: [[String: Any]] = []
  var head: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&head) == 0, let first = head else { return result }
  defer { freeifaddrs(head) }
  var cursor: UnsafeMutablePointer<ifaddrs>? = first
  while let entry = cursor {
    defer { cursor = entry.pointee.ifa_next }
    guard let address = entry.pointee.ifa_addr else { continue }
    let family = Int32(address.pointee.sa_family)
    guard family == AF_INET || family == AF_INET6 else { continue }
    guard let text = addressString(address) else { continue }
    let flags = Int32(entry.pointee.ifa_flags)
    result.append([
      "name": String(cString: entry.pointee.ifa_name),
      "address": text,
      "family": family == AF_INET6 ? "IPv6" : "IPv4",
      "internal": (flags & IFF_LOOPBACK) != 0,
      "up": (flags & IFF_UP) != 0,
    ])
  }
  return result
}

private func resolveHost(_ host: String) -> ResolveResult {
  var hints = addrinfo()
  hints.ai_family = AF_UNSPEC
  hints.ai_socktype = SOCK_STREAM
  var head: UnsafeMutablePointer<addrinfo>?
  let status = getaddrinfo(host, nil, &hints, &head)
  guard status == 0 else {
    return .failure(String(cString: gai_strerror(status)))
  }
  defer { freeaddrinfo(head) }
  var addresses: [String] = []
  var cursor = head
  while let entry = cursor {
    if let address = entry.pointee.ai_addr, let text = addressString(address),
      !addresses.contains(text)
    {
      addresses.append(text)
    }
    cursor = entry.pointee.ai_next
  }
  return .success(addresses)
}

private func tcpConnect(
  host: String,
  port: Int,
  timeoutMs: Int,
  completion: @escaping ([String: Any]) -> Void
) {
  let queue = DispatchQueue(label: "sh.paseo.networkprobe.tcp")
  guard let endpointPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else {
    completion(["outcome": "error", "ms": 0, "error": "invalid port"])
    return
  }
  let parameters = NWParameters.tcp
  if let tcp = parameters.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
    tcp.connectionTimeout = max(1, timeoutMs / 1000)
  }
  let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: parameters)
  let startedAt = DispatchTime.now()
  var finished = false
  let finish: (String, String?) -> Void = { outcome, error in
    if finished { return }
    finished = true
    connection.cancel()
    var result: [String: Any] = ["outcome": outcome, "ms": elapsedMs(since: startedAt)]
    if let error = error { result["error"] = error }
    completion(result)
  }
  connection.stateUpdateHandler = { state in
    switch state {
    case .ready:
      finish("connected", nil)
    case .waiting(let error), .failed(let error):
      if case .posix(let code) = error, code == .ECONNREFUSED {
        finish("refused", nil)
      } else if case .failed = state {
        finish("error", error.localizedDescription)
      }
    default:
      break
    }
  }
  connection.start(queue: queue)
  let clamped = min(max(timeoutMs, 100), 15_000)
  queue.asyncAfter(deadline: .now() + .milliseconds(clamped)) {
    finish("timeout", nil)
  }
}
