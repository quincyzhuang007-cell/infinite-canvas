#!/usr/bin/env bash
set -euo pipefail

site="https://canvas.qinyuanhangzhou.top"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

root_status="$(curl -sS -o /dev/null -w '%{http_code}' "$site/")"
session_body="$(curl -sS "$site/collaboration/session")"
api_status="$(curl -sS -D "$temp_dir/api.headers" -o /dev/null -w '%{http_code}' "$site/collaboration/info")"
if grep -qi '^WWW-Authenticate:' "$temp_dir/api.headers"; then
    echo "FAIL: unauthenticated API returned a browser auth challenge"
    exit 1
fi

login_status="$(curl -sS --user invalid-user:invalid-password -X POST -D "$temp_dir/login.headers" -o "$temp_dir/login.body" -w '%{http_code}' "$site/collaboration/session/login")"
if [[ "$login_status" != 200 ]] || ! grep -q '"authenticated":false' "$temp_dir/login.body"; then
    echo "FAIL: invalid login did not return a normal in-page login failure"
    exit 1
fi

internal_status="$(curl -sS -D "$temp_dir/session.headers" -o /dev/null -w '%{http_code}' -H 'X-Canvas-Team-User: deployment-smoke-test' -H 'X-Forwarded-Proto: https' -X POST http://127.0.0.1:17372/collaboration/session/login)"
cookie="$(sed -n 's/^Set-Cookie: canvas_team_session=\([^;]*\).*/\1/ip' "$temp_dir/session.headers" | tr -d '\r')"
if ! grep -qi 'HttpOnly' "$temp_dir/session.headers" || ! grep -qi 'Secure' "$temp_dir/session.headers" || ! grep -qi 'SameSite=Strict' "$temp_dir/session.headers"; then
    echo "FAIL: session cookie is missing a required security attribute"
    exit 1
fi
auth_status="$(curl -sS --cookie "canvas_team_session=$cookie" -o "$temp_dir/info.json" -w '%{http_code}' "$site/collaboration/info")"

if [[ "$root_status" != 200 || "$api_status" != 401 || "$login_status" != 200 || "$internal_status" != 200 || "$auth_status" != 200 ]]; then
    echo "FAIL: unexpected HTTP statuses root=$root_status api=$api_status login=$login_status internal=$internal_status cookie_api=$auth_status"
    exit 1
fi
for flag in '"teamLoginRequired":true' '"aiProxyEnabled":true' '"hostCodexLoginEnabled":true'; do
    if ! grep -q "$flag" "$temp_dir/info.json"; then
        echo "FAIL: authenticated collaboration info is missing an expected enabled feature"
        exit 1
    fi
done
echo "PASS: public app loads, APIs reject anonymous users without Basic challenges, login errors stay in-page, secure session cookies authorize APIs, and host CLIProxy/Codex login remain enabled"
echo "Observed statuses: root=$root_status anonymous_api=$api_status invalid_login=$login_status session_issue=$internal_status cookie_api=$auth_status"
