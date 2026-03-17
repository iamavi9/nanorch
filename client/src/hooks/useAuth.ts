import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";

export type AuthUser = {
  id: string;
  username: string | null;
  name: string | null;
  role: "admin" | "member";
};

export function useAuth() {
  const { data: user, isLoading } = useQuery<AuthUser | null>({
    queryKey: ["/api/auth/me"],
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const isAdmin = user?.role === "admin";
  const isMember = user?.role === "member";

  return { user: user ?? null, isLoading, isAdmin, isMember };
}

export function useLogout() {
  const [, navigate] = useLocation();
  return useMutation({
    mutationFn: () => apiRequest("POST", "/api/auth/logout"),
    onSuccess: () => {
      queryClient.clear();
      navigate("/login");
    },
  });
}
