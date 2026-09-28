import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { nanoid } from "nanoid";

import { useCanvasStore, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import { defaultConfig, guessCapability, modelOptionsFromChannels, useConfigStore, type ModelChannel } from "@/stores/use-config-store";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { hydrateCanvasImages } from "@/lib/canvas/canvas-generation-helpers";
import { getMediaBlob, resolveMediaUrl, setMediaBlob } from "@/services/file-storage";
import { connectSharedRoom, createSharedRoom, getCollaborationInfo, getSharedAsset, getSharedProxyModels, getSharedRoom, loadSharedBase, putSharedAsset, rememberSharedRoom, saveSharedBase, sendSharedUpdate, type CollaborationInfo, type SharedCanvasProject } from "@/services/collaboration";

type CollaborationStatus = "local" | "connecting" | "connected" | "error";
type RoomMessage = Record<string, unknown>;
const RECOVERY_SAVE_WARNING = "当前浏览器无法保存共享画布的恢复信息，请保留地址栏中的完整邀请链接。";

export function useCanvasCollaboration(projectId: string, project: CanvasProject | undefined) {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const roomId = searchParams.get("collab") || "";
    const token = searchParams.get("invite") || "";
    const [status, setStatus] = useState<CollaborationStatus>(roomId && token ? "connecting" : "local");
    const [participants, setParticipants] = useState(1);
    const [error, setError] = useState("");
    const [recoveryWarning, setRecoveryWarning] = useState("");
    const [remoteUpdate, setRemoteUpdate] = useState<{ sequence: number; project: CanvasProject } | null>(null);
    const socketRef = useRef<WebSocket | null>(null);
    const revisionRef = useRef(0);
    const baseRef = useRef<SharedCanvasProject | null>(null);
    const sentRef = useRef<SharedCanvasProject | null>(null);
    const sendingRef = useRef(false);
    const preparingRef = useRef(false);
    const applyingRef = useRef(false);
    const knownAssetsRef = useRef(new Set<string>());
    const localProjectRef = useRef(project);
    const clientIdRef = useRef(nanoid());
    const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const initializedRef = useRef(false);
    const sequenceRef = useRef(0);
    const runtimeChannelIdRef = useRef("");
    const baseWriteRef = useRef<Promise<void>>(Promise.resolve());
    const savedBaseRevisionRef = useRef(0);

    localProjectRef.current = project;

    const rememberRoom = useCallback(async (current: Pick<CanvasProject, "id" | "title">, currentRoomId: string, currentToken: string, mode: "host" | "local" = "local") => {
        try {
            await rememberSharedRoom(current, currentRoomId, currentToken, mode);
        } catch {
            setRecoveryWarning(RECOVERY_SAVE_WARNING);
        }
    }, []);

    const createInvitation = useCallback(async () => {
        if (roomId && token) {
            if (project) {
                await rememberRoom(project, roomId, token, searchParams.get("agentMode") === "host" ? "host" : "local");
                await uploadAssets(roomId, token, toSharedProject(project), knownAssetsRef.current);
            }
            const canvasUrl = new URL(window.location.href);
            canvasUrl.searchParams.delete("agentUrl");
            canvasUrl.searchParams.delete("agentToken");
            canvasUrl.searchParams.delete("agentMode");
            const info = await getCollaborationInfo().catch(() => null);
            const hostUrl = info?.hostAgentEnabled ? new URL(canvasUrl.toString()) : null;
            if (hostUrl) {
                hostUrl.searchParams.set("agentMode", "host");
            }
            return { canvasLink: canvasUrl.toString(), hostAgentLink: hostUrl?.toString() || "" };
        }
        if (!project) throw new Error("画布尚未加载完成");
        let host = window.location.hostname;
        let info: CollaborationInfo | null = null;
        if (["localhost", "127.0.0.1", "::1"].includes(host)) {
            info = await getCollaborationInfo();
            host = info.advertisedHost;
            if (!host) throw new Error("没有找到本机局域网地址，请从局域网 IP 打开 Infinite Canvas 后再共享");
        }
        info ||= await getCollaborationInfo().catch(() => null);
        const created = await createSharedRoom(toSharedProject(project));
        knownAssetsRef.current.clear();
        const inviteUrl = new URL(window.location.href);
        inviteUrl.hostname = host;
        inviteUrl.searchParams.set("collab", created.roomId);
        inviteUrl.searchParams.set("invite", created.token);
        inviteUrl.searchParams.delete("agentUrl");
        inviteUrl.searchParams.delete("agentToken");
        inviteUrl.searchParams.delete("agentMode");
        navigate(`${inviteUrl.pathname}${inviteUrl.search}${inviteUrl.hash}`, { replace: true });
        await rememberRoom(project, created.roomId, created.token);
        try {
            await saveSharedBase(created.roomId, created.revision, created.project);
        } catch {
            setRecoveryWarning(RECOVERY_SAVE_WARNING);
        }
        await uploadAssets(created.roomId, created.token, toSharedProject(project), knownAssetsRef.current);
        const hostAgentUrl = info?.hostAgentEnabled ? new URL(inviteUrl.toString()) : null;
        if (hostAgentUrl) {
            hostAgentUrl.searchParams.set("agentMode", "host");
        }
        return { canvasLink: inviteUrl.toString(), hostAgentLink: hostAgentUrl?.toString() || "" };
    }, [navigate, project, rememberRoom, roomId, searchParams, token]);

    useEffect(() => {
        if (!roomId || !token) {
            removeRuntimeProxyChannel(runtimeChannelIdRef.current);
            runtimeChannelIdRef.current = "";
            setStatus("local");
            setParticipants(1);
            setError("");
            return;
        }
        let closed = false;
        let socket: WebSocket | null = null;
        initializedRef.current = false;
        baseRef.current = null;
        sendingRef.current = false;
        setStatus("connecting");
        setError("");
        let starting = false;

        const persistBase = (revision: number, savedProject: SharedCanvasProject) => {
            baseWriteRef.current = baseWriteRef.current.catch(() => {}).then(() => saveSharedBase(roomId, revision, savedProject)).catch(() => {
                if (!closed) setRecoveryWarning(RECOVERY_SAVE_WARNING);
            });
            return baseWriteRef.current;
        };

        const receive = async (message: RoomMessage, isInitial = false) => {
            if (message.type === "presence" && typeof message.count === "number") {
                setParticipants(message.count);
                return;
            }
            if (message.type === "ack" && message.clientId === clientIdRef.current) {
                revisionRef.current = Number(message.revision) || revisionRef.current;
                baseRef.current = sentRef.current;
                if (baseRef.current) {
                    savedBaseRevisionRef.current = revisionRef.current;
                    void persistBase(revisionRef.current, baseRef.current);
                }
                sentRef.current = null;
                sendingRef.current = false;
                setStatus("connected");
                setError("");
                queueSend();
                return;
            }
            if (message.type === "storage_error") {
                if (message.clientId && message.clientId !== clientIdRef.current) return;
                sendingRef.current = false;
                sentRef.current = null;
                setStatus("error");
                setError("主机磁盘保存失败；当前修改仍保留在本机，恢复后重新同步。");
                return;
            }
            if (message.type !== "snapshot" || !message.project || typeof message.revision !== "number") return;
            if (message.rejectedClientId === clientIdRef.current) {
                sendingRef.current = false;
                sentRef.current = null;
            }
            const remote = message.project as SharedCanvasProject;
            const local = localProjectRef.current ? toSharedProject(localProjectRef.current) : null;
            const hadLocalEdits = Boolean(local && baseRef.current && !equalProjects(local, baseRef.current));
            const merged = baseRef.current && local ? mergeSharedProjects(baseRef.current, local, remote) : remote;
            const unchanged = equalProjects(local, merged);
            baseRef.current = remote;
            revisionRef.current = message.revision;
            if (message.revision >= savedBaseRevisionRef.current && !hadLocalEdits && !sendingRef.current && equalProjects(merged, remote)) {
                savedBaseRevisionRef.current = message.revision;
                void persistBase(message.revision, remote);
            }
            if (Array.isArray(message.assets)) knownAssetsRef.current = new Set(message.assets.filter((key): key is string => typeof key === "string"));
            const hydrated = await hydrateSharedProject(merged, roomId, token, knownAssetsRef.current);
            if (closed) return;
            applyingRef.current = true;
            useCanvasStore.getState().upsertProject(hydrated);
            window.setTimeout(() => {
                applyingRef.current = false;
            }, 0);
            localProjectRef.current = hydrated;
            if (!initializedRef.current || !isInitial && !unchanged) {
                if (initializedRef.current) setRemoteUpdate({ sequence: ++sequenceRef.current, project: hydrated });
                else void hydrated;
            }
            initializedRef.current = true;
            if (!equalProjects(merged, remote)) queueSend();
        };

        const start = async () => {
            if (starting || socket && socket.readyState < WebSocket.CLOSING) return;
            starting = true;
            setStatus("connecting");
            setError("");
            try {
                const snapshot = await getSharedRoom(roomId, token);
                await waitForCanvasHydration();
                if (closed) return;
                const savedBase = await loadSharedBase(roomId);
                const local = useCanvasStore.getState().projects.find((item) => item.id === projectId);
                const matchingBase = savedBase?.project.id === snapshot.project.id ? savedBase : null;
                const merged = matchingBase && matchingBase.revision > snapshot.revision ? local ? toSharedProject(local) : matchingBase.project : matchingBase && local ? mergeSharedProjects(matchingBase.project, toSharedProject(local), snapshot.project) : snapshot.project;
                const info = await getCollaborationInfo().catch(() => null);
                if (info?.aiProxyEnabled) {
                    try {
                        const modelNames = await getSharedProxyModels(roomId, token);
                        if (modelNames.length && !closed) {
                            const channelId = `shared-room-${roomId}`;
                            const channel: ModelChannel = {
                                id: channelId,
                                name: "主机 CLIProxy",
                                baseUrl: `${window.location.origin}/collaboration/rooms/${roomId}/ai`,
                                apiKey: token,
                                apiFormat: "openai",
                                models: modelNames.map((name) => ({ name, capability: guessCapability(name) })),
                            };
                            installRuntimeProxyChannel(channel);
                            runtimeChannelIdRef.current = channelId;
                        }
                    } catch {}
                }
                revisionRef.current = snapshot.revision;
                knownAssetsRef.current = new Set(snapshot.assets);
                baseRef.current = snapshot.project;
                savedBaseRevisionRef.current = matchingBase?.revision || 0;
                if (snapshot.revision >= savedBaseRevisionRef.current && equalProjects(merged, snapshot.project)) {
                    savedBaseRevisionRef.current = snapshot.revision;
                    await persistBase(snapshot.revision, snapshot.project);
                }
                const initialProject = await hydrateSharedProject(merged, roomId, token, knownAssetsRef.current);
                if (closed) return;
                applyingRef.current = true;
                useCanvasStore.getState().upsertProject(initialProject);
                window.setTimeout(() => {
                    applyingRef.current = false;
                }, 0);
                localProjectRef.current = initialProject;
                initializedRef.current = true;
                await rememberRoom(initialProject, roomId, token, new URLSearchParams(window.location.search).get("agentMode") === "host" ? "host" : "local");
                setRemoteUpdate({ sequence: ++sequenceRef.current, project: initialProject });
                let currentSocket: WebSocket;
                currentSocket = connectSharedRoom(roomId, token, (message) => {
                    if (!closed && socket === currentSocket) void receive(message);
                });
                socket = currentSocket;
                socketRef.current = currentSocket;
                currentSocket.addEventListener("open", () => {
                    if (!closed && socket === currentSocket) {
                        setStatus("connected");
                        if (!equalProjects(merged, snapshot.project)) queueSend();
                    }
                });
                currentSocket.addEventListener("close", (event) => {
                    if (closed) return;
                    if (socket === currentSocket) socket = null;
                    if (socketRef.current === currentSocket) socketRef.current = null;
                    sendingRef.current = false;
                    sentRef.current = null;
                    setStatus("error");
                    setError(event.code === 4401 ? "共享链接无效" : "与共享画布断开连接");
                });
                currentSocket.addEventListener("error", () => {
                    if (!closed) {
                        setStatus("error");
                        setError("无法连接共享画布服务");
                    }
                });
            } catch (cause) {
                if (closed) return;
                setStatus("error");
                setError(cause instanceof Error ? cause.message : "打开共享画布失败");
            } finally {
                starting = false;
            }
        };

        function queueSend() {
            if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
            sendTimerRef.current = setTimeout(() => void sendCurrent(), 250);
        }

        async function sendCurrent() {
            const current = useCanvasStore.getState().projects.find((item) => item.id === projectId);
            const base = baseRef.current;
            const socket = socketRef.current;
            if (!current || !base || !socket || sendingRef.current || preparingRef.current) return;
            const next = toSharedProject(current);
            if (equalProjects(base, next)) return;
            if (socket.readyState !== WebSocket.OPEN) return;
            preparingRef.current = true;
            try {
                await uploadAssets(roomId, token, next, knownAssetsRef.current);
                if (socket.readyState !== WebSocket.OPEN) return;
                sentRef.current = next;
                sendingRef.current = sendSharedUpdate(socket, { baseRevision: revisionRef.current, project: next, clientId: clientIdRef.current });
                if (!sendingRef.current) setStatus("error");
            } catch (cause) {
                setStatus("error");
                setError(cause instanceof Error ? cause.message : "同步画布失败");
            } finally {
                preparingRef.current = false;
                if (sendingRef.current) queueSend();
            }
        }

        const unsubscribe = useCanvasStore.subscribe((state) => {
            if (applyingRef.current) return;
            localProjectRef.current = state.projects.find((item) => item.id === projectId);
            if (initializedRef.current && localProjectRef.current) queueSend();
        });
        const flushPending = () => {
            if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
            sendTimerRef.current = null;
            void sendCurrent();
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === "hidden") flushPending();
            else if (!socket) void start();
            else flushPending();
        };
        const onFocus = () => { if (!socket) void start(); else flushPending(); };
        document.addEventListener("visibilitychange", onVisibilityChange);
        window.addEventListener("pagehide", flushPending);
        window.addEventListener("online", onFocus);
        window.addEventListener("focus", onFocus);
        void start();

        return () => {
            closed = true;
            unsubscribe();
            document.removeEventListener("visibilitychange", onVisibilityChange);
            window.removeEventListener("pagehide", flushPending);
            window.removeEventListener("online", onFocus);
            window.removeEventListener("focus", onFocus);
            if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
            socket?.close();
            if (socketRef.current === socket) socketRef.current = null;
            removeRuntimeProxyChannel(runtimeChannelIdRef.current);
            runtimeChannelIdRef.current = "";
        };
    }, [projectId, rememberRoom, roomId, token]);

    return { status, participants, error, recoveryWarning, createInvitation, remoteUpdate };
}

