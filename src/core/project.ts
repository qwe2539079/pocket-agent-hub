import type { ProjectConfig } from "../config/types.js";

export class ProjectRegistry {
  readonly #byId = new Map<string, ProjectConfig>();
  readonly #byAlias = new Map<string, ProjectConfig>();

  constructor(projects: ProjectConfig[]) {
    for (const project of projects) {
      if (this.#byId.has(project.id)) {
        throw new Error(`Duplicate project id: ${project.id}`);
      }
      this.#byId.set(project.id, project);
    }

    for (const project of projects) {
      for (const alias of project.aliases ?? []) {
        if (this.#byId.has(alias) && this.#byId.get(alias) !== project) {
          throw new Error(
            `Project alias "${alias}" on "${project.id}" collides with project id "${alias}"`,
          );
        }
        const prior = this.#byAlias.get(alias);
        if (prior && prior !== project) {
          throw new Error(
            `Project alias "${alias}" is used by both "${prior.id}" and "${project.id}"`,
          );
        }
        this.#byAlias.set(alias, project);
      }
    }
  }

  get(idOrAlias: string): ProjectConfig | undefined {
    return this.#byId.get(idOrAlias) ?? this.#byAlias.get(idOrAlias);
  }

  list(): ProjectConfig[] {
    return [...this.#byId.values()];
  }
}
