"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AdminShell from "@/components/admin/AdminShell";
import { getStoredUser, getToken, logout, type AuthUser } from "@/lib/auth";
import { MEMBER_PORTAL_ENABLED, isStaffSide } from "@/lib/permissions";

export default function AdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const stored = getStoredUser();
    if (!getToken() || !stored) {
      router.replace("/login");
      return;
    }
    if (stored.mustChangePassword) {
      router.replace("/change-password");
      return;
    }
    if (!isStaffSide(stored.role)) {
      // Nowhere to send a member while the portal is disconnected.
      if (!MEMBER_PORTAL_ENABLED) {
        void logout().then(() => router.replace("/login"));
      } else {
        router.replace("/dashboard");
      }
      return;
    }
    setUser(stored);
  }, [router]);

  if (!user) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper text-ink-soft">
        Loading…
      </main>
    );
  }

  return <AdminShell user={user} />;
}
