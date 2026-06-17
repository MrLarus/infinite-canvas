import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { APP_VERSION } from "@/constant/env";
import { parseChangelog, type ReleaseInfo } from "@/lib/release";

const latestVersionUrl = "https://raw.githubusercontent.com/MrLarus/infinite-canvas/otuapi-async-image/VERSION";
const latestChangelogUrl = "https://raw.githubusercontent.com/MrLarus/infinite-canvas/otuapi-async-image/CHANGELOG.md";
const upstreamBranchUrl = "https://api.github.com/repos/basketikun/infinite-canvas/branches/main";
const reviewedUpstreamSha = "8cbe00e3486eec00bcaf21a7c5e55fefddf28500";

export type UpstreamAuditStatus = {
    latestSha: string;
    reviewedSha: string;
    needsAudit: boolean;
    checked: boolean;
    error: boolean;
};

function readLocalReleases(): ReleaseInfo[] {
    try {
        return JSON.parse(process.env.NEXT_PUBLIC_APP_RELEASES || "[]");
    } catch {
        return [];
    }
}

function toVersionParts(version: string) {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function isNewerVersion(latestVersion: string, currentVersion: string) {
    const latest = toVersionParts(latestVersion);
    const current = toVersionParts(currentVersion);
    if (!latest || !current) return false;
    return latest.some((value, index) => value > current[index] && latest.slice(0, index).every((part, prevIndex) => part === current[prevIndex]));
}

export function useVersionCheck() {
    const currentVersion = APP_VERSION;
    const { message } = App.useApp();
    const localReleases = useMemo(readLocalReleases, []);
    const [latestVersion, setLatestVersion] = useState(currentVersion);
    const [releases, setReleases] = useState<ReleaseInfo[]>(localReleases);
    const [upstreamAuditStatus, setUpstreamAuditStatus] = useState<UpstreamAuditStatus>({
        latestSha: "",
        reviewedSha: reviewedUpstreamSha,
        needsAudit: false,
        checked: false,
        error: false,
    });
    const [checking, setChecking] = useState(false);
    const [open, setOpen] = useState(false);
    const hasNewVersion = isNewerVersion(latestVersion, currentVersion);
    const hasNotice = hasNewVersion || upstreamAuditStatus.needsAudit;

    const checkLatestVersion = useCallback(async () => {
        try {
            const response = await fetch(latestVersionUrl);
            if (!response.ok) return false;
            const version = await response.text();
            setLatestVersion(version.trim() || currentVersion);
            return true;
        } catch {
            return false;
        }
    }, [currentVersion]);

    const checkUpstreamAuditStatus = useCallback(async () => {
        try {
            const response = await fetch(upstreamBranchUrl, { headers: { Accept: "application/vnd.github+json" } });
            if (!response.ok) throw new Error("上游状态读取失败");
            const data = (await response.json()) as { commit?: { sha?: string } };
            const latestSha = data.commit?.sha || "";
            setUpstreamAuditStatus({
                latestSha,
                reviewedSha: reviewedUpstreamSha,
                needsAudit: Boolean(latestSha && latestSha !== reviewedUpstreamSha),
                checked: true,
                error: false,
            });
            return true;
        } catch {
            setUpstreamAuditStatus((current) => ({ ...current, checked: true, error: true }));
            return false;
        }
    }, []);

    const checkLatestRelease = useCallback(
        async (showMessage = false) => {
            setChecking(true);
            try {
                const [versionResponse, changelogResponse] = await Promise.all([fetch(latestVersionUrl), fetch(latestChangelogUrl), checkUpstreamAuditStatus()]);
                if (!versionResponse.ok) throw new Error("版本读取失败");
                if (!changelogResponse.ok) throw new Error("更新日志读取失败");
                const [version, changelog] = await Promise.all([versionResponse.text(), changelogResponse.text()]);
                setLatestVersion(version.trim() || currentVersion);
                if (changelog.trim()) setReleases(parseChangelog(changelog));
                if (showMessage) message.success("已获取最新版本信息");
                return true;
            } catch {
                setLatestVersion(currentVersion);
                setReleases(localReleases);
                if (showMessage) message.error("获取最新版本信息失败");
                return false;
            } finally {
                setChecking(false);
            }
        },
        [checkUpstreamAuditStatus, currentVersion, localReleases, message],
    );

    useEffect(() => {
        void checkLatestVersion();
        void checkUpstreamAuditStatus();
    }, [checkLatestVersion, checkUpstreamAuditStatus]);

    const openReleaseModal = useCallback(() => {
        setOpen(true);
        void checkLatestRelease();
    }, [checkLatestRelease]);

    return {
        open,
        setOpen,
        openReleaseModal,
        latestVersion,
        releases,
        checking,
        hasNewVersion,
        hasNotice,
        upstreamAuditStatus,
        checkLatestRelease,
    };
}
