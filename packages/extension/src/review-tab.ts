/**
 * What the review form's editor tab shows. Kept free of `vscode` so it can be
 * tested; ReviewForm applies it to the panel.
 */

/**
 * What one review's tab says. The branch leads when it is known: a window can hold a
 * review per worktree, and two tabs both reading "Code Review (Round 1)" say nothing
 * about which branch each one is asking the human to approve. Titles truncate from the
 * end, so the branch goes where it survives.
 */
export const reviewTabTitle = (round: number, branch = ""): string =>
  branch ? `${branch} · Round ${round}` : `Code Review (Round ${round})`;

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
