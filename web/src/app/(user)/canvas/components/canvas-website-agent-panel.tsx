"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, PanelRightClose, Plus, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import { Button, Switch, Tooltip } from "antd";
import { motion } from "motion/react";
import { nanoid } from "nanoid";

import { requestToolResponse, type ResponseFunctionTool, type ResponseInputMessage, type ResponseToolCall } from "@/services/api/image";
import { canvasThemes } from "@/lib/canvas-theme";
import { useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { AgentChatComposer, AgentChatMessage, AgentPanelTabs, AgentWorkingMessage, type CanvasAgentChatMessage } from "./canvas-agent-chat-ui";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";

const PANEL_MOTION_MS = 500;
const PANEL_MOTION_SECONDS = PANEL_MOTION_MS / 1000;
const ONLINE_AGENT_MAX_STEPS = 4;
const ONLINE_AGENT_PROMPT =
    "你是 Infinite Canvas 网页内置在线画布 Agent。当前画布 JSON 会随用户消息提供。首轮必须调用工具：只读问题调用 canvas_get_state，需要改动画布时调用 canvas_apply_ops 或 canvas_run_generation。不要输出 JSON 给用户，不要编造执行结果。工具参数涉及已有节点时必须使用当前画布 JSON 中真实存在的 id；缺少必要 id 或用户意图不明确时直接说明需要用户明确选择或说明，不要猜测。工具返回结果后，再根据真实结果回答用户。";

const JSON_RECORD_SCHEMA = { type: "object", additionalProperties: true };
const POSITION_SCHEMA = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false };
const VIEWPORT_SCHEMA = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, k: { type: "number" } }, required: ["x", "y", "k"], additionalProperties: false };
const NODE_TYPE_SCHEMA = { type: "string", enum: ["image", "text", "config", "video", "audio"] };
const GENERATION_MODE_SCHEMA = { type: "string", enum: ["text", "image", "video", "audio"] };
const CANVAS_OP_SCHEMA = {
    type: "object",
    properties: {
        type: { type: "string", enum: ["add_node", "update_node", "delete_node", "delete_connections", "connect_nodes", "set_viewport", "select_nodes", "run_generation"] },
        id: { type: "string" },
        ids: { type: "array", items: { type: "string" } },
        nodeType: NODE_TYPE_SCHEMA,
        title: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        position: POSITION_SCHEMA,
        metadata: JSON_RECORD_SCHEMA,
        patch: JSON_RECORD_SCHEMA,
        all: { type: "boolean" },
        fromNodeId: { type: "string" },
        toNodeId: { type: "string" },
        viewport: VIEWPORT_SCHEMA,
        nodeId: { type: "string" },
        mode: GENERATION_MODE_SCHEMA,
        prompt: { type: "string" },
    },
    required: ["type"],
    additionalProperties: false,
};
const ONLINE_AGENT_TOOLS: ResponseFunctionTool[] = [
    toolDefinition("canvas_get_state", "读取当前网页画布的节点、连线、选区和视口。", {}),
    toolDefinition("canvas_get_selection", "读取当前网页画布选中的节点。", {}),
    toolDefinition(
        "canvas_apply_ops",
        "批量操作当前网页画布。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation。",
        { ops: { type: "array", items: CANVAS_OP_SCHEMA } },
        ["ops"],
        false,
    ),
    toolDefinition("canvas_run_generation", "触发指定节点生成，通常用于配置节点或文本/图片/视频/音频节点。", { nodeId: { type: "string" }, mode: GENERATION_MODE_SCHEMA, prompt: { type: "string" } }, ["nodeId"]),
];
const READ_TOOL_NAMES = new Set(["canvas_get_state", "canvas_get_selection"]);

type AgentTab = "chat" | "log";
type AgentLog = { id: string; time: string; title: string; data?: unknown };
type ToolResult = { ok: true; message: string; data?: unknown } | { ok: false; message: string; data?: unknown };
type ExecutedToolCall = { toolCallId: string; name: string; result: ToolResult };
type PendingToolContext = { messages: ResponseInputMessage[]; toolCalls: ResponseToolCall[]; assistantId: string; step: number };

