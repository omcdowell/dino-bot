// Tailscale is required (owner decision, 27 Oct): the daemon listens on the tailnet address only. When it
// is missing or off, setup stops here with plain steps for this computer and the command to run
// afterwards. (The full walkthrough that waits and continues by itself is the next installer task.)
import { PRODUCT, PRODUCT_ID } from "./util.mjs";
import { wslTailscaleSteps } from "./wsl.mjs";

export class TailscaleRequired extends Error {
  constructor(steps) {
    super("Tailscale is required");
    this.steps = steps;
  }
}

/** One-line "why" shown before the steps when Tailscale is missing (here and on WSL). */
export const TAILSCALE_WHY = `${PRODUCT} needs Tailscale: a free app that links your iPhone to this computer, privately. About 2 minutes.`;
/** Install + log in, one paste (Linux and WSL; tailscale up prints the login link). */
export const LINUX_INSTALL = "curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --operator=$USER";

/**
 * Plain steps for `tailscale` ({installed, state}) on `os`: at most ~3 numbered steps, one action
 * each, in everyday words. `waiting`: setup is watching and carries on by itself (last step says
 * so); else the last step is the command to run. Pure, so it is unit-tested.
 */
export function tailscaleSteps(tailscale, { os = process.platform, rerun, wsl = null, waiting = false } = {}) {
  const lines = [];
  const step = (s) => lines.push(`${lines.filter((l) => /^\d\./.test(l)).length + 1}. ${s}`);
  const mac = os === "darwin";
  if (wsl) lines.push(...wslTailscaleSteps(tailscale, wsl));
  else if (!tailscale.installed) {
    lines.push(TAILSCALE_WHY, "");
    if (mac) {
      step("On this Mac: install Tailscale, open it and log in (click Allow if macOS asks).");
      lines.push("   https://apps.apple.com/app/tailscale/id1475387142   (or https://tailscale.com/download/mac)");
    } else {
      step("On this computer: install Tailscale and log in. Paste this, then open the link it prints:");
      lines.push(`   ${LINUX_INSTALL}`);
    }
  } else if (tailscale.state === "NeedsLogin" || tailscale.state === "NoState") {
    lines.push("Tailscale is installed but not logged in.", "");
    step(mac ? "On this Mac: click the Tailscale icon in the menu bar and log in." : "On this computer, run this and open the link it prints:   sudo tailscale up --operator=$USER");
  } else if (tailscale.state === "NeedsMachineAuth") {
    lines.push("Tailscale is waiting for this computer to be approved.", "");
    step("Approve it here: https://login.tailscale.com/admin/machines");
  } else {
    lines.push(`Tailscale is installed but off (${tailscale.state ?? "stopped"}).`, "");
    step(mac ? "On this Mac: click the Tailscale icon in the menu bar, then Connect." : "On this computer, run:   sudo tailscale up --operator=$USER");
  }
  step("On your iPhone: install Tailscale from the App Store and log in with the same account.");
  if (waiting) step("Come back here: setup carries on by itself once Tailscale is on.");
  else step(`Then finish setup:   ${rerun ?? `~/.${PRODUCT_ID}/bin/${PRODUCT_ID} setup`}   (a few seconds; everything is downloaded)`);
  return lines;
}
