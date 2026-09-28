import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { request as httpRequest, createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import { parse as parseYaml } from "yaml";

const app = express();
const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
const port = Number(process.env.CANVAS_COLLAB_PORT || 17372);
const dataDir = resolve(process.env.CANVAS_COLLAB_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "data"));
const cliproxyConfig = await loadCliproxyConfig();
const cliproxyUrl = normalizeCliproxyUrl(process.env.CANVAS_COLLAB_CLIPROXY_URL?.trim() || cliproxyConfig?.url || "");
const cliproxyApiKey = process.env.CANVAS_COLLAB_CLIPROXY_API_KEY?.trim() || cliproxyConfig?.apiKey || "";
const agentEntry = resolve(process.env.CANVAS_COLLAB_AGENT_ENTRY?.trim() || fileURLToPath(new URL("../canvas-agent/src/index.ts", import.meta.url)));
const agentRunner = agentEntry.endsWith(".ts") ? resolve(dirname(agentEntry), "../node_modules/tsx/dist/cli.mjs") : "";
const participantSessions = new Map();
const participantAgents = new Map();
const participantChildren = new Set();
const rooms = new Map();
const roomSaves = new Map();
const assetNamePattern = /^[\w:-]{1,160}$/;
const roomIdPattern = /^[\w-]{20,64}$/;

await mkdir(join(dataDir, "rooms"), { recursive: true });
await loadRooms();
await loadParticipantSessions();
app.disable("x-powered-by");
app.use("/collaboration/rooms/:roomId/ai", proxySharedAi);
app.post("/collaboration/rooms/:roomId/agent/sessions", express.json(), createParticipantSession);
app.use("/collaboration/rooms/:roomId/agent", proxySharedAgent);
app.use(express.json({ limit: "32mb" }));
app.get("/collaboration/info", async (_req, res) => {
    const addresses = Object.values(networkInterfaces()).flatMap((items) => (items || []).filter((item) => item.family === "IPv4" && !item.internal).map((item) => item.address));
    const hostAgentEnabled = Boolean(cliproxyUrl && cliproxyApiKey) && await agentLauncherAvailable();
    res.json({ advertisedHost: process.env.CANVAS_COLLAB_ADVERTISE_HOST || addresses[0] || "", aiProxyEnabled: Boolean(cliproxyUrl && cliproxyApiKey), hostAgentEnabled });
});

app.post("/collaboration/rooms", async (req, res) => {
    if (!isProject(req.body?.project)) return res.status(400).json({ error: "Invalid canvas project" });
    const id = randomUUID().replaceAll("-", "");
    const token = randomBytes(32).toString("base64url");
    const room = { id, tokenHash: hash(token), revision: 1, project: sharedProject(req.body.project), assets: [], clients: new Set() };
    await saveRoom(room);
    rooms.set(id, room);
    res.status(201).json({ roomId: id, token, revision: room.revision, project: room.project });
});

app.get("/collaboration/rooms/:roomId", (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room) return res.sendStatus(404);
    if (!authorized(req, room)) return res.sendStatus(401);
    res.json({ roomId: room.id, revision: room.revision, project: room.project, assets: room.assets });
});

app.put("/collaboration/rooms/:roomId/assets/:assetKey", async (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room) return res.sendStatus(404);
    if (!authorized(req, room)) return res.sendStatus(401);
    const key = req.params.assetKey;
    if (!assetNamePattern.test(key)) return res.sendStatus(400);
    if (String(req.headers["content-type"] || "").split(";", 1)[0].trim() !== "application/octet-stream") return res.sendStatus(415);
    const path = assetPath(room.id, key);
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = path + "." + randomUUID() + ".tmp";
    const maxBytes = 500 * 1024 * 1024;
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > maxBytes) {
        req.resume();
        return res.status(413).json({ error: "Asset exceeds the 500 MB limit" });
    }
    const output = createWriteStream(temporaryPath, { flags: "wx" });
    let outputError;
    output.on("error", (error) => { outputError = error; });
    const outputClosed = once(output, "close").catch(() => {});
    let size = 0;
    let oversized = false;
    try {
        for await (const chunk of req) {
            if (outputError) throw outputError;
            if (oversized) continue;
            size += chunk.length;
            if (size > maxBytes) {
                oversized = true;
                continue;
            }
            if (!output.write(chunk)) await once(output, "drain");
        }
        if (outputError) throw outputError;
        if (oversized) {
            output.destroy();
            await outputClosed;
            await unlink(temporaryPath).catch(() => {});
            return res.status(413).json({ error: "Asset exceeds the 500 MB limit" });
        }
        output.end();
        await once(output, "finish");
        await outputClosed;
        await rename(temporaryPath, path);
    } catch {
        output.destroy();
        await outputClosed;
        await unlink(temporaryPath).catch(() => {});
        return res.status(500).json({ error: "Unable to persist shared asset" });
    }
    if (!room.assets.includes(key)) room.assets.push(key);
    await saveRoom(room);
    res.sendStatus(204);
});

