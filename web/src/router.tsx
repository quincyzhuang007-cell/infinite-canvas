import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import VideoPage from "@/pages/video";
import TeamLoginPage from "@/pages/login";
import { getTeamSession } from "@/services/collaboration";

function TeamProtectedLayout() {
    const location = useLocation();
    const [authenticated, setAuthenticated] = useState<boolean | null>(null);

    useEffect(() => {
        let active = true;
        getTeamSession().then(({ required, authenticated: value }) => {
            if (active) setAuthenticated(!required || value);
        }).catch(() => {
            if (active) setAuthenticated(false);
        });
        return () => { active = false; };
    }, []);

    if (authenticated === null) return <main className="flex h-dvh items-center justify-center bg-background text-sm text-stone-500">正在检查团队登录状态…</main>;
    if (!authenticated) {
        const next = `${location.pathname}${location.search}${location.hash}`;
        return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
    }

    return (
        <UserLayout>
            <AnalyticsTracker />
            <Outlet />
        </UserLayout>
    );
}

export const router = createBrowserRouter([
    {
        element: <TeamProtectedLayout />,
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", element: <ImagePage /> },
            { path: "/video", element: <VideoPage /> },
            { path: "/assets", element: <AssetsPage /> },
            { path: "/prompts", element: <PromptsPage /> },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/config", element: <ConfigPage /> },
        ],
    },
    { path: "/login", element: <TeamLoginPage /> },
    { path: "*", element: <NotFound /> },
]);
