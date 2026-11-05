import { useCallback, useEffect, useRef } from "react";
import type { PluginDictation, PluginDictationOptions } from "@getpaseo/plugin/client/react-native";
import { DictationOverlay } from "@/components/dictation-controls";
import { useToast as useAppToast } from "@/contexts/toast-api-context";
import { useDictation } from "@/hooks/use-dictation";
import { useIsDictationReady } from "@/hooks/use-is-dictation-ready";
import {
  useHostRuntimeAgentDirectoryStatus,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { resolveVoiceUnavailableMessage } from "@/utils/server-info-capabilities";
import { computeCanStartDictation } from "@/composer/input/state";

/**
 * The app's dictation (mic → host speech-to-text → text) for plugin screens, wired the way the
 * agent composer wires it: same readiness rule, same unavailable message, same audio engine.
 * The plugin renders `DictationOverlay` in place of its input while `status` is not "idle".
 */
export function usePluginDictation(options: PluginDictationOptions): PluginDictation {
  const { serverId } = options;
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const agentDirectoryStatus = useHostRuntimeAgentDirectoryStatus(serverId);
  const isReadyForDictation = useIsDictationReady({ serverId, isConnected, agentDirectoryStatus });
  const serverInfo = useSessionStore(
    useCallback((state) => state.sessions[serverId]?.serverInfo ?? null, [serverId]),
  );
  const unavailableMessage = resolveVoiceUnavailableMessage({ serverInfo, mode: "dictation" });
  const toast = useAppToast();

  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const onTranscript = useCallback((text: string) => optionsRef.current.onTranscript(text), []);
  const onError = useCallback(
    (error: Error) => {
      const handler = optionsRef.current.onError;
      if (handler) handler(error);
      else toast.error(error.message);
    },
    [toast],
  );

  const canStart = useCallback(
    () =>
      computeCanStartDictation({
        client,
        isReadyForDictation,
        disabled: false,
        dictationUnavailableMessage: unavailableMessage,
      }),
    [client, isReadyForDictation, unavailableMessage],
  );
  const canConfirm = useCallback(() => client?.isConnected ?? false, [client]);

  const dictation = useDictation({
    client,
    onTranscript,
    onError,
    canStart,
    canConfirm,
    enableDuration: true,
  });
  const { startDictation } = dictation;

  const start = useCallback(async () => {
    if (unavailableMessage) {
      toast.error(unavailableMessage);
      return;
    }
    if (!canStart()) return;
    await startDictation();
  }, [canStart, startDictation, toast, unavailableMessage]);

  return {
    ready: isReadyForDictation && !unavailableMessage,
    unavailableMessage,
    status: dictation.status,
    volume: dictation.volume,
    duration: dictation.duration,
    isRecording: dictation.isRecording,
    isProcessing: dictation.isProcessing,
    error: dictation.error,
    start,
    cancel: dictation.cancelDictation,
    confirm: dictation.confirmDictation,
    retry: dictation.retryFailedDictation,
    discard: dictation.discardFailedDictation,
  };
}

export { DictationOverlay };
