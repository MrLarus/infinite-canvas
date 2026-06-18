"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import copyToClipboard from "copy-to-clipboard";
import { Bot, Copy, PanelRightClose, Plus, Settings2, ShieldCheck, Trash2 } from "lucide-react";
import { Button, Segmented, Switch, Tooltip } from "antd";
import { motion } from "motion/react";
import { nanoid } from "nanoid";

import { ModelPicker } from "@/components/model-picker";
import { requestToolResponse, type ResponseFunctionTool, type ResponseInputMessage, type ResponseToolCall } from "@/services/api/image";
import { canvasThemes } from "@/lib/canvas-theme";
import { normalizeModelOptionValue, resolveImageSize, resolveVideoSize, selectableModelsByCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { AgentChatComposer, AgentChatMessage, AgentPanelTabs, AgentWorkingMessage, type CanvasAgentChatMessage } from "./canvas-agent-chat-ui";
import { NODE_DEFAULT_SIZE } from "../constants";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { summarizeCanvasAgentOps, type CanvasAgentOp, type CanvasAgentSnapshot } from "../utils/canvas-agent-ops";

const PANEL_MOTION_MS = 500;
const PANEL_MOTION_SECONDS = PANEL_MOTION_MS / 1000;
const ONLINE_AGENT_MAX_STEPS = 4;
const ONLINE_AGENT_COMPATIBLE_MODELS = new Set(["claude-opus-4-6", "glm-5.2"]);
const ONLINE_AGENT_PROMPT =
    "你是 Infinite Canvas 网页内置在线画布 Agent。当前画布 JSON 会随用户消息提供。首轮必须调用工具：只读问题调用 canvas_get_state，需要生成内容时优先调用 canvas_generate_text、canvas_generate_image、canvas_generate_video、canvas_generate_audio 或 canvas_create_generation_flow；需要创建节点时调用 canvas_create_node / canvas_create_text_node / canvas_create_config_node；需要精确批量操作时调用 canvas_apply_ops。不要输出 JSON 给用户，不要编造执行结果。工具参数涉及已有节点时必须使用当前画布 JSON 中真实存在的 id；缺少必要 id 或用户意图不明确时直接说明需要用户明确选择或说明，不要猜测。工具返回结果后，再根据真实结果回答用户。";

const JSON_RECORD_SCHEMA = { type: "object", additionalProperties: true };
const POSITION_SCHEMA = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"], additionalProperties: false };
const VIEWPORT_SCHEMA = { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, k: { type: "number" } }, required: ["x", "y", "k"], additionalProperties: false };
const NODE_TYPE_SCHEMA = { type: "string", enum: ["image", "text", "config", "video", "audio"] };
const GENERATION_MODE_SCHEMA = { type: "string", enum: ["text", "image", "video", "audio"] };
const GENERATION_OPTION_PROPERTIES = {
    model: { type: "string" },
    size: { type: "string" },
    quality: { type: "string" },
    count: { type: "number" },
    seconds: { type: "string" },
    vquality: { type: "string" },
    generateAudio: { type: "string" },
    watermark: { type: "string" },
    audioVoice: { type: "string" },
    audioFormat: { type: "string" },
    audioSpeed: { type: "string" },
    audioInstructions: { type: "string" },
};
const REFERENCE_NODE_IDS_SCHEMA = { type: "array", items: { type: "string" } };
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
    toolDefinition("canvas_export_snapshot", "导出当前画布快照，用于理解布局。", {}),
    toolDefinition(
        "canvas_apply_ops",
        "批量操作当前网页画布。ops 支持 add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation。",
        { ops: { type: "array", items: CANVAS_OP_SCHEMA } },
        ["ops"],
        false,
    ),
    toolDefinition(
        "canvas_create_node",
        "创建任意类型节点：text、image、config、video、audio。适合创建占位图、媒体占位、配置节点或自定义 metadata 节点。",
        { nodeType: NODE_TYPE_SCHEMA, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" }, metadata: JSON_RECORD_SCHEMA },
        ["nodeType"],
    ),
    toolDefinition("canvas_create_text_node", "在当前画布创建单个文本节点。", { text: { type: "string" }, x: { type: "number" }, y: { type: "number" }, title: { type: "string" }, width: { type: "number" }, height: { type: "number" } }, ["text"]),
    toolDefinition(
        "canvas_create_text_nodes",
        "批量创建文本节点，适合生成标题、段落、脚本、说明等内容块。",
        {
            items: {
                type: "array",
                minItems: 1,
                items: {
                    type: "object",
                    properties: { text: { type: "string" }, title: { type: "string" }, x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
                    required: ["text"],
                    additionalProperties: false,
                },
            },
            x: { type: "number" },
            y: { type: "number" },
            gap: { type: "number" },
            direction: { type: "string", enum: ["row", "column"] },
        },
        ["items"],
    ),
    toolDefinition("canvas_create_config_node", "创建生成配置节点，可指定 text/image/video/audio 模式和生成参数，可选择立即触发生成。", {
        id: { type: "string" },
        prompt: { type: "string" },
        mode: GENERATION_MODE_SCHEMA,
        title: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        autoRun: { type: "boolean" },
        ...GENERATION_OPTION_PROPERTIES,
    }),
    toolDefinition(
        "canvas_create_image_prompt_flow",
        "创建提示词文本节点和图片生成配置节点，并自动连线，可选择立即触发生图。",
        { prompt: { type: "string" }, x: { type: "number" }, y: { type: "number" }, autoRun: { type: "boolean" }, referenceNodeIds: REFERENCE_NODE_IDS_SCHEMA, ...GENERATION_OPTION_PROPERTIES },
        ["prompt"],
    ),
    generationToolDefinition("canvas_create_generation_flow", "创建通用生成流程：提示词文本节点、生成配置节点、参考节点连线，可用于文案、生图、视频或音频。"),
    generationToolDefinition("canvas_generate_text", "创建文本生成流程并立即触发生成。", "text"),
    generationToolDefinition("canvas_generate_image", "创建图片生成流程并立即触发生成。", "image"),
    generationToolDefinition("canvas_generate_video", "创建视频生成流程并立即触发生成。", "video"),
    generationToolDefinition("canvas_generate_audio", "创建音频生成流程并立即触发生成。", "audio"),
    toolDefinition("canvas_update_node", "更新节点基础字段或 metadata。", { id: { type: "string" }, patch: JSON_RECORD_SCHEMA, metadata: JSON_RECORD_SCHEMA }, ["id"]),
    toolDefinition("canvas_update_node_text", "更新文本节点内容和标题。", { id: { type: "string" }, text: { type: "string" }, title: { type: "string" } }, ["id", "text"]),
    toolDefinition(
        "canvas_move_nodes",
        "移动一个或多个节点，支持绝对坐标或 dx/dy 偏移。",
        {
            items: {
                type: "array",
                minItems: 1,
                items: { type: "object", properties: { id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, dx: { type: "number" }, dy: { type: "number" } }, required: ["id"], additionalProperties: false },
            },
        },
        ["items"],
    ),
    toolDefinition("canvas_resize_node", "调整节点尺寸。", { id: { type: "string" }, width: { type: "number" }, height: { type: "number" }, freeResize: { type: "boolean" } }, ["id", "width", "height"]),
    toolDefinition("canvas_delete_nodes", "删除指定节点及相关连线。", { ids: { type: "array", items: { type: "string" }, minItems: 1 } }, ["ids"]),
    toolDefinition(
        "canvas_connect_nodes",
        "批量连接节点。",
        { connections: { type: "array", minItems: 1, items: { type: "object", properties: { fromNodeId: { type: "string" }, toNodeId: { type: "string" } }, required: ["fromNodeId", "toNodeId"], additionalProperties: false } } },
        ["connections"],
    ),
    toolDefinition("canvas_select_nodes", "设置当前选中节点。", { ids: { type: "array", items: { type: "string" } } }, ["ids"]),
    toolDefinition("canvas_set_viewport", "调整画布视口。", { viewport: VIEWPORT_SCHEMA }, ["viewport"]),
    toolDefinition("canvas_run_generation", "触发指定节点生成，通常用于配置节点或文本/图片/视频/音频节点。", { nodeId: { type: "string" }, mode: GENERATION_MODE_SCHEMA, prompt: { type: "string" } }, ["nodeId"]),
];
const READ_TOOL_NAMES = new Set(["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot"]);

type AgentTab = "chat" | "log";
type AgentLog = { id: string; time: string; title: string; data?: unknown };
type AgentLogContext = { model: string; running: boolean; confirmTools: boolean; nodes: number; connections: number; logs: AgentLog[] };
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
    const confirmToolsRef = useRef(confirmTools);
    const pendingToolContextRef = useRef(new Map<string, PendingToolContext>());

    useEffect(() => {
        snapshotRef.current = snapshot;
    }, [snapshot]);
    useEffect(() => {
        confirmToolsRef.current = confirmTools;
    }, [confirmTools]);

    const [agentModel, setAgentModel] = useState("");
    const agentConfig = useMemo(() => withAgentCompatibleModels(effectiveConfig), [effectiveConfig]);
    const activeModel = agentModelValue(agentConfig, agentModel || effectiveConfig.textModel || effectiveConfig.model);
    const iconButtonStyle = { color: theme.node.muted };

    useEffect(() => {
        if (activeModel && activeModel !== agentModel) setAgentModel(activeModel);
    }, [activeModel, agentModel]);

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
            if (confirmToolsRef.current && writable.length) {
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

    const runPendingTool = async (messageId: string, ignoreRunning = false) => {
        const context = pendingToolContextRef.current.get(messageId);
        if (!context || (!ignoreRunning && running)) return;
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

    const approveTool = async (messageId: string) => {
        await runPendingTool(messageId);
    };

    const handleConfirmToolsChange = (checked: boolean) => {
        confirmToolsRef.current = checked;
        setConfirmTools(checked);
        if (!checked && pendingToolContextRef.current.size) {
            const [messageId] = pendingToolContextRef.current.keys();
            if (messageId) void runPendingTool(messageId, true);
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
        if (name === "canvas_export_snapshot") return { ok: true, message: describeCanvasSnapshot(current), data: compactSnapshot(current) };
        if (name === "canvas_get_selection") {
            const ids = new Set(current.selectedNodeIds || []);
            return { ok: true, message: `当前选中 ${ids.size} 个节点。`, data: { nodes: compactSnapshot({ ...current, nodes: current.nodes.filter((node) => ids.has(node.id)) }).nodes } };
        }
        return executeOps(onlineToolToOps(name, args, current, effectiveConfig));
    };

    const executeOps = (ops: CanvasAgentOp[]): ToolResult => {
        const beforeSnapshot = snapshotRef.current;
        const before = snapshotSignature(beforeSnapshot);
        const next = onApplyOps(ops);
        snapshotRef.current = next;
        const ranGeneration = ops.some((op) => op.type === "run_generation" && Boolean(op.nodeId));
        const changed = before !== snapshotSignature(next) || ranGeneration;
        const noopReason = changed ? "" : explainNoop(ops, beforeSnapshot);
        return { ok: changed, message: changed ? summarizeCanvasAgentOps(ops) || "画布操作已执行。" : noopReason, data: { ops, before: JSON.parse(before), after: JSON.parse(snapshotSignature(next)) } };
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
                            执行前确认
                            <Switch size="small" checked={confirmTools} onChange={handleConfirmToolsChange} />
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
                        <AgentChatComposer
                            prompt={prompt}
                            sending={running}
                            placeholder="描述你想让网站 Agent 如何操作画布"
                            theme={theme}
                            left={<ModelPicker className="h-8 max-w-[220px] shrink-0" config={agentConfig} value={activeModel} capability="text" onChange={setAgentModel} onMissingConfig={() => openConfigDialog(true)} />}
                            onPromptChange={setPrompt}
                            onSubmit={submit}
                        />
                    </>
                ) : (
                    <AgentLogView context={logContext} theme={theme} />
                )}
            </motion.aside>
        </motion.div>
    );
}

function generationToolDefinition(name: string, description: string, mode?: "text" | "image" | "video" | "audio") {
    return toolDefinition(
        name,
        description,
        {
            prompt: { type: "string" },
            mode: mode ? undefined : GENERATION_MODE_SCHEMA,
            x: { type: "number" },
            y: { type: "number" },
            title: { type: "string" },
            autoRun: { type: "boolean" },
            referenceNodeIds: REFERENCE_NODE_IDS_SCHEMA,
            ...GENERATION_OPTION_PROPERTIES,
        },
        ["prompt"],
    );
}

function toolDefinition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], strict = false): ResponseFunctionTool {
    return { type: "function", function: { name, description, parameters: { type: "object", properties: cleanSchemaProperties(properties), required, additionalProperties: false }, strict } };
}

