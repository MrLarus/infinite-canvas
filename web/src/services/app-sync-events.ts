"use client";

export type AppDataDirtyReason = "canvas" | "assets" | "image-workbench" | "video-workbench" | "manual";
type AppDataDirtyListener = (reason: AppDataDirtyReason) => void;

const listeners = new Set<AppDataDirtyListener>();
let suppressDirtySignalDepth = 0;

export function markAppDataDirty(reason: AppDataDirtyReason = "manual") {
    if (isAppDataDirtySignalSuppressed()) return;
    listeners.forEach((listener) => listener(reason));
}

export function subscribeAppDataDirty(listener: AppDataDirtyListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function isAppDataDirtySignalSuppressed() {
    return suppressDirtySignalDepth > 0;
}

export async function runWithoutAppDataDirtySignal<T>(task: () => Promise<T>) {
    suppressDirtySignalDepth += 1;
    try {
        return await task();
    } finally {
        suppressDirtySignalDepth -= 1;
    }
}
