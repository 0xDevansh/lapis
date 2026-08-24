import {
  FolderSimple,
  FilePlus,
  FloppyDisk,
  PencilSimple,
  Eye,
  SidebarSimple,
} from "@phosphor-icons/react";
import type { TabMode } from "../../store/workspace";

interface MobileToolbarProps {
  /** True when a file tab is active. */
  hasActiveTab: boolean;
  /** True when the active tab has unsaved edits. */
  dirty: boolean;
  /** True while a save request is in flight. */
  saving: boolean;
  /** True when the active file is a markdown note (enables mode toggle). */
  isMd: boolean;
  /** Current display mode of the active tab. */
  mode: TabMode;
  onToggleLeft: () => void;
  onNewNote?: () => void;
  onSave?: () => void;
  onToggleMode?: () => void;
  onToggleRight: () => void;
}

function ToolbarButton({
  label,
  onClick,
  disabled,
  active,
  badge,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  badge?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={[
        "relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors active:scale-95",
        active ? "text-accent" : "text-muted",
        disabled ? "cursor-not-allowed opacity-35" : "hover:text-ink",
      ].join(" ")}
    >
      {badge && (
        <span
          aria-hidden
          className="absolute right-[calc(50%-16px)] top-1.5 h-1.5 w-1.5 rounded-full bg-accent"
        />
      )}
      {children}
      <span>{label}</span>
    </button>
  );
}

export default function MobileToolbar({
  hasActiveTab,
  dirty,
  saving,
  isMd,
  mode,
  onToggleLeft,
  onNewNote,
  onSave,
  onToggleMode,
  onToggleRight,
}: MobileToolbarProps) {
  return (
    <nav
      aria-label="Mobile toolbar"
      className="flex h-14 shrink-0 items-stretch border-t border-border bg-secondary"
    >
      <ToolbarButton label="Files" onClick={onToggleLeft}>
        <FolderSimple size={22} weight="duotone" />
      </ToolbarButton>

      <ToolbarButton label="New" onClick={onNewNote ?? (() => {})} disabled={!onNewNote}>
        <FilePlus size={22} weight="duotone" />
      </ToolbarButton>

      <ToolbarButton
        label={saving ? "Saving…" : "Save"}
        onClick={onSave ?? (() => {})}
        disabled={!onSave || !hasActiveTab || !dirty || saving}
        badge={Boolean(onSave) && hasActiveTab && dirty && !saving}
      >
        <FloppyDisk size={22} weight="duotone" />
      </ToolbarButton>

      <ToolbarButton
        label={mode === "preview" ? "Edit" : "Preview"}
        onClick={onToggleMode ?? (() => {})}
        disabled={!onToggleMode || !hasActiveTab || !isMd}
      >
        {mode === "preview" ? (
          <PencilSimple size={22} weight="duotone" />
        ) : (
          <Eye size={22} weight="duotone" />
        )}
      </ToolbarButton>

      <ToolbarButton label="Panels" onClick={onToggleRight}>
        <SidebarSimple size={22} weight="duotone" className="scale-x-[-1]" />
      </ToolbarButton>
    </nav>
  );
}
