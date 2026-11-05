// @ts-nocheck -- dev-only web harness: built with a Paseo checkout's react-dom / react-native-svg / lucide (build.mjs), not this package's.
// Web harness for the avatar designer (AV3): renders client/avatar-designer.tsx with react-native-web and
// react-native-svg, as the Paseo app would on a phone. Built by build.mjs, driven by shoot.mjs.
// Query: ?theme=dark&bot=Name&look=<avatar.json url-encoded>
import { createRoot } from "react-dom/client";
import { AppRegistry } from "react-native";
import { AVATAR_PACK } from "../../../shared/avatar";
import { DesignerBody } from "../../../client/avatar-designer";
import { defaultLook, lookFromAvatar, toAvatarJson, type Look } from "../../../client/avatar-designer-state";
import { SvgXml } from "./plugin-rn-stub";

const q = new URLSearchParams(location.search);
const dark = q.get("theme") === "dark";
const theme = {
  colors: dark
    ? { surface0: "#141414", surface1: "#1c1c1e", surface2: "#262628", border: "#323235", foreground: "#f4f4f5", foregroundMuted: "#a1a1aa", accent: "#9CC963", accentForeground: "#2B3318", statusSuccess: "#5dba80", statusWarning: "#d4a44a", statusDanger: "#d8847b" }
    : { surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", border: "#e4e4e7", foreground: "#1a1a1e", foregroundMuted: "#71717a", accent: "#9CC963", accentForeground: "#2B3318", statusSuccess: "#3f7d4f", statusWarning: "#a26b16", statusDanger: "#9d433b" },
};
const raw = q.get("look");
const initial: Look = (raw && lookFromAvatar(JSON.parse(raw), AVATAR_PACK)) || defaultLook(AVATAR_PACK);
const saved: unknown[] = [];
(window as unknown as { __saved: unknown[] }).__saved = saved;
document.body.style.background = theme.colors.surface0;

function App() {
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <DesignerBody
        open
        botName={q.get("bot") ?? "Emmet"}
        initial={initial}
        pack={AVATAR_PACK}
        theme={theme}
        Svg={SvgXml}
        onCancel={() => saved.push("cancel")}
        onSave={(look) => saved.push(toAvatarJson(look, AVATAR_PACK, 1))}
      />
    </div>
  );
}
void AppRegistry;
createRoot(document.getElementById("root")!).render(<App />);
