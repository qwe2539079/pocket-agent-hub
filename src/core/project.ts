import type { ProjectConfig } from "../config/types.js";

export class ProjectRegistry {
  readonly #projects = new Map<string, ProjectConfig>();

  constructor(projects: ProjectConfig[]) {
    for (const project of projects) {
      this.#projects.set(project.id, project);
    }
  }

  get(projectId: string): ProjectConfig | undefined {
    return this.#projects.get(projectId);
  }

  list(): ProjectConfig[] {
    return [...this.#projects.values()];
  }
}
