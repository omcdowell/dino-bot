import { isPublicFlavour } from "@/constants/flavour";
import { isElectronRuntime } from "@/desktop/host";

/**
 * The DinoBot desktop app: the public flavour inside Electron. It is a bots app like the phone, so
 * it opens on the Bots home, keeps bot chats free of coding chrome (Commit, worktree scripts) and
 * lists bots once (in the Bots list, not again under Workspaces). the owner's own Paseo desktop app
 * and the web build are unchanged.
 */
export function isPublicDesktopApp(): boolean {
  return isPublicFlavour && isElectronRuntime();
}
