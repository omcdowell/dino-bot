import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ArrowUp, Folder } from "lucide-react-native";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FlatList, Pressable, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { WORKSPACE_TREE_ICON_SIZE } from "@/components/tree-primitives";
import { useFetchQuery } from "@/data/query";
import type { Theme } from "@/styles/theme";
import {
  folderEntryPath,
  parentFolderPath,
  sortFolderEntries,
  type FolderListingEntry,
} from "./folder-listing-model";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedFolder = withUnistyles(Folder);
const ThemedArrowUp = withUnistyles(ArrowUp);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface FolderRow {
  key: string;
  name: string;
  kind: FolderListingEntry["kind"] | "parent";
  path: string;
}

function keyForRow(row: FolderRow): string {
  return row.key;
}

/**
 * A file tab that points at a folder lists the folder. Tapping a row opens it in the same tab
 * (`onOpenPath`); folders keep listing, files open as usual.
 */
export function FolderListing({
  client,
  cwd,
  path,
  onOpenPath,
}: {
  client: DaemonClient;
  cwd: string;
  path: string;
  onOpenPath?: (path: string) => void;
}) {
  const { t } = useTranslation();
  const query = useFetchQuery({
    queryKey: ["filePaneFolderListing", cwd, path],
    queryFn: () => client.listDirectory(cwd, path),
    dataShape: "value",
    staleTimeMs: 0,
    retry: 0,
  });

  const rows = useMemo<FolderRow[]>(() => {
    const entries = query.data ? sortFolderEntries(query.data.entries) : [];
    const parent = parentFolderPath(path);
    return [
      ...(parent ? [{ key: "..", name: "..", kind: "parent" as const, path: parent }] : []),
      ...entries.map((entry) => ({
        key: entry.name,
        name: entry.name,
        kind: entry.kind,
        path: folderEntryPath(path, entry.name),
      })),
    ];
  }, [path, query.data]);

  const { refetch } = query;
  const handleRetry = useCallback(() => {
    void refetch();
  }, [refetch]);

  const renderRow = useCallback<ListRenderItem<FolderRow>>(
    ({ item }) => <FolderRowItem row={item} onOpenPath={onOpenPath} />,
    [onOpenPath],
  );

  if (query.isPending) {
    return (
      <View style={styles.centerState} testID="file-pane-folder-loading">
        <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
      </View>
    );
  }

  if (query.isError) {
    return (
      <View style={styles.centerState} testID="file-pane-folder-error">
        <Text style={styles.errorText}>
          {query.error instanceof Error ? query.error.message : t("panels.file.failedToLoadFolder")}
        </Text>
        <Button variant="outline" size="sm" onPress={handleRetry} loading={query.isFetching}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="file-pane-folder">
      <Text style={styles.header} numberOfLines={1}>
        {path}
      </Text>
      {rows.length === 0 ? (
        <Text style={styles.emptyText}>{t("panels.file.folderEmpty")}</Text>
      ) : (
        <FlatList data={rows} keyExtractor={keyForRow} renderItem={renderRow} />
      )}
    </View>
  );
}

function FolderRowIcon({ row }: { row: FolderRow }) {
  if (row.kind === "parent") {
    return <ThemedArrowUp size={WORKSPACE_TREE_ICON_SIZE} uniProps={mutedColorMapping} />;
  }
  if (row.kind === "directory") {
    return <ThemedFolder size={WORKSPACE_TREE_ICON_SIZE} uniProps={mutedColorMapping} />;
  }
  return <MaterialFileIcon fileName={row.name} size={WORKSPACE_TREE_ICON_SIZE} />;
}

const FolderRowItem = memo(function FolderRowItem({
  row,
  onOpenPath,
}: {
  row: FolderRow;
  onOpenPath?: (path: string) => void;
}) {
  const handlePress = useCallback(() => {
    onOpenPath?.(row.path);
  }, [onOpenPath, row.path]);
  return (
    <Pressable
      style={styles.row}
      disabled={!onOpenPath}
      onPress={handlePress}
      accessibilityRole="button"
      testID={`file-pane-folder-row-${row.name}`}
    >
      <View style={styles.icon}>
        <FolderRowIcon row={row} />
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {row.name}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  icon: {
    width: WORKSPACE_TREE_ICON_SIZE,
    height: WORKSPACE_TREE_ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  name: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  emptyText: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