function cleanSchemaProperties(properties: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(properties).filter(([, value]) => value !== undefined));
}

function onlineToolToOps(name: string, input: Record<string, unknown>, snapshot: CanvasAgentSnapshot, config: AiConfig): CanvasAgentOp[] {
    if (name === "canvas_apply_ops") return requireOps(input.ops);
    if (name === "canvas_create_node") {
        const nodeType = requireNodeType(input.nodeType);
        const x = numberOr(input.x, nextCanvasX(snapshot));
        const y = numberOr(input.y, 0);
        if (nodeType === CanvasNodeType.Config) return [configNodeOp(stringOptional(input.id) || `config-${nanoid()}`, { ...recordOptional(input.metadata), ...input }, x, y, config)];
        return [{ type: "add_node", nodeType, title: stringOptional(input.title), position: { x, y }, width: numberOptional(input.width), height: numberOptional(input.height), metadata: recordOptional(input.metadata) as CanvasNodeData["metadata"] }];
    }
    if (name === "canvas_create_text_node") return [textNodeOp(input, numberOr(input.x, nextCanvasX(snapshot)), numberOr(input.y, 0))];
    if (name === "canvas_create_text_nodes") {
        const items = requireRecordArray(input.items, "items");
        const x = numberOr(input.x, nextCanvasX(snapshot));
        const y = numberOr(input.y, 0);
        const gap = numberOr(input.gap, 40);
        const direction = input.direction === "row" ? "row" : "column";
        return items.map((item, index) =>
            textNodeOp(
                { ...item, text: requireString(item.text, "text") },
                numberOr(item.x, direction === "row" ? x + index * (NODE_DEFAULT_SIZE[CanvasNodeType.Text].width + gap) : x),
                numberOr(item.y, direction === "row" ? y : y + index * (NODE_DEFAULT_SIZE[CanvasNodeType.Text].height + gap)),
            ),
        );
    }
    if (name === "canvas_create_image_prompt_flow") return generationFlowOps({ ...input, mode: "image" }, snapshot, config);
    if (name === "canvas_create_config_node") {
        const configId = stringOptional(input.id) || `config-${nanoid()}`;
        const mode = generationMode(input.mode);
        return [configNodeOp(configId, input, numberOr(input.x, nextCanvasX(snapshot)), numberOr(input.y, 0), config), ...(input.autoRun ? [runGenerationOp(configId, mode, stringOptional(input.prompt))] : [])];
    }
    if (name === "canvas_create_generation_flow") return generationFlowOps(input, snapshot, config);
    if (name === "canvas_generate_text") return generationFlowOps({ ...input, mode: "text", autoRun: true }, snapshot, config);
    if (name === "canvas_generate_image") return generationFlowOps({ ...input, mode: "image", autoRun: true }, snapshot, config);
    if (name === "canvas_generate_video") return generationFlowOps({ ...input, mode: "video", autoRun: true }, snapshot, config);
    if (name === "canvas_generate_audio") return generationFlowOps({ ...input, mode: "audio", autoRun: true }, snapshot, config);
    if (name === "canvas_update_node") return [{ type: "update_node", id: requireString(input.id, "id"), patch: recordOptional(input.patch) as Partial<CanvasNodeData> | undefined, metadata: recordOptional(input.metadata) as CanvasNodeData["metadata"] }];
    if (name === "canvas_update_node_text")
        return [{ type: "update_node", id: requireString(input.id, "id"), patch: stringOptional(input.title) ? { title: stringOptional(input.title) } : undefined, metadata: { content: requireString(input.text, "text"), status: "success" } }];
    if (name === "canvas_move_nodes") {
        return requireRecordArray(input.items, "items").map((item) => {
            const id = requireString(item.id, "id");
            const current = snapshot.nodes.find((node) => node.id === id);
            return { type: "update_node", id, patch: { position: { x: numberOr(item.x, (current?.position.x || 0) + numberOr(item.dx, 0)), y: numberOr(item.y, (current?.position.y || 0) + numberOr(item.dy, 0)) } } };
        });
    }
    if (name === "canvas_resize_node")
        return [
            {
                type: "update_node",
                id: requireString(input.id, "id"),
                patch: { width: requireNumber(input.width, "width"), height: requireNumber(input.height, "height") },
                metadata: typeof input.freeResize === "boolean" ? { freeResize: input.freeResize } : undefined,
            },
        ];
    if (name === "canvas_delete_nodes") return [{ type: "delete_node", ids: requireStringArray(input.ids, "ids") }];
    if (name === "canvas_connect_nodes")
        return requireRecordArray(input.connections, "connections").map((connection) => ({ type: "connect_nodes", fromNodeId: requireString(connection.fromNodeId, "fromNodeId"), toNodeId: requireString(connection.toNodeId, "toNodeId") }));
    if (name === "canvas_select_nodes") return [{ type: "select_nodes", ids: requireStringArray(input.ids, "ids") }];
    if (name === "canvas_set_viewport") return [{ type: "set_viewport", viewport: requireViewport(input.viewport) }];
    if (name === "canvas_run_generation") return [runGenerationOp(requireString(input.nodeId, "nodeId"), generationMode(input.mode), stringOptional(input.prompt))];
    throw new Error(`不支持的工具：${name}`);
}

