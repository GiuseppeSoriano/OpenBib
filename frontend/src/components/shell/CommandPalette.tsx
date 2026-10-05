import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FolderOpen, FolderPlus, History, GitFork, LayoutDashboard, LogIn, Moon, Search, Settings, Sun, type LucideIcon } from "lucide-react";
import DialogSurface from "@/components/ui/DialogSurface";
import { useAuth } from "@/contexts/AuthContext";
import { useTheme } from "@/contexts/ThemeContext";
import { PRIMARY_NAV, useCollectionsList } from "@/components/shell/navItems";
import { useRecentSearches } from "@/lib/recentSearches";

type Group = "search" | "recent" | "pages" | "collections" | "actions";

interface PaletteItem {
  id: string;
  group: Group;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

const GROUP_ORDER: Group[] = ["search", "pages", "collections", "recent", "actions"];
const GROUP_LABEL_KEYS: Record<Group, string> = {
  search: "shell.groupSearch",
  recent: "shell.recentSearches",
  pages: "shell.groupPages",
  collections: "nav.collections",
  actions: "shell.groupActions",
};
// Collections listed per group, before the user narrows them down.
const MAX_COLLECTIONS = 6;

/** Every whitespace-separated term of the query appears in the label. */
function matches(label: string, query: string): boolean {
  const text = label.toLocaleLowerCase();
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean).every((term) => text.includes(term));
}

interface CommandPaletteProps {
  onClose: () => void;
  onNewCollection: () => void;
}

/**
 * ⌘K palette: a modal dialog holding a combobox and its listbox. Focus stays
 * in the field; ↑/↓ move the active option, Enter runs it, Escape closes.
 */
export default function CommandPalette({ onClose, onNewCollection }: CommandPaletteProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { resolved, setPreference } = useTheme();
  const recent = useRecentSearches();
  const { data } = useCollectionsList(!!user);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const hintId = `${baseId}-hint`;
  const listId = `${baseId}-list`;

  const items = useMemo(() => {
    const go = (to: string) => () => navigate(to);
    const trimmed = query.trim();
    const out: PaletteItem[] = [];
    if (trimmed) {
      out.push({
        id: "search",
        group: "search",
        label: t("shell.searchFor", { query: trimmed }),
        icon: Search,
        run: go(`/search?${new URLSearchParams({ q: trimmed })}`),
      });
    }
    const pages = user
      ? [...PRIMARY_NAV.map((item) => ({ to: item.to, label: t(item.labelKey), icon: item.icon })),
        { to: "/settings", label: t("nav.settings"), icon: Settings }]
      : [
        { to: "/", label: t("nav.home"), icon: LayoutDashboard },
        { to: "/search", label: t("nav.search"), icon: Search },
        { to: "/graph", label: t("nav.graph"), icon: GitFork },
        { to: "/login", label: t("nav.signIn"), icon: LogIn },
      ];
    for (const page of pages) {
      if (matches(page.label, trimmed)) out.push({ id: `page:${page.to}`, group: "pages", label: page.label, icon: page.icon, run: go(page.to) });
    }
    const collections = (Array.isArray(data) ? data : []).filter((c) => matches(c.name, trimmed));
    for (const c of collections.slice(0, trimmed ? undefined : MAX_COLLECTIONS)) {
      out.push({ id: `collection:${c.id}`, group: "collections", label: c.name, icon: FolderOpen, run: go(`/collections/${c.id}`) });
    }
    for (const item of recent) {
      if (matches(item.query, trimmed)) out.push({ id: `recent:${item.search}`, group: "recent", label: item.query, icon: History, run: go(`/search?${item.search}`) });
    }
    const actions = [
      resolved === "dark"
        ? { id: "theme", label: t("shell.themeToLight"), icon: Sun, run: () => setPreference("light") }
        : { id: "theme", label: t("shell.themeToDark"), icon: Moon, run: () => setPreference("dark") },
      ...(user ? [{ id: "new-collection", label: t("collections.new"), icon: FolderPlus, run: onNewCollection }] : []),
    ];
    for (const action of actions) {
      if (matches(action.label, trimmed)) out.push({ ...action, group: "actions" });
    }
    return GROUP_ORDER.flatMap((group) => out.filter((item) => item.group === group));
  }, [data, navigate, onNewCollection, query, recent, resolved, setPreference, t, user]);

  const groups = GROUP_ORDER.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter(
    (entry) => entry.items.length > 0,
  );
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (!items.length) return;
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  });

  // Close first, so focus is back on the opener before the item navigates or
  // opens another dialog.
  const activate = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    window.setTimeout(item.run, 0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      activate(items[current]);
    }
  };

  return (
    <DialogSurface
      onClose={onClose}
      labelledBy={titleId}
      describedBy={hintId}
      initialFocusRef={inputRef}
      overlayClassName="palette-overlay"
      className="palette"
      testId="command-palette"
    >
      <h2 id={titleId} className="sr-only">{t("shell.paletteTitle")}</h2>
      <div className="palette-field">
        <Search size={17} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length ? optionId(current) : undefined}
          aria-label={t("shell.paletteLabel")}
          placeholder={t("shell.palettePlaceholder")}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd aria-hidden="true">Esc</kbd>
      </div>
      <div id={listId} role="listbox" aria-label={t("shell.paletteLabel")} className="palette-list">
        {groups.map(({ group, items: groupItems }) => (
          <div key={group} role="group" aria-labelledby={`${baseId}-${group}`} className="palette-group">
            <div id={`${baseId}-${group}`} className="palette-group-label label-caps">{t(GROUP_LABEL_KEYS[group])}</div>
            {groupItems.map((item) => {
              const index = items.indexOf(item);
              const Icon = item.icon;
              return (
                <div
                  key={item.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === current}
                  className={`palette-option${index === current ? " palette-option--active" : ""}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => index !== current && setActive(index)}
                  onClick={() => activate(item)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="palette-option-label" title={item.label}>{item.label}</span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {!items.length && <p className="palette-empty">{t("shell.paletteEmpty")}</p>}
      <div className="palette-foot">
        <p id={hintId} className="palette-hint">{t("shell.paletteHint")}</p>
        <span role="status" className="sr-only">{t("shell.paletteResults", { count: items.length })}</span>
      </div>
    </DialogSurface>
  );
}
