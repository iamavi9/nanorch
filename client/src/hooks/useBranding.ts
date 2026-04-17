import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

export interface Branding {
  id: string;
  appName: string;
  appLogoUrl: string | null;
  faviconUrl: string | null;
  updatedAt: string;
}

const DEFAULT_BRANDING: Branding = {
  id: "singleton",
  appName: "NanoOrch",
  appLogoUrl: null,
  faviconUrl: null,
  updatedAt: new Date().toISOString(),
};

export function useBranding(): Branding {
  const { data } = useQuery<Branding>({
    queryKey: ["/api/settings/branding"],
    staleTime: 5 * 60 * 1000,
  });

  const branding = data ?? DEFAULT_BRANDING;

  useEffect(() => {
    if (branding.appName) {
      document.title = branding.appName;
    }
  }, [branding.appName]);

  useEffect(() => {
    if (branding.faviconUrl) {
      let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.href = branding.faviconUrl;
    }
  }, [branding.faviconUrl]);

  return branding;
}