function generationFlowOps(input: Record<string, unknown>, snapshot: CanvasAgentSnapshot, config: AiConfig): CanvasAgentOp[] {
    const mode = generationMode(input.mode);
    const prompt = requireString(input.prompt, "prompt");
    const x = numberOr(input.x, nextCanvasX(snapshot));
    const y = numberOr(input.y, 0);
    const textId = `text-${nanoid()}`;
    const configId = `config-${nanoid()}`;
    const referenceNodeIds = Array.isArray(input.referenceNodeIds) ? input.referenceNodeIds.filter((id): id is string => typeof id === "string" && snapshot.nodes.some((node) => node.id === id)) : [];
    const tokens = [`@[node:${textId}]`, ...referenceNodeIds.map((id) => `@[node:${id}]`)];
    return [
        textNodeOp({ id: textId, text: prompt, title: stringOptional(input.title) || "提示词" }, x, y),
        configNodeOp(configId, { ...input, prompt: tokens.join("\n") }, x + NODE_DEFAULT_SIZE[CanvasNodeType.Text].width + 80, y, config),
        { type: "connect_nodes", fromNodeId: textId, toNodeId: configId },
        ...referenceNodeIds.map((fromNodeId) => ({ type: "connect_nodes" as const, fromNodeId, toNodeId: configId })),
        { type: "select_nodes", ids: [configId] },
        ...(input.autoRun ? [runGenerationOp(configId, mode, tokens.join("\n"))] : []),
    ];
}

