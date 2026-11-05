import { isNative } from "@/constants/platform";

/**
 * Words for the device the app runs on. The setup and pairing copy was written for the phone; the
 * desktop app (Electron, the same web build) shows the same screens on a computer.
 */
export interface DeviceCopy {
  /** "this phone" / "this computer". */
  thisDevice: string;
  /** "this phone" / "this app": what never holds a sign-in (the desktop app may share the computer). */
  thisApp: string;
  /** "Tap" / "Click". */
  press: string;
}

export function deviceCopyFor(native: boolean): DeviceCopy {
  return native
    ? { thisDevice: "this phone", thisApp: "this phone", press: "Tap" }
    : { thisDevice: "this computer", thisApp: "this app", press: "Click" };
}

export const DEVICE_COPY: DeviceCopy = deviceCopyFor(isNative);
