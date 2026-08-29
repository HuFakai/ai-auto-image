import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");
  const registerEnabled = process.env.REGISTER_ENABLED === "1";
  return (
    <section className="py-6">
      <LoginForm registerEnabled={registerEnabled} />
    </section>
  );
}