function textNodeOp(input: Record<string, unknown>, x: number, y: number): CanvasAgentOp {
    return {
        type: "add_node",
        id: stringOptional(input.id),
        nodeType: CanvasNodeType.Text,
        title: stringOptional(input.title),
        position: { x, y },
        width: numberOptional(input.width),
        height: numberOptional(input.height),
        metadata: { content: stringOptional(input.text), status: "success", fontSize: 14 },
    };
}

function configNodeOp(id: string, input: Record<string, unknown>, x: number, y: number, config: AiConfig): CanvasAgentOp {
    const mode = generationMode(input.mode);
    const prompt = stringOptional(input.prompt);
    return {
        type: "add_node",
        id,
        nodeType: CanvasNodeType.Config,
        title: stringOptional(input.title) || generationTitle(mode),
        position: { x, y },
        width: numberOptional(input.width),
        height: numberOptional(input.height),
        metadata: cleanRecord({
            generationMode: mode,
            composerContent: prompt,
            prompt,
            status: "idle",
            model: resolveGenerationModel(config, mode, stringOptional(input.model)),
            size: stringOptional(input.size) || defaultGenerationSize(config, mode),
            quality: stringOptional(input.quality) || config.quality,
            count: numberOptional(input.count) ?? generationCount(mode === "image" ? config.canvasImageCount || config.count : config.count),
            seconds: stringOptional(input.seconds) || config.videoSeconds,
            vquality: stringOptional(input.vquality) || config.vquality,
            generateAudio: stringOptional(input.generateAudio) || config.videoGenerateAudio,
            watermark: stringOptional(input.watermark) || config.videoWatermark,
            audioVoice: stringOptional(input.audioVoice) || config.audioVoice,
            audioFormat: stringOptional(input.audioFormat) || config.audioFormat,
            audioSpeed: stringOptional(input.audioSpeed) || config.audioSpeed,
            audioInstructions: stringOptional(input.audioInstructions) || config.audioInstructions,
        }) as CanvasNodeData["metadata"],
    };
}