function installRuntimeProxyChannel(channel: ModelChannel) {
    useConfigStore.setState((state) => {
        const channels = [...state.config.channels.filter((item) => item.id !== channel.id), channel];
        return { config: { ...state.config, channels, models: modelOptionsFromChannels(channels) } };
    });
}

function removeRuntimeProxyChannel(channelId: string) {
    if (!channelId) return;
    useConfigStore.setState((state) => {
        const channels = state.config.channels.filter((item) => item.id !== channelId);
        const fallback = (value: string, key: "model" | "imageModel" | "videoModel" | "textModel" | "audioModel") => value.startsWith(`${channelId}::`) ? defaultConfig[key] : value;
        return { config: { ...state.config, channels, models: modelOptionsFromChannels(channels), model: fallback(state.config.model, "model"), imageModel: fallback(state.config.imageModel, "imageModel"), videoModel: fallback(state.config.videoModel, "videoModel"), textModel: fallback(state.config.textModel, "textModel"), audioModel: fallback(state.config.audioModel, "audioModel") } };
    });
}

function toSharedProject(project: CanvasProject): SharedCanvasProject {
    const nodes = project.nodes.map((node) => {
        const metadata = node.metadata ? { ...node.metadata } : undefined;
        if (metadata?.content && (metadata.content.startsWith("blob:") || metadata.content.startsWith("data:") && metadata.storageKey)) metadata.content = "";
        if (metadata?.images) metadata.images = metadata.images.map((image) => ({ ...image, content: image.storageKey && (image.content.startsWith("blob:") || image.content.startsWith("data:")) ? "" : image.content }));
        return metadata ? { ...node, metadata } : node;
    });
    return { ...project, nodes, chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 } };
}

