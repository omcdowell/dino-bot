import type {
  ComponentType,
  FunctionComponent,
  ReactNode,
  ForwardRefExoticComponent,
  RefAttributes,
  ReactElement,
  Ref,
} from "react";
import type {
  StyleProp,
  ViewStyle,
  ScrollView as NativeScrollView,
  ScrollViewProps,
  FlatList as NativeFlatList,
  FlatListProps,
  TextInput as NativeTextInput,
  TextInputProps,
} from "react-native";
import type { PluginIconProps } from "./contracts.js";

export interface ModalProps {
  title: string;
  icon?: ReactNode;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}

export interface ModalContentProps {
  children: ReactNode;
  /** Paint the full body below the header. */
  style?: StyleProp<ViewStyle>;
  /** Overrides the default 24px padding and 16px gap. Safe-area clearance stays host-owned. */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Default true. Set false for a bounded body with your own ScrollView or FlatList. */
  scrollable?: boolean;
}

export interface ModalComponent extends FunctionComponent<ModalProps> {
  Content: ComponentType<ModalContentProps>;
}

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";

export interface ToastOptions {
  variant?: ToastVariant;
  durationMs?: number;
}

export interface ToastApi {
  show(message: string, options?: ToastOptions): void;
  error(message: string): void;
}

export declare const Icon: ComponentType<PluginIconProps>;
export declare const Modal: ModalComponent;
export declare function useToast(): ToastApi;
export declare function useRevealedText(text: string, phase: "streaming" | "complete"): string;

export type { PluginIconProps } from "./contracts.js";

/** React Native scrolling with the host's sheet gestures when rendered inside a sheet. */
export declare const ScrollView: ForwardRefExoticComponent<
  ScrollViewProps & RefAttributes<NativeScrollView>
>;
export declare function FlatList<Item>(
  props: FlatListProps<Item> & { ref?: Ref<NativeFlatList<Item>> },
): ReactElement;
/** Copies text to this client's clipboard. Rejects when copying is unavailable or denied. */
export declare function copyText(text: string): Promise<void>;

/** Native input focus integrated with modal keyboard positioning. */
export declare const TextInput: ForwardRefExoticComponent<
  TextInputProps & RefAttributes<NativeTextInput>
>;

/** Host dictation state. "uploading" = recording stopped, transcribing on the host. */
export type PluginDictationStatus = "idle" | "recording" | "uploading" | "failed";

export interface PluginDictationOptions {
  /** The host that transcribes (the screen's `host.id`). */
  serverId: string;
  /** Called once per confirmed recording with the transcribed text. */
  onTranscript(text: string): void;
  /** Defaults to an error toast. */
  onError?(error: Error): void;
}

export interface PluginDictation {
  /** Connected and the host has dictation enabled. Hide or disable the mic when false. */
  ready: boolean;
  /** Why the host cannot dictate, when it says so; `start()` toasts it. */
  unavailableMessage: string | null;
  status: PluginDictationStatus;
  /** 0..1 microphone level while recording. */
  volume: number;
  /** Seconds recorded. */
  duration: number;
  isRecording: boolean;
  isProcessing: boolean;
  error: string | null;
  start(): Promise<void>;
  cancel(): Promise<void>;
  /** Stop recording and transcribe; the text arrives through `onTranscript`. */
  confirm(): Promise<void>;
  retry(): Promise<void>;
  discard(): void;
}

export interface DictationOverlayProps {
  volume: number;
  duration: number;
  isRecording: boolean;
  isProcessing: boolean;
  status: PluginDictationStatus;
  /** Shown when `status` is "failed". */
  errorText?: string;
  onCancel(): void;
  /** Insert the transcript. */
  onAccept(): void;
  /** Insert the transcript and send. */
  onAcceptAndSend(): void;
  onRetry?(): void;
  onDiscard?(): void;
}

/**
 * The app's dictation for a plugin composer. Missing on apps older than this API:
 * feature-detect it on the module namespace and hide the mic when absent.
 */
export declare function usePluginDictation(options: PluginDictationOptions): PluginDictation;
/** The agent composer's recording bar (cancel, level, timer, insert, insert + send). Renders nothing while idle. */
export declare const DictationOverlay: ComponentType<DictationOverlayProps>;

export interface PluginPickImageOptions {
  /** Crop to a square in the picker (where the platform supports it). Default true. */
  square?: boolean;
  /** Longest side of the returned PNG, in pixels. Default 512. */
  maxSize?: number;
}

export interface PluginPickedImage {
  /** `data:image/png;base64,…` */
  dataUri: string;
  width: number;
  height: number;
}

/**
 * One image from the photo library, scaled down and re-encoded as PNG; null when cancelled. Throws
 * when photo access is denied. Missing on apps older than this API: feature-detect it.
 */
export declare function pickImage(
  options?: PluginPickImageOptions,
): Promise<PluginPickedImage | null>;

export type PluginHapticKind = "selection" | "light" | "medium" | "success" | "warning";
/** A short haptic tap on phones; nothing elsewhere. Missing on older apps: feature-detect it. */
export declare function haptic(kind?: PluginHapticKind): void;

export interface PluginSvgXmlProps {
  /** SVG markup. */
  xml: string;
  width?: number | string;
  height?: number | string;
}
/**
 * The app's react-native-svg `SvgXml` (plugins cannot bundle react-native-svg: its views are native and
 * registered once by the app). Missing on older apps: feature-detect it.
 */
export declare const SvgXml: ComponentType<PluginSvgXmlProps>;