function runGenerationOp(nodeId: string, mode: "text" | "image" | "video" | "audio", prompt?: string): CanvasAgentOp {
    return { type: "run_generation", nodeId, mode, prompt };
}

function defaultGenerationSize(config: AiConfig, mode: "text" | "image" | "video" | "audio") {
    if (mode === "image") return resolveImageSize(config);
    if (mode === "video") return resolveVideoSize(config);
    return config.size;
}

function defaultGenerationModel(config: AiConfig, mode: "text" | "image" | "video" | "audio") {
    if (mode === "image") return config.imageModel || config.model;
    if (mode === "video") return config.videoModel || config.model;
    if (mode === "audio") return config.audioModel || config.model;
    return config.textModel || config.model;
}

function withAgentCompatibleModels(config: AiConfig): AiConfig {
    if (config.channelMode !== "remote") return config;
    const textModels = config.textModels.filter(isAgentCompatibleModel);
    const fallback = textModels[0] || "";
    return {
        ...config,
        textModels,
        textModel: textModels.includes(config.textModel) ? config.textModel : fallback,
        model: textModels.includes(config.model) ? config.model : fallback,
    };
}

function agentModelValue(config: AiConfig, current: string) {
    if (config.channelMode === "remote") {
        if (isAgentCompatibleModel(current) && config.textModels.includes(current)) return current;
        return config.textModels[0] || "";
    }
    if (isAgentCompatibleModel(current) && (!config.textModels.length || config.textModels.includes(current))) return current;
    return config.textModels[0] || current;
}

