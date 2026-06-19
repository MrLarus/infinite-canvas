"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { apiGet } from "@/services/api/request";
import type { AdminPublicSettings } from "@/services/api/admin";

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    quality: string;
    size: string;
    imageSize: string;
    videoSize: string;
    rememberLastImageSize: string;
    rememberLastVideoSize: string;
    count: string;
    canvasImageCount: string;
};

export type WebdavSyncConfig = {
    autoSyncEnabled: boolean;
    proxyMode: "direct" | "nextjs";
    url: string;
    username: string;
    password: string;
    directory: string;
    configuredAt: string;
    lastSyncedAt: string;
    lastAutoSyncedAt: string;
    lastAutoSyncError: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
export type ModelCapability = "image" | "video" | "text" | "audio";

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    model: "gpt-image-2",
    imageModel: "gpt-image-2",
    videoModel: "grok-imagine-video",
    textModel: "gpt-5.5",
    audioModel: "gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "6",
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    models: [],
    imageModels: [],
    videoModels: [],
    textModels: [],
    audioModels: [],
    quality: "auto",
    size: "auto",
    imageSize: "auto",
    videoSize: "auto",
    rememberLastImageSize: "true",
    rememberLastVideoSize: "true",
    count: "1",
    canvasImageCount: "3",
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    autoSyncEnabled: true,
    proxyMode: "nextjs",
    url: "https://dav.stsh.top/dav",
    username: "",
    password: "",
    directory: "default",
    configuredAt: "",
    lastSyncedAt: "",
    lastAutoSyncedAt: "",
    lastAutoSyncError: "",
};

export function resolveImageSize(config: Pick<AiConfig, "imageSize" | "size">) {
    return config.imageSize || config.size || defaultConfig.imageSize;
}

export type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

export function rememberLastImageGenerationSettings(
    config: Pick<AiConfig, "rememberLastImageSize" | "size" | "quality" | "count">,
    updateConfig: UpdateAiConfig,
    options: { countKey?: "count" | "canvasImageCount"; count?: string | number; rememberCount?: boolean } = {},
) {
    if (config.rememberLastImageSize === "false") return;
    const size = (config.size || "").trim();
    const quality = (config.quality || "").trim();
    const count = String(options.count ?? config.count ?? "").trim();
    if (size) updateConfig("imageSize", size);
    if (quality) updateConfig("quality", quality);
    if (options.rememberCount !== false && count) updateConfig(options.countKey || "count", count);
}

export function resolveVideoSize(config: Pick<AiConfig, "videoSize" | "size">) {
    return config.videoSize || config.size || defaultConfig.videoSize;
}

const WEBDAV_TRIM_KEYS = new Set<keyof WebdavSyncConfig>(["url", "username", "password", "directory", "configuredAt", "lastSyncedAt", "lastAutoSyncedAt", "lastAutoSyncError"]);
const WEBDAV_EDGE_INVISIBLE_PATTERN = /^[\s\uFEFF\xA0\u180E\u200B-\u200D\u2060]+|[\s\uFEFF\xA0\u180E\u200B-\u200D\u2060]+$/g;

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    publicSettings: AdminPublicSettings | null;
    isPublicSettingsLoading: boolean;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    patchWebdavConfig: (patch: Partial<WebdavSyncConfig>) => void;
    loadPublicSettings: () => Promise<void>;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

function resolveEffectiveConfig(config: AiConfig, modelChannel: AdminPublicSettings["modelChannel"] | null) {
    const channelMode = modelChannel?.allowCustomChannel ? config.channelMode : "remote";
    if (channelMode === "local" || !modelChannel) return { ...config, channelMode };
    const models = modelChannel.availableModels;
    const textModels = filterModelsByCapability(models, "text");
    const imageModels = filterModelsByCapability(models, "image");
    const videoModels = filterModelsByCapability(models, "video");
    const audioModels = filterModelsByCapability(models, "audio");
    const fallbackTextModel = validDefault(modelChannel.defaultTextModel, textModels) || preferredModel(textModels, isTextModelName);
    const fallbackModel = validDefault(modelChannel.defaultModel, textModels) || fallbackTextModel;
    const fallbackImageModel = validDefault(modelChannel.defaultImageModel, imageModels) || preferredModel(imageModels, isImageModelName);
    const fallbackVideoModel = validDefault(modelChannel.defaultVideoModel, videoModels) || preferredModel(videoModels, isVideoModelName);
    const fallbackAudioModel = preferredModel(audioModels, isAudioModelName);
    return {
        ...config,
        channelMode,
        models,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        model: textModels.includes(config.model) ? config.model : fallbackModel,
        imageModel: imageModels.includes(config.imageModel) ? config.imageModel : fallbackImageModel,
        videoModel: videoModels.includes(config.videoModel) ? config.videoModel : fallbackVideoModel,
        textModel: textModels.includes(config.textModel) ? config.textModel : fallbackTextModel || fallbackModel,
        audioModel: audioModels.includes(config.audioModel) ? config.audioModel : fallbackAudioModel,
        systemPrompt: modelChannel.systemPrompt,
    };
}

