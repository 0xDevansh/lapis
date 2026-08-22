import { Modal, Notice, Setting } from "obsidian";
import type { App } from "obsidian";
import type {
  ConflictPayload,
  ConflictResolutionRequest,
} from "../types";

export interface ConflictModalOptions {
  conflicts: ConflictPayload[];
  onResolve: (request: ConflictResolutionRequest) => Promise<void>;
  onOpenNote: (path: string) => Promise<void>;
}

export class ConflictModal extends Modal {
  private conflicts: ConflictPayload[];
  private selected = 0;
  private editMerge = false;
  private merged = "";
  private resolving = false;
  private error: string | null = null;

  constructor(
    app: App,
    private readonly options: ConflictModalOptions
  ) {
    super(app);
    this.conflicts = [...options.conflicts];
    this.resetMerged();
  }

  onOpen(): void {
    this.modalEl.addClass("lapis-conflict-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Resolve sync conflicts" });

    if (this.conflicts.length === 0) {
      contentEl.createEl("p", {
        text: "All conflicts are resolved.",
        cls: "lapis-conflict-muted",
      });
      new Setting(contentEl).addButton((button) =>
        button.setButtonText("Done").setCta().onClick(() => this.close())
      );
      return;
    }

    const conflict = this.conflicts[this.selected];
    contentEl.createEl("p", {
      text: `${this.conflicts.length} unresolved conflict${this.conflicts.length === 1 ? "" : "s"}`,
      cls: "lapis-conflict-muted",
    });

    const select = contentEl.createEl("select", {
      cls: "dropdown lapis-conflict-select",
      attr: { "aria-label": "Conflict to resolve" },
    });
    this.conflicts.forEach((item, index) => {
      const option = select.createEl("option", {
        text: item.path,
        attr: { value: String(index) },
      });
      option.selected = index === this.selected;
    });
    select.disabled = this.resolving;
    select.addEventListener("change", () => {
      this.selected = Number(select.value);
      this.editMerge = false;
      this.error = null;
      this.resetMerged();
      this.render();
    });

    contentEl.createEl("p", {
      text: `Server r${conflict.serverRevision} · local base r${conflict.clientBaseRevision}`,
      cls: "lapis-conflict-revisions",
    });

    if (conflict.isBinary) {
      contentEl.createEl("p", {
        text: "This is a binary conflict. Keep the remote version here, or upload the desired local file separately.",
        cls: "lapis-conflict-warning",
      });
    } else {
      const versions = contentEl.createDiv({
        cls: "lapis-conflict-versions",
      });
      this.renderVersion(versions, "Remote (server)", conflict.serverContent);
      this.renderVersion(versions, "Local (yours)", conflict.clientContent);
      this.renderVersion(versions, "Common base", conflict.baseContent);
    }

    if (this.editMerge && !conflict.isBinary) {
      const editor = contentEl.createEl("textarea", {
        cls: "lapis-conflict-merge-editor",
        attr: {
          "aria-label": "Edited merge result",
          spellcheck: "false",
        },
      });
      editor.value = this.merged;
      editor.disabled = this.resolving;
      editor.addEventListener("input", () => {
        this.merged = editor.value;
      });
    }

    if (this.error) {
      contentEl.createEl("p", {
        text: this.error,
        cls: "lapis-conflict-error",
      });
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Open conflict note")
          .setDisabled(this.resolving)
          .onClick(() => void this.options.onOpenNote(conflict.conflictNote))
      )
      .addButton((button) =>
        button
          .setButtonText("Keep remote")
          .setDisabled(this.resolving)
          .onClick(() => void this.resolve("keep-server"))
      )
      .addButton((button) =>
        button
          .setButtonText("Keep local")
          .setDisabled(
            this.resolving ||
              conflict.isBinary === true ||
              conflict.clientContent === undefined
          )
          .onClick(() =>
            void this.resolve("keep-client", conflict.clientContent)
          )
      );

    if (!conflict.isBinary) {
      new Setting(contentEl)
        .setName(
          this.editMerge ? "Edit the merge result above" : "Manual merge"
        )
        .setDesc("Start from your version, edit it, then save it as the new head.")
        .addButton((button) =>
          this.editMerge
            ? button
                .setButtonText("Resolve with merge")
                .setCta()
                .setDisabled(this.resolving)
                .onClick(() => void this.resolve("use-merged", this.merged))
            : button
                .setButtonText("Open & edit merge result")
                .setDisabled(this.resolving)
                .onClick(() => {
                  this.editMerge = true;
                  this.render();
                })
        );
    }
  }

  private renderVersion(
    parent: HTMLElement,
    title: string,
    content: string | undefined
  ): void {
    const section = parent.createDiv({ cls: "lapis-conflict-version" });
    section.createEl("h3", { text: title });
    section.createEl("pre", {
      text: content ?? "Unavailable",
      cls:
        content === undefined
          ? "lapis-conflict-version-empty"
          : undefined,
    });
  }

  private resetMerged(): void {
    const conflict = this.conflicts[this.selected];
    this.merged =
      conflict?.clientContent ?? conflict?.serverContent ?? "";
  }

  private async resolve(
    action: ConflictResolutionRequest["action"],
    content?: string
  ): Promise<void> {
    const conflict = this.conflicts[this.selected];
    if (!conflict || this.resolving) return;
    this.resolving = true;
    this.error = null;
    this.render();
    try {
      await this.options.onResolve({
        path: conflict.path,
        conflictNote: conflict.conflictNote,
        action,
        content,
      });
      this.conflicts.splice(this.selected, 1);
      this.selected = Math.min(this.selected, this.conflicts.length - 1);
      this.editMerge = false;
      this.resetMerged();
      new Notice("Lapis: conflict resolved");
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : "Conflict resolution failed";
    } finally {
      this.resolving = false;
      this.render();
    }
  }
}
