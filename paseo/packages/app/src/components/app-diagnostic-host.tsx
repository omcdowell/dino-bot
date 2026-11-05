import { AppDiagnosticSheet } from "@/components/app-diagnostic-sheet";
import { isElectronRuntime } from "@/desktop/host";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { resolveDisplayVersion, resolveNativeBuildNumber } from "@/utils/app-version";
import { formatDiagnosticAppVersion } from "@/utils/app-version-label";

export function AppDiagnosticHost() {
  const visible = useAppDiagnosticStore((state) => state.visible);
  const close = useAppDiagnosticStore((state) => state.close);

  return (
    <AppDiagnosticSheet
      visible={visible}
      onClose={close}
      appVersion={formatDiagnosticAppVersion(resolveDisplayVersion(), resolveNativeBuildNumber())}
      isDesktopApp={isElectronRuntime()}
    />
  );
}
