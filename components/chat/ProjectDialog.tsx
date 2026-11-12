"use client";

// Shared project create/edit dialog. The one-line description becomes
// the header of the project's memory block and the extractor's orientation
// line, so it is one sentence, not a document. The slug is derived server-side
// from the name and never changes.

import { useState } from "react";
import type { Project } from "@/lib/paf";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project;
  /** Save the project; resolves to an error message, or null on success. */
  onSave: (
    name: string,
    description: string,
    root: string,
  ) => Promise<string | null>;
};

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  onSave,
}: Props) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [root, setRoot] = useState(project?.root ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = () => {
    onOpenChange(false);
    setName("");
    setDescription("");
    setRoot("");
    setError(null);
  };

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const err = await onSave(name.trim(), description.trim(), root.trim());
    setSaving(false);
    if (err) setError(err);
    else close();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{project ? "Edit project" : "New project"}</DialogTitle>
            <DialogDescription>
              {project
                ? "Changes apply to conversations in this project on their next turn."
                : "Conversations in a project share its memory context."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Name (e.g. paf)"
              aria-label="Project name"
            />
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One-line description (optional)"
              aria-label="Project description"
            />
            <label
              htmlFor="project-root"
              className="text-xs text-muted-foreground"
            >
              Project root (optional)
            </label>
            <Input
              id="project-root"
              value={root}
              onChange={(e) => {
                setRoot(e.target.value);
                setError(null);
              }}
              placeholder="~/projects/my-project"
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              aria-describedby="project-root-help"
            />
            <p id="project-root-help" className="text-xs text-muted-foreground">
              Directory on the paf server. Leave blank to use the agent’s default
              directories.
            </p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {project ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
