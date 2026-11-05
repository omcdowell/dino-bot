import type { PluginClientContext, PluginScreenContribution } from "@getpaseo/plugin/client";
import { BotScreen } from "./client/bot-screen";
import { dmCardTransformer, makeDmCardRenderer } from "./client/dm-card";
import { rateLimitCardRenderer, rateLimitCardTransformer } from "./client/rate-limit-card";
import { DMS_PANEL_ID, titleCase } from "./client/dms-format";
import { DmsPanel, DmsScreen } from "./client/dms-screen";
import { BotsSidebarItem } from "./client/sidebar";
import { HomeScreen } from "./client/home-screen";
import { GroupScreen } from "./client/group-screen";
import { GroupHeaderAvatar, GroupHeaderControls } from "./client/group-header";
import { GROUP_SCREEN_ID, setOpenScreen } from "./client/group-nav";
import { setRoomEvents } from "./client/group-data";
import { setBotEvents, type BotEvents } from "./client/push";
import * as pluginReactNative from "@getpaseo/plugin/client/react-native";
import { HOME_MENU } from "./client/manage-data";
import { registerAvatarSvg } from "./client/host-svg";

export default function contribute(client: PluginClientContext) {
  // Bots-home data pushed by the host (Paseo plugin events); older apps: undefined, keep polling.
  setBotEvents((client as { events?: BotEvents }).events);
  setRoomEvents((client as { events?: BotEvents }).events);
  // Screens get no openScreen prop: the phone home opens the group screen through this.
  setOpenScreen((input) => client.openScreen(input));
  // Designed avatars drawn from avatar.json where the app has SvgXml (feature-detected); else PNGs as before.
  registerAvatarSvg(pluginReactNative);
  // Phone home (layout A): on phones this is the app's start screen in place of the main menu.
  // `mobileHome` is read by Paseo builds that have the start-screen hook; older apps ignore it.
  // `mobileHomeMenu` (Paseo 31+): New bot, New group chat and Archived at the top of the home's "⋯"
  // menu. Older apps ignore it; the home then shows the same three as links under the list.
  const home: PluginScreenContribution & { mobileHome?: boolean; mobileHomeMenu?: typeof HOME_MENU } = {
    id: "home",
    title: "Bots",
    Component: HomeScreen,
    mobileHome: true,
    mobileHomeMenu: HOME_MENU,
  };
  client.addScreen(home);
  // Group chat (rooms): one thread per group from ~/bots/.groups.json. On phones, Paseo builds with
  // `mobileFloatingHeader` give it the bot chat's header D and slide it in over the home like a chat;
  // older apps ignore the option and show the plain plugin header.
  const group: PluginScreenContribution & {
    mobileFloatingHeader?: {
      Avatar?: PluginScreenContribution["Component"];
      Controls?: PluginScreenContribution["Component"];
    };
  } = {
    id: GROUP_SCREEN_ID,
    title: (params) => params.name ?? "Group",
    Component: GroupScreen,
    mobileFloatingHeader: { Avatar: GroupHeaderAvatar, Controls: GroupHeaderControls },
  };
  client.addScreen(group);
  client.addScreen({
    id: "bot",
    title: (params) => params.name ?? "Bot",
    Component: BotScreen,
  });
  // DMs live in the Explorer sidebar of each bot's workspace (next to Files and Changes); add it
  // once per workspace with the Explorer's "+" menu. Explorer only, so the main area's New tab page
  // of every workspace does not offer it. A non-bot workspace shows "Not a bot workspace".
  client.addWorkspacePanel({
    id: DMS_PANEL_ID,
    title: "DMs",
    icon: "MessagesSquare",
    context: "workspace",
    locations: ["explorer"],
    Component: DmsPanel,
  });
  // Phone fallback: the iOS app's Explorer shows built-in tabs only, so there the DMs stay a screen,
  // reached from DMs rows in the Bots sidebar (shown only where the panel is unavailable).
  client.addScreen({
    id: "dms",
    title: (params) => `${params.name ?? titleCase(params.botId ?? "")} · DMs`,
    Component: DmsScreen,
  });
  client.addSidebarHeaderItem({ id: "bots", title: "Bots", Component: BotsSidebarItem });
  // Option C: bot DMs in a bot's main chat render as "DM from <bot>" cards linking to the thread.
  client.addTimelineTransformer(dmCardTransformer);
  client.addTimelineRenderer(
    makeDmCardRenderer({
      openScreen: (input) => client.openScreen(input),
      openPanel: (id, options) => client.openPanel(id, options),
    }),
  );
  // Owner-only: provider retries and usage-pool quota errors read as one card with the reset time.
  client.addTimelineTransformer(rateLimitCardTransformer);
  client.addTimelineRenderer(rateLimitCardRenderer);
  return () => {};
}
