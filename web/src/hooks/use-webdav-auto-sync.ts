"use client";

import { useEffect, useRef } from "react";

import { isAppDataDirtySignalSuppressed, subscribeAppDataDirty } from "@/services/app-sync-events";
import { syncAppDataToWebdav } from "@/services/app-sync";
import { isWebdavAutoSyncRunnable, normalizeWebdavConfig, useConfigStore, webdavAutoSyncSignature, type WebdavSyncConfig } from "@/stores/use-config-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { useCanvasStore } from "@/app/(user)/canvas/stores/use-canvas-store";

const OPEN_SYNC_DELAY_MS = 1000;
const DIRTY_SYNC_DELAY_MS = 8000;
const RETRY_SYNC_DELAY_MS = 30000;
const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCK_KEY = "infinite-canvas:webdav_auto_sync_lock";
const CLIENT_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

type AutoSyncReason = "open" | "dirty" | "retry" | "visible" | "online";
type LockValue = {
    owner: string;
    expiresAt: number;
};

export function useWebdavAutoSync(enabled = true) {
    const webdav = useConfigStore((state) => state.webdav);
    const patchWebdavConfig = useConfigStore((state) => state.patchWebdavConfig);
    const canvasHydrated = useCanvasStore((state) => state.hydrated);
    const assetsHydrated = useAssetStore((state) => state.hydrated);
    const configRef = useRef(normalizeWebdavConfig(webdav));
    const runningRef = useRef(false);
    const dirtyRef = useRef(false);
    const openingSyncedSignatureRef = useRef("");
    const timerRef = useRef<number | null>(null);
    const mountedRef = useRef(false);

    useEffect(() => {
        configRef.current = normalizeWebdavConfig(webdav);
    }, [webdav]);

    const scheduleRef = useRef<(reason: AutoSyncReason, delay?: number) => void>(() => {});

    useEffect(() => {
        mountedRef.current = true;
        scheduleRef.current = (reason, delay = reason === "open" ? OPEN_SYNC_DELAY_MS : DIRTY_SYNC_DELAY_MS) => {
            if (!mountedRef.current || !enabled) return;
            if (timerRef.current) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
                timerRef.current = null;
                void runAutoSync(reason);
            }, delay);
        };

        const runAutoSync = async (reason: AutoSyncReason): Promise<void> => {
            if (!mountedRef.current || !enabled) return;
            if (!canRunAutoSync(configRef.current, canvasHydrated, assetsHydrated)) return;
            if (runningRef.current) {
                dirtyRef.current = true;
                return;
            }
            if (reason !== "open" && document.visibilityState === "hidden") {
                dirtyRef.current = true;
                return;
            }
            if (!navigator.onLine) {
                dirtyRef.current = true;
                return;
            }
            if (!acquireAutoSyncLock()) {
                dirtyRef.current = true;
                scheduleRef.current("retry", RETRY_SYNC_DELAY_MS);
                return;
            }

            runningRef.current = true;
            dirtyRef.current = false;
            let retryScheduled = false;
            try {
                const result = await syncAppDataToWebdav(configRef.current);
                const syncedAt = result.syncedAt;
                patchWebdavConfig({ configuredAt: configRef.current.configuredAt || syncedAt, lastSyncedAt: syncedAt, lastAutoSyncedAt: syncedAt, lastAutoSyncError: "" });
            } catch (error) {
                patchWebdavConfig({ lastAutoSyncError: error instanceof Error ? error.message : "WebDAV 自动同步失败" });
                dirtyRef.current = true;
                scheduleRef.current("retry", RETRY_SYNC_DELAY_MS);
                retryScheduled = true;
            } finally {
                runningRef.current = false;
                releaseAutoSyncLock();
            }

            if (dirtyRef.current && mountedRef.current && !retryScheduled) scheduleRef.current("dirty", DIRTY_SYNC_DELAY_MS);
        };

        const unsubscribeDirty = subscribeAppDataDirty(() => {
            if (isAppDataDirtySignalSuppressed()) return;
            if (!canRunAutoSync(configRef.current, canvasHydrated, assetsHydrated)) return;
            dirtyRef.current = true;
            scheduleRef.current("dirty", DIRTY_SYNC_DELAY_MS);
        });

        const handleVisible = () => {
            if (document.visibilityState === "visible" && dirtyRef.current) scheduleRef.current("visible", 500);
        };
        const handleOnline = () => {
            if (dirtyRef.current) scheduleRef.current("online", 500);
        };
        document.addEventListener("visibilitychange", handleVisible);
        window.addEventListener("online", handleOnline);

        return () => {
            mountedRef.current = false;
            unsubscribeDirty();
            document.removeEventListener("visibilitychange", handleVisible);
            window.removeEventListener("online", handleOnline);
            if (timerRef.current) window.clearTimeout(timerRef.current);
            timerRef.current = null;
            if (runningRef.current) releaseAutoSyncLock();
        };
    }, [assetsHydrated, canvasHydrated, enabled, patchWebdavConfig]);

    useEffect(() => {
        if (!enabled) return;
        if (!canRunAutoSync(configRef.current, canvasHydrated, assetsHydrated)) return;
        const signature = webdavAutoSyncSignature(configRef.current);
        if (openingSyncedSignatureRef.current === signature) return;
        openingSyncedSignatureRef.current = signature;
        dirtyRef.current = true;
        scheduleRef.current("open", OPEN_SYNC_DELAY_MS);
    }, [assetsHydrated, canvasHydrated, enabled, webdav]);
}

function canRunAutoSync(config: WebdavSyncConfig, canvasHydrated: boolean, assetsHydrated: boolean) {
    return Boolean(canvasHydrated && assetsHydrated && isWebdavAutoSyncRunnable(config) && typeof window !== "undefined");
}

function acquireAutoSyncLock() {
    const now = Date.now();
    try {
        const raw = window.localStorage.getItem(LOCK_KEY);
        const current = raw ? (JSON.parse(raw) as LockValue) : null;
        if (current?.owner && current.owner !== CLIENT_ID && current.expiresAt > now) return false;
        window.localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: CLIENT_ID, expiresAt: now + LOCK_TTL_MS }));
        const latest = JSON.parse(window.localStorage.getItem(LOCK_KEY) || "{}") as Partial<LockValue>;
        return latest.owner === CLIENT_ID;
    } catch {
        return true;
    }
}

function releaseAutoSyncLock() {
    try {
        const raw = window.localStorage.getItem(LOCK_KEY);
        const current = raw ? (JSON.parse(raw) as LockValue) : null;
        if (current?.owner === CLIENT_ID) window.localStorage.removeItem(LOCK_KEY);
    } catch {
        // Ignore storage failures; the TTL will clear stale ownership.
    }
}