type CanvasWebsiteAgentPanelProps = {
    snapshot: CanvasAgentSnapshot;
    onApplyOps: (ops?: CanvasAgentOp[]) => CanvasAgentSnapshot;
    onCollapse: () => void;
};

export function CanvasWebsiteAgentPanel({ snapshot, onApplyOps, onCollapse }: CanvasWebsiteAgentPanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const user = useUserStore((state) => state.user);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const [width, setWidth] = useState(520);
    const [closing, setClosing] = useState(false);
    const [resizing, setResizing] = useState(false);
    const [activeTab, setActiveTab] = useState<AgentTab>("chat");
    const [prompt, setPrompt] = useState("");
    const [running, setRunning] = useState(false);
    const [confirmTools, setConfirmTools] = useState(true);
    const [messages, setMessages] = useState<CanvasAgentChatMessage[]>([]);
    const [logs, setLogs] = useState<AgentLog[]>([]);
    const snapshotRef = useRef(snapshot);
    const pendingToolContextRef = useRef(new Map<string, PendingToolContext>());

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);

    const activeModel = effectiveConfig.textModel || effectiveConfig.model;
    const iconButtonStyle = { color: theme.node.muted };

    const addLog = (title: string, data?: unknown) => setLogs((prev) => [{ id: nanoid(), time: new Date().toLocaleTimeString(), title, data }, ...prev].slice(0, 80));
    const addMessage = (message: CanvasAgentChatMessage) => setMessages((prev) => [...prev, message]);
    const upsertMessage = (message: CanvasAgentChatMessage) => setMessages((prev) => (prev.some((item) => item.id === message.id) ? prev.map((item) => (item.id === message.id ? { ...item, ...message } : item)) : [...prev, message]));

    const submit = async () => {
        const text = prompt.trim();
        if (!text || running) return;
        const requestConfig = { ...effectiveConfig, model: activeModel };
        if (!isAiConfigReady(requestConfig, requestConfig.model)) {
            openConfigDialog(true);
            return;
        }
        const userMessage: CanvasAgentChatMessage = { id: nanoid(), role: "user", text };
        const assistantId = nanoid();
        const history = messages;
        addMessage(userMessage);
        setPrompt("");
        addLog("发送请求", { text, nodes: snapshotRef.current.nodes.length, connections: snapshotRef.current.connections.length });
        await runAgentStep(assistantId, buildAgentMessages(snapshotRef.current, history, text), 1, "required");
    };

    const runAgentStep = async (assistantId: string, inputMessages: ResponseInputMessage[], step: number, toolChoice: "auto" | "required") => {
        const requestConfig = { ...effectiveConfig, model: activeModel, systemPrompt: "" };
        try {
            setRunning(true);
            let streamed = "";
            const result = await requestToolResponse(requestConfig, inputMessages, ONLINE_AGENT_TOOLS, toolChoice, (text) => {
                streamed = text;
                if (text.trim()) upsertMessage({ id: assistantId, role: "assistant", text });
            });
            addLog(`模型回复 ${step}`, result);
            if (!result.toolCalls.length) {
                upsertMessage({ id: assistantId, role: "assistant", text: result.content || streamed || "没有返回内容。" });
                return;
            }
            const writable = result.toolCalls.filter((call) => !READ_TOOL_NAMES.has(call.function.name));
            if (confirmTools && writable.length) {
                upsertMessage({ id: assistantId, role: "assistant", text: result.content || streamed || "准备执行工具，等待确认。" });
                const toolMessageId = nanoid();
                pendingToolContextRef.current.set(toolMessageId, { messages: inputMessages, toolCalls: result.toolCalls, assistantId, step });
                addMessage({ id: toolMessageId, role: "tool", title: "确认工具调用", text: summarizeToolCalls(result.toolCalls), detail: { status: "pending", step, toolCalls: result.toolCalls } });
                addLog("等待确认", result.toolCalls);
                return;
            }
            await continueAfterToolCalls(assistantId, inputMessages, result.toolCalls, executeToolCalls(result.toolCalls), step);
        } catch (error) {
            addLog("请求失败", error instanceof Error ? error.message : error);
            addMessage({ id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            setRunning(false);
        }
    };

    const continueAfterToolCalls = async (assistantId: string, previousMessages: ResponseInputMessage[], toolCalls: ResponseToolCall[], toolResults: ExecutedToolCall[], step: number) => {
        addMessage({ id: nanoid(), role: "tool", title: "工具执行完成", text: toolResults.map((item) => item.result.message).join("\n"), detail: { status: "completed", step, toolCalls, results: toolResults } });
        addLog("工具执行结果", toolResults);
        const nextMessages: ResponseInputMessage[] = [...previousMessages, ...toolCalls.map(toolCallToResponseInput), ...toolResults.map((item) => ({ role: "tool" as const, tool_call_id: item.toolCallId, content: JSON.stringify(item.result) }))];
        if (step >= ONLINE_AGENT_MAX_STEPS) {
            upsertMessage({ id: assistantId, role: "assistant", text: toolResults.map((item) => item.result.message).join("\n") || "工具已执行。" });
            return;
        }
        await runAgentStep(assistantId, nextMessages, step + 1, "auto");
    };

    const approveTool = async (messageId: string) => {
        const context = pendingToolContextRef.current.get(messageId);
        if (!context || running) return;
        pendingToolContextRef.current.delete(messageId);
        upsertMessage({ id: messageId, role: "tool", title: "工具执行中", text: summarizeToolCalls(context.toolCalls), detail: { status: "running", toolCalls: context.toolCalls } });
        try {
            setRunning(true);
            const results = executeToolCalls(context.toolCalls);
            upsertMessage({ id: messageId, role: "tool", title: "工具执行完成", text: results.map((item) => item.result.message).join("\n"), detail: { status: "completed", toolCalls: context.toolCalls, results } });
            await continueAfterToolCalls(context.assistantId, context.messages, context.toolCalls, results, context.step);
        } catch (error) {
            addMessage({ id: nanoid(), role: "error", title: "操作失败", text: error instanceof Error ? error.message : "操作失败" });
        } finally {
            setRunning(false);
        }
    };

    const rejectTool = (messageId: string) => {
        pendingToolContextRef.current.delete(messageId);
        upsertMessage({ id: messageId, role: "tool", title: "已拒绝执行", text: "工具调用已取消", detail: { status: "rejected" } });
        addLog("拒绝工具", { messageId });
    };

    const executeToolCalls = (toolCalls: ResponseToolCall[]) => {
        const results: ExecutedToolCall[] = [];
        let stopped = false;
        toolCalls.forEach((toolCall) => {
            if (stopped) {
                results.push({ toolCallId: toolCall.id, name: toolCall.function.name, result: { ok: false, message: "前一个工具调用失败，未继续执行。" } });
                return;
            }
            const result = executeToolCall(toolCall);
            results.push(result);
            if (!result.result.ok) stopped = true;
        });
        return results;
    };

    const executeToolCall = (toolCall: ResponseToolCall): ExecutedToolCall => {
        try {
            const result = executeTool(toolCall.function.name, parseToolArguments(toolCall.function.arguments));
            return { toolCallId: toolCall.id, name: toolCall.function.name, result };
        } catch (error) {
            return { toolCallId: toolCall.id, name: toolCall.function.name, result: { ok: false, message: error instanceof Error ? error.message : "工具参数错误" } };
        }
    };

    const executeTool = (name: string, args: Record<string, unknown>): ToolResult => {
        const current = snapshotRef.current;
        if (name === "canvas_get_state") return { ok: true, message: describeCanvasSnapshot(current), data: compactSnapshot(current) };
        if (name === "canvas_get_selection") {
            const ids = new Set(current.selectedNodeIds || []);
            return { ok: true, message: `当前选中 ${ids.size} 个节点。`, data: { nodes: compactSnapshot({ ...current, nodes: current.nodes.filter((node) => ids.has(node.id)) }).nodes } };
        }
        if (name === "canvas_apply_ops") return executeOps(requireOps(args.ops));
        if (name === "canvas_run_generation") return executeOps([{ type: "run_generation", nodeId: requireString(args.nodeId, "nodeId"), mode: generationMode(args.mode), prompt: stringOptional(args.prompt) }]);
        return { ok: false, message: `不支持的工具：${name}` };
    };

    const executeOps = (ops: CanvasAgentOp[]): ToolResult => {
        const before = snapshotSignature(snapshotRef.current);
        const next = onApplyOps(ops);
        snapshotRef.current = next;
        const ranGeneration = ops.some((op) => op.type === "run_generation" && Boolean(op.nodeId));
        const changed = before !== snapshotSignature(next) || ranGeneration;
        return { ok: changed, message: changed ? summarizeCanvasAgentOps(ops) || "画布操作已执行。" : "工具已执行，但画布状态没有变化。", data: { ops, before: JSON.parse(before), after: JSON.parse(snapshotSignature(next)) } };
    };

    const startResize = () => {
        const move = (event: MouseEvent) => setWidth(Math.min(760, Math.max(360, window.innerWidth - event.clientX)));
        const stop = () => {
            setResizing(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", stop);
        };
        setResizing(true);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", stop);
    };

    const collapse = () => {
        setClosing(true);
        window.setTimeout(onCollapse, PANEL_MOTION_MS);
    };

    const logContext = useMemo(
        () => ({ model: activeModel, running, confirmTools, nodes: snapshot.nodes.length, connections: snapshot.connections.length, logs }),
        [activeModel, confirmTools, logs, running, snapshot.connections.length, snapshot.nodes.length],
    );

    return (
        <motion.div
            className="flex shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: closing ? 0 : width + 1, opacity: closing ? 0 : 1 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex shrink-0 flex-col border-l"
                initial={{ x: 48 }}
                animate={{ x: closing ? 28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: [0.22, 1, 0.36, 1] }}
                style={{ width, background: theme.node.panel, borderColor: theme.node.stroke, color: theme.node.text }}
            >
                <button type="button" className="absolute inset-y-0 left-0 z-40 w-4 -translate-x-1/2 cursor-col-resize" onMouseDown={startResize} aria-label="调整网站 Agent 面板宽度" />
                <header className="flex min-h-14 items-center justify-between border-b px-4" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                        <Bot className="size-4" />
                        <span>网站 Agent</span>
                        <span className="truncate text-xs font-normal opacity-55">{activeModel || "未选择模型"}</span>
                    </div>
                    <div className="flex items-center gap-1">
                        <Tooltip title="新对话">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Plus className="size-4" />} disabled={!messages.length || running} onClick={() => setMessages([])} />
                        </Tooltip>
                        <Tooltip title="清空日志">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Trash2 className="size-4" />} disabled={!logs.length} onClick={() => setLogs([])} />
                        </Tooltip>
                        <Tooltip title="配置">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<Settings2 className="size-4" />} onClick={() => openConfigDialog(false)} />
                        </Tooltip>
                        <Tooltip title="收起">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" style={iconButtonStyle} icon={<PanelRightClose className="size-4" />} onClick={collapse} />
                        </Tooltip>
                    </div>
                </header>
                <AgentPanelTabs
                    value={activeTab}
                    theme={theme}
                    items={[
                        { value: "chat", label: "对话", icon: <Bot className="size-3.5" /> },
                        { value: "log", label: "日志", icon: <ShieldCheck className="size-3.5" />, count: logs.length },
                    ]}
                    right={
                        <label className="flex shrink-0 items-center gap-1.5 text-xs" style={{ color: theme.node.muted }}>
                            确认执行
                            <Switch size="small" checked={confirmTools} onChange={setConfirmTools} />
                        </label>
                    }
                    onChange={setActiveTab}
                />
                {activeTab === "chat" ? (
                    <>
                        <div className="thin-scrollbar min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
                            {messages.length ? messages.map((item) => <AgentChatMessage key={item.id} item={item} theme={theme} user={user} onApproveTool={approveTool} onRejectTool={rejectTool} />) : <EmptyAgentState theme={theme} />}
                            {running ? <AgentWorkingMessage theme={theme} /> : null}
                        </div>
                        <AgentChatComposer prompt={prompt} sending={running} placeholder="描述你想让网站 Agent 如何操作画布" theme={theme} onPromptChange={setPrompt} onSubmit={submit} />
                    </>
                ) : (
                    <AgentLogView context={logContext} theme={theme} />
                )}
            </motion.aside>
        </motion.div>
    );
}

