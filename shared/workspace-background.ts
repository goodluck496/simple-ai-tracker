export const WORKSPACE_BACKGROUNDS = ['ocean', 'moss', 'plum', 'ember', 'slate'] as const;
export type WorkspaceBackground = typeof WORKSPACE_BACKGROUNDS[number];

export function isWorkspaceBackground(value: unknown): value is WorkspaceBackground {
  return WORKSPACE_BACKGROUNDS.some(background => background === value);
}
