package sh.paseo.networkprobe

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.ConnectException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * Network probes for the Network page: interfaces (to spot the Tailscale tunnel), name lookup
 * (MagicDNS) and a timed TCP connect (is box answering). Expo runs AsyncFunctions off the UI
 * thread, so the blocking calls here are fine.
 */
class PaseoNetworkProbeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoNetworkProbe")

    AsyncFunction("listInterfaces") {
      val result = mutableListOf<Map<String, Any>>()
      for (networkInterface in NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()) {
        for (address in networkInterface.inetAddresses.toList()) {
          result.add(
            mapOf(
              "name" to networkInterface.name,
              "address" to (address.hostAddress ?: "").substringBefore('%'),
              "family" to if (address is Inet6Address) "IPv6" else "IPv4",
              "internal" to networkInterface.isLoopback,
              "up" to networkInterface.isUp,
            ),
          )
        }
      }
      result
    }

    AsyncFunction("resolve") { host: String ->
      val startedAt = System.nanoTime()
      val addresses =
        try {
          InetAddress.getAllByName(host).mapNotNull { it.hostAddress }.distinct()
        } catch (error: Exception) {
          throw CodedException("ERR_RESOLVE", error.message ?: "lookup failed", error)
        }
      mapOf("addresses" to addresses, "ms" to (System.nanoTime() - startedAt) / 1_000_000.0)
    }

    AsyncFunction("tcpConnect") { host: String, port: Int, timeoutMs: Int ->
      val startedAt = System.nanoTime()
      val clamped = timeoutMs.coerceIn(100, 15_000)
      val outcome: Pair<String, String?> =
        try {
          Socket().use { socket -> socket.connect(InetSocketAddress(host, port), clamped) }
          "connected" to null
        } catch (error: SocketTimeoutException) {
          "timeout" to null
        } catch (error: ConnectException) {
          if (error.message?.contains("ECONNREFUSED") == true) "refused" to null
          else "error" to error.message
        } catch (error: Exception) {
          "error" to (error.message ?: error.javaClass.simpleName)
        }
      val result =
        mutableMapOf<String, Any>(
          "outcome" to outcome.first,
          "ms" to (System.nanoTime() - startedAt) / 1_000_000.0,
        )
      outcome.second?.let { result["error"] = it }
      result
    }
  }
}