function toolDefinition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], strict = false): ResponseFunctionTool {
    return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false }, strict } };
}

function buildAgentMessages(snapshot: CanvasAgentSnapshot, history: CanvasAgentChatMessage[], userText: string): ResponseInputMessage[] {
    return [
        { role: "system", content: ONLINE_AGENT_PROMPT },
        ...history.slice(-12).flatMap((item): ResponseInputMessage[] => (item.role === "user" || item.role === "assistant" ? [{ role: item.role, content: item.text }] : [])),
        { role: "user", content: `当前画布：\n${JSON.stringify(compactSnapshot(snapshot))}\n\n用户请求：${userText}` },
    ];
}

function compactSnapshot(snapshot: CanvasAgentSnapshot) {
    return {
        projectId: snapshot.projectId,
        title: snapshot.title,
        viewport: snapshot.viewport,
        selectedNodeIds: snapshot.selectedNodeIds,
        nodes: snapshot.nodes.map((node) => ({ id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata: compactMetadata(node) })),
        connections: snapshot.connections,
    };
}

function compactMetadata(node: CanvasNodeData) {
    const metadata = node.metadata || {};
    return Object.fromEntries(
        Object.entries(metadata)
            .filter(([key]) => ["content", "composerContent", "prompt", "status", "generationMode", "model", "size", "quality", "count", "seconds", "references"].includes(key))
            .map(([key, value]) => [key, typeof value === "string" && value.startsWith("data:") ? "[media data omitted]" : typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}...` : value]),
    );
}

function describeCanvasSnapshot(snapshot: CanvasAgentSnapshot) {
    const counts = snapshot.nodes.reduce<Record<string, number>>((acc, node) => {
        acc[node.type] = (acc[node.type] || 0) + 1;
        return acc;
    }, {});
    return `当前画布有 ${snapshot.nodes.length} 个节点、${snapshot.connections.length} 条连线。文本 ${counts[CanvasNodeType.Text] || 0} 个，图片 ${counts[CanvasNodeType.Image] || 0} 个，生成配置 ${counts[CanvasNodeType.Config] || 0} 个，视频 ${counts[CanvasNodeType.Video] || 0} 个，音频 ${counts[CanvasNodeType.Audio] || 0} 个。`;
}

function parseToolArguments(value: string) {
    try {
        const parsed = JSON.parse(value || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("工具参数必须是 JSON 对象");
        return parsed as Record<string, unknown>;
    } catch {
        throw new Error("工具参数不是合法 JSON 对象");
    }
}

function toolCallToResponseInput(call: ResponseToolCall): ResponseInputMessage {
    return { type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments };
}

function summarizeToolCalls(calls: ResponseToolCall[]) {
    return calls.map((call) => toolCallLabel(call.function.name)).join("，") || "工具调用";
}

function toolCallLabel(name: string) {
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_run_generation") return "触发生成";
    return name;
}

function requireOps(value: unknown): CanvasAgentOp[] {
    if (!Array.isArray(value)) throw new Error("ops 必须是数组");
    return value.map(toCanvasAgentOp);
}

function toCanvasAgentOp(value: unknown): CanvasAgentOp {
    const item = objectDetail(value);
    const type = item.type;
    if (type === "add_node")
        return {
            type,
            id: stringOptional(item.id),
            nodeType: item.nodeType ? requireNodeType(item.nodeType) : undefined,
            title: stringOptional(item.title),
            position: recordOptional(item.position) ? { x: requireNumber(objectDetail(item.position).x, "position.x"), y: requireNumber(objectDetail(item.position).y, "position.y") } : undefined,
            x: numberOptional(item.x),
            y: numberOptional(item.y),
            width: numberOptional(item.width),
            height: numberOptional(item.height),
            metadata: recordOptional(item.metadata) as CanvasNodeData["metadata"],
        };
    if (type === "update_node") return { type, id: requireString(item.id, "id"), patch: recordOptional(item.patch) as Partial<CanvasNodeData> | undefined, metadata: recordOptional(item.metadata) as CanvasNodeData["metadata"] };
    if (type === "delete_node") return { type, id: stringOptional(item.id), ids: Array.isArray(item.ids) ? requireStringArray(item.ids, "ids") : undefined, nodeType: item.nodeType ? requireNodeType(item.nodeType) : undefined };
    if (type === "delete_connections") return { type, id: stringOptional(item.id), ids: Array.isArray(item.ids) ? requireStringArray(item.ids, "ids") : undefined, all: typeof item.all === "boolean" ? item.all : undefined };
    if (type === "connect_nodes") return { type, id: stringOptional(item.id), fromNodeId: requireString(item.fromNodeId, "fromNodeId"), toNodeId: requireString(item.toNodeId, "toNodeId") };
    if (type === "set_viewport") return { type, viewport: requireViewport(item.viewport) };
    if (type === "select_nodes") return { type, ids: requireStringArray(item.ids, "ids") };
    if (type === "run_generation") return { type, nodeId: requireString(item.nodeId, "nodeId"), mode: generationMode(item.mode), prompt: stringOptional(item.prompt) };
    throw new Error("不支持的画布操作类型");
}

function requireStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组`);
    if (!value.every((item) => typeof item === "string" && Boolean(item))) throw new Error(`${field} 必须只包含非空字符串`);
    return value as string[];
}

function requireString(value: unknown, field: string) {
    if (typeof value !== "string" || !value) throw new Error(`${field} 必须是非空字符串`);
    return value;
}

function requireNumber(value: unknown, field: string) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} 必须是数字`);
    return value;
}

function requireNodeType(value: unknown): CanvasNodeType {
    if (Object.values(CanvasNodeType).includes(value as CanvasNodeType)) return value as CanvasNodeType;
    throw new Error("节点类型必须是 text、image、config、video 或 audio");
}

function requireViewport(value: unknown) {
    const item = objectDetail(value);
    return { x: requireNumber(item.x, "viewport.x"), y: requireNumber(item.y, "viewport.y"), k: requireNumber(item.k, "viewport.k") };
}

function recordOptional(value: unknown) {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringOptional(value: unknown) {
    return typeof value === "string" ? value : "";
}

function numberOptional(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function generationMode(value: unknown): "text" | "image" | "video" | "audio" {
    return value === "text" || value === "video" || value === "audio" ? value : "image";
}

function objectDetail(value: unknown) {
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function snapshotSignature(snapshot: CanvasAgentSnapshot) {
    return JSON.stringify({ nodes: snapshot.nodes, connections: snapshot.connections, selectedNodeIds: snapshot.selectedNodeIds, viewport: snapshot.viewport });
}

function EmptyAgentState({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div className="flex h-full flex-col items-center justify-center px-4 text-center text-sm" style={{ color: theme.node.muted }}>
            <Bot className="mb-3 size-8 opacity-50" />
            <div className="font-medium" style={{ color: theme.node.text }}>
                网站 Agent
            </div>
            <div className="mt-2 max-w-[280px] leading-6">让模型读取当前画布并调用工具。写入画布前默认需要确认。</div>
        </div>
    );
}

function AgentLogView({ context, theme }: { context: { model: string; running: boolean; confirmTools: boolean; nodes: number; connections: number; logs: AgentLog[] }; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const text = JSON.stringify(context, null, 2);
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-auto p-4">
            <pre className="min-h-full whitespace-pre-wrap rounded-xl border p-3 text-[11px] leading-4" style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.muted }}>
                {text}
            </pre>
        </div>
    );
}
