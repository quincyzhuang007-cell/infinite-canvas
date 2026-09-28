import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { localForageStorage } from "@/lib/localforage-storage";

const COLLAB_PATH = "/collaboration";
const SAVED_ROOMS_KEY = "infinite-canvas:shared_rooms";
const SAVED_BASE_PREFIX = "infinite-canvas:shared_base:";
let roomListWrite = Promise.resolve();

export type RememberedSharedRoom = { projectId: string; roomId: string; token: string; title: string; agentMode: "host" | "local"; openedAt: number };

export class CollaborationHttpError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

export type SharedCanvasProject = Omit<CanvasProject, "chatSessions" | "activeChatId" | "viewport"> & {
    chatSessions: [];
    activeChatId: null;
    viewport: { x: number; y: number; k: number };
};

export type SharedRoomSnapshot = { roomId: string; revision: number; project: SharedCanvasProject; assets: string[] };
export type CollaborationInfo = { advertisedHost: string; aiProxyEnabled: boolean; hostAgentEnabled: boolean; hostCodexLoginEnabled?: boolean; teamLoginRequired?: boolean };

export async function getTeamSession() {
    const response = await fetch(`${COLLAB_PATH}/session`, { credentials: "same-origin" });
    if (!response.ok) throw new Error("无法检查团队登录状态");
    return (await response.json()) as { required: boolean; authenticated: boolean };
}

export async function loginTeam(username: string, password: string) {
    const credentials = new TextEncoder().encode(`${username}:${password}`);
    const authorization = btoa(Array.from(credentials, (byte) => String.fromCharCode(byte)).join(""));
    const response = await fetch(`${COLLAB_PATH}/session/login`, {
        method: "POST",
        headers: { Authorization: `Basic ${authorization}` },
        credentials: "same-origin",
    });
    const result = await response.json().catch(() => null) as { authenticated?: boolean; error?: string } | null;
    if (!response.ok) throw new Error(result?.error || "用户名或密码错误");
    return result?.authenticated === true;
}

export async function loadSharedBase(roomId: string): Promise<Pick<SharedRoomSnapshot, "revision" | "project"> | null> {
    try {
        const raw = await localForageStorage.getItem(`${SAVED_BASE_PREFIX}${roomId}`);
        if (!raw) return null;
        const value = JSON.parse(raw) as Pick<SharedRoomSnapshot, "revision" | "project">;
        return Number.isInteger(value.revision) && typeof value.project?.id === "string" && Array.isArray(value.project.nodes) && Array.isArray(value.project.connections) ? value : null;
    } catch {
        return null;
    }
}

export async function saveSharedBase(roomId: string, revision: number, project: SharedCanvasProject) {
    await localForageStorage.setItem(`${SAVED_BASE_PREFIX}${roomId}`, JSON.stringify({ revision, project }));
}

export async function listRememberedSharedRooms(): Promise<RememberedSharedRoom[]> {
    const value = JSON.parse((await localForageStorage.getItem(SAVED_ROOMS_KEY)) || "[]") as unknown;
    if (!Array.isArray(value)) throw new Error("Invalid shared room list");
    return value.filter((room): room is RememberedSharedRoom => Boolean(room && typeof room.projectId === "string" && /^[\w-]{20,64}$/.test(room.roomId) && typeof room.token === "string" && /^[\w-]{20,128}$/.test(room.token) && typeof room.title === "string" && (room.agentMode === "host" || room.agentMode === "local") && typeof room.openedAt === "number"));
}

export function rememberSharedRoom(project: Pick<CanvasProject, "id" | "title">, roomId: string, token: string, agentMode: "host" | "local" = "local") {
    roomListWrite = roomListWrite.catch(() => {}).then(async () => {
        const rooms = (await listRememberedSharedRooms()).filter((room) => room.roomId !== roomId);
        rooms.unshift({ projectId: project.id, roomId, token, title: project.title, agentMode, openedAt: Date.now() });
        await localForageStorage.setItem(SAVED_ROOMS_KEY, JSON.stringify(rooms));
    });
    return roomListWrite;
}

