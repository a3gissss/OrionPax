// @mint-engine/watcher — go-live detection and pre-arm scheduling.
export { waitForGoLive, prearm, Watcher } from "./watcher.js";
export type { WatcherDeps, WatchOptions, GoLiveResult, ArmInfo, WatchHandle, Unsubscribe } from "./watcher.js";
export { sleep, waitUntil, preciseNow, jitteredBackoff } from "./timing.js";
