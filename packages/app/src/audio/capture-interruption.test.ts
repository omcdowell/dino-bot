import { describe, expect, it } from "vitest";
import { resolveCaptureInterruption } from "./capture-interruption";

describe("resolveCaptureInterruption", () => {
  describe("dictation (end-on-began)", () => {
    const policy = "end-on-began" as const;

    it("ends the capture as soon as a call or Siri takes the session", () => {
      expect(resolveCaptureInterruption({ event: "began", captureActive: true, policy })).toBe(
        "end-capture",
      );
    });

    it("silences the mic native resumed after the interruption, since dictation already stopped", () => {
      expect(resolveCaptureInterruption({ event: "ended", captureActive: false, policy })).toBe(
        "silence-mic",
      );
    });

    it("does nothing for a 'blocked' end when capture already ended at 'began'", () => {
      expect(resolveCaptureInterruption({ event: "blocked", captureActive: false, policy })).toBe(
        "none",
      );
    });

    it("ignores a 'began' while not capturing", () => {
      expect(resolveCaptureInterruption({ event: "began", captureActive: false, policy })).toBe(
        "none",
      );
    });
  });

  describe("realtime voice (end-if-blocked)", () => {
    const policy = "end-if-blocked" as const;

    it("keeps capturing through 'began' so native can resume afterwards", () => {
      expect(resolveCaptureInterruption({ event: "began", captureActive: true, policy })).toBe(
        "none",
      );
      expect(resolveCaptureInterruption({ event: "ended", captureActive: true, policy })).toBe(
        "none",
      );
    });

    it("ends the capture when iOS refuses to resume", () => {
      expect(resolveCaptureInterruption({ event: "blocked", captureActive: true, policy })).toBe(
        "end-capture",
      );
    });

    it("silences a resumed mic when voice was only playing back", () => {
      expect(resolveCaptureInterruption({ event: "ended", captureActive: false, policy })).toBe(
        "silence-mic",
      );
    });
  });

  it("ignores unknown events", () => {
    expect(
      resolveCaptureInterruption({ event: "other", captureActive: true, policy: "end-on-began" }),
    ).toBe("none");
  });
});
