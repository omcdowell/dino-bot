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

/** Plain steps for `tailscale` ({installed, state}) on `os`. Pure, so it is unit-tested. */
export function tailscaleSteps(tailscale, { os = process.platform, rerun, wsl = null } = {}) {
  const lines = [];
  const mac = os === "darwin";
  if (wsl) lines.push(...wslTailscaleSteps(tailscale, wsl));
  else if (!tailscale.installed) {
    lines.push(`One more thing first: ${PRODUCT} uses Tailscale (free) so your iPhone can reach this computer`);
    lines.push("from anywhere, privately, without opening anything to the internet. It takes about two minutes.");
    lines.push("");
    if (mac) {
      lines.push("1. Install Tailscale from the Mac App Store: https://apps.apple.com/app/tailscale/id1475387142");
      lines.push("   (or the standalone app: https://tailscale.com/download/mac)");
      lines.push("2. Open Tailscale, allow the VPN configuration, and log in.");
    } else {
      lines.push("1. Install it:   curl -fsSL https://tailscale.com/install.sh | sh");
      lines.push(`2. Turn it on:   sudo tailscale up --operator=$USER   (then open the login link it prints)`);
    }
  } else if (tailscale.state === "NeedsLogin" || tailscale.state === "NoState") {
    lines.push("Tailscale is installed but not logged in.");
    lines.push(mac ? "1. Click the Tailscale icon in the menu bar and log in." : "1. Run:   sudo tailscale up --operator=$USER   and open the login link it prints.");
  } else if (tailscale.state === "NeedsMachineAuth") {
    lines.push("Tailscale is waiting for this computer to be approved.");
    lines.push("1. Approve it at https://login.tailscale.com/admin/machines");
  } else {
    lines.push(`Tailscale is installed but off (${tailscale.state ?? "stopped"}).`);
    lines.push(mac ? "1. Click the Tailscale icon in the menu bar, then Connect." : "1. Run:   sudo tailscale up --operator=$USER");
  }
  const n = lines.filter((l) => /^\d\./.test(l)).length + 1;
  lines.push(`${n}. On your iPhone: install Tailscale from the App Store and log in with the same account.`);
  lines.push("");
  lines.push(`Then finish setup:   ${rerun ?? `~/.${PRODUCT_ID}/bin/${PRODUCT_ID} setup`}`);
  lines.push("(Everything is downloaded already; this part takes a few seconds.)");
  return lines;
}
