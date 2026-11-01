import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ModelPickerFieldProps } from "@getpaseo/plugin/client/ui";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { SettingsSelect } from "@/components/settings";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { formatThinkingOptionLabel } from "@/agent-controls/labels";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { findModelByReference } from "@/provider-selection/model-catalog";

/**
 * A model + thinking field for plugin sheets (paseo-bots' compaction model). The model opens the
 * app's own picker, so a Pi-based provider gets the same Scoped / All lists as the composer.
 */
export function ModelPickerField({
  serverId,
  provider,
  modelId,
  thinkingId,
  onChange,
  label,
  thinkingLabel = "Thinking",
  disabled = false,
  testID,
}: ModelPickerFieldProps) {
  const snapshot = useProvidersSnapshot(serverId);
  const entry = useMemo(
    () => snapshot.entries?.find((candidate) => candidate.provider === provider) ?? null,
    [provider, snapshot.entries],
  );
  const providers = useMemo(
    () => (entry ? buildSelectableProviderSelectorProviders([entry]) : []),
    [entry],
  );
  const model = useMemo(
    () => findModelByReference(entry?.models ?? null, modelId),
    [entry?.models, modelId],
  );
  const thinkingOptions = useMemo(
    () =>
      (model?.thinkingOptions ?? []).map((option) => ({
        value: option.id,
        label: formatThinkingOptionLabel(option),
      })),
    [model?.thinkingOptions],
  );

  const handleSelect = useCallback(
    (_provider: string, nextModelId: string) => {
      const next = findModelByReference(entry?.models ?? null, nextModelId);
      const options = next?.thinkingOptions ?? [];
      const keep = thinkingId && options.some((option) => option.id === thinkingId);
      onChange({
        modelId: nextModelId,
        thinkingId: keep ? thinkingId : (next?.defaultThinkingOptionId ?? options[0]?.id ?? null),
      });
    },
    [entry?.models, onChange, thinkingId],
  );
  const handleThinking = useCallback(
    (next: string) => onChange({ modelId, thinkingId: next }),
    [modelId, onChange],
  );
  const handleOpen = useCallback(() => snapshot.refetchIfStale(provider), [provider, snapshot]);

  return (
    <View testID={testID}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.field}>
        <CombinedModelSelector
          providers={providers}
          selectedProvider={provider}
          selectedModel={modelId}
          onSelect={handleSelect}
          isLoading={snapshot.isLoading}
          onOpen={handleOpen}
          disabled={disabled}
          serverId={serverId}
          desktopPlacement="bottom-start"
          desktopMinWidth={360}
        />
      </View>
      {thinkingOptions.length > 0 ? (
        <SettingsSelect
          label={thinkingLabel}
          value={thinkingId ?? thinkingOptions[0]!.value}
          options={thinkingOptions}
          onValueChange={handleThinking}
          disabled={disabled}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[1],
  },
  field: {
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1],
  },
}));
