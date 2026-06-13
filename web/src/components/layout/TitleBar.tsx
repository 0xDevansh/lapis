import { Link } from "react-router-dom";
import {
  SidebarSimple,
  Sidebar as SidebarRight,
  MagnifyingGlass,
  Command,
  Sun,
  Moon,
  House,
  DeviceMobile,
  DownloadSimple,
  CaretRight,
} from "@phosphor-icons/react";
import type { Theme } from "../../hooks/useTheme";

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
  children,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={[
        "flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-ink",
        active ? "text-accent-soft" : "",
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
            <span
              className={[
                "truncate",
                last ? "text-ink" : "text-muted",
              ].join(" ")}
            >
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
  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-secondary px-2">
      {/* Left controls */}
      <IconButton
        label={leftCollapsed ? "Show sidebar" : "Hide sidebar"}
        active={!leftCollapsed}
        onClick={onToggleLeft}
      >
        <SidebarSimple size={17} />
      </IconButton>

      <Link
        to="/"
        title="All vaults"
        aria-label="All vaults"
        onClick={(e) => {
          if (!onNavigateGuard()) e.preventDefault();
        }}
        className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-ink"
      >
        <House size={17} weight="duotone" />
      </Link>

      <div className="mx-1 h-4 w-px bg-border" aria-hidden />

      {/* Vault name + breadcrumb */}
      <span className="shrink-0 text-[13px] font-semibold text-ink">{vaultName}</span>
      <CaretRight size={11} className="shrink-0 text-faint" weight="bold" />
      <div className="min-w-0 flex-1 overflow-hidden">
        <Breadcrumb path={activePath} />
      </div>

      {/* Right controls */}
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Search (⌘F)" onClick={onOpenSearch}>
          <MagnifyingGlass size={16} />
        </IconButton>
        <IconButton label="Command palette (⌘P)" onClick={onOpenPalette}>
          <Command size={16} />
        </IconButton>
        <IconButton
          label={theme === "dark" ? "Light theme" : "Dark theme"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </IconButton>

        <div className="mx-1 h-4 w-px bg-border" aria-hidden />

        <Link
          to={`/vault/${vaultId}/devices`}
          title="Devices"
          aria-label="Devices"
          onClick={(e) => {
            if (!onNavigateGuard()) e.preventDefault();
          }}
          className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <DeviceMobile size={17} weight="duotone" />
        </Link>
        <a
          href={exportUrl}
          download
          title="Export vault as zip"
          aria-label="Export vault"
          className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <DownloadSimple size={17} />
        </a>

        <IconButton
          label={rightCollapsed ? "Show right panel" : "Hide right panel"}
          active={!rightCollapsed}
          onClick={onToggleRight}
        >
          <SidebarRight size={17} />
        </IconButton>
      </div>
    </header>
  );
}
