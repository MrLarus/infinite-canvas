export const videoSizeOptions = [
    { value: "1280x720", label: "横屏", width: 1280, height: 720 },
    { value: "720x1280", label: "竖屏", width: 720, height: 1280 },
    { value: "1024x1024", label: "方形", width: 1024, height: 1024 },
    { value: "1792x1024", label: "宽屏", width: 1792, height: 1024 },
    { value: "1024x1792", label: "长图", width: 1024, height: 1792 },
    { value: "auto", label: "auto", width: 0, height: 0 },
] as const;

export function normalizeVideoSizeValue(value: string) {
    const size = String(value || "").trim();
    if (!size || size === "auto" || size === "adaptive") return "auto";
    if (/^\d+x\d+$/.test(size)) return size;
    if (size === "1:1") return "1024x1024";
    if (["9:16", "2:3", "3:4"].includes(size)) return "720x1280";
    if (["16:9", "3:2", "4:3"].includes(size)) return "1280x720";
    return "1280x720";
}

export function normalizeVideoSizeParam(value: string) {
    const size = normalizeVideoSizeValue(value);
    return size === "auto" ? null : size;
}
