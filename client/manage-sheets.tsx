/**
 * Bot management sheets on the phone home (build 31): new / edit bot (name, avatar, AGENTS.md),
 * new / edit group chat (name, members, leads) and Archived (Unarchive).
 *
 * AV3: on apps that pass SvgXml, the avatar opens the avatar designer (client/avatar-designer.tsx). Its Save
 * is queued at once as avatar.json (client/avatar-outbox.ts): an edited bot's new avatar shows straight away
 * and is sent when the host answers; a new bot's is queued right after Create. "Use a photo" stays.
 */
import { useRpc } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from "react-native";
import { BOT_TEMPLATES, agentsMdFor, suggestedTemplate, type TemplateId } from "../shared/templates";
import {
  botsAgentsMdRpc,
  botsCompactorRpc,
  botsCreateRpc,
  botsDeleteRpc,
  botsSetCompactorRpc,
  botsUpdateRpc,
  roomsCreateRpc,
  roomsRenameRpc,
  type Compactor,
} from "../shared/manage-rpc";
import { compactorFromModelId, compactorLabel, compactorModelId } from "../shared/compactor";
import { roomsSetMembersRpc } from "../shared/rooms/rpc";
import type { Bot } from "../shared/rpc";
import { BotAvatar } from "./bot-avatar";
import { GroupAvatar } from "./group-avatar";
import { avatarFor, toGroup } from "./group-data";
import { avatarStack } from "./group-format";
import type { RoomSummary } from "./group-types";
import type { ArchivedItem } from "./manage-format";
import { leadHint, toggleLead, toggleMember } from "./manage-format";
import type { HostExtras } from "./manage-data";
import { accentFill, accentOn, accentText } from "./accent";
import { AVATAR_PACK, type AvatarJson } from "../shared/avatar";
import { designerSvgs } from "./avatar-designer-svg";
import { AvatarDesigner } from "./avatar-designer";
import { defaultLook, lookFromAvatar, toAvatarJson, type Look } from "./avatar-designer-state";
import { useAvatarApi } from "./avatar-api";
import { noteHostRevision, saveStatus } from "./avatar-outbox";
import { useBotAvatarEntry, useSaveAvatar, writeOutbox } from "./avatar-outbox-data";
import { useQueryClient } from "@tanstack/react-query";

type Colors = PluginTheme["colors"];
const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, monospace" });
const GROUP_SHEET_NOTE = "Messages without an @name go to the lead(s). The group appears on home with its members' avatars.";
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The edited bot's avatar save, in words (null: nothing to say). */
function avatarSaveLine(status: ReturnType<typeof saveStatus>, error?: string): string | null {
  switch (status) {
    case "queued":
      return "Avatar saved on this phone. It is sent to your computer when it answers.";
    case "stale":
      return "A newer avatar was saved from another device, so this one was not used.";
    case "invalid":
      return `Your computer could not use this avatar${error ? `: ${error}` : "."}`;
    default:
      return null;
  }
}

function Label({ children, c, right }: { children: ReactNode; c: Colors; right?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 18, marginBottom: 8 }}>
      <Text style={{ flex: 1, fontSize: 14, color: c.foregroundMuted }}>{children}</Text>
      {right}
    </View>
  );
}

function Field({ value, onChange, placeholder, c, testID }: { value: string; onChange(v: string): void; placeholder: string; c: Colors; testID: string }) {
  return (
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={c.foregroundMuted}
      autoCorrect={false}
      style={{
        fontSize: 17,
        color: c.foreground,
        backgroundColor: c.surface2,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 14,
        paddingHorizontal: 16,
        paddingVertical: 12,
      }}
    />
  );
}

