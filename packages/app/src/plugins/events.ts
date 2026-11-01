import type { PluginCleanup } from "@getpaseo/plugin";

type Listener = (data: unknown) => void;

/**
 * Events a plugin's server pushes to this installation (server_info.features.pluginEvents).
 * `live` is true once this app is subscribed to them on the host; a plugin can use it to drop
 * its polling. Events missed while not live are not replayed: plugins refetch when they connect.
 */
export class PluginEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private liveListeners = new Set<(live: boolean) => void>();
  private isLive = false;

  get live(): boolean {
    return this.isLive;
  }

  setLive(live: boolean): void {
    if (this.isLive === live) return;
    this.isLive = live;
    for (const listener of Array.from(this.liveListeners)) listener(live);
  }

  dispatch(name: string, data: unknown): void {
    for (const listener of Array.from(this.listeners.get(name) ?? [])) {
      try {
        listener(data);
      } catch (error) {
        console.warn(`[Plugins] Event listener for ${name} failed`, error);
      }
    }
  }

  on(name: string, listener: Listener): PluginCleanup {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(name) === set) this.listeners.delete(name);
    };
  }

  onLiveChange(listener: (live: boolean) => void): PluginCleanup {
    this.liveListeners.add(listener);
    return () => {
      this.liveListeners.delete(listener);
    };
  }

  clear(): void {
    this.listeners.clear();
    this.liveListeners.clear();
    this.isLive = false;
  }
}
