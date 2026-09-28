import { App, Button, Form, Input } from "antd";
import { LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { loginTeam } from "@/services/collaboration";

type LoginValues = { username: string; password: string };

export default function TeamLoginPage() {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [busy, setBusy] = useState(false);

    const submit = async ({ username, password }: LoginValues) => {
        setBusy(true);
        try {
            if (!await loginTeam(username, password)) throw new Error("用户名或密码错误");
            const next = searchParams.get("next") || "/";
            navigate(next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "登录失败，请检查网络后重试");
        } finally {
            setBusy(false);
        }
    };

    return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
            <section className="w-full max-w-sm rounded-2xl border border-stone-200 bg-background p-7 shadow-sm dark:border-stone-800">
                <div className="mb-6 flex items-center gap-2 text-sm font-semibold text-stone-900 dark:text-stone-100">
                    <span className="size-5 bg-current" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                    Infinite Canvas
                </div>
                <div className="mb-6">
                    <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">团队登录</h1>
                    <p className="mt-2 text-sm text-stone-500">登录一次后，此浏览器会保持登录状态。请输入画布团队账号。</p>
                </div>
                <Form layout="vertical" requiredMark={false} onFinish={(values: LoginValues) => void submit(values)}>
                    <Form.Item label="用户名" name="username" rules={[{ required: true, message: "请输入用户名" }]}>
                        <Input autoComplete="username" autoFocus size="large" prefix={<LockKeyhole className="size-4 text-stone-400" />} />
                    </Form.Item>
                    <Form.Item label="密码" name="password" rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password autoComplete="current-password" size="large" />
                    </Form.Item>
                    <Button className="mt-2" block type="primary" size="large" htmlType="submit" loading={busy}>登录</Button>
                </Form>
            </section>
        </main>
    );
}
