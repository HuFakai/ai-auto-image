import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  const registerEnabled = process.env.REGISTER_ENABLED === "1";
  return (
    <section className="flex min-h-screen items-center justify-center px-4 py-10">
      <LoginForm registerEnabled={registerEnabled} />
    </section>
  );
}
