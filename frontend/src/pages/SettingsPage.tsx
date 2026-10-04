import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import PageHeader from "@/components/ui/PageHeader";
import { useShellChrome } from "@/components/shell/ShellContext";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { PHONE_QUERY } from "@/lib/breakpoints";
import ProfileSettings, { RestrictedProfileNotice } from "@/components/settings/ProfileSettings";
import SecuritySettings from "@/components/settings/SecuritySettings";
import AppearanceSettings from "@/components/settings/AppearanceSettings";
import ZoteroSettings from "@/components/settings/ZoteroSettings";
import YourDataSettings from "@/components/settings/YourDataSettings";
import DeleteAccountSettings from "@/components/settings/DeleteAccountSettings";
import {
  SettingsMobileIndex,
  SettingsNav,
  settingsSections,
  type SettingsSectionId,
} from "@/components/settings/SettingsIndex";
import "./SettingsPage.css";

/**
 * Settings. Wide screens show every section beside a section index whose
 * links are `#anchors` (`/settings#zotero`, `#your-data`, …). Phones show the
 * index as a drill-in list; the same anchors open one section with a back link.
 */
export default function SettingsPage() {
  const { user } = useAuth();
  // Before accepting updated terms, only the account tools stay available.
  const restricted = !!user?.legal_acceptance_required;
  const phone = useMediaQuery(PHONE_QUERY);
  const { hash } = useLocation();
  // The page's own header replaces the shell's breadcrumb and phone app bar.
  useShellChrome({ topBar: false, mobileTopBar: false });

  const items = settingsSections(restricted, phone);
  const target = hash.slice(1);
  const section = (id: SettingsSectionId) => {
    switch (id) {
      case "profile":
        return restricted ? <RestrictedProfileNotice /> : <ProfileSettings />;
      case "security":
        return <SecuritySettings />;
      case "appearance":
        return <AppearanceSettings part={phone ? "theme" : "all"} />;
      case "language":
        return <AppearanceSettings part="language" />;
      case "zotero":
        return <ZoteroSettings />;
      case "your-data":
        return <YourDataSettings />;
      case "delete-account":
        return <DeleteAccountSettings />;
    }
  };

  if (phone) return <MobileSettings items={items} target={target} restricted={restricted} render={section} />;
  return <DesktopSettings items={items} target={target} render={section} />;
}

interface LayoutProps {
  items: ReturnType<typeof settingsSections>;
  target: string;
  render: (id: SettingsSectionId) => ReactNode;
}

function DesktopSettings({ items, target, render }: LayoutProps) {
  const { t } = useTranslation();
  const ids = items.map((item) => item.id as string);
  // `#language` is a row of Appearance on wide screens.
  const linked = target === "language" ? "appearance" : ids.includes(target) ? target : null;
  const active = useActiveSection(ids, linked);

  return (
    <div className="settings">
      <PageHeader title={t("settings.title")} description={t("settings.pageDescription")} />
      <div className="settings-layout">
        <SettingsNav items={items} active={active} />
        <div className="settings-content">
          {items.map((item) => (
            <Fragment key={item.id}>{render(item.id)}</Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The index entry for the section in view: the linked one while it is on
 * screen, otherwise the first section crossing the upper part of the viewport.
 */
function useActiveSection(ids: string[], linked: string | null): string {
  const [spied, setSpied] = useState<{ linked: string | null; id: string } | null>(null);
  const key = ids.join(" ");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const order = key.split(" ");
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        const id = linked && visible.has(linked) ? linked : order.find((each) => visible.has(each));
        if (id) setSpied({ linked, id });
      },
      { rootMargin: "0px 0px -55% 0px" },
    );
    for (const id of order) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [key, linked]);

  if (spied && spied.linked === linked) return spied.id;
  return linked ?? ids[0] ?? "";
}

function MobileSettings({ items, target, restricted, render }: LayoutProps & { restricted: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state } = useLocation();
  const open = items.find((item) => item.id === target);
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (open) lastOpened.current = open.id;
  }, [open]);

  if (!open) {
    return (
      <div className="settings">
        <header className="settings-mobile-header">
          <h1 className="settings-mobile-title">{t("settings.title")}</h1>
        </header>
        <SettingsMobileIndex items={items} restricted={restricted} returnFocus={lastOpened.current} />
      </div>
    );
  }

  // Opened from the list: going back pops that entry, like the browser's Back.
  const fromIndex = !!(state as { settingsIndex?: boolean } | null)?.settingsIndex;
  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!fromIndex) return;
    event.preventDefault();
    navigate(-1);
  };

  return (
    <div className="settings settings--drilled">
      <header className="settings-mobile-header">
        <Link
          to="/settings"
          replace
          className="btn-ghost settings-back"
          aria-label={t("settings.backToSettings")}
          title={t("settings.backToSettings")}
          onClick={back}
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </Link>
        <h1 className="settings-mobile-title">{t(open.labelKey)}</h1>
      </header>
      {render(open.id)}
    </div>
  );
}