function isAgentCompatibleModel(model: string) {
    return ONLINE_AGENT_COMPATIBLE_MODELS.has(model.trim().toLowerCase());
}

function resolveGenerationModel(config: AiConfig, mode: "text" | "image" | "video" | "audio", model?: string) {
    const models = selectableModelsByCapability(config, mode);
    const requested = normalizeModelOptionValue(model, models);
    return requested && (!models.length || models.includes(requested)) ? requested : defaultGenerationModel(config, mode);
}

function generationTitle(mode: "text" | "image" | "video" | "audio") {
    if (mode === "text") return "文本生成";
    if (mode === "video") return "视频生成";
    if (mode === "audio") return "音频生成";
    return "图片生成";
}

function generationCount(value: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 1)));
}

function cleanRecord(value: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function explainNoop(ops: CanvasAgentOp[], snapshot: CanvasAgentSnapshot) {
    if (!ops.length) return "模型没有返回可执行的画布操作。";
    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    const connectionIds = new Set(snapshot.connections.map((conn) => conn.id));
    const deleteConnectionOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "delete_connections" }> => op.type === "delete_connections");
    const connectOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "connect_nodes" }> => op.type === "connect_nodes");
    const deleteNodeOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "delete_node" }> => op.type === "delete_node");
    const updateOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "update_node" }> => op.type === "update_node");
    const selectOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "select_nodes" }> => op.type === "select_nodes");
    const generationOps = ops.filter((op): op is Extract<CanvasAgentOp, { type: "run_generation" }> => op.type === "run_generation");
    if (deleteConnectionOps.length && !snapshot.connections.length) return "画布当前没有连线可删除。";
    if (deleteConnectionOps.length && deleteConnectionOps.every((op) => !op.all && [...(op.ids || []), ...(op.id ? [op.id] : [])].every((id) => !connectionIds.has(id)))) return "没有找到要删除的连线。";
    if (connectOps.length && connectOps.every((op) => snapshot.connections.some((conn) => conn.fromNodeId === op.fromNodeId && conn.toNodeId === op.toNodeId))) return "这些节点已经存在对应连线，无需重复连接。";
    if (connectOps.length && connectOps.every((op) => !nodeIds.has(op.fromNodeId) || !nodeIds.has(op.toNodeId))) return "没有找到要连接的节点。";
    if (deleteNodeOps.length && deleteNodeOps.every((op) => op.nodeType === CanvasNodeType.Config) && !snapshot.nodes.some((node) => node.type === CanvasNodeType.Config)) return "画布当前没有生成配置节点可删除。";
    if (deleteNodeOps.length && deleteNodeOps.every((op) => [...(op.ids || []), ...(op.id ? [op.id] : [])].every((id) => !nodeIds.has(id)))) return "没有找到要删除的节点。";
    if (updateOps.length && updateOps.every((op) => !nodeIds.has(op.id))) return "没有找到要更新的节点。";
    if (selectOps.length && selectOps.every((op) => !(op.ids || []).some((id) => nodeIds.has(id)))) return "没有找到要选择的节点。";
    if (generationOps.length && generationOps.every((op) => !nodeIds.has(op.nodeId))) return "没有找到要触发生成的节点。";
    if (ops.every((op) => op.type === "set_viewport")) return "视图已经是目标状态。";
    if (selectOps.length && selectOps.every((op) => JSON.stringify(op.ids || []) === JSON.stringify(snapshot.selectedNodeIds))) return "选区已经是目标状态。";
    return "工具已执行，但画布状态没有变化；请在日志 tab 查看工具参数和执行前后状态。";
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
    const labels = calls.map((call) => toolCallLabel(call.function.name));
    if (!labels.length) return "工具调用";
    return labels.length === 1 ? labels[0] : `${labels.length} 个工具：${labels.join("，")}`;
}