function validDefault(model: string, models: string[]) {
    return models.includes(model) ? model : "";
}

function preferredModel(models: string[], predicate: (model: string) => boolean) {
    return models.find(predicate) || "";
}

function isVideoModelName(model: string) {
    const value = model.toLowerCase();
    return value.includes("seedance") || value.includes("video") || value.includes("sora") || value.includes("veo") || value.includes("omni") || value.includes("kling") || value.includes("wan") || value.includes("hailuo");
}

function isImageModelName(model: string) {
    const value = model.toLowerCase();
    return (
        !isVideoModelName(model) &&
        !isAudioModelName(model) &&
        (value.includes("seedream") ||
            value.includes("gpt-image") ||
            value.includes("image") ||
            value.includes("dall-e") ||
            value.includes("dalle") ||
            value.includes("imagen") ||
            value.includes("flux") ||
            value.includes("sdxl") ||
            value.includes("stable-diffusion") ||
            value.includes("midjourney") ||
            value.includes("nano_banana") ||
            value.includes("banana"))
    );
}

function isAudioModelName(model: string) {
    const value = model.toLowerCase();
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice") || value.includes("music") || value.includes("sound");
}

function isTextModelName(model: string) {
    return !isImageModelName(model) && !isVideoModelName(model) && !isAudioModelName(model);
}

export function modelMatchesCapability(model: string, capability?: ModelCapability) {
    if (!capability) return true;
    if (capability === "image") return isImageModelName(model);
    if (capability === "video") return isVideoModelName(model);
    if (capability === "audio") return isAudioModelName(model);
    return isTextModelName(model);
}

export function filterModelsByCapability(models: string[], capability?: ModelCapability) {
    return capability ? models.filter((model) => modelMatchesCapability(model, capability)) : models;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config[modelListKey(capability)];
}

export function normalizeModelOptionValue(value: string | undefined, options: string[] = []) {
    const model = (value || "").trim();
    if (!model) return "";
    const models = normalizeModelList(options);
    if (!models.length) return model;
    const exact = models.find((item) => item === model);
    if (exact) return exact;
    const modelKey = modelOptionSearchKey(model);
    return models.find((item) => modelOptionSearchKey(item) === modelKey) || "";
}

function modelListKey(capability: ModelCapability) {
    return `${capability}Models` as "imageModels" | "videoModels" | "textModels" | "audioModels";
}

function isAiConfigReady(config: AiConfig, model: string) {
    return Boolean(model.trim()) && (config.channelMode === "remote" || Boolean(config.baseUrl.trim() && config.apiKey.trim()));
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            publicSettings: null,
            isPublicSettingsLoading: false,
            isConfigOpen: false,
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: normalizeWebdavValue(key, value),
                    },
                })),
            patchWebdavConfig: (patch) =>
                set((state) => ({
                    webdav: normalizeWebdavConfig({
                        ...state.webdav,
                        ...patch,
                    }),
                })),
            loadPublicSettings: async () => {
                if (get().isPublicSettingsLoading) return;
                set({ isPublicSettingsLoading: true });
                try {
                    set({ publicSettings: await apiGet<AdminPublicSettings>("/api/settings") });
                } finally {
                    set({ isPublicSettingsLoading: false });
                }
            },
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                const config = { ...defaultConfig, ...persistedConfig };
                const legacySize = persistedConfig.size || defaultConfig.size;
                return {
                    ...current,
                    webdav: normalizeWebdavConfig({ ...defaultWebdavSyncConfig, ...persistedWebdav }),
                    config: {
                        ...config,
                        channelMode: config.channelMode || "remote",
                        imageModel: config.imageModel || config.model,
                        videoModel: config.videoModel || "grok-imagine-video",
                        textModel: config.textModel || config.model,
                        audioModel: config.audioModel || defaultConfig.audioModel,
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        audioInstructions: config.audioInstructions || "",
                        videoSeconds: config.videoSeconds || "6",
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || "true",
                        videoWatermark: config.videoWatermark || "false",
                        canvasImageCount: config.canvasImageCount || "3",
                        imageSize: config.imageSize || legacySize,
                        videoSize: config.videoSize || legacySize,
                        size: config.size || legacySize,
                        rememberLastImageSize: config.rememberLastImageSize === "false" ? "false" : "true",
                        rememberLastVideoSize: config.rememberLastVideoSize === "false" ? "false" : "true",
                        imageModels: Array.isArray(persistedConfig.imageModels) ? normalizeModelList(config.imageModels) : filterModelsByCapability(config.models, "image"),
                        videoModels: Array.isArray(persistedConfig.videoModels) ? normalizeModelList(config.videoModels) : filterModelsByCapability(config.models, "video"),
                        textModels: Array.isArray(persistedConfig.textModels) ? normalizeModelList(config.textModels) : filterModelsByCapability(config.models, "text"),
                        audioModels: Array.isArray(persistedConfig.audioModels) ? normalizeModelList(config.audioModels) : filterModelsByCapability(config.models, "audio"),
                    },
                };
            },
        },
    ),
);

