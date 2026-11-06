// Words and ids the Motion session shares between its parts.

/** The id of the one warning the session keeps in the problems bar for the scene on view. */
export const PROBLEM = 'motion-err';
/** A later read of the scenes failed: the last ones stay on screen with this warning. */
export const LOAD_PROBLEM = 'motion-load';
/** The shots (preview.plan) could not be read. */
export const PLAN_PROBLEM = 'motion-plan';

export const SOON = 'This part comes in the next studio update. Nothing is lost.';

export const reason = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

/** While a scene is being made, the screen reads again this often in case a push from the service was missed. */
export const REREAD_WHILE_MAKING_MS = 10_000;