app.get("/collaboration/rooms/:roomId/assets/:assetKey", (req, res) => {
    const room = getRoom(req.params.roomId);
    if (!room) return res.sendStatus(404);
    if (!authorized(req, room)) return res.sendStatus(401);
    const key = req.params.assetKey;
    if (!assetNamePattern.test(key) || !room.assets.includes(key)) return res.sendStatus(404);
    const input = createReadStream(assetPath(room.id, key));
    input.on("error", () => {
        if (!res.headersSent) res.sendStatus(404);
        else res.destroy();
    });
    res.type("application/octet-stream");
    input.pipe(res);
});

server.on("upgrade", (req, socket, head) => {
    let match;
    try {
        match = new URL(req.url || "", "http://localhost").pathname.match(/^\/collaboration\/rooms\/([\w-]+)\/socket$/);
    } catch {}
    const room = match && getRoom(match[1]);
    const protocols = String(req.headers["sec-websocket-protocol"] || "").split(",").map((value) => value.trim());
    if (!room || !protocols.includes("infinite-canvas-collab-v1")) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
    }
    sockets.handleUpgrade(req, socket, head, (client) => sockets.emit("connection", client, req, room));
});

sockets.on("connection", (client, _req, room) => {
    let authenticated = false;
    const timeout = setTimeout(() => client.close(4401, "Authentication required"), 5000);
    client.on("message", async (raw) => {
        let message;
        try {
            message = JSON.parse(raw.toString());
        } catch {
            client.close(4400, "Invalid message");
            return;
        }
        if (!authenticated) {
            if (message.type !== "auth" || !validToken(message.token, room.tokenHash)) {
                client.close(4401, "Invalid invitation");
                return;
            }
            authenticated = true;
            clearTimeout(timeout);
            room.clients.add(client);
            client.send(JSON.stringify({ type: "snapshot", revision: room.revision, project: room.project, assets: room.assets }));
            broadcast(room, { type: "presence", count: room.clients.size });
            return;
        }
        if (message.type !== "sync" || !isProject(message.project) || !Number.isInteger(message.baseRevision)) return;
        if (message.baseRevision !== room.revision) {
            client.send(JSON.stringify({ type: "snapshot", revision: room.revision, project: room.project, assets: room.assets, rejectedClientId: message.clientId }));
            return;
        }
        const previousProject = room.project;
        const previousRevision = room.revision;
        room.project = sharedProject(message.project);
        room.revision += 1;
        try {
            await saveRoom(room);
        } catch {
            if (room.revision === previousRevision + 1) {
                room.project = previousProject;
                room.revision = previousRevision;
            }
            client.send(JSON.stringify({ type: "storage_error" }));
            return;
        }
        broadcast(room, { type: "snapshot", revision: room.revision, project: room.project, assets: room.assets, clientId: message.clientId }, client);
        client.send(JSON.stringify({ type: "ack", revision: room.revision, clientId: message.clientId }));
    });
    client.on("close", () => {
        clearTimeout(timeout);
        if (room.clients.delete(client)) broadcast(room, { type: "presence", count: room.clients.size });
    });
});

const bindHost = process.env.CANVAS_COLLAB_BIND_HOST || "0.0.0.0";
server.listen(port, bindHost, () => console.log(`Canvas collaboration server listening on ${bindHost}:${port}`));

