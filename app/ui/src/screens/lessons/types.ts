// The shapes Lessons reads from `lessons.list`. Field names are the service's.

export interface LessonSource {
  /** The id of the project the note came from. */
  project?: string;
  /** That project's name, from the service. */
  project_title?: string;
  node?: string;
  note?: string;
  /** A path to the frame the owner marked. */
  image?: string;
  frame?: number;
}

export type LessonScope = 'all' | 'project';

export interface Lesson {
  id: string;
  /** The lesson's own name. Lessons from before names have none. */
  name?: string;
  text: string;
  section: string;
  /** The owner has decided on it. Until then it waits for them. */
  approved: boolean;
  on: boolean;
  scope: LessonScope;
  /** For an only-one-project lesson: the project it is used in. */
  project?: string;
  /** Scenes built with it. */
  used: number;
  source?: LessonSource;
}

export interface LessonsAnswer {
  lessons: Lesson[];
}
