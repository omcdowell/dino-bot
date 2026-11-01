import { describe, expect, it } from "vitest";
import { formatAppVersionLabel, formatDiagnosticAppVersion } from "./app-version-label";

describe("formatAppVersionLabel", () => {
  it("shows the native build number next to the version", () => {
    expect(formatAppVersionLabel("0.11.2", "21")).toBe("0.11.2 (21)");
    expect(formatAppVersionLabel(" 0.11.2 ", " 21 ")).toBe("0.11.2 (21)");
  });

  it("keeps the plain v-prefixed version where there is no native build", () => {
    expect(formatAppVersionLabel("0.11.2", null)).toBe("v0.11.2");
    expect(formatAppVersionLabel("0.11.2", "")).toBe("v0.11.2");
    expect(formatAppVersionLabel(null, "21")).toBe("\u2014");
  });
});

describe("formatDiagnosticAppVersion", () => {
  it("carries the build number into the diagnostics report", () => {
    expect(formatDiagnosticAppVersion("0.11.2", "21")).toBe("0.11.2 (21)");
    expect(formatDiagnosticAppVersion("0.11.2", null)).toBe("0.11.2");
    expect(formatDiagnosticAppVersion(null, "21")).toBeNull();
  });
});