function getRoom(id) {
    if (!roomIdPattern.test(id)) return null;
    return rooms.get(id) || null;
}

async function loadRooms() {
    for (const file of await readdir(join(dataDir, "rooms"))) {
        if (!file.endsWith(".json")) continue;
        try {
            const saved = JSON.parse(await readFile(join(dataDir, "rooms", file), "utf8"));
            if (roomIdPattern.test(saved.id) && isProject(saved.project) && typeof saved.tokenHash === "string" && Array.isArray(saved.assets)) rooms.set(saved.id, { ...saved, clients: new Set() });
        } catch {}
    }
}

function isProject(value) {
    return Boolean(value && typeof value === "object" && typeof value.id === "string" && typeof value.title === "string" && Array.isArray(value.nodes) && Array.isArray(value.connections));
}

function sharedProject(project) {
    const { chatSessions: _sessions, activeChatId: _active, viewport: _viewport, ...shared } = project;
    return { ...shared, chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 } };
}

function validToken(token, expectedHash) {
    if (typeof token !== "string") return false;
    const actual = Buffer.from(hash(token), "hex");
    const expected = Buffer.from(expectedHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function authorized(req, room) {
    const value = String(req.headers.authorization || "");
    return value.startsWith("Bearer ") && validToken(value.slice(7), room.tokenHash);
}

function proxySharedAi(req, res) {
    const room = getRoom(req.params.roomId);
    if (!room) return res.sendStatus(404);
    if (!authorized(req, room)) return res.sendStatus(401);
    if (!cliproxyUrl || !cliproxyApiKey) return res.status(503).json({ error: { message: "Host CLIProxy is not configured" } });

    let target;
    try {
        const requestUrl = new URL(req.originalUrl, "http://localhost");
        const prefix = `/collaboration/rooms/${room.id}/ai`;
        if (!requestUrl.pathname.startsWith(`${prefix}/`)) return res.sendStatus(404);
        target = new URL(cliproxyUrl);
        if (!/^https?:$/.test(target.protocol) || target.username || target.password) return res.status(503).json({ error: { message: "Invalid host CLIProxy URL" } });
        target.pathname = `${target.pathname.replace(/\/$/, "")}${requestUrl.pathname.slice(prefix.length)}`;
        target.search = requestUrl.search;
    } catch {
        return res.status(503).json({ error: { message: "Invalid host CLIProxy URL" } });
    }

    const headers = { ...req.headers, host: target.host, authorization: `Bearer ${cliproxyApiKey}` };
    ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "cookie"].forEach((header) => delete headers[header]);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = send(target, { method: req.method, headers }, (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
    });
    upstream.on("error", () => {
        if (!res.headersSent) res.status(502).json({ error: { message: "Host CLIProxy is unavailable" } });
        else res.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
}

async function createParticipantSession(req, res) {
    const room = getRoom(req.params.roomId);
    if (!room) return res.sendStatus(404);
    if (!authorized(req, room)) return res.sendStatus(401);
    if (!cliproxyUrl || !cliproxyApiKey || !await agentLauncherAvailable()) return res.status(503).json({ error: "Host Canvas Agent is unavailable" });
    const existingToken = req.body?.participantToken;
    if (existingToken !== undefined && (typeof existingToken !== "string" || !/^[\w-]{40,64}$/.test(existingToken))) return res.sendStatus(400);
    const sessions = participantSessions.get(room.id) || new Map();
    let participant = existingToken ? sessions.get(hash(existingToken)) : null;
    if (existingToken && !participant) return res.status(401).json({ error: "Participant session is unavailable" });
    let participantToken = existingToken;
    if (!participant) {
        participantToken = randomBytes(32).toString("base64url");
        participant = { id: randomUUID().replaceAll("-", ""), tokenHash: hash(participantToken) };
        const directory = participantDirectory(room.id, participant.id);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "session.json"), JSON.stringify(participant), { flag: "wx" });
        sessions.set(participant.tokenHash, participant);
        participantSessions.set(room.id, sessions);
    }
    const cookiePath = `/collaboration/rooms/${room.id}/agent`;
    const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `canvas_agent_${room.id}=${participantToken}; Path=${cookiePath}; HttpOnly; SameSite=Strict${secure}`);
    res.setHeader("Cache-Control", "no-store");
    res.json({ agentUrl: cookiePath, participantToken });
}

