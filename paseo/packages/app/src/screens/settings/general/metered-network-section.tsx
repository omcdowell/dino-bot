import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@/components/settings";
import { useAppSettings } from "@/hooks/use-settings";

/** Desktop: a laptop on a phone hotspot looks like Wi-Fi, so let the owner say it is metered. */
export function MeteredNetworkSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const change = useCallback(
    (meteredNetwork: boolean) => void updateSettings({ meteredNetwork }),
    [updateSettings],
  );
  return (
    <SettingsSection title={t("settings.general.network")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("settings.general.meteredNetwork.label")}
          hint={t("settings.general.meteredNetwork.hint")}
          value={settings.meteredNetwork}
          onValueChange={change}
          testID="settings-metered-network"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
