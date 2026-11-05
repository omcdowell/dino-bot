import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { SearchField } from "@/components/ui/search-field";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  MODEL_ROLES,
  ONBOARDING_RPC,
  ROLE_COPY,
  filterModels,
  findModel,
  initialPicks,
  pickModel,
  previousStep,
  samePick,
  stepRoute,
  type ModelPicks,
  type ModelRole,
  type ModelsAnswer,
  type PiModel,
} from "@/onboarding/onboarding-model";
import { routeAfterStep } from "@/onboarding/setup-store";
import { providerLabels } from "@/onboarding/signin-session-store";
import { RELEASE_POLICY } from "@/constants/flavour";
import { setupColumnStyle } from "@/constants/layout";

const MutedSpinner = withUnistyles(LoadingSpinner, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

async function rpc<T>(serverId: string, method: string, input: unknown): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const client = getHostRuntimeStore().getClient(serverId);
    if (client) return (await client.invokePluginRpc(ONBOARDING_RPC.pluginId, method, input)) as T;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Not connected to your computer yet.");
}

/**
 * Onboarding step "models" (27 Oct): model and effort for bots, compaction and herdr
 * subagents. The lists are pi's: the computer refreshes pi's catalog once (`pi update --models`)
 * and answers with pi's get_available_models for the signed-in providers only; each model's
 * effort levels come from its thinkingLevelMap (no picker when it has none). Suggestions are
 * pi-optchat's per-sign-in defaults, used only when pi lists that model.
 */
