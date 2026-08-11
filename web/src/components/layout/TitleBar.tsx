import { Link } from "react-router-dom";
import { useRef, useState } from "react";
import {
  SidebarSimple,
  Sidebar as SidebarRight,
  MagnifyingGlass,
  Command,
  House,
  CaretRight,
  GearSix,
} from "@phosphor-icons/react";
import type { Theme } from "../../hooks/useTheme";
import SettingsPopover from "../overlays/SettingsPopover";

interface TitleBarProps {
  vaultId: string;
  vaultName: string;
  /** Active tab path for the breadcrumb, or null when no tab is open. */
  activePath: string | null;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenSearch: () => void;
  onOpenPalette: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  /** Guard navigation away when there are unsaved edits. Return false to block. */
  onNavigateGuard: () => boolean;
  exportUrl: string;
}

function IconButton({
  label,
  active,
  onClick,
  extraClass,
  size = "sm",
  children,
  buttonRef,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  extraClass?: string;
  size?: "sm" | "lg";
  children: React.ReactNode;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const dim = size === "lg" ? "h-9 w-9" : "h-9 w-9";
  return (
    <button
      ref={buttonRef as React.RefObject<HTMLButtonElement>}
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={[
        `flex ${dim} items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink`,
        active ? "text-accent-soft" : "",
        extraClass ?? "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Breadcrumb({ path }: { path: string | null }) {
  if (!path) {
    return <span className="text-[13px] text-faint">No file open</span>;
  }
  const segments = path.split("/");
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-[13px]">
      {segments.map((seg, i) => {
        const last = i === segments.length - 1;
        return (
          <span key={i} className="flex min-w-0 items-center gap-1">
            <span className={["truncate", last ? "text-ink" : "text-muted"].join(" ")}>
              {last ? seg.replace(/\.md$/i, "") : seg}
            </span>
            {!last && (
              <CaretRight size={11} className="shrink-0 text-faint" weight="bold" />
            )}
          </span>
        );
      })}
    </nav>
  );
}

export default function TitleBar({
  vaultId,
  vaultName,
  activePath,
  leftCollapsed,
  rightCollapsed,
  onToggleLeft,
  onToggleRight,
  onOpenSearch,
  onOpenPalette,
  theme,
  onToggleTheme,
  onNavigateGuard,
  exportUrl,
}: TitleBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <header className="relative flex h-11 shrink-0 items-center gap-1 border-b border-border bg-secondary px-2">
      <IconButton
        label={leftCollapsed ? "Show sidebar" : "Hide sidebar"}
        active={!leftCollapsed}
        onClick={onToggleLeft}
      >
        <SidebarSimple size={22} />
      </IconButton>

      <Link
        to="/"
        title="All vaults"
        aria-label="All vaults"
        onClick={(e) => {
          if (!onNavigateGuard()) e.preventDefault();
        }}
        className="flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink"
      >
        <House size={22} weight="duotone" />
      </Link>

      <div className="mx-1 h-4 w-px bg-border" aria-hidden />

      <span className="shrink-0 text-[13px] font-semibold text-ink">{vaultName}</span>
      <CaretRight size={14} className="shrink-0 text-faint" weight="bold" />
      <div className="min-w-0 flex-1 overflow-hidden">
        <Breadcrumb path={activePath} />
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Search (⌘F)" onClick={onOpenSearch} extraClass="hidden md:flex">
          <MagnifyingGlass size={22} />
        </IconButton>
        <IconButton label="Command palette (⌘P)" onClick={onOpenPalette} extraClass="hidden md:flex">
          <Command size={22} />
        </IconButton>

        <IconButton
          label={rightCollapsed ? "Show right panel" : "Hide right panel"}
          active={!rightCollapsed}
          onClick={onToggleRight}
        >
          <SidebarRight size={22} />
        </IconButton>

        <div className="mx-1 h-4 w-px bg-border" aria-hidden />

        <IconButton
          label="Settings"
          active={settingsOpen}
          size="lg"
          onClick={() => setSettingsOpen((o) => !o)}
          buttonRef={settingsBtnRef}
        >
          <GearSix size={22} weight={settingsOpen ? "fill" : "duotone"} />
        </IconButton>
      </div>

      <SettingsPopover
        vaultId={vaultId}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onToggleTheme={onToggleTheme}
        exportUrl={exportUrl}
        anchorRef={settingsBtnRef}
      />
    </header>
  );
}