/** Cancel + primary, at the bottom of every sheet. */
function Actions({ c, primary, disabled, busy, onPrimary, onCancel, testID }: {
  c: Colors;
  primary: string;
  disabled: boolean;
  busy: boolean;
  onPrimary(): void;
  onCancel(): void;
  testID: string;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 12, marginTop: 22 }}>
      <Pressable
        accessibilityRole="button"
        onPress={onCancel}
        style={{ flex: 1, alignItems: "center", paddingVertical: 14, borderRadius: 999, backgroundColor: c.surface2 }}
      >
        <Text style={{ fontSize: 16, color: c.foreground }}>Cancel</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        testID={testID}
        disabled={disabled || busy}
        onPress={onPrimary}
        style={{ flex: 1, alignItems: "center", paddingVertical: 14, borderRadius: 999, backgroundColor: c.foreground, opacity: disabled ? 0.35 : 1 }}
      >
        {busy ? <ActivityIndicator color={c.surface0} /> : <Text style={{ fontSize: 16, fontWeight: "600", color: c.surface0 }}>{primary}</Text>}
      </Pressable>
    </View>
  );
}

function ErrorLine({ text, c }: { text: string | null; c: Colors }) {
  return text ? <Text style={{ color: c.statusDanger, marginTop: 12, fontSize: 14 }}>{text}</Text> : null;
}

// ---------- bot ----------

/**
 * Compaction model: the OptChat profile's `compactor` (writes memory summaries). The model comes
 * from the app's own picker (Scoped / All), so it is the same list as the chat's model.
 */
function CompactorField({
  c,
  serverId,
  value,
  dirty,
  extras,
  onChange,
}: {
  c: Colors;
  serverId: string;
  value: Compactor | null;
  dirty: boolean;
  extras: HostExtras;
  onChange(next: Compactor): void;
}) {
  const Picker = extras.ModelPickerField;
  return (
    <View testID="bots-sheet-compactor">
      <Label
        c={c}
        right={dirty ? <Text style={{ fontSize: 13, fontWeight: "600", color: c.statusWarning }}>● Unsaved changes</Text> : null}
      >
        Compaction model
      </Label>
      {value === null ? (
        <ActivityIndicator color={c.foregroundMuted} style={{ marginVertical: 12 }} />
      ) : Picker ? (
        <View style={{ backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 }}>
          <Picker
            serverId={serverId}
            provider="optchat"
            modelId={compactorModelId(value)}
            thinkingId={value.thinking}
            thinkingLabel="Thinking"
            testID="bots-sheet-compactor-picker"
            onChange={({ modelId, thinkingId }) => {
              const next = compactorFromModelId(modelId, thinkingId);
              if (next) onChange(next);
            }}
          />
        </View>
      ) : (
        <Text style={{ fontSize: 15, color: c.foreground }}>{compactorLabel(value)}</Text>
      )}
      <Text style={{ marginTop: 8, fontSize: 13, color: c.foregroundMuted }}>
        {Picker
          ? "Writes this bot's memory summaries. Used from the next summary."
          : "Writes this bot's memory summaries. Update the Paseo app to change it here."}
      </Text>
    </View>
  );
}