export function rememberedSharedRoomPath(room: RememberedSharedRoom) {
    const params = new URLSearchParams({ collab: room.roomId, invite: room.token });
    if (room.agentMode === "host") params.set("agentMode", "host");
    return `/canvas/${encodeURIComponent(room.projectId)}?${params.toString()}`;
}

export async function getCollaborationInfo() {
    const response = await fetch(`${COLLAB_PATH}/info`);
    if (!response.ok) throw new Error("无法读取共享服务信息");
    return (await response.json()) as CollaborationInfo;
}

export async function startHostCodexLogin() {
    const response = await fetch(`${COLLAB_PATH}/host-codex-auth`);
    if (!response.ok) throw new Error(`启动 Codex 登录失败（${response.status}）`);
    return (await response.json()) as { url: string };
}

export async function submitHostCodexCallback(redirectUrl: string) {
    const response = await fetch(`${COLLAB_PATH}/host-codex-auth/callback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirectUrl }) });
    if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error || `确认 Codex 登录失败（${response.status}）`);
    }
    return (await response.json()) as { status: "ok" };
}

export async function createSharedRoom(project: SharedCanvasProject) {
    const response = await fetch(`${COLLAB_PATH}/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project }) });
    if (!response.ok) throw new Error(`创建共享画布失败（${response.status}）`);
    return (await response.json()) as { roomId: string; token: string; revision: number; project: SharedCanvasProject };
}

export async function getSharedRoom(roomId: string, token: string) {
    const response = await fetch(`${COLLAB_PATH}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (!response.ok) throw new Error(response.status === 401 ? "共享链接无效" : `打开共享画布失败（${response.status}）`);
    return (await response.json()) as SharedRoomSnapshot;
}

export async function getSharedProxyModels(roomId: string, token: string) {
    const response = await fetch(`${COLLAB_PATH}/rooms/${encodeURIComponent(roomId)}/ai/v1/models`, { headers: authHeaders(token) });
    if (!response.ok) throw new Error(`读取主机 CLIProxy 模型失败（${response.status}）`);
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return (data.data || []).map((model) => model.id).filter((id): id is string => Boolean(id));
}

export async function registerHostAgentSession(roomId: string, inviteToken: string, participantToken?: string) {
    const response = await fetch(`${COLLAB_PATH}/rooms/${encodeURIComponent(roomId)}/agent/sessions`, {
        method: "POST",
        headers: { ...authHeaders(inviteToken), "Content-Type": "application/json" },
        body: JSON.stringify({ participantToken }),
    });
    if (!response.ok) throw new CollaborationHttpError(`连接主机 Agent 失败（${response.status}）`, response.status);
    return (await response.json()) as { agentUrl: string; participantToken: string };
}

export function connectSharedRoom(roomId: string, token: string, onMessage: (message: Record<string, unknown>) => void) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}${COLLAB_PATH}/rooms/${encodeURIComponent(roomId)}/socket`, "infinite-canvas-collab-v1");
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    socket.addEventListener("message", (event) => {
        try {
            const message = JSON.parse(String(event.data)) as Record<string, unknown>;
            onMessage(message);
        } catch {}
    });
    return socket;
}

export function sendSharedUpdate(socket: WebSocket, update: { baseRevision: number; project: SharedCanvasProject; clientId: string }) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type: "sync", ...update }));
    return true;
}

export async function putSharedAsset(roomId: string, token: string, key: string, blob: Blob) {
    const response = await fetch(assetUrl(roomId, key), { method: "PUT", headers: { ...authHeaders(token), "Content-Type": "application/octet-stream" }, body: blob });
    if (!response.ok) throw new Error(`共享媒体上传失败（${response.status}）`);
}

export async function getSharedAsset(roomId: string, token: string, key: string) {
    const response = await fetch(assetUrl(roomId, key), { headers: authHeaders(token) });
    if (!response.ok) throw new Error(`共享媒体下载失败（${response.status}）`);
    return response.blob();
}

function assetUrl(roomId: string, key: string) {
    return `${COLLAB_PATH}/rooms/${encodeURIComponent(roomId)}/assets/${encodeURIComponent(key)}`;
}

function authHeaders(token: string) {
    return { Authorization: `Bearer ${token}` };
}
