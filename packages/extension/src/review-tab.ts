/**
 * What the review form's editor tab shows. Kept free of `vscode` so it can be
 * tested; ReviewForm applies it to the panel.
 */

/** The round is the one thing that changes between two visits to the same form. */
export const reviewTabTitle = (round: number): string => `Code Review (Round ${round})`;

/**
 * Tab icons, relative to the extension's media folder. VS Code picks `light` on
 * light themes, so that one is the dark glyph — and vice versa. Both are the
 * Marketplace mark cut out of its black square: at tab size an opaque square
 * reads as a hole in the tab bar on a light theme.
 */
export const REVIEW_TAB_ICON = {
  light: "tab-icon-light.png",
  dark: "tab-icon-dark.png",
} as const;