async function proxySharedAgent(req, res) {
    const room = getRoom(req.params.roomId);
    if (!room) return res.sendStatus(404);
    const prefix = `/collaboration/rooms/${room.id}/agent`;
    const incoming = new URL(req.originalUrl, "http://localhost");
    if (!incoming.pathname.startsWith(`${prefix}/`) || incoming.pathname === `${prefix}/sessions`) return res.sendStatus(404);
    const cookie = String(req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`canvas_agent_${room.id}=`));
    const participantToken = cookie?.slice(`canvas_agent_${room.id}=`.length) || "";
    const participant = participantSessions.get(room.id)?.get(hash(participantToken));
    if (!participant || !validToken(participantToken, participant.tokenHash)) return res.sendStatus(401);

    let agent;
    try {
        agent = await ensureParticipantAgent(room.id, participant.id);
    } catch {
        return res.status(503).json({ error: "Participant Canvas Agent is unavailable" });
    }
    const target = new URL(`http://127.0.0.1:${agent.port}`);
    target.pathname = incoming.pathname.slice(prefix.length);
    incoming.searchParams.delete("token");
    target.search = incoming.searchParams.toString();
    const headers = { ...req.headers, host: target.host, "x-canvas-agent-token": agent.token };
    ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "cookie", "origin", "authorization"].forEach((header) => delete headers[header]);
    const upstream = httpRequest(target, { method: req.method, headers }, (response) => {
        res.writeHead(response.statusCode || 502, { ...response.headers, "cache-control": "no-store" });
        response.pipe(res);
    });
    upstream.on("error", () => {
        if (!res.headersSent) res.status(502).json({ error: "Participant Canvas Agent is unavailable" });
        else res.destroy();
    });
    req.on("aborted", () => upstream.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
}

function participantDirectory(roomId, participantId) {
    return join(dataDir, "agents", roomId, participantId);
}

async function loadParticipantSessions() {
    for (const roomId of await readdir(join(dataDir, "agents")).catch(() => [])) {
        if (!rooms.has(roomId)) continue;
        const sessions = new Map();
        for (const id of await readdir(join(dataDir, "agents", roomId)).catch(() => [])) {
            if (!/^[a-f0-9]{32}$/.test(id)) continue;
            try {
                const value = JSON.parse(await readFile(join(participantDirectory(roomId, id), "session.json"), "utf8"));
                if (value.id === id && /^[a-f0-9]{64}$/.test(value.tokenHash)) sessions.set(value.tokenHash, value);
            } catch {}
        }
        participantSessions.set(roomId, sessions);
    }
}

async function agentLauncherAvailable() {
    try {
        await access(agentEntry);
        if (agentRunner) await access(agentRunner);
        return true;
    } catch {
        return false;
    }
}

async function ensureParticipantAgent(roomId, participantId) {
    const key = `${roomId}:${participantId}`;
    let pending = participantAgents.get(key);
    if (!pending) {
        pending = startParticipantAgent(roomId, participantId, key).catch((error) => {
            if (participantAgents.get(key) === pending) participantAgents.delete(key);
            throw error;
        });
        participantAgents.set(key, pending);
    }
    return await pending;
}

