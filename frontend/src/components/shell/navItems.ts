import { FolderOpen, LayoutDashboard, LibraryBig, Search, Share2, type LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import api, { library } from "@/lib/api";
import type { Collection } from "@/types";

export interface NavItem {
  to: string;
  labelKey: string;
  icon: LucideIcon;
  end: boolean;
}

/** The signed-in app's destinations, in sidebar order. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { to: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, end: true },
  { to: "/search", labelKey: "nav.search", icon: Search, end: false },
  { to: "/library", labelKey: "nav.library", icon: LibraryBig, end: false },
  { to: "/collections", labelKey: "nav.collections", icon: FolderOpen, end: false },
  { to: "/graph/library", labelKey: "nav.graph", icon: Share2, end: false },
];

/** The user's collections, shared with the Collections page and Dashboard cache. */
export function useCollectionsList(enabled: boolean) {
  return useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data } = await api.get<Collection[]>("/collections");
      return data;
    },
    enabled,
  });
}

/** Library size, from the saved-keys list every save already refreshes. */
export function useLibraryCount(enabled: boolean): number | undefined {
  const { data } = useQuery({
    queryKey: ["library-keys"],
    queryFn: () => library.listKeys(),
    enabled,
  });
  return Array.isArray(data) ? data.length : undefined;
}
