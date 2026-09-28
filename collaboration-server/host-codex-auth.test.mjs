import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import { createServer as createTcpServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTeamSessions } from "./team-sessions.mjs";

let child;
let mock;
let mockBaseUrl;
let baseUrl;
let dataDir;
let callbackBody;

async function availablePort() {
    const probe = createTcpServer();
    await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    return port;
}

function websocketUpgradeStatus(cookie = "") {
    return new Promise((resolve, reject) => {
        const request = httpRequest(`${baseUrl}/collaboration/rooms/${"a".repeat(32)}/socket`, {
            headers: {
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Protocol": "infinite-canvas-collab-v1",
                ...(cookie ? { Cookie: cookie } : {}),
            },
        });
        request.once("response", (response) => {
            response.resume();
            resolve(response.statusCode);
        });
        request.once("upgrade", (_response, socket) => {
            socket.destroy();
            resolve(101);
        });
        request.once("error", reject);
        request.end();
    });
}

before(async () => {
    const mockPort = await availablePort();
    const port = await availablePort();
    mockBaseUrl = `http://127.0.0.1:${mockPort}`;
    baseUrl = `http://127.0.0.1:${port}`;
    mock = createHttpServer(async (req, res) => {
        if (req.url === "/v0/management/codex-auth-url") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ url: "https://auth.example/codex", state: "test-state" }));
            return;
        }
        if (req.url === "/v0/management/oauth-callback") {
            let body = "";
            for await (const chunk of req) body += chunk;
            callbackBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok" }));
            return;
        }
        res.writeHead(404).end();
    });
    mock.listen(mockPort, "127.0.0.1");
    await once(mock, "listening");
    dataDir = await mkdtemp(join(tmpdir(), "canvas-collab-test-"));
    const configPath = join(dataDir, "cliproxy.yaml");
    await writeFile(configPath, "host: 127.0.0.1\nport: 8317\napi-keys:\n  - test-api-key\nremote-management:\n  secret-key: test-management-key\n");
    child = spawn(process.execPath, [join(import.meta.dirname, "server.mjs")], {
        cwd: import.meta.dirname,
        env: { ...process.env, CANVAS_COLLAB_PORT: String(port), CANVAS_COLLAB_BIND_HOST: "127.0.0.1", CANVAS_COLLAB_DATA_DIR: dataDir, CANVAS_COLLAB_TEAM_LOGIN_REQUIRED: "true", CANVAS_COLLAB_CLIPROXY_CONFIG: configPath, CANVAS_COLLAB_CLIPROXY_MANAGEMENT_KEY: "", CANVAS_COLLAB_CLIPROXY_MANAGEMENT_URL: mockBaseUrl },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    const deadline = Date.now() + 5000;
    while (!output.includes("listening on") && Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`Collaboration server exited during startup: ${output}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!output.includes("listening on")) throw new Error(`Collaboration server did not start: ${output}`);
});

after(async () => {
    if (child && child.exitCode === null) {
        child.kill();
        await once(child, "exit");
    }
    if (mock?.listening) {
        mock.close();
        await once(mock, "close");
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("lets team users start and complete host Codex login without administrator credentials", async () => {
    const unauthenticatedInfo = await fetch(`${baseUrl}/collaboration/info`);
    assert.equal(unauthenticatedInfo.status, 401);

    const loginResponse = await fetch(`${baseUrl}/collaboration/session/login`, {
        method: "POST",
        headers: { "X-Canvas-Team-User": "test-user", "X-Forwarded-Proto": "https" },
    });
    assert.equal(loginResponse.status, 200);
    assert.deepEqual(await loginResponse.json(), { authenticated: true });
    const setCookie = loginResponse.headers.get("set-cookie");
    assert.match(setCookie || "", /HttpOnly/);
    assert.match(setCookie || "", /Secure/);
    assert.match(setCookie || "", /SameSite=Strict/);
    const cookie = setCookie?.split(";", 1)[0];
    assert.ok(cookie);
    assert.equal(await websocketUpgradeStatus(), 401);
    assert.equal(await websocketUpgradeStatus(cookie), 404);

    const infoResponse = await fetch(`${baseUrl}/collaboration/info`, { headers: { Cookie: cookie } });
    assert.equal(infoResponse.status, 200);
    const info = await infoResponse.json();
    assert.equal(info.teamLoginRequired, true);
    assert.equal(info.hostCodexLoginEnabled, true);
    assert.equal(JSON.stringify(info).includes("test-management-key"), false);

    const login = await (await fetch(`${baseUrl}/collaboration/host-codex-auth`, { headers: { Cookie: cookie } })).json();
    assert.deepEqual(login, { url: "https://auth.example/codex" });
    assert.equal(JSON.stringify(login).includes("test-management-key"), false);

    const invalidCallbackResponse = await fetch(`${baseUrl}/collaboration/host-codex-auth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ redirectUrl: "http://localhost:1455/auth/callback?state=wrong-state&code=test-code" }),
    });
    assert.equal(invalidCallbackResponse.status, 400);

    const callbackResponse = await fetch(`${baseUrl}/collaboration/host-codex-auth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ redirectUrl: "http://localhost:1455/auth/callback?state=test-state&code=test-code" }),
    });
    assert.equal(callbackResponse.status, 200);
    assert.deepEqual(await callbackResponse.json(), { status: "ok" });
    assert.deepEqual(callbackBody, { provider: "codex", redirect_url: "http://localhost:1455/auth/callback?state=test-state&code=test-code" });
});

test("rejects missing or forged team-session cookies without a Basic Auth challenge", async () => {
    for (const cookie of ["canvas_team_session=not-a-session", "canvas_team_session=%E0%A4%A"]) {
        const response = await fetch(`${baseUrl}/collaboration/info`, { headers: { Cookie: cookie } });
        assert.equal(response.status, 401);
        assert.equal(response.headers.has("www-authenticate"), false);
    }
});

test("keeps local collaboration open when team login is not configured", () => {
    const sessions = createTeamSessions(false);
    assert.equal(sessions.isAuthenticated({ headers: {} }), true);
});