function mergeSharedProjects(base: SharedCanvasProject, local: SharedCanvasProject, remote: SharedCanvasProject): SharedCanvasProject {
    const scalar = { ...remote };
    (Object.keys(remote) as Array<keyof SharedCanvasProject>).forEach((key) => {
        if (key === "nodes" || key === "connections" || key === "chatSessions" || key === "activeChatId" || key === "viewport") return;
        if (!equalProjects(local[key], base[key]) && equalProjects(remote[key], base[key])) (scalar as Record<string, unknown>)[key] = local[key];
    });
    return { ...scalar, nodes: mergeItems(base.nodes, local.nodes, remote.nodes), connections: mergeItems(base.connections, local.connections, remote.connections), chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 } };
}

function mergeItems<T extends { id: string }>(base: T[], local: T[], remote: T[]) {
    const before = new Map(base.map((item) => [item.id, item]));
    const ours = new Map(local.map((item) => [item.id, item]));
    const theirs = new Map(remote.map((item) => [item.id, item]));
    const ids = new Set([...before.keys(), ...ours.keys(), ...theirs.keys()]);
    const merged: T[] = [];
    ids.forEach((id) => {
        const original = before.get(id);
        const localItem = ours.get(id);
        const remoteItem = theirs.get(id);
        const localChanged = !equalProjects(localItem, original);
        const remoteChanged = !equalProjects(remoteItem, original);
        const selected = localChanged && !remoteChanged ? localItem : remoteChanged ? remoteItem : localChanged ? localItem : remoteItem;
        if (selected) merged.push(selected);
    });
    return merged;
}

