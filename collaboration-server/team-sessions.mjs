import { createHash, randomBytes } from "node:crypto";

const COOKIE_NAME = "canvas_team_session";

export function createTeamSessions(required = true) {
    const sessions = new Set();

    function sessionHash(token) {
        return createHash("sha256").update(token).digest("hex");
    }

    function tokenFromRequest(req) {
        const cookies = String(req.headers.cookie || "").split(";");
        const entry = cookies.map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
        try {
            return entry ? decodeURIComponent(entry.slice(COOKIE_NAME.length + 1)) : "";
        } catch {
            return "";
        }
    }

    function isAuthenticated(req) {
        if (!required) return true;
        const token = tokenFromRequest(req);
        return Boolean(token && sessions.has(sessionHash(token)));
    }

    function create(req, res) {
        const token = randomBytes(32).toString("base64url");
        sessions.add(sessionHash(token));
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.setHeader("Set-Cookie", `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure}`);
    }

    function clear(req, res) {
        const token = tokenFromRequest(req);
        if (token) sessions.delete(sessionHash(token));
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
    }

    function requireSession(req, res, next) {
        if (!required) return next();
        if (isAuthenticated(req)) return next();
        res.status(401).json({ error: "Team login required" });
    }

    return { create, clear, isAuthenticated, requireSession, required };
}
