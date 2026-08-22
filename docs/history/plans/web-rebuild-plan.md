# Web Vault Rebuild Plan — Obsidian-style Editor

Rebuild the Lapis web vault UI (`web/`) into an Obsidian-like editing
experience: dark-first, keyboard-accessible, tabbed, with collapsible and
resizable side panels and a live-preview Markdown editor. All existing
features must keep working; `src/api.ts` is the contract and stays unchanged.

## Locked decisions

1. **Theme**: dark-first using the Obsidian palette from `docs/product/design.md`.
   Keep a light toggle. Drop sepia.
2. **Editor**: CodeMirror 6 live preview — raw Markdown shown on the active
   line/block, rendered preview elsewhere (Obsidian Live Preview behaviour).
3. **Persistence**: persist open tabs, active tab, and panel widths/collapse
   state to `localStorage`, scoped per vault.
4. **Tailwind v4** via the `@tailwindcss/vite` plugin.
5. **Icons**: `@phosphor-icons/react` (design.md shows lucide/iconify but
   Phosphor is the chosen set).

## Design tokens (Tailwind v4 `@theme`)

| Token | Value |
| --- | --- |
| `--bg-primary` | `#0f0f0f` |
| `--bg-secondary` | `#171717` (sidebar/header) |
| `--bg-surface` | `#1f1f1f` (cards) |
| `--text` | `#eeeeee` |
| `--text-muted` | `#a3a3a3` |
| `--accent` | `#7c3aed` |
| `--accent-soft` | `#a78bfa` |
| `--border` | `#262626` |
| radii | 4px small, 6–8px cards, 9999px pills |

Fonts: Inter (400/500/600) for UI/body, JetBrains Mono for code/metadata
(via `@fontsource`). Light theme via `[data-theme='light']` overrides. Port
markdown/callout/tag-pill/custom-scroll styles to the new dark setup.

## Workspace store — `src/store/workspace.tsx`

React context + `useReducer` + `localStorage` (keyed per `vaultId`).

```
Tab { id, path, mode: 'live' | 'preview', dirty,
      editBuffer?, baseContent?, baseRevision? }
State { tabs[], activeTabId,
        left  { collapsed, width },
        right { collapsed, width, tab: 'backlinks' | 'outline' } }
```

- Open file = activate existing tab or push a new one.
- Close tab = activate neighbour + update route.
- Persist + restore tabs (refetch content on restore).
- Active tab syncs to `/vault/:id/file/*` (deep links preserved).
- Remote-change handling adapted to multi-tab.
- Unsaved guard on tab close, navigation, and `beforeunload`.
- WebSocket reports the active tab's path.

## Component tree

**Layout**: `WorkspaceLayout` (3-pane grid), `ResizablePanel`/`ResizeHandle`
(drag, persist, double-click reset, arrow-key resize), `TitleBar` (40px:
window dots, history chevrons, breadcrumb, panel toggles, search, palette,
theme), `TabBar` (icon + name + dirty dot + close, overflow scroll, keyboard
nav, middle-click close), `StatusBar` (24px: presence, word/char count, sync
state, theme).

**Left sidebar**: `Sidebar`, `FileTree` (Phosphor icons, keyboard nav,
context menu, indent guides), `SearchPanel` (restyled; keeps Cmd+F + arrow
nav), `SnapshotsPanel` (collapsible), `TagsPanel` (new, uses `getVaultTags`;
optional).

**Center**: `EditorTabView` → `MarkdownEditor` (CM6 live preview, Cmd+S save
+ conflict) / `ImageView` / `BinaryView` / `PlainTextView`; frontmatter
property block with tag pills.

**Right panel**: `RightPanel` with tabs → `BacklinksPanel` (moved) +
`OutlinePanel` (new headings nav).

**Overlays**: `CommandPalette` (Cmd/Ctrl+P) + Quick Switcher (Cmd/Ctrl+O),
`Modal` (focus-trapped: new note / rename / delete), `ContextMenu`, `Toast`
(replaces `alert()`; conflict still routes to the conflict note).

**Hooks**: `useWorkspace`, `useHotkeys`, simplified `useTheme`; keep
`useAuth`, `useVaultNotify`. Pages re-skinned (logic unchanged): `AuthPage`,
`VaultListPage`, `DevicesPage`, thinned `VaultBrowserPage` (providers +
layout).

## Keyboard map

| Shortcut | Action |
| --- | --- |
| Cmd/Ctrl+P | Command palette |
| Cmd/Ctrl+O | Quick switcher |
| Cmd/Ctrl+F | Search |
| Cmd/Ctrl+S | Save |
| Cmd/Ctrl+W | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Cycle tabs |
| Cmd/Ctrl+B | Toggle left sidebar |
| Cmd/Ctrl+\ | Toggle right panel |
| Cmd/Ctrl+N | New note |
| Arrows | Navigate tree/search/palette |
| Esc | Close overlays |
| F2 | Rename |
| Delete | Delete in tree |

Roving tabindex + ARIA (tree, tablist/tab, dialog).

## Must preserve

All `api.ts` calls; conflict handling; unsaved guard; remote
put/rename/delete; presence + same-file warning; upload; rename; delete; new
note; snapshots; search; backlinks; devices; theming.

## Build phases

1. Tailwind v4 + Phosphor + fonts + tokens; verify `dev` + `tsc -b && vite build`.
2. Dark theme + port markdown styles; re-skin Auth/VaultList/Devices.
3. Workspace store + `WorkspaceLayout` resizable/collapsible shell.
4. `TitleBar` + `TabBar` + `StatusBar`.
5. `FileTree` rebuild (keyboard + context menu).
6. Right panel (Backlinks + Outline).
7. CM6 live-preview `MarkdownEditor` + save/conflict wiring.
8. Command palette + quick switcher + hotkeys + modals/toasts.
9. Restyle/integrate Search/Snapshots/Presence/Tags.
10. QA: keyboard, a11y, every feature, production build.