function equalProjects(left: unknown, right: unknown) {
    return JSON.stringify(left) === JSON.stringify(right);
}

async function uploadAssets(roomId: string, token: string, project: SharedCanvasProject, known: Set<string>) {
    const keys = storageKeys(project.nodes);
    for (const key of keys) {
        if (known.has(key)) continue;
        const blob = key.startsWith("image:") ? await getImageBlob(key) : await getMediaBlob(key);
        if (!blob) throw new Error(`共享媒体在本机不存在：${key}`);
        await putSharedAsset(roomId, token, key, blob);
        known.add(key);
    }
}

function waitForCanvasHydration() {
    if (useCanvasStore.getState().hydrated) return Promise.resolve();
    return new Promise<void>((resolve) => {
        const unsubscribe = useCanvasStore.subscribe((state) => {
            if (!state.hydrated) return;
            unsubscribe();
            resolve();
        });
        if (useCanvasStore.getState().hydrated) {
            unsubscribe();
            resolve();
        }
    });
}

async function hydrateSharedProject(project: SharedCanvasProject, roomId: string, token: string, known: Set<string>): Promise<CanvasProject> {
    for (const key of storageKeys(project.nodes)) {
        if (!known.has(key)) continue;
        const existing = key.startsWith("image:") ? await getImageBlob(key) : await getMediaBlob(key);
        if (existing) continue;
        try {
            const blob = await getSharedAsset(roomId, token, key);
            if (key.startsWith("image:")) await setImageBlob(key, blob);
            else await setMediaBlob(key, blob);
        } catch {}
    }
    const nodes = await hydrateCanvasImages(project.nodes);
    const restoredNodes = await Promise.all(nodes.map(async (node) => {
        const key = node.metadata?.storageKey;
        if (!key || node.type === "image") return node;
        const content = await resolveMediaUrl(key, node.metadata?.content || "");
        return { ...node, metadata: { ...node.metadata, content } };
    }));
    return { ...project, nodes: restoredNodes };
}

function storageKeys(value: unknown, found = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return found;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) found.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => storageKeys(child, found)) : storageKeys(item, found)));
    return found;
}
