"use client";

// "New project" dialog — name + a one-line description. The description becomes
// the header of the project's memory block and the extractor's orientation
// line, so it is one sentence, not a document. The slug is derived server-side
// from the name and never changes.

import { useState } from "react";

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
  /** Create the project; resolves to an error message, or null on success. */
  onCreate: (name: string, description: string) => Promise<string | null>;
};

export function NewProjectDialog({ open, onOpenChange, onCreate }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const close = () => {
    onOpenChange(false);
    setName("");
    setDescription("");
    setError(null);
  };

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    const err = await onCreate(name.trim(), description.trim());
    setSaving(false);
    if (err) setError(err);
    else close();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              Conversations in a project share its memory context.
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
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
