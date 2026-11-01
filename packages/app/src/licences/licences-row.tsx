/**
 * Settings -> About -> Licences (release/app): the product notice (public build), the app's own
 * licence (Apache-2.0, Paseo, Copyright (c) 2025-present Mohamed Boudra, modified by us), the host
 * software the installer sets up (bots and push plugins, pi-optchat, pi, herdr, Node), and every bundled
 * npm package's licence (scripts/gen-licences.mjs writes licences.generated.json).
 */
import { memo, useCallback, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, Text, View } from "react-native";
import type { ListRenderItem } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight, X } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import type { Theme } from "@/styles/theme";
import data from "./licences.generated.json";
import { APP_DISPLAY_NAME } from "@/constants/flavour";
import {
  electronRuntimeFromUserAgent,
  licenceRows,
  type LicenceData,
  type LicenceRow,
} from "./licences-model";
import { isPublicDesktopApp } from "@/desktop/public-desktop";
import { getDesktopHost } from "@/desktop/host";

/** The DinoBot desktop app lists its runtime (Electron, Chromium); the own build is unchanged. */
function electronRuntime() {
  if (!isPublicDesktopApp() || typeof navigator === "undefined") return null;
  return electronRuntimeFromUserAgent(navigator.userAgent);
}

function openChromiumNotices(): void {
  const invoke = getDesktopHost()?.invoke;
  if (invoke) void invoke("open_licence_file", { file: "chromium" }).catch(() => undefined);
}

const ThemedChevron = withUnistyles(ChevronRight);
const ThemedX = withUnistyles(X);
const foregroundColorMapping = (theme: Theme) => ({
  color: theme.colors.foreground,
});
const keyOf = (row: LicenceRow) => row.key;

export function LicencesRow() {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  return (
    <>
      <Pressable
        style={[settingsStyles.row, settingsStyles.rowBorder]}
        onPress={show}
        accessibilityRole="button"
        testID="settings-licences"
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Licences</Text>
          <Text style={settingsStyles.rowHint}>Open-source software in this app</Text>
        </View>
        <ThemedChevron size={16} uniProps={mutedIconColorMapping} />
      </Pressable>
      {open ? <LicencesModal onClose={hide} /> : null}
    </>
  );
}

const LicenceItem = memo(function LicenceItem({
  row,
  expanded,
  onToggle,
}: {
  row: LicenceRow;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const handlePress = useCallback(() => onToggle(row.key), [onToggle, row.key]);
  return (
    <Pressable onPress={handlePress} style={styles.item} testID={`licence-${row.key}`}>
      <Text style={styles.name}>{row.title}</Text>
      <Text style={styles.meta}>{row.subtitle}</Text>
      {row.copyright.map((line) => (
        <Text key={line} style={styles.meta}>
          {line}
        </Text>
      ))}
      {expanded && row.text ? <Text style={styles.text}>{row.text}</Text> : null}
      {expanded && row.file === "chromium" ? (
        <Pressable
          onPress={openChromiumNotices}
          accessibilityRole="button"
          testID="licence-open-chromium-notices"
        >
          <Text style={styles.link}>Open LICENSES.chromium.html</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
});

function LicencesModal({ onClose }: { onClose: () => void }) {
  const rows = useMemo(
    () => licenceRows(data as LicenceData, APP_DISPLAY_NAME, electronRuntime()),
    [],
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const toggle = useCallback(
    (key: string) => setExpanded((current) => (current === key ? null : key)),
    [],
  );
  const renderItem = useCallback<ListRenderItem<LicenceRow>>(
    ({ item }) => <LicenceItem row={item} expanded={expanded === item.key} onToggle={toggle} />,
    [expanded, toggle],
  );
  return (
    <Modal animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} visible>
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={styles.title}>Licences</Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={12}
          >
            <ThemedX size={20} uniProps={foregroundColorMapping} />
          </Pressable>
        </View>
        <FlatList
          data={rows}
          keyExtractor={keyOf}
          initialNumToRender={20}
          extraData={expanded}
          contentContainerStyle={styles.list}
          renderItem={renderItem}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheet: { flex: 1, backgroundColor: theme.colors.surface0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
  },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  list: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[8],
  },
  item: {
    paddingVertical: theme.spacing[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  name: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  text: {
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    marginTop: theme.spacing[2],
  },
  link: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    textDecorationLine: "underline",
    marginTop: theme.spacing[2],
  },
}));