function normalizeModelList(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

function modelOptionSearchKey(value: string) {
    return value
        .trim()
        .replace(/^[`"']+|[`"']+$/g, "")
        .toLowerCase()
        .replace(/[\s_-]+/g, "");
}

export function normalizeWebdavConfig(config: WebdavSyncConfig | Partial<WebdavSyncConfig>): WebdavSyncConfig {
    const proxyMode: WebdavSyncConfig["proxyMode"] = config.proxyMode === "nextjs" ? "nextjs" : "direct";
    return {
        ...defaultWebdavSyncConfig,
        ...config,
        autoSyncEnabled: config.autoSyncEnabled !== false,
        proxyMode,
        url: normalizeWebdavText(config.url),
        username: normalizeWebdavText(config.username),
        password: normalizeWebdavPassword(config.password),
        directory: normalizeWebdavPath(config.directory),
        configuredAt: normalizeWebdavText(config.configuredAt),
        lastSyncedAt: normalizeWebdavText(config.lastSyncedAt),
        lastAutoSyncedAt: normalizeWebdavText(config.lastAutoSyncedAt),
        lastAutoSyncError: normalizeWebdavText(config.lastAutoSyncError),
    };
}

export function isWebdavAutoSyncRunnable(config: WebdavSyncConfig | Partial<WebdavSyncConfig>) {
    const webdav = normalizeWebdavConfig(config);
    return Boolean(webdav.autoSyncEnabled && webdav.url && (webdav.configuredAt || webdav.lastSyncedAt || webdav.username || webdav.password));
}

export function webdavAutoSyncSignature(config: WebdavSyncConfig | Partial<WebdavSyncConfig>) {
    const webdav = normalizeWebdavConfig(config);
    return JSON.stringify({
        autoSyncEnabled: webdav.autoSyncEnabled,
        proxyMode: webdav.proxyMode,
        url: webdav.url,
        username: webdav.username,
        password: webdav.password,
        directory: webdav.directory,
    });
}

export function normalizeWebdavValue<K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) {
    if (!WEBDAV_TRIM_KEYS.has(key)) return value;
    if (typeof value !== "string") return value;
    if (key === "directory") return normalizeWebdavPath(value) as WebdavSyncConfig[K];
    if (key === "password") return normalizeWebdavPassword(value) as WebdavSyncConfig[K];
    return normalizeWebdavText(value) as WebdavSyncConfig[K];
}

function normalizeWebdavText(value: unknown) {
    return typeof value === "string" ? value.replace(WEBDAV_EDGE_INVISIBLE_PATTERN, "") : "";
}

function normalizeWebdavPassword(value: unknown) {
    return normalizeWebdavText(value);
}

function normalizeWebdavPath(value: unknown) {
    return normalizeWebdavText(value).replace(/^\/+|\/+$/g, "");
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    const modelChannel = useConfigStore((state) => state.publicSettings?.modelChannel || null);
    return useMemo(() => resolveEffectiveConfig(config, modelChannel), [config, modelChannel]);
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const isVersioned =
        lowerBaseUrl.endsWith("/v1") ||
        lowerBaseUrl.endsWith("/api/v3") ||
        lowerBaseUrl.endsWith("/api/plan/v3") ||
        lowerBaseUrl.endsWith("/api/coding/paas/v4") ||
        lowerBaseUrl.endsWith("/api/paas/v4");
    const apiBaseUrl = isVersioned ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}