async function startParticipantAgent(roomId, participantId, key) {
    const directory = participantDirectory(roomId, participantId);
    const configPath = join(directory, "canvas-agent.json");
    let config;
    try {
        config = JSON.parse(await readFile(configPath, "utf8"));
        if (typeof config.token !== "string" || !config.token) throw new Error("Invalid participant Agent config");
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        config = { token: randomBytes(18).toString("hex"), url: "http://127.0.0.1:0" };
        await writeFile(configPath, JSON.stringify(config), { flag: "wx" });
    }
    const port = await availableLoopbackPort();
    const codexDirectory = join(directory, "codex-home");
    await mkdir(codexDirectory, { recursive: true });
    const child = spawn(process.execPath, [...(agentRunner ? [agentRunner] : []), agentEntry], {
        cwd: dirname(agentEntry),
        env: {
            ...process.env,
            PORT: String(port),
            CODEX_HOME: codexDirectory,
            CANVAS_AGENT_CONFIG_DIR: directory,
            CANVAS_AGENT_CLIPROXY_BASE_URL: `${cliproxyUrl}/v1`,
            CANVAS_AGENT_CLIPROXY_API_KEY: cliproxyApiKey,
            ...(process.env.CANVAS_COLLAB_CLIPROXY_CONFIG ? { CANVAS_AGENT_CLIPROXY_CONFIG: process.env.CANVAS_COLLAB_CLIPROXY_CONFIG } : {}),
        },
        stdio: "ignore",
        windowsHide: true,
    });
    participantChildren.add(child);
    child.on("error", () => participantChildren.delete(child));
    child.on("exit", () => {
        participantChildren.delete(child);
        const current = participantAgents.get(key);
        if (current) void current.then((agent) => {
            if (agent.child === child && participantAgents.get(key) === current) participantAgents.delete(key);
        }).catch(() => {});
    });
    await new Promise((resolveReady, rejectReady) => {
        let settled = false;
        const fail = (error) => {
            if (settled) return;
            settled = true;
            rejectReady(error);
        };
        child.once("error", fail);
        child.once("exit", () => fail(new Error("Participant Agent exited before startup")));
        const check = async () => {
            if (settled) return;
            try {
                const response = await fetch(`http://127.0.0.1:${port}/agent/codex/workspace`, { headers: { "x-canvas-agent-token": config.token } });
                if (response.ok) {
                    settled = true;
                    return resolveReady();
                }
            } catch {}
            if (!settled) setTimeout(check, 200);
        };
        void check();
    });
    return { port, token: config.token, child };
}

async function availableLoopbackPort() {
    const probe = createTcpServer();
    await new Promise((resolveReady, rejectReady) => probe.once("error", rejectReady).listen(0, "127.0.0.1", resolveReady));
    const port = probe.address().port;
    await new Promise((resolveClosed) => probe.close(resolveClosed));
    return port;
}

process.on("exit", () => participantChildren.forEach((child) => child.kill()));

async function loadCliproxyConfig() {
    const configPath = process.env.CANVAS_COLLAB_CLIPROXY_CONFIG?.trim();
    if (!configPath) return null;
    try {
        const config = parseYaml(await readFile(resolve(configPath), "utf8"));
        const host = String(config?.host || "127.0.0.1").trim();
        const port = Number(config?.port || 8317);
        const keys = config?.["api-keys"];
        const apiKey = Array.isArray(keys) ? String(keys.find((value) => typeof value === "string" && value.trim()) || "").trim() : "";
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || !apiKey) return null;
        const protocol = config?.tls?.enable === true ? "https" : "http";
        return { url: protocol + "://" + host + ":" + port, apiKey };
    } catch {
        return null;
    }
}

function normalizeCliproxyUrl(value) {
    try {
        const target = new URL(value);
        if (!/^https?:$/.test(target.protocol) || target.username || target.password) return "";
        target.search = "";
        target.hash = "";
        target.pathname = target.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "");
        return target.toString().replace(/\/$/, "");
    } catch {
        return "";
    }
}

function hash(token) {
    return createHash("sha256").update(token).digest("hex");
}

function roomFile(id) {
    return join(dataDir, "rooms", `${id}.json`);
}

function assetPath(id, key) {
    return join(dataDir, "rooms", id, "assets", hash(key));
}

function saveRoom(room) {
    const previous = roomSaves.get(room.id) || Promise.resolve();
    const saved = previous.catch(() => {}).then(async () => {
        const path = roomFile(room.id);
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify({ id: room.id, tokenHash: room.tokenHash, revision: room.revision, project: room.project, assets: room.assets }));
        await rename(temporaryPath, path);
    });
    roomSaves.set(room.id, saved);
    void saved.then(() => { if (roomSaves.get(room.id) === saved) roomSaves.delete(room.id); }, () => { if (roomSaves.get(room.id) === saved) roomSaves.delete(room.id); });
    return saved;
}

function broadcast(room, message, except) {
    const value = JSON.stringify(message);
    room.clients.forEach((client) => {
        if (client !== except && client.readyState === 1) client.send(value);
    });
}