function toolCallLabel(name: string) {
    if (name === "canvas_apply_ops") return "画布操作";
    if (name === "canvas_get_state") return "读取画布";
    if (name === "canvas_get_selection") return "读取选区";
    if (name === "canvas_export_snapshot") return "导出快照";
    if (name === "canvas_create_node") return "创建节点";
    if (name === "canvas_create_text_node") return "创建文本";
    if (name === "canvas_create_text_nodes") return "批量创建文本";
    if (name === "canvas_create_config_node") return "创建生成配置";
    if (name === "canvas_create_image_prompt_flow") return "创建生图流程";
    if (name === "canvas_create_generation_flow") return "创建生成流程";
    if (name === "canvas_generate_text") return "生成文本";
    if (name === "canvas_generate_image") return "生成图片";
    if (name === "canvas_generate_video") return "生成视频";
    if (name === "canvas_generate_audio") return "生成音频";
    if (name === "canvas_update_node") return "更新节点";
    if (name === "canvas_update_node_text") return "更新文本";
    if (name === "canvas_move_nodes") return "移动节点";
    if (name === "canvas_resize_node") return "调整节点尺寸";
    if (name === "canvas_delete_nodes") return "删除节点";
    if (name === "canvas_connect_nodes") return "连接节点";
    if (name === "canvas_select_nodes") return "选择节点";
    if (name === "canvas_set_viewport") return "调整视图";
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

function requireRecordArray(value: unknown, field: string): Record<string, unknown>[] {
    if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
    return value.map((item) => {
        const record = objectDetail(item);
        if (!Object.keys(record).length) throw new Error(`${field} 必须只包含对象`);
        return record;
    });
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

function numberOr(value: unknown, fallback: number) {
    return numberOptional(value) ?? fallback;
}

function nextCanvasX(snapshot: CanvasAgentSnapshot) {
    return snapshot.nodes.length ? Math.max(...snapshot.nodes.map((node) => node.position.x + node.width)) + 80 : 0;
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

function AgentLogView({ context, theme }: { context: AgentLogContext; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const [mode, setMode] = useState<"text" | "json">("text");
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const content = mode === "text" ? formatAgentLogText(context) : formatAgentLogJson(context);
    const lastError = [...context.logs].reverse().find((item) => /错误|失败|error/i.test(`${item.title}\n${stringifyLog(item.data)}`));
    const copy = async (value = content) => {
        if (await copyToClipboard(value)) return;
        textareaRef.current?.focus();
        textareaRef.current?.select();
        document.execCommand("copy");
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
                <Segmented
                    size="small"
                    value={mode}
                    onChange={(value) => setMode(value as "text" | "json")}
                    options={[
                        { label: "排查日志", value: "text" },
                        { label: "原始 JSON", value: "json" },
                    ]}
                />
                <span className="text-xs" style={{ color: theme.node.muted }}>
                    {context.logs.length} 条
                </span>
                <Button size="small" icon={<Copy className="size-3.5" />} disabled={!context.logs.length} onClick={() => void copy()}>
                    复制
                </Button>
                <Button size="small" disabled={!lastError} onClick={() => lastError && void copy(formatAgentLogText({ ...context, logs: [lastError] }))}>
                    最近错误
                </Button>
            </div>
            <textarea
                ref={textareaRef}
                readOnly
                value={content}
                className="thin-scrollbar min-h-[360px] flex-1 resize-none rounded-xl border bg-transparent p-3 font-mono text-xs leading-5 outline-none"
                style={{ borderColor: theme.node.stroke, background: theme.toolbar.panel, color: theme.node.text }}
            />
        </div>
    );
}

function formatAgentLogText(context: AgentLogContext) {
    const head = [
        "Infinite Canvas 网站 Agent 诊断日志",
        `model: ${context.model || "none"}`,
        `running: ${context.running}`,
        `confirmTools: ${context.confirmTools}`,
        `nodes: ${context.nodes}`,
        `connections: ${context.connections}`,
        `logs: ${context.logs.length}`,
    ].join("\n");
    const body = context.logs.map((log, index) => [`#${index + 1} ${log.time} ${log.title}`, log.data === undefined ? "" : stringifyLog(log.data)].filter(Boolean).join("\n")).join("\n\n---\n\n");
    return [head, body || "暂无事件日志"].join("\n\n");
}

function formatAgentLogJson(context: AgentLogContext) {
    const { logs, ...rest } = context;
    return JSON.stringify({ context: rest, logs: logs.map(({ time, title, data }) => ({ time, title, data })) }, null, 2);
}

function stringifyLog(value: unknown) {
    if (value === undefined) return "";
    if (value instanceof Error) return value.message;
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
