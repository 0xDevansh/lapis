## Business
Lapis - A web editor and sync tool for Obsidian vaults

## Design Language
Authentic Obsidian Editor theme - dark mode, minimalist, knowledge-worker focused

## Color Palette
- Background Primary: #0f0f0f (true black)
- Background Secondary: #171717 (sidebar/header bg)
- Background Surface: #1f1f1f (card/elevated surfaces)
- Text Primary: #eeeeee (main text)
- Text Muted: #a3a3a3 (secondary/placeholder text)
- Primary Accent: #7c3aed (purple - buttons, highlights, active states)
- Accent Soft: #a78bfa (light purple - tags, secondary accents)
- Border: #262626 (subtle dividers and borders)

## Typography
- Primary Font: Inter (400, 500, 600 weights)
- Monospace Font: JetBrains Mono (code/metadata)
- Heading Scale: h1 = 2.25rem (700 weight), h2 = 1.5rem (600 weight)
- Body: 14-16px (400 weight), Line height 1.5
- UI Elements: 12-13px (500 weight) for compact labels
- Code/Metadata: 11-12px monospace (400 weight)

## Layout System
- Three-Panel Architecture: Sidebar (264px) | Editor (flex) | Right Panel (288px)
- Header: 40px (tabs, breadcrumb, controls)
- Footer: 24px (status bar)
- Gutters: 8-12px base, 16px content padding
- Border Radius: 6-8px for cards, 4px for small elements, 9999px for pills

## Reusable Components

### Header Navigation
<div class=\"h-10 obsidian-border border-b flex items-center justify-between px-4 bg-[#0f0f0f] z-50\"><div class=\"flex items-center gap-4\"><div class=\"flex gap-1.5\"><div class=\"w-3 h-3 rounded-full bg-[#ff5f57]\"></div><div class=\"w-3 h-3 rounded-full bg-[#febc2e]\"></div><div class=\"w-3 h-3 rounded-full bg-[#28c840]\"></div></div><div class=\"flex items-center gap-2 ml-4 text-[var(--text-muted)]\"><iconify-icon icon=\"lucide:chevron-left\" class=\"cursor-pointer hover:text-white\"></iconify-icon><iconify-icon icon=\"lucide:chevron-right\" class=\"cursor-pointer hover:text-white opacity-50\"></iconify-icon></div></div><div class=\"text-xs text-[var(--text-muted)] flex items-center gap-2\"><iconify-icon icon=\"lucide:file-text\" class=\"text-xs\"></iconify-icon> Periodic Notes / 2022-10-13</div><div class=\"flex items-center gap-4 text-[var(--text-muted)]\"><iconify-icon icon=\"lucide:search\" class=\"text-sm cursor-pointer hover:text-white\"></iconify-icon><iconify-icon icon=\"lucide:layout-sidebar-right\" class=\"text-sm cursor-pointer hover:text-white\"></iconify-icon></div></div>

### Sidebar File Tree
<aside class=\"w-64 obsidian-border border-r bg-[#171717] flex flex-col h-full\"><div class=\"p-3 flex items-center justify-between\"><div class=\"text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider\">Obsidian Vault</div><div class=\"flex gap-2 text-[var(--text-muted)]\"><iconify-icon icon=\"lucide:plus\" class=\"cursor-pointer hover:text-white\"></iconify-icon><iconify-icon icon=\"lucide:folder-plus\" class=\"cursor-pointer hover:text-white\"></iconify-icon></div></div><div class=\"flex-1 overflow-y-auto custom-scroll text-sm px-2\"><div class=\"space-y-0.5\"><div class=\"flex items-center gap-2 py-1 px-2 rounded hover:bg-[#262626] cursor-pointer text-[var(--text-muted)]\"><iconify-icon icon=\"lucide:chevron-right\" class=\"text-xs\"></iconify-icon><iconify-icon icon=\"lucide:folder\" class=\"text-xs\"></iconify-icon> Areas</div><div class=\"py-1 px-2 rounded bg-[var(--accent)] text-white font-medium\">2022-10-13</div></div></div></aside>

### Tag Pill Component
<span class=\"tag-pill\">#Cadence/Daily</span>

CSS:
.tag-pill {
  background: rgba(124, 58, 237, 0.15);
  border: 1px solid rgba(124, 58, 237, 0.3);
  color: var(--accent-soft);
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 0.75rem;
}

### Right Sidebar Panel
<aside class=\"w-72 bg-[#171717] obsidian-border border-l flex flex-col\"><div class=\"p-4 flex flex-col gap-6\"><div class=\"flex items-center justify-between\"><h3 class=\"text-xs font-bold text-[var(--text-muted)] uppercase tracking-widest\">Calendar</h3><div class=\"flex gap-2 text-[var(--text-muted)]\"><iconify-icon icon=\"lucide:chevron-left\" class=\"text-sm cursor-pointer hover:text-white\"></iconify-icon><iconify-icon icon=\"lucide:chevron-right\" class=\"text-sm cursor-pointer hover:text-white\"></iconify-icon></div></div></div></aside>

### Editor Content Area
<article class=\"max-w-3xl mx-auto py-20 px-8 markdown-preview\"><h1>Thursday, October 13, 2022</h1><section><h2>Summary</h2></section></article>

CSS for Markdown Preview:
.markdown-preview h1 {
  font-size: 2.25rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
  letter-spacing: -0.025em;
}
.markdown-preview h2 {
  font-size: 1.5rem;
  font-weight: 600;
  margin-top: 2rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.5rem;
}

### Custom Scrollbar
.custom-scroll::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}
.custom-scroll::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 10px;
}

## Visual Style
- **Aesthetic**: Minimalist, knowledge-worker focused, distraction-free
- **Borders**: Subtle (#262626) 1px only where structure is needed
- **Shadows**: Minimal - only on hover states
- **Spacing**: Generous negative space in editor, compact UI in panels
- **Interactions**: Icon hover → text-white, background → #262626 on hover
- **Focus States**: Purple accent (#7c3aed) with soft background overlay
- **Active States**: Full purple background with white text

## Icon Library
Using Iconify with Lucide icons:
- Navigation: chevron-left, chevron-right, file-text
- Actions: plus, folder-plus, search, lock, x
- Sidebar: folder, folder-open, calendar, rss, paperclip, briefcase, tag
- Layout: layout-sidebar-right, edit, layout-sidebar-left