/** Starter template chips (New bot): label + one line; a coordinator is suggested, never required. */
function TemplatePicker({ c, value, onChange }: { c: Colors; value: TemplateId; onChange(next: TemplateId): void }) {
  const selected = BOT_TEMPLATES.find((t) => t.id === value);
  return (
    <View testID="bots-sheet-templates">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {BOT_TEMPLATES.map((t) => {
          const on = t.id === value;
          return (
            <Pressable
              key={t.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              testID={`bots-sheet-template-${t.id}`}
              onPress={() => onChange(t.id)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: on ? accentFill(c) : c.border,
                backgroundColor: on ? accentFill(c) : c.surface2,
              }}
            >
              <Text style={{ fontSize: 15, fontWeight: on ? "600" : "400", color: on ? accentOn(c) : c.foreground }}>{t.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {selected ? <Text style={{ marginTop: 8, fontSize: 13, color: c.foregroundMuted }}>{selected.blurb}</Text> : null}
    </View>
  );
}

/** Delete bot: type the name to confirm. Nothing is erased on the host; the folder goes to ~/bots/.trash. */
function DeleteBot({ c, bot, onDeleted }: { c: Colors; bot: Bot; onDeleted(): void }) {
  const remove = useRpc(botsDeleteRpc);
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!armed) {
    return (
      <Pressable accessibilityRole="button" testID="bots-sheet-delete" onPress={() => setArmed(true)} style={{ marginTop: 28, alignItems: "center" }}>
        <Text style={{ fontSize: 16, fontWeight: "600", color: c.statusDanger }}>Delete bot</Text>
      </Pressable>
    );
  }
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await remove({ botId: bot.id, confirmName: typed });
      onDeleted();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View testID="bots-sheet-delete-confirm" style={{ marginTop: 28, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: c.statusDanger }}>
      <Text style={{ fontSize: 14, color: c.foreground }}>
        {`Delete ${bot.name}? Its chats are archived and its folder moves to the trash folder on your computer (~/bots/.trash), so it can be restored there. Type ${bot.name} to confirm.`}
      </Text>
      <View style={{ marginTop: 10 }}>
        <Field testID="bots-sheet-delete-name" value={typed} onChange={setTyped} placeholder={bot.name} c={c} />
      </View>
      <ErrorLine text={error} c={c} />
      <View style={{ flexDirection: "row", gap: 12, marginTop: 12 }}>
        <Pressable accessibilityRole="button" onPress={() => setArmed(false)} style={{ flex: 1, alignItems: "center", paddingVertical: 12, borderRadius: 999, backgroundColor: c.surface2 }}>
          <Text style={{ fontSize: 15, color: c.foreground }}>Keep</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          testID="bots-sheet-delete-go"
          disabled={busy || typed.trim() !== bot.name.trim()}
          onPress={() => void go()}
          style={{ flex: 1, alignItems: "center", paddingVertical: 12, borderRadius: 999, backgroundColor: c.statusDanger, opacity: typed.trim() === bot.name.trim() ? 1 : 0.35 }}
        >
          {busy ? <ActivityIndicator color={c.surface0} /> : <Text style={{ fontSize: 15, fontWeight: "600", color: c.surface0 }}>Delete</Text>}
        </Pressable>
      </View>
    </View>
  );
}

export function BotSheet({
  open,
  bot,
  theme,
  extras,
  serverId,
  botCount = 1,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null: New bot. */
  bot: Bot | null;
  theme: PluginTheme;
  extras: HostExtras;
  /** The host the sheet edits (the model picker lists its catalogue). */
  serverId: string;
  /** Bots on the host now; with none the sheet suggests a coordinator. */
  botCount?: number;
  onClose(): void;
  onSaved(): void;
}) {
  const c = theme.colors;
  const toast = useToast();
  const loadAgents = useRpc(botsAgentsMdRpc);
  const loadCompactor = useRpc(botsCompactorRpc);
  const saveCompactor = useRpc(botsSetCompactorRpc);
  const [compactor, setCompactor] = useState<Compactor | null>(null);
  const [loadedCompactor, setLoadedCompactor] = useState<Compactor | null>(null);
  const create = useRpc(botsCreateRpc);
  const update = useRpc(botsUpdateRpc);
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<string | null>(null);
  const [agents, setAgents] = useState("");
  const [loaded, setLoaded] = useState<{ text: string; mtimeMs: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // New bot only: template, purpose, chat model, intro, and the AGENTS.md editor under Advanced.
  const [template, setTemplate] = useState<TemplateId>("blank");
  const [purpose, setPurpose] = useState("");
  const [chatModel, setChatModel] = useState<{ modelId: string; thinkingId: string | null } | null>(null);
  const [intro, setIntro] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  // Avatar designer (AV3): open, a new bot's designed look (queued after Create), the host's avatar.json.
  const queryClient = useQueryClient();
  const avatarApi = useAvatarApi();
  const saveAvatar = useSaveAvatar();
  const avatarEntry = useBotAvatarEntry(bot?.id);
  const [designing, setDesigning] = useState(false);
  const [designed, setDesigned] = useState<Look | null>(null);
  const [hostAvatar, setHostAvatar] = useState<AvatarJson | null>(null);
  const designedXml = useMemo(() => (designed ? designerSvgs(AVATAR_PACK, designed).full : null), [designed]);

  useEffect(() => {
    if (!open) return;
    setName(bot?.name ?? "");
    setAvatar(null);
    setDesigning(false);
    setDesigned(null);
    setHostAvatar(null);
    setError(null);
    setLoaded(null);
    setTemplate(suggestedTemplate(botCount));
    setPurpose("");
    setChatModel(null);
    setIntro(true);
    setAdvanced(false);
    setAgents("");
    setCompactor(null);
    setLoadedCompactor(null);
    if (!bot) return;
    let live = true;
    // The host's avatar.json (to start the designer from it, and so the next save's revision goes above it).
    avatarApi
      .get({ botId: bot.id })
      .then(({ avatar: stored }) => {
        if (!live || !stored) return;
        writeOutbox(queryClient, (box) => noteHostRevision(box, bot.id, stored.revision));
        setHostAvatar(stored);
      })
      .catch(() => {});
    loadCompactor({ botId: bot.id })
      .then(({ isDefault: _isDefault, ...result }) => {
        if (!live) return;
        setLoadedCompactor(result);
        setCompactor(result);
      })
      .catch(() => {});
    loadAgents({ botId: bot.id })
      .then((result) => {
        if (!live) return;
        setLoaded(result);
        setAgents(result.text);
      })
      .catch((cause) => live && setError(message(cause)));
    return () => {
      live = false;
    };
  }, [open, bot?.id]);

  const agentsDirty = bot ? loaded !== null && agents !== loaded.text : false;
  const compactorDirty =
    !!compactor && !!loadedCompactor && compactorLabel(compactor) !== compactorLabel(loadedCompactor);
  const dirty =
    !!avatar || !!designed || (bot ? name.trim() !== bot.name || agentsDirty || compactorDirty : name.trim().length > 0);
  const pick = async () => {
    if (!extras.pickImage) return;
    try {
      const picked = await extras.pickImage({ square: true, maxSize: 384 });
      if (picked) {
        setAvatar(picked.dataUri);
        setDesigned(null);
      }
    } catch (cause) {
      setError(message(cause));
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (bot) {
        await update({
          botId: bot.id,
          ...(name.trim() !== bot.name ? { name: name.trim() } : {}),
          ...(agentsDirty && loaded ? { agentsMd: { text: agents, baseMtimeMs: loaded.mtimeMs } } : {}),
          ...(avatar ? { avatar } : {}),
        });
        if (compactorDirty && compactor) await saveCompactor({ botId: bot.id, compactor });
        toast.show(`${name.trim()} saved`, { variant: "success" });
      } else {
        // Empty AGENTS.md: the host builds it from template + purpose (and adds the bot-dm block).
        const created = await create({
          name: name.trim(),
          agentsMd: advanced ? agents : "",
          template,
          ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
          ...(chatModel?.modelId
            ? { chat: { provider: `optchat/${chatModel.modelId}`, ...(chatModel.thinkingId ? { thinkingOptionId: chatModel.thinkingId } : {}) } }
            : {}),
          intro,
          ...(avatar ? { avatar } : {}),
        });
        if (designed) saveAvatar(created.botId, toAvatarJson(designed, AVATAR_PACK, 0), null);
        toast.show(intro ? `${name.trim()} created. Saying hello…` : `${name.trim()} created`, { variant: "success" });
      }
      extras.haptic("success");
      onSaved();
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const Svg = extras.SvgXml;
  /** Where the designer starts: this sheet's unsaved design, else the newest avatar.json known (this phone's
   *  last save or the host's), else Emmet in his box cap. */
  const designerStart = (): Look => {
    if (designed) return designed;
    const mine = avatarEntry?.saved ?? null;
    const newest = mine && (!hostAvatar || mine.revision >= hostAvatar.revision) ? mine : hostAvatar;
    return (newest && lookFromAvatar(newest, AVATAR_PACK)) ?? defaultLook(AVATAR_PACK);
  };
  const onDesigned = (look: Look) => {
    setDesigning(false);
    setAvatar(null);
    if (!bot) {
      setDesigned(look);
      return;
    }
    // Edited bot: saved now (optimistic, queued), not with the sheet's Save.
    saveAvatar(bot.id, toAvatarJson(look, AVATAR_PACK, 0), bot.avatarHash ?? null);
    extras.haptic("success");
    toast.show("Avatar saved", { variant: "success" });
  };
  const changeAvatar = () => (Svg ? setDesigning(true) : void pick());
  const avatarLine = bot ? avatarSaveLine(saveStatus(avatarEntry), avatarEntry?.dropped?.error) : null;

  return (
    <Modal title={bot ? "Edit bot" : "New bot"} open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28, gap: 0 }}>
        <View style={{ alignItems: "center", marginTop: 8 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Change avatar"
            testID="bots-sheet-avatar"
            disabled={!extras.pickImage && !Svg}
            onPress={changeAvatar}
          >
            {avatar ? (
              <Image source={{ uri: avatar }} style={{ width: 96, height: 96 }} resizeMode="contain" />
            ) : designedXml && Svg ? (
              <Svg xml={designedXml} width={96} height={96} />
            ) : bot ? (
              <BotAvatar bot={bot} size={96} theme={theme} />
            ) : (
              <View style={{ width: 96, height: 96, borderRadius: 30, backgroundColor: c.surface2, alignItems: "center", justifyContent: "center" }}>
                <Icon name="Bot" size={44} color={c.foregroundMuted} />
              </View>
            )}
            {extras.pickImage || Svg ? (
              <View
                style={{
                  position: "absolute",
                  right: -6,
                  bottom: -6,
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  backgroundColor: c.surface2,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Icon name={Svg ? "Pencil" : "Camera"} size={16} color={c.foreground} />
              </View>
            ) : null}
          </Pressable>
          {Svg ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 18, marginTop: 12 }}>
              <Pressable onPress={() => setDesigning(true)} hitSlop={8} testID="bots-sheet-design-avatar">
                <Text style={{ fontSize: 16, fontWeight: "600", color: accentText(c) }}>Design avatar</Text>
              </Pressable>
              {extras.pickImage ? (
                <Pressable onPress={() => void pick()} hitSlop={8} testID="bots-sheet-photo">
                  <Text style={{ fontSize: 15, color: c.foregroundMuted }}>Use a photo</Text>
                </Pressable>
              ) : null}
            </View>
          ) : extras.pickImage ? (
            <Pressable onPress={() => void pick()} hitSlop={8}>
              <Text style={{ marginTop: 12, fontSize: 16, fontWeight: "600", color: accentText(c) }}>
                {bot ? "Change avatar" : "Choose avatar"}
              </Text>
            </Pressable>
          ) : (
            <Text style={{ marginTop: 12, fontSize: 13, color: c.foregroundMuted }}>Update the Paseo app to change the avatar.</Text>
          )}
          {avatarLine ? (
            <Text testID="bots-sheet-avatar-status" style={{ marginTop: 8, fontSize: 13, color: c.foregroundMuted, textAlign: "center" }}>
              {avatarLine}
            </Text>
          ) : null}
        </View>
        <Label c={c}>Name</Label>
        <Field testID="bots-sheet-name" value={name} onChange={setName} placeholder="Bot name" c={c} />
        {!bot ? (
          <>
            <Label c={c}>{`What is ${name.trim() || "it"} for?`}</Label>
            <Field testID="bots-sheet-purpose" value={purpose} onChange={setPurpose} placeholder="e.g. Plans my week and keeps my reading list" c={c} />
            <Label c={c}>Starts from</Label>
            <TemplatePicker c={c} value={template} onChange={setTemplate} />
            {botCount === 0 ? (
              <Text style={{ marginTop: 6, fontSize: 13, color: c.foregroundMuted }}>
                Tip: a coordinator can hand work to your other bots later. Pick any template you like.
              </Text>
            ) : null}
            {extras.ModelPickerField ? (
              <>
                <Label c={c}>Model</Label>
                <View style={{ backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6 }}>
                  <extras.ModelPickerField
                    serverId={serverId}
                    provider="optchat"
                    modelId={chatModel?.modelId ?? ""}
                    thinkingId={chatModel?.thinkingId ?? null}
                    thinkingLabel="Thinking"
                    testID="bots-sheet-model-picker"
                    onChange={(next) => setChatModel(next)}
                  />
                </View>
                <Text style={{ marginTop: 8, fontSize: 13, color: c.foregroundMuted }}>
                  {chatModel ? "Change it later from the chat's model menu." : "Not chosen: your default bot model."}
                </Text>
              </>
            ) : null}
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: intro }}
              testID="bots-sheet-intro"
              onPress={() => setIntro(!intro)}
              style={{ flexDirection: "row", alignItems: "center", marginTop: 18, gap: 10 }}
            >
              <Icon name={intro ? "SquareCheck" : "Square"} size={20} color={intro ? accentText(c) : c.foregroundMuted} />
              <Text style={{ flex: 1, fontSize: 15, color: c.foreground }}>{`${name.trim() || "The bot"} says hello when it is created`}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="bots-sheet-advanced"
              onPress={() => {
                if (!advanced) setAgents(agentsMdFor({ name, template, purpose }));
                setAdvanced(!advanced);
              }}
              style={{ flexDirection: "row", alignItems: "center", marginTop: 18, gap: 6 }}
            >
              <Icon name={advanced ? "ChevronDown" : "ChevronRight"} size={16} color={c.foregroundMuted} />
              <Text style={{ fontSize: 14, color: c.foregroundMuted }}>Advanced: edit AGENTS.md</Text>
            </Pressable>
          </>
        ) : null}
        {bot || advanced ? (
        <>
        <Label
          c={c}
          right={
            agentsDirty ? <Text style={{ fontSize: 13, fontWeight: "600", color: c.statusWarning }}>● Unsaved changes</Text> : null
          }
        >
          AGENTS.md
        </Label>
        {bot && loaded === null && !error ? (
          <ActivityIndicator color={c.foregroundMuted} style={{ marginVertical: 24 }} />
        ) : (
          <TextInput
            testID="bots-sheet-agents"
            value={agents}
            onChangeText={setAgents}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            textAlignVertical="top"
            scrollEnabled={false}
            style={{
              minHeight: 260,
              fontFamily: MONO,
              fontSize: 13,
              lineHeight: 19,
              color: c.foreground,
              backgroundColor: c.surface1,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 14,
              padding: 14,
            }}
          />
        )}
        </>
        ) : null}
        {bot ? (
          <CompactorField
            c={c}
            serverId={serverId}
            value={compactor}
            dirty={compactorDirty}
            extras={extras}
            onChange={setCompactor}
          />
        ) : null}
        {!bot ? (
          <Text style={{ marginTop: 10, fontSize: 13, color: c.foregroundMuted }}>
            The new bot appears on home straight away. Edits to AGENTS.md apply from its next message.
          </Text>
        ) : null}
        <ErrorLine text={error} c={c} />
        <Actions
          c={c}
          testID="bots-sheet-save"
          primary={bot ? "Save" : "Create"}
          disabled={!name.trim() || !dirty}
          busy={busy}
          onPrimary={() => void save()}
          onCancel={onClose}
        />
        {bot ? (
          <DeleteBot
            c={c}
            bot={bot}
            onDeleted={() => {
              toast.show(`${bot.name} deleted`, { variant: "success" });
              extras.haptic("success");
              onSaved();
              onClose();
            }}
          />
        ) : null}
      </Modal.Content>
      {Svg && designing ? (
        <AvatarDesigner
          open={designing}
          botName={name.trim() || bot?.name || "New bot"}
          initial={designerStart()}
          pack={AVATAR_PACK}
          theme={theme}
          Svg={Svg}
          onCancel={() => setDesigning(false)}
          onSave={onDesigned}
        />
      ) : null}
    </Modal>
  );
}

// ---------- group ----------

export function GroupSheet({
  open,
  group,
  bots,
  theme,
  extras,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** Null: New group chat. */
  group: RoomSummary | null;
  /** Bots that can be members (archived ones left out by the caller). */
  bots: readonly Bot[];
  theme: PluginTheme;
  extras: HostExtras;
  onClose(): void;
  onSaved(): void;
}) {
  const c = theme.colors;
  const toast = useToast();
  const create = useRpc(roomsCreateRpc);
  const rename = useRpc(roomsRenameRpc);
  const setMembers = useRpc(roomsSetMembersRpc);
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ members: string[]; leads: string[] }>({ members: [], leads: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setEdit(group ? { members: toGroup(group).members, leads: toGroup(group).leads } : { members: [], leads: [] });
    setError(null);
  }, [open, group?.id]);

  const before = group ? toGroup(group) : null;
  const membersChanged =
    !before || before.members.join() !== edit.members.join() || before.leads.slice().sort().join() !== edit.leads.slice().sort().join();
  const nameChanged = !group || name.trim() !== group.name;
  const valid = name.trim().length > 0 && edit.members.length >= 2 && edit.leads.length >= 1;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!group) {
        await create({ name: name.trim(), members: edit.members, leads: edit.leads });
        toast.show(`${name.trim()} created`, { variant: "success" });
      } else {
        if (nameChanged) await rename({ groupId: group.id, name: name.trim() });
        if (membersChanged) await setMembers({ groupId: group.id, members: edit.members, leads: edit.leads });
        toast.show(`${name.trim()} saved`, { variant: "success" });
      }
      extras.haptic("success");
      onSaved();
      onClose();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  // Members of an edited group stay listed even if archived since.
  const listed = [...bots, ...(group ? (before?.members ?? []).filter((id) => !bots.some((b) => b.id === id)).map((id) => avatarFor(id, group, []) as Bot) : [])];

  return (
    <Modal title={group ? "Edit group chat" : "New group chat"} open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28, gap: 0 }}>
        <Label c={c}>Name</Label>
        <Field testID="groups-sheet-name" value={name} onChange={setName} placeholder="Group name" c={c} />
        <Label
          c={c}
          right={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Icon name="Crown" size={14} color={c.foregroundMuted} />
              <Text style={{ fontSize: 13, color: c.foregroundMuted }}>{leadHint(Platform.OS)}</Text>
            </View>
          }
        >
          {`Members · ${edit.members.length} selected`}
        </Label>
        {listed.map((bot) => {
          const member = edit.members.includes(bot.id);
          const lead = edit.leads.includes(bot.id);
          return (
            <View key={bot.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 8 }}>
              <BotAvatar bot={bot} size={44} theme={theme} />
              <View style={{ flex: 1, marginLeft: 14, flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text numberOfLines={1} style={{ fontSize: 17, fontWeight: "600", color: c.foreground, flexShrink: 1 }}>
                  {bot.name ?? bot.id}
                </Text>
                {lead ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: c.surface2 }}>
                    <Icon name="Crown" size={12} color={c.foregroundMuted} />
                    <Text style={{ fontSize: 12, color: c.foregroundMuted }}>lead</Text>
                  </View>
                ) : null}
              </View>
              {member ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={lead ? `${bot.name} is a lead` : `Make ${bot.name} a lead`}
                  testID={`groups-sheet-lead-${bot.id}`}
                  onPress={() => setEdit(toggleLead(edit, bot.id))}
                  style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: lead ? c.surface2 : "transparent", marginRight: 10 }}
                >
                  <Icon name="Crown" size={20} color={lead ? c.foreground : c.foregroundMuted} />
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: member }}
                accessibilityLabel={bot.name}
                testID={`groups-sheet-member-${bot.id}`}
                onPress={() => setEdit(toggleMember(edit, bot.id))}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 15,
                  borderWidth: member ? 0 : 1.5,
                  borderColor: c.foregroundMuted,
                  backgroundColor: member ? accentFill(c) : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {member ? <Icon name="Check" size={18} color={accentOn(c)} /> : null}
              </Pressable>
            </View>
          );
        })}
        <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
          <Icon name="Info" size={16} color={c.foregroundMuted} />
          <Text style={{ flex: 1, fontSize: 13, color: c.foregroundMuted }}>{GROUP_SHEET_NOTE}</Text>
        </View>
        <ErrorLine text={error} c={c} />
        <Actions
          c={c}
          testID="groups-sheet-save"
          primary={group ? "Save" : "Create"}
          disabled={!valid || (!nameChanged && !membersChanged)}
          busy={busy}
          onPrimary={() => void save()}
          onCancel={onClose}
        />
      </Modal.Content>
    </Modal>
  );
}

