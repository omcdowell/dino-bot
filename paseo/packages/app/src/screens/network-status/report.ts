import { formatDiagnosticSection } from "@/diagnostics/app-diagnostic-report";
import type { PhoneNetworkState } from "@/runtime/network-monitor";
import type { NetworkStatus } from "./model";
import type { NetworkTestRun } from "./run-tests";
import { formatMs } from "./stats";
import { branded } from "@/constants/flavour";

/** Plain-text report for "Copy report". Host addresses are left out; labels are kept. */

function value(input: string | number | boolean | null | undefined): string {
  if (input === null || input === undefined) return "n/a";
  return String(input);
}

function formatMbps(mbps: number | null | undefined): string {
  return mbps === null || mbps === undefined ? "n/a" : `${mbps.toFixed(2)} Mbit/s`;
}

function phoneSection(phone: PhoneNetworkState | null): string {
  return formatDiagnosticSection("This device", [
    { label: "Type", value: value(phone?.type) },
    { label: "Connected", value: value(phone?.isConnected) },
    { label: "Metered", value: value(phone?.isExpensive) },
    { label: "Cellular", value: value(phone?.cellularGeneration) },
    { label: "Wi-Fi strength", value: value(phone?.wifiStrength) },
  ]);
}

function linksSection(status: NetworkStatus): string[] {
  return status.hosts.map((host) =>
    formatDiagnosticSection(
      `Links to ${host.label} (${host.route})`,
      host.rows.map((row) => ({
        label: row.id,
        value: [
          row.state,
          row.reason,
          row.blockedBy ? `blocked by ${row.blockedBy}` : null,
          formatMs(row.latencyMs),
          row.params?.error ? String(row.params.error) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    ),
  );
}

function runSections(run: NetworkTestRun): string[] {
  const sections = [
    formatDiagnosticSection("Internet", [
      { label: "Verdict", value: run.internet.verdict },
      ...run.internet.targets.map((target) => ({
        label: target.label,
        value: `${value(formatMs(target.medianMs))} (${target.okCount}/${target.attempts})${
          target.error ? ` ${target.error}` : ""
        }`,
      })),
      { label: "Location", value: value(run.internet.trace?.loc) },
    ]),
    formatDiagnosticSection("Tailscale", [
      { label: "Probe", value: value(run.tailscale.available) },
      { label: "Tunnel up", value: value(run.tailscale.tunnelUp) },
    ]),
  ];
  for (const host of run.hosts) {
    sections.push(
      formatDiagnosticSection(`Test ${host.label}`, [
        { label: "Verdict", value: host.verdict },
        { label: "Resolve", value: host.resolve?.error ?? value(formatMs(host.resolve?.ms)) },
        {
          label: "TCP 22",
          value: `${value(host.machine?.outcome)} ${value(formatMs(host.machine?.ms))}`,
        },
        {
          label: "TCP daemon",
          value: `${value(host.daemonPort?.outcome)} ${value(formatMs(host.daemonPort?.ms))}`,
        },
        {
          label: "RTT",
          value: host.rtt
            ? `median ${value(formatMs(host.rtt.medianMs))}, p95 ${value(formatMs(host.rtt.p95Ms))}, loss ${value(host.rtt.lossPct)}%`
            : "n/a",
        },
        {
          label: "Speed",
          value: host.speed
            ? (host.speed.error ??
              `down ${formatMbps(host.speed.downMbps)}, up ${formatMbps(host.speed.upMbps)}`)
            : "n/a",
        },
        {
          label: "Provider",
          value: host.provider
            ? `${host.provider.viaBaseUrl ? "proxy" : "direct"} HTTP ${value(host.provider.httpStatus)} in ${value(formatMs(host.provider.httpMs))}${host.provider.error ? ` ${host.provider.error}` : ""}`
            : value(host.providerError),
        },
        {
          label: "Status page",
          value: host.provider?.status
            ? `${host.provider.status.indicator} · ${host.provider.status.description}`
            : value(host.provider?.statusError),
        },
      ]),
    );
  }
  return sections;
}

export function formatNetworkReport(input: {
  status: NetworkStatus;
  phone: PhoneNetworkState | null;
  lastRun: NetworkTestRun | null;
  now: Date;
}): string {
  return [
    formatDiagnosticSection(branded("Paseo network report"), [
      { label: "Collected at", value: input.now.toISOString() },
      {
        label: "Last test",
        value: input.lastRun ? new Date(input.lastRun.finishedAt).toISOString() : "never",
      },
    ]),
    phoneSection(input.phone),
    ...linksSection(input.status),
    ...(input.lastRun ? runSections(input.lastRun) : []),
  ].join("\n\n");
}
