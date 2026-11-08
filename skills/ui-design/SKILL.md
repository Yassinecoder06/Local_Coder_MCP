---
name: ui-design
description: "Practical modern UI design guidance: layout, spacing scale, typography, color tokens, dark mode, accessibility (WCAG), and component checklist."
---

# UI Design Guidelines

Practical, production-tested principles for designing clean, accessible, modern web and mobile user interfaces.

## 1. Layout & Structure

- **Content-Driven Containers**: Max container width typically `1200px` for dashboards/apps, `720px` for reading/articles.
- **Visual Hierarchy**: Guide eye flow from top-left to bottom-right. Most critical CTA above the fold.
- **Consistent Grid**: Use flexbox and CSS grid with consistent alignment:
  - Header: fixed or sticky with distinct border/shadow on scroll.
  - Sidebar: collapsible, 240-280px wide.
  - Main area: scrollable, padded evenly.

## 2. Spacing Scale (8pt Grid)

Use multiples of 4px and 8px across padding, margin, and gap:
- `4px` (`0.25rem`): tight gaps between icon and text.
- `8px` (`0.5rem`): inline badges, compact chip padding.
- `12px` (`0.75rem`): button vertical padding, form input inner padding.
- `16px` (`1.0rem`): card padding, standard gap between form fields.
- `24px` (`1.5rem`): card padding on desktop, section spacing.
- `32px` (`2.0rem`): page header spacing, grid row gap.
- `48px` (`3.0rem`): page section margins.

Never mix arbitrary pixel values like `13px`, `19px`, `27px`.

## 3. Typography System

- **Font Family**: System font stack or clean sans-serif (Inter, Roboto, SF Pro):
  `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;`
- **Scale**:
  - H1 / Page title: `28px` - `32px` (bold / 700), line-height `1.2`
  - H2 / Section title: `20px` - `24px` (semibold / 600), line-height `1.3`
  - H3 / Card title: `16px` - `18px` (semibold / 600), line-height `1.4`
  - Body: `14px` - `16px` (regular / 400), line-height `1.5` - `1.6`
  - Caption / Helper text: `12px` - `13px` (medium / 500), line-height `1.4`
- **Contrast & Legibility**: Body copy line length between 45 and 75 characters per line for readability.

## 4. Semantic Color Tokens & Dark Mode

Define design tokens via CSS variables for seamless light/dark mode:

```css
:root {
  --bg-canvas: #ffffff;
  --bg-surface: #f8fafc;
  --bg-card: #ffffff;
  --border-subtle: #e2e8f0;
  --border-strong: #cbd5e1;
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #94a3b8;
  --accent-primary: #2563eb;
  --accent-hover: #1d4ed8;
  --success: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
}

[data-theme="dark"] {
  --bg-canvas: #090d16;
  --bg-surface: #0f172a;
  --bg-card: #1e293b;
  --border-subtle: #334155;
  --border-strong: #475569;
  --text-primary: #f8fafc;
  --text-secondary: #94a3b8;
  --text-muted: #64748b;
  --accent-primary: #3b82f6;
  --accent-hover: #60a5fa;
  --success: #22c55e;
  --warning: #f59e0b;
  --danger: #ef4444;
}
```

## 5. Accessibility (WCAG 2.1 AA)

- **Color Contrast**: Minimum 4.5:1 for regular text, 3:1 for large text (>= 18pt or 14pt bold) and active UI controls.
- **Focus Indicators**: Never disable `outline: none` without providing an explicit `:focus-visible` ring (e.g. `outline: 2px solid var(--accent-primary); outline-offset: 2px`).
- **Touch & Click Targets**: Interactive elements must be at least 44x44px.
- **Keyboard Navigation**: All interactive elements reachable via `Tab` / `Shift+Tab`, activated by `Enter` / `Space`.
- **Form Controls**: Always pair every `<input>` with an explicit `<label for="...">` or `aria-label`. Include error messages via `aria-describedby`.

## 6. Component Quality Checklist

Before finalizing any UI component, check:
1. **Interactive States**: Default, hover, active, focused, disabled, and loading/busy states clearly defined.
2. **Empty States**: If a table/list has 0 items, display an informative empty state with an action button.
3. **Truncation & Overflow**: Text that could exceed container width has `text-overflow: ellipsis` or wraps cleanly.
4. **Loading States**: Skeletons or subtle spinners that match the dimensions of the final loaded content.
5. **Transitions**: Micro-interactions kept fast (`150ms` - `200ms`, `ease-out`); avoid sluggish transitions.