// ---------- archived ----------

export function ArchivedSheet({
  open,
  items,
  bots,
  theme,
  onClose,
  onUnarchive,
}: {
  open: boolean;
  items: ArchivedItem<Bot, RoomSummary>[];
  bots: readonly Bot[];
  theme: PluginTheme;
  onClose(): void;
  onUnarchive(key: string): Promise<unknown>;
}) {
  const c = theme.colors;
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Modal title="Archived" open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 28, gap: 0 }}>
        <Text style={{ fontSize: 14, color: c.foregroundMuted, marginBottom: 12 }}>
          Archived bots and group chats are hidden from home and the sidebar. Nothing is deleted; their timers and DMs keep
          working.
        </Text>
        {items.length === 0 ? <Text style={{ fontSize: 16, color: c.foregroundMuted, paddingVertical: 20, textAlign: "center" }}>Nothing archived.</Text> : null}
        {items.map((item) => (
          <View key={item.key} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10 }}>
            {item.kind === "bot" ? (
              <BotAvatar bot={item.bot} size={44} theme={theme} />
            ) : (
              <GroupAvatar stack={avatarStack(toGroup(item.group)).map((id) => avatarFor(id, item.group, bots))} size={44} theme={theme} />
            )}
            <Text numberOfLines={1} style={{ flex: 1, marginLeft: 14, fontSize: 17, fontWeight: "600", color: c.foreground }}>
              {item.kind === "bot" ? item.bot.name : item.group.name}
            </Text>
            <Pressable
              accessibilityRole="button"
              testID={`bots-archived-restore-${item.key}`}
              disabled={busy !== null}
              onPress={() => {
                setBusy(item.key);
                void onUnarchive(item.key).finally(() => setBusy(null));
              }}
              style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: c.surface2 }}
            >
              {busy === item.key ? (
                <ActivityIndicator color={c.foregroundMuted} />
              ) : (
                <Text style={{ fontSize: 15, color: c.foreground }}>Unarchive</Text>
              )}
            </Pressable>
          </View>
        ))}
      </Modal.Content>
    </Modal>
  );
}