export default function SetupModelsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const [answer, setAnswer] = useState<ModelsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<ModelPicks>({ bots: null, compaction: null, workers: null });
  const [picking, setPicking] = useState<ModelRole | null>(null);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  // "Could not save the models", shown on the screen (Alert.alert does nothing on desktop).
  const [saveError, setSaveError] = useState<string | null>(null);
  // The sign-ins in their own words ("ChatGPT (Codex)"), from the sign-in step's list.
  const [signedIn, setSignedIn] = useState<string[] | null>(null);

  const next = useCallback(async () => {
    if (!serverId) {
      router.replace("/" as Href);
      return;
    }
    const route = await routeAfterStep("models", serverId);
    router.replace(route as Href);
  }, [router, serverId]);

  // Back goes to the sign-in step when it is behind this one (to add an account), else on.
  const back = useCallback(() => {
    const prev = previousStep(RELEASE_POLICY.onboardingSteps, "models");
    if (prev && serverId) router.replace(stepRoute(prev, serverId) as Href);
    else void next();
  }, [router, serverId, next]);

  const load = useCallback(
    async (refresh: boolean) => {
      setError(null);
      setAnswer(null);
      void rpc<{ signedIn?: string[] }>(serverId, ONBOARDING_RPC.signinOptions, {})
        .then((o) => setSignedIn(o.signedIn ?? null))
        .catch(() => setSignedIn(null));
      let a: ModelsAnswer;
      try {
        a = await rpc<ModelsAnswer>(serverId, ONBOARDING_RPC.models, { refresh });
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      if (!a.available) {
        await next();
        return;
      }
      setAnswer(a);
      setPicks(initialPicks(a));
      if (a.error) setError(a.error);
    },
    [serverId, next],
  );
  // Once, right after sign-in: refresh pi's model catalog first.
  useEffect(() => void load(true), [load]);
  const retry = useCallback(() => void load(false), [load]);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await rpc<{ ok: boolean; error: string | null }>(serverId, ONBOARDING_RPC.apply, {
        models: picks,
      });
      if (!r.ok) throw new Error(r.error ?? "The computer refused the models.");
      await next();
    } catch (e) {
      setSaveError(`Could not save the models: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [serverId, picks, next]);
  const handleSave = useCallback(() => void save(), [save]);
  const closePicker = useCallback(() => setPicking(null), []);

  const listed = useMemo(() => (answer ? filterModels(answer.models, query) : []), [answer, query]);
  const choose = useCallback(
    (model: PiModel) => {
      if (!picking) return;
      setPicks((p) => ({ ...p, [picking]: pickModel(model, p[picking]) }));
      setPicking(null);
      setQuery("");
    },
    [picking],
  );
  const setEffort = useCallback((role: ModelRole, thinking: string) => {
    setPicks((p) => (p[role] ? { ...p, [role]: { ...p[role]!, thinking } } : p));
  }, []);

  const contentStyle = useMemo(
    () => [styles.content, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );
  const ready = Boolean(answer && MODEL_ROLES.every((r) => picks[r]));
  // When the host already has models (onboarding opened again), offer the sign-in's suggestions.
  const differsFromSuggested = Boolean(
    answer && MODEL_ROLES.some((r) => !samePick(picks[r], answer.suggested[r])),
  );
  const useSuggested = useCallback(() => {
    if (answer) setPicks({ ...answer.suggested });
  }, [answer]);
  const sheetStyle = useMemo(() => [styles.container, styles.sheet], []);
  const listContentStyle = useMemo(() => ({ paddingBottom: insets.bottom + 24 }), [insets.bottom]);
  const current = picking ? picks[picking] : null;
  const renderModel = useCallback(
    ({ item }: { item: PiModel }) => (
      <ModelRow
        model={item}
        on={current?.provider === item.provider && current?.model === item.id}
        onChoose={choose}
      />
    ),
    [current, choose],
  );

  return (
    <View style={styles.container} testID="setup-models-screen">
      <BackHeader title="Choose models" onBack={back} />
      <ScrollView contentContainerStyle={contentStyle}>
        <Text style={styles.lead}>
          {answer
            ? `Suggested for ${providerLabels(answer.providers, signedIn).join(" and ")}. Change any of them; the lists come from pi on your computer.`
            : "Getting the model list from pi on your computer…"}
        </Text>
        {answer && differsFromSuggested ? (
          <Button onPress={useSuggested} testID="setup-models-use-suggested">
            Use the suggested models
          </Button>
        ) : null}
        {!answer && !error ? (
          <View style={styles.row}>
            <MutedSpinner />
            <Text style={styles.body}>pi update --models, then get_available_models</Text>
          </View>
        ) : null}
        {error ? (
          <View style={styles.card}>
            <Text style={styles.error}>{error}</Text>
            <Button onPress={retry}>Try again</Button>
          </View>
        ) : null}
        {answer
          ? MODEL_ROLES.map((role) => (
              <RoleCard
                key={role}
                role={role}
                pick={picks[role]}
                model={findModel(answer.models, picks[role])}
                onPick={setPicking}
                onEffort={setEffort}
              />
            ))
          : null}
        {saveError ? (
          <Text style={styles.error} testID="setup-models-save-error">
            {saveError}
          </Text>
        ) : null}
        {answer ? (
          <Button
            variant="default"
            onPress={handleSave}
            disabled={!ready || saving}
            loading={saving}
            testID="setup-models-continue"
          >
            Continue
          </Button>
        ) : null}
      </ScrollView>

      <Modal
        visible={picking !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closePicker}
      >
        <View style={sheetStyle}>
          <View style={[styles.row, styles.sheetHeader]}>
            <Text style={styles.title}>{picking ? `${ROLE_COPY[picking].title} model` : ""}</Text>
            <Button size="sm" onPress={closePicker}>
              Done
            </Button>
          </View>
          <View style={styles.search}>
            <SearchField
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              clearAccessibilityLabel="Clear search"
            />
          </View>
          <FlatList
            data={listed}
            keyExtractor={modelKey}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={listContentStyle}
            renderItem={renderModel}
          />
        </View>
      </Modal>
    </View>
  );
}

type ModelPick = ModelPicks[ModelRole];
type ListedModel = NonNullable<ReturnType<typeof findModel>>;

function modelKey(m: PiModel): string {
  return `${m.provider}/${m.id}`;
}
function pickerStyle({ pressed }: PressableStateCallbackType) {
  return [styles.picker, pressed && styles.pressed];
}
function itemStyle({ pressed }: PressableStateCallbackType) {
  return [styles.item, pressed && styles.pressed];
}

/** One role (bots, compaction, herdr subagents): its model and, if the model has any, effort. */
function RoleCard({
  role,
  pick,
  model,
  onPick,
  onEffort,
}: {
  role: ModelRole;
  pick: ModelPick;
  model: ListedModel | null | undefined;
  onPick: (role: ModelRole) => void;
  onEffort: (role: ModelRole, level: string) => void;
}) {
  const handlePick = useCallback(() => onPick(role), [onPick, role]);
  return (
    <View style={styles.card} testID={`setup-models-${role}`}>
      <Text style={styles.title}>{ROLE_COPY[role].title}</Text>
      <Text style={styles.body}>{ROLE_COPY[role].hint}</Text>
      <Pressable onPress={handlePick} style={pickerStyle} testID={`setup-models-${role}-model`}>
        <View style={styles.pickerText}>
          <Text style={styles.value}>{model ? model.name : "Pick a model"}</Text>
          {pick ? <Text style={styles.body}>{`${pick.provider}/${pick.model}`}</Text> : null}
        </View>
        <Text style={styles.change}>Change</Text>
      </Pressable>
      {model && model.levels.length ? (
        <View style={styles.chips} testID={`setup-models-${role}-effort`}>
          <Text style={styles.body}>Effort</Text>
          {model.levels.map((level) => (
            <EffortChip
              key={level}
              role={role}
              level={level}
              on={pick?.thinking === level}
              onEffort={onEffort}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function EffortChip({
  role,
  level,
  on,
  onEffort,
}: {
  role: ModelRole;
  level: string;
  on: boolean;
  onEffort: (role: ModelRole, level: string) => void;
}) {
  const handlePress = useCallback(() => onEffort(role, level), [onEffort, role, level]);
  return (
    <Pressable onPress={handlePress} style={on ? styles.chipSelected : styles.chip}>
      <Text style={on ? styles.chipTextSelected : styles.chipText}>{level}</Text>
    </Pressable>
  );
}

/** A model in the picker sheet: name, provider/id and the effort levels pi lists for it. */
function ModelRow({
  model,
  on,
  onChoose,
}: {
  model: PiModel;
  on: boolean;
  onChoose: (model: PiModel) => void;
}) {
  const handlePress = useCallback(() => onChoose(model), [onChoose, model]);
  const efforts = model.levels.length
    ? ` · effort ${model.levels.join(", ")}`
    : " · no effort setting";
  return (
    <Pressable onPress={handlePress} style={itemStyle}>
      <Text
        style={on ? styles.valueSelected : styles.value}
      >{`${on ? "✓ " : ""}${model.name}`}</Text>
      <Text style={styles.body}>{`${model.provider}/${model.id}${efforts}`}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[6], gap: theme.spacing[3], ...setupColumnStyle },
  lead: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  card: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  body: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  value: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    justifyContent: "space-between",
  },
  picker: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  pickerText: { flex: 1, gap: 2 },
  change: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  pressed: { opacity: 0.7 },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  chip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
  },
  chipSelected: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  chipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  chipTextSelected: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  valueSelected: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  sheet: { paddingTop: 12 },
  sheetHeader: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[2] },
  search: { marginHorizontal: theme.spacing[4], marginBottom: theme.spacing[2] },
  item: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: 2,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
}));
