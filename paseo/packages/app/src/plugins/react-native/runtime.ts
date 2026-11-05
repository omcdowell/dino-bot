import { Icon } from "../icons";
import { Modal } from "./modal";
import { ScrollView, FlatList } from "./scroll-view";
import { TextInput } from "./text-input";
import { copyText } from "./clipboard";
import { useToast } from "./toast";
import { useRevealedText } from "@/hooks/use-revealed-text";
import { DictationOverlay, usePluginDictation } from "./lazy-dictation";
import { SvgXml, haptic, pickImage } from "./lazy-native";

export const pluginReactNativeRuntime = {
  Icon,
  Modal,
  ScrollView,
  FlatList,
  TextInput,
  copyText,
  useRevealedText,
  useToast,
  usePluginDictation,
  DictationOverlay,
  pickImage,
  haptic,
  SvgXml,
};
